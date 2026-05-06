import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'

interface RouteContext {
  params: Promise<{ id: string }>
}

// GET /api/projects/[id]/collaborators — list project collaborators
export async function GET(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) {
    return NextResponse.json({ error: access.error }, { status: access.status })
  }

  const collaborators = await prisma.collaborator.findMany({
    where: { projectId: id, isActive: true },
    select: {
      id: true,
      name: true,
      description: true,
      isActive: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
  })

  return NextResponse.json(collaborators)
}

// POST /api/projects/[id]/collaborators — add collaborator (from template or custom)
export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) {
    return NextResponse.json({ error: access.error }, { status: access.status })
  }

  let body: { templateId?: string; name?: string; description?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Clone from platform default template
  if (body.templateId) {
    const template = await prisma.collaborator.findFirst({
      where: { id: body.templateId, isPlatformDefault: true, projectId: null },
    })
    if (!template) {
      return NextResponse.json({ error: 'Template not found' }, { status: 404 })
    }

    const collaborator = await prisma.collaborator.create({
      data: {
        projectId: id,
        name: template.name,
        description: template.description,
        skillMd: template.skillMd,
      },
      select: { id: true, name: true, description: true },
    })

    return NextResponse.json(collaborator, { status: 201 })
  }

  // Custom collaborator
  const name = body.name?.trim()
  const description = body.description?.trim()

  if (!name) {
    return NextResponse.json({ error: 'Name is required' }, { status: 400 })
  }
  if (!description) {
    return NextResponse.json({ error: 'Description is required' }, { status: 400 })
  }

  const collaborator = await prisma.collaborator.create({
    data: {
      projectId: id,
      name,
      description,
    },
    select: { id: true, name: true, description: true },
  })

  return NextResponse.json(collaborator, { status: 201 })
}
