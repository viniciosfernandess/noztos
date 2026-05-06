import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'

interface RouteContext {
  params: Promise<{ id: string; collaboratorId: string }>
}

// PATCH /api/projects/[id]/collaborators/[collaboratorId] — update collaborator
export async function PATCH(request: NextRequest, context: RouteContext) {
  const { id, collaboratorId } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) {
    return NextResponse.json({ error: access.error }, { status: access.status })
  }

  // Verify collaborator belongs to this project
  const existing = await prisma.collaborator.findFirst({
    where: { id: collaboratorId, projectId: id },
  })
  if (!existing) {
    return NextResponse.json({ error: 'Collaborator not found' }, { status: 404 })
  }

  let body: { name?: string; description?: string; skillMd?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const data: Record<string, string> = {}
  if (body.name?.trim()) data.name = body.name.trim()
  if (body.description?.trim()) data.description = body.description.trim()
  if (body.skillMd !== undefined) data.skillMd = body.skillMd

  const updated = await prisma.collaborator.update({
    where: { id: collaboratorId },
    data,
    select: { id: true, name: true, description: true },
  })

  return NextResponse.json(updated)
}

// DELETE /api/projects/[id]/collaborators/[collaboratorId] — soft delete (set isActive=false)
export async function DELETE(_request: NextRequest, context: RouteContext) {
  const { id, collaboratorId } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) {
    return NextResponse.json({ error: access.error }, { status: access.status })
  }

  const existing = await prisma.collaborator.findFirst({
    where: { id: collaboratorId, projectId: id },
  })
  if (!existing) {
    return NextResponse.json({ error: 'Collaborator not found' }, { status: 404 })
  }

  await prisma.collaborator.update({
    where: { id: collaboratorId },
    data: { isActive: false },
  })

  return new NextResponse(null, { status: 204 })
}
