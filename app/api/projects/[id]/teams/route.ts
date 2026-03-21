import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function GET(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) {
    return NextResponse.json({ error: access.error }, { status: access.status })
  }

  const teams = await prisma.team.findMany({
    where: { projectId: id },
    select: {
      id: true,
      name: true,
      collaboratorOrder: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
  })

  return NextResponse.json(teams)
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) {
    return NextResponse.json({ error: access.error }, { status: access.status })
  }

  let body: { name?: string; collaboratorIds?: string[] }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const name = body.name?.trim()
  if (!name) {
    return NextResponse.json({ error: 'Team name is required' }, { status: 400 })
  }

  const collaboratorIds = body.collaboratorIds ?? []

  // Validate that all collaborator IDs belong to this project
  if (collaboratorIds.length > 0) {
    const count = await prisma.collaborator.count({
      where: { id: { in: collaboratorIds }, projectId: id, isActive: true },
    })
    if (count !== collaboratorIds.length) {
      return NextResponse.json({ error: 'Invalid collaborator IDs' }, { status: 400 })
    }
  }

  const team = await prisma.team.create({
    data: {
      projectId: id,
      name,
      collaboratorOrder: { collaboratorIds },
    },
    select: { id: true, name: true, collaboratorOrder: true },
  })

  return NextResponse.json(team, { status: 201 })
}
