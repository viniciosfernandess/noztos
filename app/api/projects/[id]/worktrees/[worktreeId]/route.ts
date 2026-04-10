import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'

interface RouteContext {
  params: Promise<{ id: string; worktreeId: string }>
}

// PATCH — rename a worktree.
export async function PATCH(request: NextRequest, context: RouteContext) {
  const { id, worktreeId } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) return NextResponse.json({ error: access.error }, { status: access.status })

  const body = await request.json() as { name?: string }
  const data: { name?: string } = {}
  if (body.name) data.name = body.name.trim()

  const worktree = await prisma.worktree.update({
    where: { id: worktreeId },
    data,
    select: { id: true, name: true, status: true },
  })

  return NextResponse.json(worktree)
}
