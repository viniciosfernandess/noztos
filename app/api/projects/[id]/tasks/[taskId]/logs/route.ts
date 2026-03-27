import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'

interface RouteContext {
  params: Promise<{ id: string; taskId: string }>
}

export async function GET(_request: NextRequest, context: RouteContext) {
  const { id, taskId } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) return NextResponse.json({ error: access.error }, { status: access.status })

  const task = await prisma.task.findFirst({
    where: { id: taskId, projectId: id },
    select: { id: true },
  })
  if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 })

  const [logs, buildLogs, suggestions] = await Promise.all([
    prisma.taskSkillLog.findMany({
      where: { taskId },
      select: {
        collaboratorName: true,
        thoughts: true,
        conclusion: true,
        approved: true,
        startedAt: true,
        finishedAt: true,
      },
      orderBy: { startedAt: 'asc' },
    }),
    prisma.taskBuildLog.findMany({
      where: { taskId },
      select: { filesTouched: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.taskSuggestion.findMany({
      where: { taskId },
      select: { id: true, suggestionText: true, reason: true, accepted: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    }),
  ])

  return NextResponse.json({ logs, buildLogs, suggestions })
}
