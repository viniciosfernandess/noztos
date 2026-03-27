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

  let body: { name?: string; instruction?: string; teamId?: string; executorType?: string; executorId?: string | null; status?: string; scheduledAt?: string | null; accumulatedContext?: Record<string, unknown> }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const data: Record<string, unknown> = {}
  if (body.name?.trim()) data.name = body.name.trim()
  if (body.instruction !== undefined) data.instruction = body.instruction?.trim() || null
  if (body.status) data.status = body.status
  if (body.scheduledAt !== undefined) {
    if (body.scheduledAt) {
      // Validate no other task is scheduled at the same time (within 1 min window)
      const scheduledDate = new Date(body.scheduledAt)
      const windowStart = new Date(scheduledDate.getTime() - 60000)
      const windowEnd = new Date(scheduledDate.getTime() + 60000)
      const conflict = await prisma.task.findFirst({
        where: {
          projectId: id,
          id: { not: taskId },
          status: 'queue',
          scheduledAt: { gte: windowStart, lte: windowEnd },
        },
        select: { id: true, name: true },
      })
      if (conflict) {
        return NextResponse.json(
          { error: `Time conflict — "${conflict.name}" is already scheduled at this time. Choose a different time.` },
          { status: 409 }
        )
      }
      data.scheduledAt = scheduledDate
    } else {
      data.scheduledAt = null
    }
  }
  if (body.executorType) data.executorType = body.executorType
  if (body.executorId !== undefined) data.executorId = body.executorId
  if (body.accumulatedContext) data.accumulatedContext = JSON.parse(JSON.stringify(body.accumulatedContext))

  // Auto-assign queue position when moving to queue
  if (body.status === 'queue') {
    const maxPos = await prisma.task.aggregate({
      where: { projectId: id, status: 'queue' },
      _max: { queuePosition: true },
    })
    data.queuePosition = (maxPos._max.queuePosition ?? -1) + 1
  }

  // Clear queue position when leaving queue
  if (body.status && body.status !== 'queue') {
    data.queuePosition = null
  }

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
    select: {
      id: true, name: true, instruction: true, status: true,
      executorType: true, executorId: true, context: true, accumulatedContext: true,
      queuePosition: true, scheduledAt: true, originalScheduledAt: true, rescheduledReason: true, rescheduledCount: true, createdAt: true,
    },
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
