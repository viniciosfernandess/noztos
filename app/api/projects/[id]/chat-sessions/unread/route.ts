import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'

interface RouteContext {
  params: Promise<{ id: string }>
}

// GET — list the ids of every open chat that has assistant/tool
// messages newer than its lastReadAt. The client seeds its in-memory
// unread Set from this on mount / F5 / device switch. After that, live
// updates come through the SSE companion stream.
export async function GET(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) {
    return NextResponse.json({ error: access.error }, { status: access.status })
  }

  // Pull every open chat of this user in this project along with their
  // lastReadAt and the most recent assistant/tool message timestamp.
  // A lean aggregate — one round trip, no N+1.
  const sessions = await prisma.chatSession.findMany({
    where: {
      projectId: id,
      userId: access.userId,
      status: 'open',
      deletedAt: null,
    },
    select: {
      id: true,
      lastReadAt: true,
      messages: {
        where: {
          role: { in: ['assistant', 'tool'] },
          deletedAt: null,
        },
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { createdAt: true },
      },
    },
  })

  const unreadIds: string[] = []
  for (const s of sessions) {
    const lastActivity = s.messages[0]?.createdAt
    if (!lastActivity) continue
    if (!s.lastReadAt || lastActivity > s.lastReadAt) {
      unreadIds.push(s.id)
    }
  }

  return NextResponse.json({ unreadIds })
}
