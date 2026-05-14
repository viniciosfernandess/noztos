// POST /api/projects/[id]/tasks/[taskId]/cancel
//
// Kill an actively running task. Marks the latest iteration as
// cancelled, flips the task back to `pending` (config preserved so the
// user can re-run after adjusting). The actual child process kill is
// best-effort via the workflows process registry — relevant when the
// iteration was executing a workflow-kind agent. For skill-kind tasks
// the in-flight `claude -p` child also gets the SIGTERM through the
// same registry once we wire it; for now the flag in the DB is
// authoritative and the runner respects it on its next persist tick.

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'

interface RouteContext {
  params: Promise<{ id: string; taskId: string }>
}

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
  if (task.status !== 'running') {
    return NextResponse.json({ error: 'Task is not running.' }, { status: 409 })
  }

  // Mark the latest non-terminal iteration as cancelled. The runner
  // sees this and short-circuits on next checkpoint.
  const latest = await prisma.taskIteration.findFirst({
    where: { taskId, status: { in: ['running', 'queued'] } },
    orderBy: { iterationNumber: 'desc' },
    select: { id: true, workflowRunId: true },
  })
  if (latest) {
    await prisma.taskIteration.update({
      where: { id: latest.id },
      data: { status: 'cancelled', finishedAt: new Date(), errorReason: 'cancelled by user' },
    })
    // If this iteration spawned a workflow run, mark that cancelled
    // too — the workflow runner picks this up and tears down children.
    if (latest.workflowRunId) {
      await prisma.workflowRun.updateMany({
        where: { id: latest.workflowRunId, status: { not: 'cancelled' } },
        data: { status: 'cancelled', completedAt: new Date(), errorReason: 'task cancelled' },
      })
    }
  }

  const updated = await prisma.task.update({
    where: { id: task.id },
    data: { status: 'pending' },
    select: { id: true, status: true },
  })

  return NextResponse.json(updated)
}
