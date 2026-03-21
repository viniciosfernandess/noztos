import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'

interface RouteContext {
  params: Promise<{ id: string; taskId: string }>
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const { id, taskId } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) {
    return NextResponse.json({ error: access.error }, { status: access.status })
  }

  const existing = await prisma.task.findFirst({
    where: { id: taskId, projectId: id },
  })
  if (!existing) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 })
  }

  let body: { name?: string; instruction?: string; teamId?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const data: Record<string, unknown> = {}
  if (body.name?.trim()) data.name = body.name.trim()
  if (body.instruction !== undefined) data.instruction = body.instruction?.trim() || null

  if (body.teamId !== undefined) {
    if (body.teamId) {
      const team = await prisma.team.findFirst({
        where: { id: body.teamId, projectId: id },
      })
      if (!team) {
        return NextResponse.json({ error: 'Team not found' }, { status: 404 })
      }
      data.executorType = 'team'
      data.executorId = body.teamId
    } else {
      data.executorType = 'no_skill'
      data.executorId = null
    }
  }

  const updated = await prisma.task.update({
    where: { id: taskId },
    data,
    select: { id: true, name: true, status: true, executorType: true, executorId: true },
  })

  return NextResponse.json(updated)
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
  const { id, taskId } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) {
    return NextResponse.json({ error: access.error }, { status: access.status })
  }

  const existing = await prisma.task.findFirst({
    where: { id: taskId, projectId: id },
  })
  if (!existing) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 })
  }

  await prisma.task.delete({ where: { id: taskId } })

  return new NextResponse(null, { status: 204 })
}
