// POST /api/projects/[id]/tasks/from-chat
//
// Sole task-creation entry point. Triggered when the user clicks the
// discrete "take context to task" button under an assistant message in
// the chat. Captures the chat history from that message backwards (same
// sizing budget as Bridge IN), freezes it as the task's preamble, and
// drops a new Task row in `pending`. The manage modal (opened next, or
// later from the tasks page) is where the user configures executor /
// chat mode / instruction and either runs or schedules.
//
// Required body fields:
//   sessionId         — chat session id the click happened in
//   cutoffMessageId   — id of the assistant message clicked (anchor)
// Optional:
//   name              — defaults to the chat session name

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'
import { buildChatSnapshot } from '@/lib/tasks/context'

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) {
    return NextResponse.json({ error: access.error }, { status: access.status })
  }

  let body: { sessionId?: string; cutoffMessageId?: string; name?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!body.sessionId || !body.cutoffMessageId) {
    return NextResponse.json(
      { error: 'sessionId and cutoffMessageId are required' },
      { status: 400 },
    )
  }

  console.log(`[task/create] from-chat session=${body.sessionId.slice(0, 8)} cutoff=${body.cutoffMessageId.slice(0, 8)} project=${id.slice(0, 8)}`)

  const session = await prisma.chatSession.findFirst({
    where: { id: body.sessionId, projectId: id, deletedAt: null },
    select: { id: true, name: true, worktreeId: true },
  })
  if (!session) {
    console.warn(`[task/create] session not found sid=${body.sessionId.slice(0, 8)}`)
    return NextResponse.json({ error: 'Chat session not found' }, { status: 404 })
  }
  if (!session.worktreeId) {
    console.warn(`[task/create] session has no worktree sid=${body.sessionId.slice(0, 8)} — refusing`)
    return NextResponse.json(
      { error: 'Cannot create a task from a chat with no worktree (main-branch chats not supported yet).' },
      { status: 400 },
    )
  }

  const snapshot = await buildChatSnapshot(body.sessionId, body.cutoffMessageId, access.userId)
  console.log(`[task/create] snapshot built rows=${snapshot.rowCount} bytes=${snapshot.xml.length} cutoffAt=${snapshot.cutoffAt?.toISOString() ?? '-'}`)
  if (!snapshot.xml || snapshot.rowCount === 0) {
    return NextResponse.json(
      { error: 'No chat history could be captured for that anchor. Pick a different message.' },
      { status: 400 },
    )
  }

  const name = body.name?.trim() || session.name || `Task — ${new Date().toLocaleString('en-US')}`

  const task = await prisma.task.create({
    data: {
      projectId: id,
      worktreeId: session.worktreeId,
      userId: access.userId,
      name,
      contextSource: {
        chatId: body.sessionId,
        cutoffMessageId: body.cutoffMessageId,
        cutoffAt: snapshot.cutoffAt?.toISOString() ?? null,
        rowCount: snapshot.rowCount,
      },
      contextSnapshot: snapshot.xml,
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
  console.log(`[task/create] ✓ created taskId=${task.id.slice(0, 8)} name="${task.name}" branch=${worktree?.branchName ?? '?'} status=pending`)
  return NextResponse.json(
    { ...rest, branchName: worktree?.branchName ?? null },
    { status: 201 },
  )
}
