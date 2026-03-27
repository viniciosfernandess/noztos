import { NextRequest, NextResponse } from 'next/server'
import { verifyProjectAccess } from '@/lib/auth'
import { runAndChain } from '@/lib/queue-worker'
import { getRepoLockStatus } from '@/lib/repo-lock'
import { prisma } from '@/lib/db'

interface RouteContext {
  params: Promise<{ id: string; taskId: string }>
}

// POST /api/projects/[id]/tasks/[taskId]/run — run a specific task, then chain
export async function POST(_request: NextRequest, context: RouteContext) {
  const { id, taskId } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) {
    return NextResponse.json({ error: access.error }, { status: access.status })
  }

  const task = await prisma.task.findFirst({
    where: { id: taskId, projectId: id },
    select: { id: true, status: true },
  })

  if (!task) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 })
  }

  if (task.status !== 'queue' && task.status !== 'pending') {
    return NextResponse.json({ error: `Task is ${task.status}, cannot run` }, { status: 400 })
  }

  // Check if repo is locked by chat
  const lockStatus = await getRepoLockStatus(id)
  if (lockStatus.locked && lockStatus.lockedBy === 'chat') {
    return NextResponse.json({ error: 'Repository is being used in chat. Wait for the build to finish before running a task.' }, { status: 409 })
  }
  if (lockStatus.locked && lockStatus.lockedBy === 'task') {
    return NextResponse.json({ error: 'Another task is already running. Wait for it to finish.' }, { status: 409 })
  }

  // Set queue to running so chain continues after this task
  await prisma.project.update({
    where: { id },
    data: { queueStatus: 'running' },
  })

  // Fire and forget — runs in background, chains to next
  runAndChain(id, taskId).catch((err) => {
    console.error(`[task-run] Task ${taskId} failed:`, err)
  })

  // Return the task
  const updated = await prisma.task.findUnique({
    where: { id: taskId },
    select: {
      id: true, name: true, instruction: true, status: true,
      executorType: true, executorId: true, context: true, accumulatedContext: true,
      scheduledAt: true, createdAt: true,
    },
  })

  return NextResponse.json(updated)
}
