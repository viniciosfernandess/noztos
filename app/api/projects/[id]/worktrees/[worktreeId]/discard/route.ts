import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'
import { discardWorktreeChanges } from '@/lib/worktree'

interface RouteContext {
  params: Promise<{ id: string; worktreeId: string }>
}

// POST — discard all changes in a worktree, resetting back to its baseCommit.
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

  const ok = await discardWorktreeChanges(id, worktreeId)
  if (!ok) {
    return NextResponse.json({ error: 'Failed to discard changes' }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
