import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'
import { invalidateWorktreeCache } from '@/lib/tools'

interface RouteContext {
  params: Promise<{ id: string; worktreeId: string }>
}

// POST — "delete forever" from the user's perspective: unlinks the worktree
// (and its chats) from every UI surface. Nothing is physically destroyed:
//
//   - DB rows stay intact (dataset for ML training + audit trail)
//   - Branch + .bornastar-worktrees/<id> directory on disk stay intact
//     so if an admin ever restores we can bring back the full state
//   - Ports release so the range can be reused by new worktrees
//
// Hard cleanup (git worktree remove + branch -D) is a separate admin
// responsibility — not exposed via the user-facing UI.
export async function POST(_request: NextRequest, context: RouteContext) {
  const { id, worktreeId } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) {
    return NextResponse.json({ error: access.error }, { status: access.status })
  }

  const wt = await prisma.worktree.findUnique({
    where: { id: worktreeId },
    select: { projectId: true },
  })
  if (!wt || wt.projectId !== id) {
    return NextResponse.json({ error: 'Worktree not found' }, { status: 404 })
  }

  const sessionIds = (await prisma.chatSession.findMany({
    where: { worktreeId },
    select: { id: true },
  })).map((s) => s.id)

  // Flip every chat + its messages to 'deleted' with the same timestamp
  // so every query layer agrees "this worktree is gone". Stamping both
  // `status` and `deletedAt` keeps text-based and null-based checks
  // consistent across the codebase.
  const now = new Date()
  await prisma.$transaction([
    prisma.chatMessage.updateMany({
      where: { sessionId: { in: sessionIds }, deletedAt: null },
      data: { deletedAt: now },
    }),
    prisma.chatSession.updateMany({
      where: { worktreeId },
      data: { status: 'deleted', deletedAt: now },
    }),
    prisma.worktree.update({
      where: { id: worktreeId },
      data: {
        status: 'deleted',
        deletedAt: now,
        // Release the port slot so new worktrees can reuse it; keep
        // branchName + worktreePath for admin restore.
        portBase: null,
      },
    }),
  ])

  // Drop the in-process resolver cache for every chat that lived in this worktree
  for (const sid of sessionIds) invalidateWorktreeCache(sid)

  return NextResponse.json({ success: true })
}
