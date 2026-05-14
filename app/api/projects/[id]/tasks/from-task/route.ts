// POST /api/projects/[id]/tasks/from-task
//
// Creates a chained task — a new Task whose contextSnapshot is the
// source task's snapshot with one extra `<previous_task>` block
// appended, containing the source task's instruction + final result.
//
// Use case: the user opens a Done task's modal, sees the model output,
// and decides "now I want another task to act on what this one just
// produced." Click "Create chained task" → POST here → new pending task
// opens in the manage modal. The chain is transparent: each chained
// task carries forward the full history.
//
// Why an extra route instead of /tasks/from-chat with a flag: the
// inputs are completely different (source task vs anchored chat
// message), and the snapshot construction logic doesn't overlap. Two
// routes keep both narrow.
//
// Required body fields:
//   sourceTaskId — the task to fork from
// Optional:
//   name         — defaults to "<source name> (chained)"

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'

interface RouteContext {
  params: Promise<{ id: string }>
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttr(s: string): string {
  return escapeXml(s).replace(/"/g, '&quot;')
}

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
    where: { id: body.sourceTaskId, projectId: id },
    select: {
      id: true,
      name: true,
      worktreeId: true,
      contextSnapshot: true,
      contextSource: true,
      instruction: true,
      executorKind: true,
      executorId: true,
      chatMode: true,
      iterations: {
        orderBy: { iterationNumber: 'desc' },
        take: 1,
        select: {
          finishedAt: true,
          outputSummary: true,
          fullOutput: true,
          status: true,
        },
      },
    },
  })
  if (!source) {
    return NextResponse.json({ error: 'Source task not found' }, { status: 404 })
  }
  const latest = source.iterations[0]
  if (!latest || latest.status !== 'completed') {
    return NextResponse.json(
      { error: 'Source task has no completed iteration to chain from.' },
      { status: 400 },
    )
  }

  // Append one `<previous_task>` block carrying the source's user
  // prompt + assistant response. Anything earlier in the chain is
  // already inside source.contextSnapshot (each chain step appends one
  // more block), so a single append is enough — no walking back.
  const result = latest.fullOutput ?? latest.outputSummary ?? ''
  const attrs = [
    `name="${escapeAttr(source.name)}"`,
    `executor="${escapeAttr(`${source.executorKind ?? '?'}/${source.executorId ?? '?'}`)}"`,
    `mode="${escapeAttr(source.chatMode ?? '?')}"`,
    `finishedAt="${escapeAttr(latest.finishedAt?.toISOString() ?? '')}"`,
  ].join(' ')
  const block = [
    `<previous_task ${attrs}>`,
    `  <instruction>${escapeXml(source.instruction ?? '')}</instruction>`,
    `  <result>${escapeXml(result)}</result>`,
    `</previous_task>`,
  ].join('\n')

  const newSnapshot = `${source.contextSnapshot}\n${block}`
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

  const { worktree, ...rest } = task
  return NextResponse.json(
    { ...rest, branchName: worktree?.branchName ?? null },
    { status: 201 },
  )
}
