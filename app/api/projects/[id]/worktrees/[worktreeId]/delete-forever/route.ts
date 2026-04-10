import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'
import { removeWorktreePhysical } from '@/lib/worktree'
import { invalidateWorktreeCache } from '@/lib/tools'

interface RouteContext {
  params: Promise<{ id: string; worktreeId: string }>
}

// POST — permanently delete a worktree (soft-delete in DB, hard-remove on disk).
//
// The Worktree row stays for analytics. The on-disk worktree directory is
// removed and the reserved port range is released. Any chats that were
// inside this worktree are also marked as deleted.
export async function POST(_request: NextRequest, context: RouteContext) {
  const { id, worktreeId } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) {
    return NextResponse.json({ error: access.error }, { status: access.status })
  }

  const wt = await prisma.worktree.findUnique({
    where: { id: worktreeId },
    select: { projectId: true, branchName: true, worktreePath: true },
  })
  if (!wt || wt.projectId !== id) {
    return NextResponse.json({ error: 'Worktree not found' }, { status: 404 })
  }

  // Tear down the on-disk worktree (fire and forget). We snapshot the
  // branchName + worktreePath here because the row update below clears them.
  removeWorktreePhysical(id, wt.branchName, wt.worktreePath)
    .catch((err) => console.error('[delete-forever] worktree cleanup error:', err))

  // Mark sessions inside this worktree as deleted, then mark the worktree
  const sessionIds = (await prisma.chatSession.findMany({
    where: { worktreeId },
    select: { id: true },
  })).map((s) => s.id)

  await prisma.chatSession.updateMany({
    where: { worktreeId },
    data: { status: 'deleted' },
  })

  await prisma.worktree.update({
    where: { id: worktreeId },
    data: {
      status: 'deleted',
      worktreePath: '',
      branchName: '',
      portBase: null,
    },
  })

  // Drop the in-process resolver cache for every chat that lived in this worktree
  for (const sid of sessionIds) invalidateWorktreeCache(sid)

  return NextResponse.json({ success: true })
}
