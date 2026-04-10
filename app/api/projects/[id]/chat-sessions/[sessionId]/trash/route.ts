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
    select: { projectId: true },
  })
  if (!session || session.projectId !== id) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  }

  await prisma.chatSession.update({
    where: { id: sessionId },
    data: { status: 'trashed', trashedAt: new Date() },
  })

  return NextResponse.json({ success: true })
}
