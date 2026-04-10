import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'
import { getWorktreeDiffStats } from '@/lib/worktree'

interface RouteContext {
  params: Promise<{ id: string; worktreeId: string }>
}

// POST — move a worktree to trash. Refuses on pending changes (409).
// Trashed worktrees keep their on-disk state for 7 days, then a cleanup
// worker promotes them to "deleted" and tears down the physical worktree.
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

  const stats = await getWorktreeDiffStats(id, worktreeId)
  if (stats && (stats.added > 0 || stats.removed > 0)) {
    return NextResponse.json(
      { error: 'has_pending_changes', stats },
      { status: 409 },
    )
  }

  await prisma.worktree.update({
    where: { id: worktreeId },
    data: { status: 'trashed', trashedAt: new Date() },
  })

  return NextResponse.json({ success: true })
}
