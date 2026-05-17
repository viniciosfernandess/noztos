// GET /api/cloud/materialize/[worktreeId]
//
// Called by the sandbox init script after E2B provisioning. Returns the
// full manifest needed to reconstruct the worktree bit-perfect:
//   - branch + commit pointers (so git reset --hard knows where to land)
//   - file list with (path, hash, mode)
//   - unpushed commits (so cloud history matches local history)
//
// The sandbox then fetches each blob by hash via /api/cloud/blob/[hash],
// writes files to /workspace, applies modes, and replays the unpushed
// commit patches with `git am`.
//
// Auth: sandbox bearer token. The token is scoped to one worktree, so
// the URL :worktreeId must match — otherwise 403 (defense against a
// token being reused for a different worktree).

import { NextRequest, NextResponse } from 'next/server'
import { verifySandboxAuth } from '@/lib/mirror/sandbox-auth'
import { prisma } from '@/lib/db'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ worktreeId: string }> },
) {
  const auth = await verifySandboxAuth(request)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { worktreeId } = await params
  if (worktreeId !== auth.worktreeId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const mirror = await prisma.worktreeMirror.findUnique({
    where: { worktreeId },
  })
  if (!mirror) {
    return NextResponse.json({ error: 'mirror not found' }, { status: 404 })
  }
  if (mirror.status !== 'ready') {
    return NextResponse.json(
      { error: `mirror not ready (status=${mirror.status})` },
      { status: 409 },
    )
  }

  const [files, unpushed] = await Promise.all([
    prisma.worktreeFileEntry.findMany({
      where: { worktreeId },
      select: { path: true, hash: true, mode: true, status: true },
      orderBy: { path: 'asc' },
    }),
    prisma.unpushedCommit.findMany({
      where: { worktreeId },
      select: {
        commitSha: true,
        parentSha: true,
        message: true,
        authorName: true,
        authorEmail: true,
        authorDate: true,
        orderIndex: true,
      },
      orderBy: { orderIndex: 'asc' },
    }),
  ])

  return NextResponse.json({
    branch: mirror.currentBranch,
    commit: mirror.currentCommitSha,
    treeRootHash: mirror.treeRootHash,
    files,
    unpushedCommits: unpushed,
  })
}
