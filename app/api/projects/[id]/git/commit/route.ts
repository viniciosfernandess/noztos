import { NextRequest, NextResponse } from 'next/server'
import { verifyProjectAccess } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { commitAll, ensureGitIdentity, loadProjectGitContext, resolveWorkingDir } from '@/lib/git'

interface RouteContext { params: Promise<{ id: string }> }

// POST — commit every pending change in the working tree of main or a
// worktree. Body: { message: string; worktreeId?: string; sessionId?: string }.
// Returns the resulting commit SHA (or null when there was nothing to
// commit, which we treat as a soft success).
export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const auth = await verifyProjectAccess(id)
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  let body: { message?: string; worktreeId?: string | null; sessionId?: string | null } = {}
  try { body = await request.json() } catch {}
  const message = body.message?.trim()
  if (!message) return NextResponse.json({ error: 'message required' }, { status: 400 })

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

  // Use the user's GitHub username/email when we have them, fall back to
  // generic identity. Branded co-author keeps the trail to Bornastar.
  const user = await prisma.user.findUnique({
    where: { id: auth.userId },
    select: { email: true, name: true },
  })
  await ensureGitIdentity(ctx.sandboxId, cwd, user?.email ?? undefined, user?.name ?? undefined)

  try {
    const sha = await commitAll(ctx.sandboxId, cwd, message, 'Noztos Agent <noreply@noztos.com>')
    // After a successful commit, clear the task-touched marker set on
    // this worktree so the "T" badges drop alongside the "U" badges in
    // the Changes list. Main-branch commits (worktreeId=null) have no
    // marker set to clear.
    if (sha && worktreeId) {
      await prisma.worktree.update({
        where: { id: worktreeId },
        data: { taskTouchedPaths: [] },
      }).catch((err) => {
        console.warn(`[git/commit] failed to clear taskTouchedPaths: ${(err as Error).message}`)
      })
    }
    return NextResponse.json({ ok: true, sha })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'commit failed' }, { status: 500 })
  }
}
