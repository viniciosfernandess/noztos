import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'

interface RouteContext {
  params: Promise<{ id: string; sessionId: string }>
}

// POST — soft-delete a chat session permanently. The chat row stays in the
// database for analytics, but disappears from every user-facing view.
//
// This is a chat-only operation — the worktree (if any) belongs to a parent
// Worktree row and is managed independently through /worktrees/[id]/delete-forever.
export async function POST(_request: NextRequest, context: RouteContext) {
  const { id, sessionId } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) {
    return NextResponse.json({ error: access.error }, { status: access.status })
  }

  const session = await prisma.chatSession.findUnique({
    where: { id: sessionId },
    select: { projectId: true },
  })
  if (!session || session.projectId !== id) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  }

  await prisma.chatSession.update({
    where: { id: sessionId },
    data: { status: 'deleted' },
  })

  return NextResponse.json({ success: true })
}
