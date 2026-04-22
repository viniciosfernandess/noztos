import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'

interface RouteContext {
  params: Promise<{ id: string; worktreeId: string }>
}

// POST — archive a worktree and every chat inside it.
//
// Archive preserves the full state as-is: uncommitted changes, staged
// files, the PR the user opened, the current branch HEAD. Nothing is
// touched on disk. Restoring later brings the worktree back exactly as
// it was — yellow indicator, changes list, PR status, everything.
//
// Any dirty-state confirmation the UI wants to show belongs in the
// client; the server always accepts and preserves.
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

  // Archive the worktree and take every chat inside with it. Individually-
  // archived chats stay in 'archived' — restoring the worktree later will
  // restore them all together (see /restore route).
  await prisma.worktree.update({
    where: { id: worktreeId },
    data: { status: 'archived' },
  })
  await prisma.chatSession.updateMany({
    where: { worktreeId, status: 'open' },
    data: { status: 'archived' },
  })

  return NextResponse.json({ success: true })
}
