import { NextRequest, NextResponse } from 'next/server'
import { verifyProjectAccess } from '@/lib/auth'
import { prisma } from '@/lib/db'
import {
  commitAll,
  createPullRequest,
  ensureGitIdentity,
  findPullRequestForBranch,
  loadProjectGitContext,
  pushCurrent,
  resolveWorkingDir,
  uncommittedCount,
} from '@/lib/git'

interface RouteContext { params: Promise<{ id: string; worktreeId: string }> }

// GET — fetch the current PR state for this worktree's branch (latest PR
// touching that head ref). Used by the Checks panel polling loop.
export async function GET(_request: NextRequest, context: RouteContext) {
  const { id, worktreeId } = await context.params
  const auth = await verifyProjectAccess(id)
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const wt = await prisma.worktree.findUnique({
    where: { id: worktreeId },
    select: { projectId: true, branchName: true },
  })
  if (!wt || wt.projectId !== id) return NextResponse.json({ error: 'worktree not found' }, { status: 404 })

  const ctx = await loadProjectGitContext(id)
  if (!ctx) return NextResponse.json({ error: 'No repository' }, { status: 503 })

  const pr = await findPullRequestForBranch(ctx.githubOwner, ctx.githubRepo, wt.branchName, ctx.githubToken)
  return NextResponse.json({ pr })
}

// POST — create a new PR from this worktree's branch into main. Body:
//   { title: string; body?: string; draft?: boolean; base?: string }
export async function POST(request: NextRequest, context: RouteContext) {
  const { id, worktreeId } = await context.params
  const auth = await verifyProjectAccess(id)
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const wt = await prisma.worktree.findUnique({
    where: { id: worktreeId },
    select: { projectId: true, branchName: true },
  })
  if (!wt || wt.projectId !== id) return NextResponse.json({ error: 'worktree not found' }, { status: 404 })

  let body: {
    title?: string
    body?: string
    draft?: boolean
    base?: string
    // If the working tree has uncommitted edits when the user asks for a
    // PR, we pack them into a single commit and push before opening the
    // PR — matching Conductor's "one button" feel. Caller opts in; default
    // is false so the endpoint stays explicit.
    autoCommit?: boolean
    commitMessage?: string
  } = {}
  try { body = await request.json() } catch {}
  if (!body.title?.trim()) return NextResponse.json({ error: 'title required' }, { status: 400 })

  const ctx = await loadProjectGitContext(id)
  if (!ctx) return NextResponse.json({ error: 'No repository' }, { status: 503 })
  if (!ctx.githubToken) return NextResponse.json({ error: 'GitHub not connected', code: 'no_auth' }, { status: 401 })

  // Phase 1 — auto-commit + push when requested. Any failure here aborts
  // before we touch GitHub, so we never end up with a PR pointing at a
  // stale branch.
  if (body.autoCommit) {
    const cwd = await resolveWorkingDir(id, worktreeId)
    if (!cwd) return NextResponse.json({ error: 'Unknown worktree' }, { status: 400 })

    const dirty = await uncommittedCount(ctx.sandboxId, cwd)
    if (dirty > 0) {
      const user = await prisma.user.findUnique({
        where: { id: auth.userId },
        select: { email: true, name: true },
      })
      await ensureGitIdentity(ctx.sandboxId, cwd, user?.email ?? undefined, user?.name ?? undefined)
      try {
        await commitAll(ctx.sandboxId, cwd, body.commitMessage?.trim() || body.title.trim(), 'Bornastar Agent <noreply@bornastar.app>')
      } catch (e) {
        return NextResponse.json({ error: e instanceof Error ? e.message : 'commit failed' }, { status: 500 })
      }
    }

    // Push whatever's on the branch — idempotent, safe even if nothing new.
    const push = await pushCurrent(ctx.sandboxId, cwd, ctx.githubToken, ctx.githubOwner, ctx.githubRepo)
    if (!push.ok) {
      return NextResponse.json({ error: push.error ?? 'push failed', code: push.error === 'protected' ? 'protected' : 'push_failed' }, { status: 400 })
    }
  }

  // Phase 2 — open the actual PR.
  const res = await createPullRequest(ctx.githubOwner, ctx.githubRepo, ctx.githubToken, {
    title: body.title.trim(),
    body: body.body ?? '',
    head: wt.branchName,
    base: body.base?.trim() || 'main',
    draft: !!body.draft,
  })
  if (!res.ok) return NextResponse.json({ error: res.error, status: res.status }, { status: res.status >= 400 ? res.status : 500 })

  return NextResponse.json({ pr: res.pr }, { status: 201 })
}
