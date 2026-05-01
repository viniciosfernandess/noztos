import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'

interface RouteContext {
  params: Promise<{ id: string; worktreeId: string }>
}

// POST — restore an archived worktree back to the open list. The
// `deleted` state has no restore path on purpose: the on-disk worktree
// directory and the git branch were removed at delete time, so there is
// nothing to bring back besides the chat history (which stays in the DB
// for ML/audit but isn't re-attached to the user's UI).
export async function POST(_request: NextRequest, context: RouteContext) {
  const { id, worktreeId } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) {
    return NextResponse.json({ error: access.error }, { status: access.status })
  }

  const wt = await prisma.worktree.findUnique({
    where: { id: worktreeId },
    select: { projectId: true, status: true },
  })
  if (!wt || wt.projectId !== id) {
    return NextResponse.json({ error: 'Worktree not found' }, { status: 404 })
  }
  if (wt.status !== 'archived') {
    return NextResponse.json({ error: 'Cannot restore — worktree is not archived' }, { status: 400 })
  }

  // Cascading restore: bring back every chat this worktree owns, even
  // those that were individually archived before the worktree itself
  // was put away. The user's mental model is "the worktree plus its
  // chats move together" — when restoring the container, every chat
  // rides along.
  const [, sessRes] = await prisma.$transaction([
    prisma.worktree.update({
      where: { id: worktreeId },
      data: { status: 'open' },
    }),
    prisma.chatSession.updateMany({
      where: { worktreeId, status: 'archived' },
      data: { status: 'open' },
    }),
  ])
  console.log(`[wt-restore] worktreeId=${worktreeId.slice(0, 8)} sessions=${sessRes.count}`)

  return NextResponse.json({ success: true })
}
