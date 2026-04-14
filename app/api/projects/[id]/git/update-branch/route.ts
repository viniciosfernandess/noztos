import { NextRequest, NextResponse } from 'next/server'
import { verifyProjectAccess } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { loadProjectGitContext, rebaseOntoMain, resolveWorkingDir } from '@/lib/git'

interface RouteContext { params: Promise<{ id: string }> }

// POST — fetch origin/main and rebase the current branch onto it. Used by
// the "Update branch" action when the branch is behind main or GitHub
// blocks the merge for being out of date. Returns conflict=true when the
// rebase can't complete so the UI can prompt the user to resolve manually.
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
  if (!worktreeId) return NextResponse.json({ error: 'worktreeId required' }, { status: 400 })

  const cwd = await resolveWorkingDir(id, worktreeId)
  if (!cwd) return NextResponse.json({ error: 'Unknown worktree' }, { status: 400 })

  const ctx = await loadProjectGitContext(id)
  if (!ctx) return NextResponse.json({ error: 'No repository / sandbox unavailable' }, { status: 503 })

  const r = await rebaseOntoMain(ctx.sandboxId, cwd, ctx.githubToken, ctx.githubOwner, ctx.githubRepo)
  if (!r.ok) {
    return NextResponse.json({ error: r.error ?? 'rebase failed', conflict: !!r.conflict }, { status: 409 })
  }
  return NextResponse.json({ ok: true })
}
