import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'

interface RouteContext {
  params: Promise<{ id: string; sessionId: string }>
}

// POST — restore an archived or trashed chat back to the open list.
// Worktree was preserved during archive/trash, so the chat comes back with
// every file change still in place. The user can pick up exactly where
// they left off.
export async function POST(_request: NextRequest, context: RouteContext) {
  const { id, sessionId } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) {
    return NextResponse.json({ error: access.error }, { status: access.status })
  }

  const session = await prisma.chatSession.findUnique({
    where: { id: sessionId },
    select: { projectId: true, status: true },
  })
  if (!session || session.projectId !== id) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  }

  if (session.status !== 'archived' && session.status !== 'trashed') {
    return NextResponse.json({ error: 'Cannot restore — session is not archived or trashed' }, { status: 400 })
  }

  await prisma.chatSession.update({
    where: { id: sessionId },
    data: {
      status: 'open',
      trashedAt: null,
    },
  })

  return NextResponse.json({ success: true })
}
