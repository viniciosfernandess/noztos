import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'
import { provisionWorktree, generateWorktreeCodename } from '@/lib/worktree'
import { withRetry } from '@/lib/retry'

interface RouteContext {
  params: Promise<{ id: string }>
}

// GET — list all open worktrees for this project, with their nested chats.
export async function GET(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) return NextResponse.json({ error: access.error }, { status: access.status })

  const worktrees = await prisma.worktree.findMany({
    // Defense in depth: status='open' AND deletedAt null AND not still
    // a creation placeholder. The optimistic-create flow inserts a
    // placeholder row with worktreePath='_pending_' before the on-disk
    // git provisioning runs; if the create later 500s, the row sits
    // here until the orphan-cleanup sweep (5 min) reaps it. Filtering
    // here means a refresh during that window doesn't surface the
    // ghost worktree the user just dismissed via the failure modal.
    where: {
      projectId: id,
      status: 'open',
      deletedAt: null,
      worktreePath: { not: '_pending_' },
    },
    select: {
      id: true,
      name: true,
      branchName: true,
      portBase: true,
      createdAt: true,
      updatedAt: true,
      sessions: {
        where: { status: 'open', deletedAt: null },
        select: { id: true, name: true, createdAt: true, updatedAt: true },
        orderBy: { createdAt: 'asc' },
      },
    },
    orderBy: { createdAt: 'asc' },
  })

  return NextResponse.json({ worktrees })
}

