// POST /api/projects/[id]/tasks/from-task
//
// Creates a chained task. The new task's contextSnapshot is:
//
//   parent.contextSnapshot  +  serializeTaskHistory(parent)
//
// `serializeTaskHistory` walks the parent's iterations in order and
// renders each as a chat-style turn — for workflow iterations it
// embeds the full per-role hand-off via <workflow_internals>, the
// same format the chat workflow card uses. Skill iterations are
// simpler (prompt + result). Because each parent's contextSnapshot
// already contains its own ancestors' task_history blocks, the chain
// is transitively complete with a single concatenation; no recursive
// traversal needed at fork time.
//
// A soft 80 KB budget caps growth on deep chains. The chat_context
// base is always preserved; older task_history blocks are dropped
// oldest-first when the snapshot exceeds the budget.
//
// Required body fields:
//   sourceTaskId — the task to fork from
// Optional:
//   name         — defaults to "<source name> (chained)"

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'
import { serializeTaskHistory, truncateToBudget } from '@/lib/tasks/history'

interface RouteContext {
  params: Promise<{ id: string }>
}

// Soft cap on contextSnapshot bytes. Tuned generously so 95%+ of
// chains never hit truncation in practice. 300 KB fits ~5-6 deep
// workflow chains (each ~50 KB serialized with internals) on top of
// the 30 KB chat context base, leaving headroom for skill iterations
// in between. Cost trade-off: extra input tokens per chained run,
// but the alternative (losing parent memory on truncation) defeats
// the whole point of chaining. The invariant "always keep at least
// the most recent block" in truncateToBudget makes the overshoot
// path graceful when chains do get extreme.
const SNAPSHOT_BUDGET_BYTES = 300 * 1024

export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) {
    return NextResponse.json({ error: access.error }, { status: access.status })
  }

  let body: { sourceTaskId?: string; name?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  if (!body.sourceTaskId) {
    return NextResponse.json({ error: 'sourceTaskId is required' }, { status: 400 })
  }

  const source = await prisma.task.findFirst({
    where: { id: body.sourceTaskId, projectId: id, deletedAt: null },
    select: {
      id: true,
      name: true,
      worktreeId: true,
      contextSnapshot: true,
      contextSource: true,
      iterations: {
        // ALL completed iterations in chronological order — the
        // chain captures the source task's full execution history,
        // not just its latest run. Re-runs of the source feed the
        // chained task with everything that was learned.
        orderBy: { iterationNumber: 'asc' },
        select: {
          iterationNumber: true,
          instruction: true,
          executorKind: true,
          executorId: true,
          chatMode: true,
          status: true,
          fullOutput: true,
          outputSummary: true,
          workflowRunId: true,
          finishedAt: true,
        },
      },
    },
  })
  if (!source) {
    return NextResponse.json({ error: 'Source task not found' }, { status: 404 })
  }
  // Require at least one completed iteration so there's actually
  // history to inherit. Otherwise a chain off an empty task would
  // just clone the snapshot without adding any signal.
  const hasCompleted = source.iterations.some((it) => it.status === 'completed')
  if (!hasCompleted) {
    return NextResponse.json(
      { error: 'Source task has no completed iteration to chain from.' },
      { status: 400 },
    )
  }

  // Build the new contextSnapshot: parent's full inherited base +
  // parent's own thread serialized as task_history.
  const sourceHistory = await serializeTaskHistory(
    { id: source.id, name: source.name },
    source.iterations,
  )
  const merged = sourceHistory
    ? `${source.contextSnapshot}\n\n${sourceHistory}`
    : source.contextSnapshot

  const newSnapshot = truncateToBudget(merged, SNAPSHOT_BUDGET_BYTES)
  const truncated = newSnapshot.length < merged.length
  console.log(`[task/from-task] source=${source.id.slice(0, 8)} parentSnap=${source.contextSnapshot.length}b history=${sourceHistory.length}b merged=${merged.length}b final=${newSnapshot.length}b${truncated ? ' (truncated)' : ''}`)

  const name = body.name?.trim() || `${source.name} (chained)`

  const task = await prisma.task.create({
    data: {
      projectId: id,
      worktreeId: source.worktreeId,
      userId: access.userId,
      name,
      contextSource: source.contextSource as object,
      contextSnapshot: newSnapshot,
      sourceTaskId: source.id,
      status: 'pending',
    },
    select: {
      id: true,
      name: true,
      status: true,
      worktreeId: true,
      instruction: true,
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

  // Enforce a linear chain per worktree: once a task is forked, the
  // source disappears from the user's lists. Prevents the fan-out
  // footgun — forking the same Done task twice would create two
  // parallel chains writing to the same worktree filesystem, with
  // each branch unaware of the other's edits. The source row stays
  // in the DB (soft-delete via deletedAt) so the audit trail and
  // chain lineage (sourceTaskId pointer) remain intact.
  await prisma.task.update({
    where: { id: source.id },
    data: { deletedAt: new Date() },
  })
  console.log(`[task/from-task] source=${source.id.slice(0, 8)} soft-deleted (linear chain enforced)`)

  const { worktree, ...rest } = task
  return NextResponse.json(
    { ...rest, branchName: worktree?.branchName ?? null },
    { status: 201 },
  )
}
