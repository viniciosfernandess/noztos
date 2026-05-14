// GET — single task with iterations
// PATCH — partial update of name / instruction / executorKind / executorId / chatMode / status / scheduledAt
// DELETE — wipe the task and its iterations (cascade)
//
// PATCH is the only way the manage modal mutates a task; /run, /schedule,
// /cancel are intentionally split out as their own POSTs because they
// trigger side-effects (spawn, schedule, kill) the runner owns, not the
// CRUD route.

import { NextRequest, NextResponse } from 'next/server'
import { TaskStatus } from '@/generated/prisma/enums'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'

interface RouteContext {
  params: Promise<{ id: string; taskId: string }>
}

const VALID_EXECUTOR_KINDS = new Set(['workflow', 'skill'])
const VALID_CHAT_MODES = new Set(['agent', 'plan', 'ask'])
const VALID_STATUSES = new Set<TaskStatus>(['pending', 'scheduled', 'running', 'done', 'failed'])

export async function GET(_request: NextRequest, context: RouteContext) {
  const { id, taskId } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) {
    return NextResponse.json({ error: access.error }, { status: access.status })
  }

  const task = await prisma.task.findFirst({
    where: { id: taskId, projectId: id },
    include: {
      worktree: { select: { branchName: true } },
      iterations: {
        orderBy: { iterationNumber: 'asc' },
        select: {
          id: true,
          iterationNumber: true,
          instruction: true,
          executorKind: true,
          executorId: true,
          chatMode: true,
          status: true,
          startedAt: true,
          finishedAt: true,
          outputSummary: true,
          fullOutput: true,
          filesTouched: true,
          errorReason: true,
          workflowRunId: true,
          createdAt: true,
        },
      },
    },
  })

  if (!task) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 })
  }

  // Auto-stamp reviewedAt on first GET in done/failed state. The card
  // flips from amber → emerald on the next poll. We do it server-side
  // so any client (manage modal, future deep-link) gets the same
  // behavior; the GET response carries the stamped value so the modal
  // doesn't need a follow-up call.
  let reviewedAt = task.reviewedAt
  if (!reviewedAt && (task.status === 'done' || task.status === 'failed')) {
    reviewedAt = new Date()
    await prisma.task.update({
      where: { id: task.id },
      data: { reviewedAt },
    })
  }

  const { worktree, ...rest } = task
  return NextResponse.json({
    ...rest,
    reviewedAt,
    branchName: worktree?.branchName ?? null,
  })
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const { id, taskId } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) {
    return NextResponse.json({ error: access.error }, { status: access.status })
  }

  const existing = await prisma.task.findFirst({
    where: { id: taskId, projectId: id },
    select: { id: true, status: true },
  })
  if (!existing) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 })
  }

  // Reject mutations while the task is actively executing — /cancel
  // is the only legitimate way to interrupt a running task.
  if (existing.status === 'running') {
    return NextResponse.json({ error: 'Task is running; cancel it before editing.' }, { status: 409 })
  }

  let body: {
    name?: string
    instruction?: string | null
    executorKind?: 'workflow' | 'skill' | null
    executorId?: string | null
    chatMode?: 'agent' | 'plan' | 'ask' | null
    status?: TaskStatus
    scheduledAt?: string | null
  }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const data: Record<string, unknown> = {}
  if (body.name?.trim()) data.name = body.name.trim()
  if (body.instruction !== undefined) {
    data.instruction = body.instruction === null ? null : body.instruction.trim() || null
  }
  if (body.executorKind !== undefined) {
    if (body.executorKind !== null && !VALID_EXECUTOR_KINDS.has(body.executorKind)) {
      return NextResponse.json({ error: 'executorKind must be "workflow" or "skill"' }, { status: 400 })
    }
    data.executorKind = body.executorKind
  }
  if (body.executorId !== undefined) data.executorId = body.executorId
  if (body.chatMode !== undefined) {
    if (body.chatMode !== null && !VALID_CHAT_MODES.has(body.chatMode)) {
      return NextResponse.json({ error: 'chatMode must be "agent", "plan", or "ask"' }, { status: 400 })
    }
    data.chatMode = body.chatMode
  }
  if (body.status !== undefined) {
    if (!VALID_STATUSES.has(body.status)) {
      return NextResponse.json({ error: 'invalid status' }, { status: 400 })
    }
    data.status = body.status
  }
  if (body.scheduledAt !== undefined) {
    data.scheduledAt = body.scheduledAt ? new Date(body.scheduledAt) : null
  }

  // Workflow executorKind locks chat mode to "agent" — enforce here so
  // a stale UI can't bypass the rule and create a workflow task in
  // plan/ask mode.
  const nextKind = data.executorKind ?? (body.executorKind === null ? null : undefined)
  const nextMode = data.chatMode ?? (body.chatMode === null ? null : undefined)
  if (nextKind === 'workflow' && nextMode && nextMode !== 'agent') {
    return NextResponse.json({ error: 'Workflow tasks must run in agent mode.' }, { status: 400 })
  }

  const updated = await prisma.task.update({
    where: { id: taskId },
    data,
    select: {
      id: true,
      name: true,
      instruction: true,
      status: true,
      worktreeId: true,
      executorKind: true,
      executorId: true,
      chatMode: true,
      scheduledAt: true,
      reviewedAt: true,
      sourceTaskId: true,
      createdAt: true,
      updatedAt: true,
      contextSource: true,
      worktree: { select: { branchName: true } },
    },
  })

  const { worktree, ...rest } = updated
  return NextResponse.json({
    ...rest,
    branchName: worktree?.branchName ?? null,
  })
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
  const { id, taskId } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) {
    return NextResponse.json({ error: access.error }, { status: access.status })
  }

  const existing = await prisma.task.findFirst({
    where: { id: taskId, projectId: id },
    select: { id: true, status: true },
  })
  if (!existing) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 })
  }

  // Don't allow deleting a task that's actively running; the user must
  // cancel it first so the runner gets a chance to clean up child
  // processes and persist the final iteration state.
  if (existing.status === 'running') {
    return NextResponse.json({ error: 'Cancel the running task before deleting.' }, { status: 409 })
  }

  await prisma.task.delete({ where: { id: taskId } })
  return new NextResponse(null, { status: 204 })
}
