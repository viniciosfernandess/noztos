// POST /api/projects/[id]/tasks/[taskId]/run
//
// Fires immediate execution of a task. Reads the task's current
// configuration (instruction + executorKind + executorId + chatMode),
// validates it's complete, then hands off to the task runner which
// spawns the agent async and returns once the iteration row is
// registered. The response is 202 — the actual run continues in the
// background and the user follows it via the running side area.
//
// Refuses to run if:
//   - Task is missing instruction / executorKind / executorId / chatMode
//   - Task is already running (use /cancel first)
//   - executorKind is workflow but chatMode != agent (UI should have
//     prevented this, but server enforces)

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'
import { triggerTaskIteration } from '@/lib/tasks/runner'

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
    select: {
      id: true,
      status: true,
      instruction: true,
      executorKind: true,
      executorId: true,
      chatMode: true,
    },
  })
  if (!task) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 })
  }
  if (task.status === 'running') {
    return NextResponse.json({ error: 'Task is already running. Cancel it before re-running.' }, { status: 409 })
  }
  if (!task.instruction || !task.executorKind || !task.executorId || !task.chatMode) {
    return NextResponse.json(
      { error: 'Task is incomplete. Set instruction, executor, and chat mode before running.' },
      { status: 400 },
    )
  }
  if (task.executorKind === 'workflow' && task.chatMode !== 'agent') {
    return NextResponse.json({ error: 'Workflow tasks must run in agent mode.' }, { status: 400 })
  }

  console.log(`[task/run] requested taskId=${task.id.slice(0, 8)} kind=${task.executorKind}/${task.executorId} mode=${task.chatMode}`)

  try {
    const iteration = await triggerTaskIteration({
      taskId: task.id,
      instruction: task.instruction,
      executorKind: task.executorKind as 'workflow' | 'skill',
      executorId: task.executorId,
      chatMode: task.chatMode as 'agent' | 'plan' | 'ask',
    })
    // Clear scheduledAt — manual Run now takes the task out of scheduled.
    await prisma.task.update({
      where: { id: task.id },
      data: { scheduledAt: null },
    })
    console.log(`[task/run] ✓ accepted taskId=${task.id.slice(0, 8)} iterationId=${iteration.iterationId.slice(0, 8)} num=${iteration.iterationNumber}`)
    return NextResponse.json(iteration, { status: 202 })
  } catch (err) {
    console.error(`[task/run] ✗ failed taskId=${task.id.slice(0, 8)}: ${(err as Error).message}`)
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }
}
