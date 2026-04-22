import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'
import { getWorktreeDiffStats } from '@/lib/worktree'

interface RouteContext {
  params: Promise<{ id: string }>
}

// GET — diff stats for ALL open worktrees in a project, in one round trip.
// Returns { [worktreeId]: { added, removed, files } }.
export async function GET(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) {
    return NextResponse.json({ error: access.error }, { status: access.status })
  }

  const worktrees = await prisma.worktree.findMany({
    where: { projectId: id, status: 'open', deletedAt: null },
    select: { id: true },
  })

  const results = await Promise.all(
    worktrees.map(async (w) => {
      const stats = await getWorktreeDiffStats(id, w.id)
      return [w.id, stats ?? { added: 0, removed: 0, files: 0 }] as const
    })
  )

  return NextResponse.json(Object.fromEntries(results))
}
