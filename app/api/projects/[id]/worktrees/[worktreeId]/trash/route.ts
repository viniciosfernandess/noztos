import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'

interface RouteContext {
  params: Promise<{ id: string; worktreeId: string }>
}

// POST — move a worktree to trash along with every chat it owns.
//
// State is preserved: uncommitted/staged changes, the open PR, the branch
// HEAD, everything stays. The trash list GET endpoint promotes entries
// older than TRASH_TTL_DAYS to 'deleted' lazily; nothing is physically
// torn down. The UI is responsible for the "heads up, you have dirty
// changes" confirmation.
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

  // Group every chat inside into the worktree's trash bucket so they come
  // back together on restore. Previously-individually-trashed chats keep
  // their own trashedAt — the restore route pulls them back anyway.
  const trashedAt = new Date()
  await prisma.worktree.update({
    where: { id: worktreeId },
    data: { status: 'trashed', trashedAt },
  })
  await prisma.chatSession.updateMany({
    where: { worktreeId, status: 'open' },
    data: { status: 'trashed', trashedAt },
  })

  return NextResponse.json({ success: true })
}
