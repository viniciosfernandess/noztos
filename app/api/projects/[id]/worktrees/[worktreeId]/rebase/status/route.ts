import { NextRequest, NextResponse } from 'next/server'
import { verifyProjectAccess } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { loadProjectGitContext, runGit } from '@/lib/git'

interface RouteContext { params: Promise<{ id: string; worktreeId: string }> }

// GET — snapshot of the current rebase state. Returns:
//   { active: boolean; files: string[] }
// where `files` lists paths still containing unresolved conflict
// markers (detected via `git diff --diff-filter=U`). Used to refresh
// the conflict resolver UI after the user saves a file locally.
export async function GET(_request: NextRequest, context: RouteContext) {
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

  // .git/rebase-merge or rebase-apply dir indicates rebase is paused.
  const check = await runGit(ctx.sandboxId, wt.worktreePath,
    `rev-parse --git-path rebase-merge rebase-apply 2>/dev/null`)
  const paths = check.stdout.split('\n').map((l) => l.trim()).filter(Boolean)

  // Use shell test to confirm at least one exists.
  const existCheck = await runGit(ctx.sandboxId, wt.worktreePath,
    `rev-parse --git-dir`)
  void existCheck

  const active = paths.length > 0

  const diffRes = await runGit(ctx.sandboxId, wt.worktreePath, `diff --name-only --diff-filter=U`)
  const files = diffRes.stdout.split('\n').map((l) => l.trim()).filter(Boolean)

  return NextResponse.json({ active: active || files.length > 0, files })
}