// POST — create a new worktree (and provision its branch + working dir).
//
// Body: {
//   id?: string         ← optional client-minted cuid. When provided the
//                         endpoint becomes idempotent: re-POSTing the same
//                         id returns the existing worktree, lets the client
//                         retry safely after a transient failure without
//                         duplicating state.
//   sessionId?: string  ← optional client-minted id for the auto-created
//                         first chat inside the worktree. Same idempotency
//                         contract.
//   name?: string       ← display-name override; otherwise we auto-generate
//                         a city codename like "Kampala v1".
// }
//
// All Prisma writes go through withRetry so transient pool-level errors
// (DatabaseNotReachable / SocketTimeout / ConnectionClosed) get one or
// two backoff retries before surfacing as 500. Most real-world flakiness
// vanishes on the first retry.
//
// Failure modes:
//   - provisionWorktree returns null  → 500 (placeholder lingers; the
//     orphan-cleanup sweep removes it after 5 min if no resume).
//   - any unhandled throw             → 500 (placeholder lingers, same).
// Idempotent retry from the client picks up where we left off.
export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) return NextResponse.json({ error: access.error }, { status: access.status })

  let body: { id?: string; sessionId?: string; name?: string } = {}
  try { body = await request.json() } catch { /* empty body is fine */ }

  const tStart = Date.now()
  console.log(`[wt-route] POST start projectId=${id.slice(0, 12)} preMintedId=${body.id?.slice(0, 12) ?? '(none)'}`)

  // Idempotent fast-path: if the client already finished a successful
  // creation under this id and is just retrying after a network hiccup,
  // return the existing worktree + its first session unchanged.
  if (body.id) {
    const existing = await withRetry(
      () => prisma.worktree.findUnique({
        where: { id: body.id },
        select: {
          id: true, projectId: true, name: true, branchName: true,
          portBase: true, createdAt: true, worktreePath: true,
          sessions: {
            where: { status: 'open', deletedAt: null },
            orderBy: { createdAt: 'asc' },
            take: 1,
            select: { id: true, name: true, worktreeId: true, createdAt: true },
          },
        },
      }),
      { tag: 'worktree-idempotent-lookup' },
    )
    if (existing && existing.projectId === id && existing.worktreePath !== '_pending_') {
      const session = existing.sessions[0]
      const { sessions: _omit, projectId: _omit2, worktreePath: _omit3, ...worktree } = existing
      void _omit; void _omit2; void _omit3
      console.log(`[wt-route] IDEMPOTENT HIT id=${body.id.slice(0, 12)} ms=${Date.now() - tStart}`)
      return NextResponse.json({ worktree, session }, { status: 200 })
    }
    if (existing && existing.worktreePath === '_pending_') {
      console.log(`[wt-route] IDEMPOTENT RESUME id=${body.id.slice(0, 12)} (placeholder exists, will continue provisioning)`)
    }
  }

  // Generate a fresh codename (or honor the user-provided name as the display).
  const codename = await withRetry(
    () => generateWorktreeCodename(id),
    { tag: 'codename-gen' },
  )
  const displayName = body.name?.trim() || codename.name

  // Upsert the placeholder so a client retry with the same id resumes
  // rather than colliding on the unique key. Concurrent POSTs without a
  // pre-minted id still get distinct rows because Prisma generates the
  // primary key at insert time.
  const placeholderId = body.id
  const placeholder = await withRetry(
    () => placeholderId
      ? prisma.worktree.upsert({
          where: { id: placeholderId },
          create: {
            id: placeholderId,
            projectId: id,
            userId: access.userId,
            name: displayName,
            branchName: codename.branchName,
            worktreePath: '_pending_',
            baseCommit: '_pending_',
          },
          update: {}, // don't clobber an in-progress row
          select: { id: true, branchName: true, worktreePath: true, baseCommit: true, portBase: true },
        })
      : prisma.worktree.create({
          data: {
            projectId: id,
            userId: access.userId,
            name: displayName,
            branchName: codename.branchName,
            worktreePath: '_pending_',
            baseCommit: '_pending_',
          },
          select: { id: true, branchName: true, worktreePath: true, baseCommit: true, portBase: true },
        }),
    { tag: 'placeholder-upsert' },
  )

  // Provision (or resume): if the worktree already has a real path the
  // disk side is done — just trust the existing values. Otherwise run
  // provisionWorktree which is itself idempotent on the directory.
  let worktreePath: string
  let baseCommit: string
  let portBase: number
  if (placeholder.worktreePath !== '_pending_' && placeholder.portBase !== null) {
    worktreePath = placeholder.worktreePath
    baseCommit = placeholder.baseCommit
    portBase = placeholder.portBase
  } else {
    const info = await provisionWorktree(id, placeholder.id, placeholder.branchName, access.userId)
    if (!info) {
      // Delete the placeholder row right away rather than waiting for
      // the orphan sweep — keeping it around just confuses the user
      // (it leaks back into the sidebar on next page load even after
      // they dismissed the modal). A client retry pre-mints a fresh
      // cuid and creates a new placeholder, so resumption from this
      // exact placeholder isn't part of our flow today.
      try {
        await prisma.worktree.delete({ where: { id: placeholder.id } })
      } catch (err) {
        console.warn(`[wt-route] cleanup of failed placeholder threw id=${placeholder.id.slice(0, 12)}: ${(err as Error).message}`)
      }
      console.warn(`[wt-route] provisionWorktree returned null id=${placeholder.id.slice(0, 12)} branch=${placeholder.branchName} ms=${Date.now() - tStart} (placeholder removed)`)
      return NextResponse.json({ error: 'Failed to create worktree on sandbox' }, { status: 500 })
    }
    worktreePath = info.worktreePath
    baseCommit = info.baseCommit
    portBase = info.portBase
  }

  // Update with the real provisioning data. update() is naturally
  // idempotent — second pass writes the same values.
  const worktree = await withRetry(
    () => prisma.worktree.update({
      where: { id: placeholder.id },
      data: { worktreePath, baseCommit, portBase },
      select: {
        id: true,
        name: true,
        branchName: true,
        portBase: true,
        createdAt: true,
      },
    }),
    { tag: 'worktree-finalize' },
  )

  // Auto-create the first chat. If a sessionId was pre-minted (and may
  // already exist from an earlier attempt) use upsert so retry doesn't
  // double-create. Otherwise create normally.
  const sessionId = body.sessionId
  const session = await withRetry(
    () => sessionId
      ? prisma.chatSession.upsert({
          where: { id: sessionId },
          create: {
            id: sessionId,
            projectId: id,
            userId: access.userId,
            name: 'New Chat',
            worktreeId: worktree.id,
          },
          update: {},
          select: { id: true, name: true, worktreeId: true, createdAt: true },
        })
      : prisma.chatSession.create({
          data: {
            projectId: id,
            userId: access.userId,
            name: 'New Chat',
            worktreeId: worktree.id,
          },
          select: { id: true, name: true, worktreeId: true, createdAt: true },
        }),
    { tag: 'session-create' },
  )

  console.log(`[wt-route] DONE id=${worktree.id.slice(0, 12)} branch=${worktree.branchName} sessionId=${session.id.slice(0, 12)} ms=${Date.now() - tStart}`)
  return NextResponse.json({ worktree, session }, { status: 201 })
}
