import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'

interface RouteContext {
  params: Promise<{ id: string; worktreeId: string }>
}

// POST — restore an archived or trashed worktree back to the open list.
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
  if (wt.status !== 'archived' && wt.status !== 'trashed') {
    return NextResponse.json({ error: 'Cannot restore — worktree is not archived or trashed' }, { status: 400 })
  }

  await prisma.worktree.update({
    where: { id: worktreeId },
    data: { status: 'open', trashedAt: null },
  })

  return NextResponse.json({ success: true })
}
