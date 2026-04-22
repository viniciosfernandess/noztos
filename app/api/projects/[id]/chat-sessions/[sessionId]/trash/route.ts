import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'

interface RouteContext {
  params: Promise<{ id: string; sessionId: string }>
}

// POST — move a chat session to trash.
//
// Pure status flip — worktree state (if any) is shared across multiple
// chats and is managed through /worktrees/[id] endpoints, not here.
export async function POST(_request: NextRequest, context: RouteContext) {
  const { id, sessionId } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) {
    return NextResponse.json({ error: access.error }, { status: access.status })
  }

  const session = await prisma.chatSession.findUnique({
    where: { id: sessionId },
    select: { projectId: true, worktreeId: true },
  })
  if (!session || session.projectId !== id) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  }

  // Invariant: an active worktree must always have at least one active chat.
  // When deleting the last chat would leave the worktree empty, the user is
  // expected to trash the whole worktree instead — the UI already hides the
  // individual "Delete chat" action when `sessions.length === 1`, and we
  // enforce it here so a direct API call can't sneak past.
  if (session.worktreeId) {
    const activeSiblings = await prisma.chatSession.count({
      where: {
        worktreeId: session.worktreeId,
        status: 'open',
        id: { not: sessionId },
      },
    })
    if (activeSiblings === 0) {
      return NextResponse.json(
        { error: 'Cannot trash the last chat of an active worktree — trash the worktree instead' },
        { status: 409 },
      )
    }
  }

  await prisma.chatSession.update({
    where: { id: sessionId },
    data: { status: 'trashed', trashedAt: new Date() },
  })

  return NextResponse.json({ success: true })
}
