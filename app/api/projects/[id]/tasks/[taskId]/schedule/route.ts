// POST /api/projects/[id]/tasks/[taskId]/schedule
//
// Move a task into the `scheduled` column with a datetime. The server-
// side scheduler worker checks `scheduledAt <= now()` every minute and
// fires the run when the time arrives (and a companion daemon is
// connected to actually execute on the worktree).
//
// DELETE on this endpoint clears scheduledAt and returns the task to
// `pending`. Useful for "cancel the schedule" without deleting the
// task entirely.

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'

interface RouteContext {
  params: Promise<{ id: string; taskId: string }>
}

export async function POST(request: NextRequest, context: RouteContext) {
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
    return NextResponse.json({ error: 'Cancel the running task before scheduling.' }, { status: 409 })
  }
  if (!task.instruction || !task.executorKind || !task.executorId || !task.chatMode) {
    return NextResponse.json(
      { error: 'Task is incomplete. Set instruction, executor, and chat mode before scheduling.' },
      { status: 400 },
    )
  }

  let body: { scheduledAt?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  if (!body.scheduledAt) {
    return NextResponse.json({ error: 'scheduledAt is required' }, { status: 400 })
  }

  const when = new Date(body.scheduledAt)
  if (Number.isNaN(when.getTime())) {
    return NextResponse.json({ error: 'scheduledAt must be a valid ISO datetime' }, { status: 400 })
  }
  if (when.getTime() < Date.now() - 60_000) {
    // Allow a small grace window (1 min) for clock drift, but reject
    // clearly past dates so the user doesn't accidentally fire a task
    // immediately when they meant tomorrow.
    return NextResponse.json({ error: 'scheduledAt must be in the future.' }, { status: 400 })
  }

  const updated = await prisma.task.update({
    where: { id: task.id },
    data: { status: 'scheduled', scheduledAt: when },
    select: { id: true, status: true, scheduledAt: true },
  })

  return NextResponse.json(updated)
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
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
  if (task.status !== 'scheduled') {
    return NextResponse.json({ error: 'Task is not scheduled.' }, { status: 409 })
  }

  const updated = await prisma.task.update({
    where: { id: task.id },
    data: { status: 'pending', scheduledAt: null },
    select: { id: true, status: true, scheduledAt: true },
  })

  return NextResponse.json(updated)
}
