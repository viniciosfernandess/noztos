import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function GET(request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) {
    return NextResponse.json({ error: access.error }, { status: access.status })
  }

  // Optional filters
  const statusFilter = request.nextUrl.searchParams.get('status')
  const limitParam = request.nextUrl.searchParams.get('limit')
  const take = limitParam ? parseInt(limitParam) : undefined

  const where: Record<string, unknown> = { projectId: id }
  if (statusFilter) where.status = statusFilter

  const [tasks, teams] = await Promise.all([
    prisma.task.findMany({
      where,
      ...(take ? { take } : {}),
      select: {
        id: true,
        name: true,
        instruction: true,
        status: true,
        executorType: true,
        executorId: true,
        context: true,
        accumulatedContext: true,
        isRecurring: true,
        recurrenceConfig: true,
        queuePosition: true,
        pausedAtEmployee: true,
        scheduledAt: true,
        originalScheduledAt: true,
        rescheduledReason: true,
        rescheduledCount: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.team.findMany({
      where: { projectId: id },
      select: { id: true, name: true, hasBuilder: true },
      orderBy: { createdAt: 'desc' },
    }),
  ])

  return NextResponse.json({ tasks, teams })
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) {
    return NextResponse.json({ error: access.error }, { status: access.status })
  }

  let body: { name?: string; instruction?: string; teamId?: string; executorType?: string; executorId?: string; status?: string; scheduledAt?: string; isRecurring?: boolean; recurrenceConfig?: Record<string, unknown>; accumulatedContext?: Record<string, unknown>; context?: Record<string, unknown>; permissionMode?: 'plan' | 'edit' | 'agent' }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const name = body.name?.trim()
  if (!name) {
    return NextResponse.json({ error: 'Task name is required' }, { status: 400 })
  }

  // If teamId provided, verify it belongs to this project
  if (body.teamId) {
    const team = await prisma.team.findFirst({
      where: { id: body.teamId, projectId: id },
    })
    if (!team) {
      return NextResponse.json({ error: 'Team not found' }, { status: 404 })
    }
  }

  // Auto-assign queue position if going to queue
  let queuePosition: number | undefined
  const targetStatus = body.status ?? 'pending'
  if (targetStatus === 'queue') {
    const maxPos = await prisma.task.aggregate({
      where: { projectId: id, status: 'queue' },
      _max: { queuePosition: true },
    })
    queuePosition = (maxPos._max.queuePosition ?? -1) + 1
  }

  const task = await prisma.task.create({
    data: {
      projectId: id,
      userId: access.userId,
      name,
      instruction: body.instruction?.trim() || null,
      executorType: (body.executorType ?? (body.teamId ? 'team' : 'no_skill')) as 'no_skill' | 'skill' | 'team',
      executorId: body.executorId ?? body.teamId ?? null,
      status: targetStatus as 'pending' | 'queue' | 'progress' | 'completed' | 'done',
      scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : undefined,
      isRecurring: body.isRecurring ?? false,
      recurrenceConfig: body.recurrenceConfig ? JSON.parse(JSON.stringify(body.recurrenceConfig)) : undefined,
      accumulatedContext: body.accumulatedContext ? JSON.parse(JSON.stringify(body.accumulatedContext)) : undefined,
      context: body.context ? JSON.parse(JSON.stringify(body.context)) : undefined,
      permissionMode: body.permissionMode ?? 'edit',
      queuePosition,
    },
    select: {
      id: true,
      name: true,
      status: true,
      executorType: true,
      executorId: true,
    },
  })

  return NextResponse.json(task, { status: 201 })
}
