import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'

interface RouteContext {
  params: Promise<{ id: string; sessionId: string }>
}

// POST — archive a chat session.
//
// Chats no longer hold worktree state (their worktree, if any, is shared
// across multiple sessions), so this is a pure status flip. Worktree-level
// approval/discard happens through /worktrees/[id] endpoints.
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
    data: { status: 'archived' },
  })

  return NextResponse.json({ success: true })
}
