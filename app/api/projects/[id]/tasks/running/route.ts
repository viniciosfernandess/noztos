import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'

interface RouteContext {
  params: Promise<{ id: string }>
}

// GET — get the currently running task + its logs
export async function GET(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) return NextResponse.json({ error: access.error }, { status: access.status })

  const task = await prisma.task.findFirst({
    where: { projectId: id, status: 'progress' },
    select: {
      id: true,
      name: true,
      instruction: true,
      status: true,
      executorType: true,
      executorId: true,
      context: true,
      accumulatedContext: true,
      pausedAtEmployee: true,
      scheduledAt: true,
      createdAt: true,
    },
  })

  if (!task) return NextResponse.json({ task: null, logs: [], buildLogs: [] })

  const logs = await prisma.taskSkillLog.findMany({
    where: { taskId: task.id },
    select: {
      id: true,
      collaboratorName: true,
      inputReceived: true,
      thoughts: true,
      conclusion: true,
      approved: true,
      rejectionReason: true,
      startedAt: true,
      finishedAt: true,
    },
    orderBy: { startedAt: 'asc' },
  })

  const buildLogs = await prisma.taskBuildLog.findMany({
    where: { taskId: task.id },
    select: {
      id: true,
      filesTouched: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
  })

  return NextResponse.json({ task, logs, buildLogs })
}
