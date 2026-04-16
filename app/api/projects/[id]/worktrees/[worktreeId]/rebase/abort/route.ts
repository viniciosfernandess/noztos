import { NextRequest, NextResponse } from 'next/server'
import { verifyProjectAccess } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { loadProjectGitContext, runGit } from '@/lib/git'

interface RouteContext { params: Promise<{ id: string; worktreeId: string }> }

// POST — bail out of an in-progress rebase. Working tree returns to
// the pre-rebase state; the conflict at the GitHub level still exists,
// so the top bar keeps showing the Conflicts banner until the user
// either tries again or updates main.
export async function POST(_request: NextRequest, context: RouteContext) {
  const { id, worktreeId } = await context.params
  const auth = await verifyProjectAccess(id)
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const wt = await prisma.worktree.findUnique({
    where: { id: worktreeId },
    select: { projectId: true, worktreePath: true },
  })
  if (!wt || wt.projectId !== id || !wt.worktreePath) {
    return NextResponse.json({ error: 'worktree not found' }, { status: 404 })
  }

  const ctx = await loadProjectGitContext(id)
  if (!ctx) return NextResponse.json({ error: 'No sandbox' }, { status: 503 })

  const r = await runGit(ctx.sandboxId, wt.worktreePath, `rebase --abort`)
  if ((r.exitCode ?? 0) !== 0) {
    return NextResponse.json({ error: r.stderr || r.stdout || 'abort failed' }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
