import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'
import { discardWorktreeChanges } from '@/lib/worktree'

interface RouteContext {
  params: Promise<{ id: string; sessionId: string }>
}

// POST — discard the parent worktree's changes if this chat lives inside one.
// Chats on main don't have any state of their own to discard.
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
  if (!session.worktreeId) {
    return NextResponse.json({ error: 'Chat has no worktree to discard' }, { status: 400 })
  }

  const ok = await discardWorktreeChanges(id, session.worktreeId)
  if (!ok) {
    return NextResponse.json({ error: 'Failed to discard changes' }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
