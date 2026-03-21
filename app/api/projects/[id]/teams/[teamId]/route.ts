import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'

interface RouteContext {
  params: Promise<{ id: string; teamId: string }>
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const { id, teamId } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) {
    return NextResponse.json({ error: access.error }, { status: access.status })
  }

  const existing = await prisma.team.findFirst({
    where: { id: teamId, projectId: id },
  })
  if (!existing) {
    return NextResponse.json({ error: 'Team not found' }, { status: 404 })
  }

  let body: { name?: string; collaboratorIds?: string[] }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const data: Record<string, unknown> = {}
  if (body.name?.trim()) data.name = body.name.trim()

  if (body.collaboratorIds) {
    // Validate collaborator IDs belong to project
    const count = await prisma.collaborator.count({
      where: { id: { in: body.collaboratorIds }, projectId: id, isActive: true },
    })
    if (count !== body.collaboratorIds.length) {
      return NextResponse.json({ error: 'Invalid collaborator IDs' }, { status: 400 })
    }
    data.collaboratorOrder = { collaboratorIds: body.collaboratorIds }
  }

  const updated = await prisma.team.update({
    where: { id: teamId },
    data,
    select: { id: true, name: true, collaboratorOrder: true },
  })

  return NextResponse.json(updated)
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
  const { id, teamId } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) {
    return NextResponse.json({ error: access.error }, { status: access.status })
  }

  const existing = await prisma.team.findFirst({
    where: { id: teamId, projectId: id },
  })
  if (!existing) {
    return NextResponse.json({ error: 'Team not found' }, { status: 404 })
  }

  await prisma.team.delete({ where: { id: teamId } })

  return new NextResponse(null, { status: 204 })
}
