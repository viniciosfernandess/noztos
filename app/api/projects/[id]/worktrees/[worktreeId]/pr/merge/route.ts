import { NextRequest, NextResponse } from 'next/server'
import { verifyProjectAccess } from '@/lib/auth'
import { prisma } from '@/lib/db'
import {
  deleteRemoteBranch,
  findPullRequestForBranch,
  loadProjectGitContext,
  mergePullRequest,
} from '@/lib/git'

interface RouteContext { params: Promise<{ id: string; worktreeId: string }> }

// POST — merge the PR associated with this worktree's branch. Body:
//   { method?: 'merge'|'squash'|'rebase'; deleteBranch?: boolean }
//
// We look up the PR number server-side so the client just hits this with
// the worktree id and doesn't need to track the PR state separately.
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
