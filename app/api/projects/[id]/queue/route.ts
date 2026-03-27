import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'
import { startQueue } from '@/lib/queue-worker'

interface RouteContext {
  params: Promise<{ id: string }>
}

// GET — get queue status
export async function GET(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) return NextResponse.json({ error: access.error }, { status: access.status })

  const project = await prisma.project.findUnique({
    where: { id },
    select: { queueStatus: true, lastActivityAt: true },
  })

  const repo = await prisma.repository.findUnique({
    where: { projectId: id },
    select: { lockedBy: true, lockedByTaskId: true },
  })

  const queuedCount = await prisma.task.count({
    where: { projectId: id, status: 'queue' },
  })

  const runningTask = await prisma.task.findFirst({
    where: { projectId: id, status: 'progress' },
    select: { id: true, name: true },
  })

  return NextResponse.json({
    queueStatus: project?.queueStatus ?? 'paused',
    lastActivityAt: project?.lastActivityAt,
    repoLockedBy: repo?.lockedBy ?? null,
    repoLockedByTaskId: repo?.lockedByTaskId ?? null,
    queuedCount,
    runningTask,
  })
}

// PATCH — toggle queue status (running/paused)
export async function PATCH(request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) return NextResponse.json({ error: access.error }, { status: access.status })

  const body = await request.json() as { queueStatus: 'running' | 'paused' }
  if (!body.queueStatus || !['running', 'paused'].includes(body.queueStatus)) {
    return NextResponse.json({ error: 'queueStatus must be "running" or "paused"' }, { status: 400 })
  }

  await prisma.project.update({
    where: { id },
    data: { queueStatus: body.queueStatus },
  })

  // If switching to running, start the queue chain
  if (body.queueStatus === 'running') {
    startQueue(id).catch((err) => {
      console.error(`[queue] Failed to start queue for ${id}:`, err)
    })
  }

  const project = await prisma.project.findUnique({
    where: { id },
    select: { queueStatus: true, lastActivityAt: true },
  })

  return NextResponse.json(project)
}
