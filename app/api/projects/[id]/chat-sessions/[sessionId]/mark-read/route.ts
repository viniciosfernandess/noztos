import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'

interface RouteContext {
  params: Promise<{ id: string; sessionId: string }>
}

// POST — stamp lastReadAt so subsequent unread-count queries stop
// showing this chat as unread. Called every time the user switches to
// (or lands on) a chat in the UI. Idempotent.
export async function POST(_request: NextRequest, context: RouteContext) {
  const { id, sessionId } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) {
    return NextResponse.json({ error: access.error }, { status: access.status })
  }

  const session = await prisma.chatSession.findUnique({
    where: { id: sessionId },
    select: { projectId: true, userId: true },
  })
  if (!session || session.projectId !== id || session.userId !== access.userId) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  }

  await prisma.chatSession.update({
    where: { id: sessionId },
    data: { lastReadAt: new Date() },
  })
  return NextResponse.json({ ok: true })
}
