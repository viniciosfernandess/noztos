import { NextRequest, NextResponse } from 'next/server'
import { verifyProjectAccess } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { loadProjectGitContext, pushCurrent, resolveWorkingDir } from '@/lib/git'

interface RouteContext { params: Promise<{ id: string }> }

// POST — push the current branch to origin with an auth'd URL built from the
// user's GitHub token. Returns a structured error so the client can branch
// on "protected branch" specifically and prompt the move-to-branch flow.
export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const auth = await verifyProjectAccess(id)
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  let body: { worktreeId?: string | null; sessionId?: string | null } = {}
  try { body = await request.json() } catch {}

  let worktreeId = body.worktreeId ?? null
  if (!worktreeId && body.sessionId) {
    const s = await prisma.chatSession.findUnique({
      where: { id: body.sessionId },
      select: { projectId: true, worktreeId: true },
    })
    if (s && s.projectId === id) worktreeId = s.worktreeId
  }

  const cwd = await resolveWorkingDir(id, worktreeId)
  if (!cwd) return NextResponse.json({ error: 'Unknown worktree' }, { status: 400 })

  const ctx = await loadProjectGitContext(id)
  if (!ctx) return NextResponse.json({ error: 'No repository / sandbox unavailable' }, { status: 503 })

  if (!ctx.githubToken) {
    return NextResponse.json({ error: 'GitHub not connected', code: 'no_auth' }, { status: 401 })
  }

  const r = await pushCurrent(ctx.sandboxId, cwd, ctx.githubToken, ctx.githubOwner, ctx.githubRepo)
  if (!r.ok) {
    const code = r.error === 'protected' ? 'protected' : 'push_failed'
    return NextResponse.json({ error: r.error ?? 'push failed', code }, { status: 400 })
  }
  return NextResponse.json({ ok: true })
}
