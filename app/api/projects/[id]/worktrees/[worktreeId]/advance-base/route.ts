import { NextRequest, NextResponse } from 'next/server'
import { verifyProjectAccess } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { loadProjectGitContext, runGit } from '@/lib/git'

interface RouteContext { params: Promise<{ id: string; worktreeId: string }> }

// POST — advance the worktree's diff baseline forward to the current
// origin/main tip. Called by the client after it detects the worktree's
// PR has just transitioned to merged.
//
// Effect: `git diff <baseCommit>` (the basis for the Changes panel and the
// Explorer's yellow-file flags) now compares against the post-merge state
// of main, so the merged files naturally drop out of the changes view —
// while any uncommitted/unrelated edits in the worktree continue to show.
//
// What it does NOT do:
//   • does not modify the worktree's working tree
//   • does not move HEAD or any branch
//   • does not run reset / pull / checkout
// Pure metadata operation: one DB row update + one `git fetch` to refresh
// the local origin/main ref so the new SHA is resolvable.
//
// Idempotent: if origin/main is already at the cached baseCommit (no merge
// happened, or another caller already advanced), returns advanced=false
// and skips the DB write.
export async function POST(_request: NextRequest, context: RouteContext) {
  const { id, worktreeId } = await context.params
  const auth = await verifyProjectAccess(id)
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const wt = await prisma.worktree.findUnique({
    where: { id: worktreeId },
    select: { projectId: true, worktreePath: true, baseCommit: true },
  })
  if (!wt || wt.projectId !== id || !wt.worktreePath) {
    return NextResponse.json({ error: 'worktree not found' }, { status: 404 })
  }

  const ctx = await loadProjectGitContext(id)
  if (!ctx) return NextResponse.json({ error: 'No project context' }, { status: 503 })

  // Auth'd fetch so private repos work. Sync the local origin/main ref to
  // the remote tip before reading its SHA — without this, `rev-parse
  // origin/main` would still return the pre-merge commit.
  const remote = ctx.githubToken
    ? `https://${ctx.githubToken}@github.com/${ctx.githubOwner}/${ctx.githubRepo}.git`
    : `https://github.com/${ctx.githubOwner}/${ctx.githubRepo}.git`
  const fetchRes = await runGit(ctx.sandboxId, wt.worktreePath, `fetch ${remote} main:refs/remotes/origin/main`)
  if ((fetchRes.exitCode ?? 0) !== 0) {
    return NextResponse.json({ error: 'fetch failed' }, { status: 502 })
  }

  const sha = await runGit(ctx.sandboxId, wt.worktreePath, `rev-parse origin/main`)
  const newSha = sha.stdout.trim()
  if (!newSha) {
    return NextResponse.json({ error: 'failed to resolve origin/main' }, { status: 500 })
  }

  if (newSha === wt.baseCommit) {
    return NextResponse.json({ advanced: false, baseCommit: newSha })
  }

  await prisma.worktree.update({
    where: { id: worktreeId },
    data: { baseCommit: newSha },
  })
  console.log(`[isolation] advance-base wt=${worktreeId.slice(0, 8)} ${wt.baseCommit?.slice(0, 8) ?? '-'}→${newSha.slice(0, 8)}`)
  return NextResponse.json({ advanced: true, previous: wt.baseCommit, baseCommit: newSha })
}
