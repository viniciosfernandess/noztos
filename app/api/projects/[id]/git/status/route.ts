import { NextRequest, NextResponse } from 'next/server'
import { verifyProjectAccess } from '@/lib/auth'
import { prisma } from '@/lib/db'
import {
  aheadBehind,
  currentBranch,
  findPullRequestForBranch,
  getBranchProtection,
  loadProjectGitContext,
  resolveWorkingDir,
  uncommittedCount,
} from '@/lib/git'

interface RouteContext { params: Promise<{ id: string }> }

// GET — single endpoint used by the Checks panel polling loop. Rolls
// together every piece of state the UI wants (uncommitted count, ahead /
// behind vs main, current PR + derived status, main protection) so the
// frontend doesn't have to orchestrate N requests.
//
// Query params:
//   ?worktree=ID  — target worktree (omit for main chat).
//   ?session=ID   — alternative: resolve worktree through the session.
export async function GET(request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const auth = await verifyProjectAccess(id)
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const worktreeIdParam = request.nextUrl.searchParams.get('worktree')
  const sessionIdParam = request.nextUrl.searchParams.get('session')

  // Resolve worktreeId from session if only session was passed.
  let worktreeId: string | null = worktreeIdParam
  if (!worktreeId && sessionIdParam) {
    const session = await prisma.chatSession.findUnique({
      where: { id: sessionIdParam },
      select: { projectId: true, worktreeId: true },
    })
    if (session && session.projectId === id) worktreeId = session.worktreeId
  }

  const cwd = await resolveWorkingDir(id, worktreeId)
  if (!cwd) return NextResponse.json({ error: 'Unknown worktree' }, { status: 400 })

  const ctx = await loadProjectGitContext(id)
  if (!ctx) return NextResponse.json({ error: 'No repository / sandbox unavailable' }, { status: 503 })

  // Kick off independent probes in parallel.
  const [uncommitted, ab, branch, protection] = await Promise.all([
    uncommittedCount(ctx.sandboxId, cwd).catch(() => 0),
    aheadBehind(ctx.sandboxId, cwd).catch(() => ({ ahead: 0, behind: 0 })),
    currentBranch(ctx.sandboxId, cwd).catch(() => ''),
    getBranchProtection(ctx.githubOwner, ctx.githubRepo, 'main', ctx.githubToken),
  ])

  // PR lookup depends on the branch, so chain after.
  let pr = null
  if (branch && branch !== 'main' && branch !== 'HEAD') {
    pr = await findPullRequestForBranch(ctx.githubOwner, ctx.githubRepo, branch, ctx.githubToken).catch(() => null)
  }

  return NextResponse.json({
    branch,
    uncommitted,
    commitsAhead: ab.ahead,
    commitsBehind: ab.behind,
    mainProtected: protection.protected,
    mainProtectionChecked: protection.checkedAt,
    pr,
    githubConnected: !!ctx.githubToken,
  })
}
