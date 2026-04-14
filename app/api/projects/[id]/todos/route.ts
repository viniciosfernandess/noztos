import { NextRequest, NextResponse } from 'next/server'
import { verifyProjectAccess } from '@/lib/auth'
import { prisma } from '@/lib/db'

interface RouteContext { params: Promise<{ id: string }> }

// GET — list todos scoped to the active chat context. Exactly one of
// ?worktree=ID or ?session=ID should be set. Main chats scope by session;
// worktree chats scope by the worktree (shared across its chats).
export async function GET(request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const auth = await verifyProjectAccess(id)
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const worktreeId = request.nextUrl.searchParams.get('worktree')
  const sessionId = request.nextUrl.searchParams.get('session')
  if (!worktreeId && !sessionId) return NextResponse.json({ todos: [] })

  // Scope check — make sure the caller actually owns that worktree/session
  if (worktreeId) {
    const wt = await prisma.worktree.findUnique({ where: { id: worktreeId }, select: { projectId: true } })
    if (!wt || wt.projectId !== id) return NextResponse.json({ error: 'not found' }, { status: 404 })
  } else if (sessionId) {
    const s = await prisma.chatSession.findUnique({ where: { id: sessionId }, select: { projectId: true } })
    if (!s || s.projectId !== id) return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  const todos = await prisma.todo.findMany({
    where: worktreeId ? { worktreeId } : { sessionId: sessionId ?? undefined },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    select: { id: true, content: true, done: true, position: true, createdAt: true },
  })
  return NextResponse.json({ todos })
}

// POST — create a new todo. Body: { content: string; worktreeId? | sessionId? }
export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const auth = await verifyProjectAccess(id)
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  let body: { content?: string; worktreeId?: string | null; sessionId?: string | null } = {}
  try { body = await request.json() } catch {}
  const content = body.content?.trim()
  if (!content) return NextResponse.json({ error: 'content required' }, { status: 400 })

  // Resolve scope and guard — don't let someone attach a todo to a worktree
  // or session they don't own.
  if (body.worktreeId) {
    const wt = await prisma.worktree.findUnique({ where: { id: body.worktreeId }, select: { projectId: true } })
    if (!wt || wt.projectId !== id) return NextResponse.json({ error: 'not found' }, { status: 404 })
  } else if (body.sessionId) {
    const s = await prisma.chatSession.findUnique({ where: { id: body.sessionId }, select: { projectId: true } })
    if (!s || s.projectId !== id) return NextResponse.json({ error: 'not found' }, { status: 404 })
  } else {
    return NextResponse.json({ error: 'scope required' }, { status: 400 })
  }

  try {
    // Next position = max existing + 1 so new items land at the end.
    const last = await prisma.todo.findFirst({
      where: body.worktreeId ? { worktreeId: body.worktreeId } : { sessionId: body.sessionId ?? undefined },
      orderBy: { position: 'desc' },
      select: { position: true },
    })
    const position = (last?.position ?? 0) + 1

    const todo = await prisma.todo.create({
      data: {
        content,
        worktreeId: body.worktreeId ?? null,
        sessionId: body.worktreeId ? null : (body.sessionId ?? null),
        position,
      },
      select: { id: true, content: true, done: true, position: true, createdAt: true },
    })
    return NextResponse.json(todo, { status: 201 })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown'
    console.error('[todos:POST]', msg, e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
