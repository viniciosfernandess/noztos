// GET /api/workflow?sessionId=X
//
// Lists workflow runs for a chat session — minimal payload to let the
// chat UI render each run's WorkflowRunCard inline at its trigger
// message position. Without this, the UI only knew about the
// currently-active run and pinned the card to the bottom of the chat.
//
// Per row we return:
//   id, status, workflowType, triggerMessageId, createdAt, completedAt
//
// Heavy fields (`progress`, `plan`, transcripts) stay on the
// per-run detail endpoint — clients only fetch them when expanding a
// card. Keeps the list cheap on chat hydrate.

import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { getSessionUserId } from '@/lib/session'
import { prisma } from '@/lib/db'

export async function GET(request: NextRequest) {
  const cookieStore = await cookies()
  const userId = getSessionUserId(cookieStore.get('session')?.value)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const sessionId = request.nextUrl.searchParams.get('sessionId')
  if (!sessionId) {
    return NextResponse.json({ error: 'sessionId required' }, { status: 400 })
  }

  // Ownership check via session — workflow rows live under the same
  // user's session, so verifying session ownership is enough (the
  // workflow.userId always matches).
  const session = await prisma.chatSession.findFirst({
    where: { id: sessionId, userId, deletedAt: null },
    select: { id: true },
  })
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 })

  const runs = await prisma.workflowRun.findMany({
    where: { sessionId, userId },
    select: {
      id: true,
      status: true,
      workflowType: true,
      triggerMessageId: true,
      createdAt: true,
      completedAt: true,
    },
    orderBy: { createdAt: 'asc' },
  })

  return NextResponse.json({ runs })
}
