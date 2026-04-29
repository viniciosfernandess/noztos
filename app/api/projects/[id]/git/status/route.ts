import { NextRequest, NextResponse } from 'next/server'
import { verifyProjectAccess } from '@/lib/auth'
import { prisma } from '@/lib/db'
import {
  aheadBehind,
  currentBranch,
  findPullRequestForBranch,
  getBranchProtection,
  getCiStatusForRef,
  loadProjectGitContext,
  resolveWorkingDir,
  uncommittedCount,
} from '@/lib/git'

interface RouteContext { params: Promise<{ id: string }> }

// GET — git status snapshot for a worktree (or the main chat working dir).
// Rolls together what the UI wants in one round-trip: local probe (branch,
// uncommitted, ahead/behind) + remote probe (GitHub PR / CI / main branch
// protection).
//
// Query params:
//   ?worktree=ID    — target worktree (omit for main chat).
//   ?session=ID     — alternative: resolve worktree through the session.
//   ?localOnly=true — skip the GitHub round-trips and return only the local
//                     git fields. Used by fs-change-driven refreshes so the
//                     yellow badge / "Commit and push" / "Create PR" buttons
//                     react in ~150ms after an edit instead of waiting for
//                     the next 15-30s polling cycle. The remote fields
//                     (`pr`, `ciStatus`, `mainProtected*`) are *omitted*
//                     from the response so the client can merge into its
//                     existing state without clobbering the last known
//                     GitHub-side values.
export async function GET(request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const auth = await verifyProjectAccess(id)
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const worktreeIdParam = request.nextUrl.searchParams.get('worktree')
  const sessionIdParam = request.nextUrl.searchParams.get('session')
  const localOnly = request.nextUrl.searchParams.get('localOnly') === 'true'

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

  // Local probes — always run, in parallel. ~50ms total on a normal repo.
  const [uncommitted, ab, branch] = await Promise.all([
    uncommittedCount(ctx.sandboxId, cwd).catch(() => 0),
    aheadBehind(ctx.sandboxId, cwd).catch(() => ({ ahead: 0, behind: 0 })),
    currentBranch(ctx.sandboxId, cwd).catch(() => ''),
  ])

  // Local-only fast path: skip the GitHub fan-out (branch protection, PR
  // lookup, CI status). Returns just the fields the client wants merged
  // into its existing snapshot. Total latency ~50ms.
  if (localOnly) {
    return NextResponse.json({
      branch,
      uncommitted,
      commitsAhead: ab.ahead,
      commitsBehind: ab.behind,
    })
  }

  // Remote probes — branch protection runs alongside the local probes
  // when we're doing the full fetch.
  const protection = await getBranchProtection(ctx.githubOwner, ctx.githubRepo, 'main', ctx.githubToken)

  // PR lookup depends on the branch, so chain after.
  let pr = null
  let ciStatus: 'passing' | 'pending' | 'failing' | null = null
  if (branch && branch !== 'main' && branch !== 'HEAD') {
    pr = await findPullRequestForBranch(ctx.githubOwner, ctx.githubRepo, branch, ctx.githubToken).catch(() => null)
    // Only query CI when there's a live PR — no point polling check
    // runs for a branch that doesn't exist on GitHub yet.
    if (pr) {
      ciStatus = await getCiStatusForRef(ctx.githubOwner, ctx.githubRepo, branch, ctx.githubToken)
    }
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
    isLocalProject: !ctx.githubOwner,
    ciStatus,
  })
}
