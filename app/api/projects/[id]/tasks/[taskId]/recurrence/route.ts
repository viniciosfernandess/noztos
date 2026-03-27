import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'

interface RouteContext {
  params: Promise<{ id: string; taskId: string }>
}

// PATCH /api/projects/[id]/tasks/[taskId]/recurrence — set recurrence config
export async function PATCH(request: NextRequest, context: RouteContext) {
  const { id, taskId } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) {
    return NextResponse.json({ error: access.error }, { status: access.status })
  }

  const task = await prisma.task.findFirst({
    where: { id: taskId, projectId: id },
    select: { id: true },
  })
  if (!task) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 })
  }

  let body: {
    isRecurring?: boolean
    recurrenceConfig?: {
      type: string
      time?: string
      dayOfWeek?: number
      dayOfMonth?: number
    }
  }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const isRecurring = body.isRecurring ?? false

  // Validate recurrence config
  if (isRecurring && body.recurrenceConfig) {
    const validTypes = ['daily', 'weekly', 'monthly']
    if (!validTypes.includes(body.recurrenceConfig.type)) {
      return NextResponse.json({ error: 'Invalid recurrence type' }, { status: 400 })
    }

    if (body.recurrenceConfig.time) {
      const timeMatch = /^\d{2}:\d{2}$/.test(body.recurrenceConfig.time)
      if (!timeMatch) {
        return NextResponse.json({ error: 'Time must be in HH:MM format' }, { status: 400 })
      }
    }
  }

  const updated = await prisma.task.update({
    where: { id: taskId },
    data: {
      isRecurring,
      recurrenceConfig: isRecurring ? (body.recurrenceConfig ?? undefined) : undefined,
    },
    select: {
      id: true,
      isRecurring: true,
      recurrenceConfig: true,
    },
  })

  return NextResponse.json(updated)
}
