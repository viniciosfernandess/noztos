import { NextRequest, NextResponse } from 'next/server'
import { verifyProjectAccess } from '@/lib/auth'
import { prisma } from '@/lib/db'
import {
  deleteRemoteBranch,
  findPullRequestForBranch,
  loadProjectGitContext,
  mergePullRequest,
} from '@/lib/git'
import { cloudAwareCompute } from '@/lib/compute-router'

interface RouteContext { params: Promise<{ id: string; worktreeId: string }> }

// POST — merge the worktree's branch.
//
// Two paths:
//   GitHub project  → finds the open PR and merges it via the GitHub API.
//   Local project   → runs `git merge <branch>` directly on the local repo.
//
// Body: { method?: 'merge'|'squash'|'rebase'; deleteBranch?: boolean }
export async function POST(request: NextRequest, context: RouteContext) {
  const { id, worktreeId } = await context.params
  const auth = await verifyProjectAccess(id)
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const wt = await prisma.worktree.findUnique({
    where: { id: worktreeId },
    select: { projectId: true, branchName: true },
  })
  if (!wt || wt.projectId !== id) return NextResponse.json({ error: 'worktree not found' }, { status: 404 })

  let body: { method?: 'merge' | 'squash' | 'rebase'; deleteBranch?: boolean } = {}
  try { body = await request.json() } catch {}

  const ctx = await loadProjectGitContext(id)
  if (!ctx) return NextResponse.json({ error: 'No repository' }, { status: 503 })

  // ── Local project: no GitHub repo attached ────────────────────────────
  if (!ctx.githubOwner) {
    if (!wt.branchName) return NextResponse.json({ error: 'worktree has no branch' }, { status: 400 })
    // Merge target is the project root (main), which is always local —
    // cloudAwareCompute falls through to LocalProvider for non-worktree paths.
    const compute = cloudAwareCompute
    const mergeRes = await compute.exec(
      ctx.sandboxId,
      `cd ${ctx.sandboxId} && git merge ${wt.branchName} --no-ff -m "Merge branch '${wt.branchName}'" 2>&1`,
    )
    if (mergeRes.exitCode !== 0) {
      return NextResponse.json({ error: mergeRes.stderr || mergeRes.stdout || 'merge failed' }, { status: 500 })
    }
    return NextResponse.json({ ok: true, local: true })
  }

  // ── GitHub project: merge via GitHub API ──────────────────────────────
  if (!ctx.githubToken) return NextResponse.json({ error: 'GitHub not connected', code: 'no_auth' }, { status: 401 })

  const pr = await findPullRequestForBranch(ctx.githubOwner, ctx.githubRepo, wt.branchName, ctx.githubToken)
  if (!pr || pr.state !== 'open') {
    return NextResponse.json({ error: 'no open PR for this worktree' }, { status: 404 })
  }

  const merge = await mergePullRequest(ctx.githubOwner, ctx.githubRepo, ctx.githubToken, pr.number, body.method ?? 'merge')
  if (!merge.ok) return NextResponse.json({ error: merge.error ?? 'merge failed' }, { status: merge.status ?? 500 })

  if (body.deleteBranch) {
    await deleteRemoteBranch(ctx.githubOwner, ctx.githubRepo, ctx.githubToken, wt.branchName).catch(() => {})
  }

  return NextResponse.json({ ok: true })
}
