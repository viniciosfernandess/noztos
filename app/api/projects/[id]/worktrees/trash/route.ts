import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'

interface RouteContext {
  params: Promise<{ id: string }>
}

const TRASH_TTL_DAYS = 7

// GET — list trashed worktrees that haven't expired yet (within 7 days).
export async function GET(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) {
    return NextResponse.json({ error: access.error }, { status: access.status })
  }

  const cutoff = new Date(Date.now() - TRASH_TTL_DAYS * 24 * 60 * 60 * 1000)

  const worktrees = await prisma.worktree.findMany({
    where: {
      projectId: id,
      status: 'trashed',
      trashedAt: { gte: cutoff },
    },
    select: { id: true, name: true, branchName: true, trashedAt: true, createdAt: true },
    orderBy: { trashedAt: 'desc' },
  })

  const enriched = worktrees.map((w) => {
    const expiresAt = w.trashedAt
      ? new Date(w.trashedAt.getTime() + TRASH_TTL_DAYS * 24 * 60 * 60 * 1000)
      : null
    const daysLeft = expiresAt
      ? Math.max(0, Math.ceil((expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000)))
      : 0
    return { ...w, expiresAt, daysLeft }
  })

  return NextResponse.json({ worktrees: enriched })
}
