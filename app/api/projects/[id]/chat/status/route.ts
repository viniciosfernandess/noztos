import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'

interface RouteContext {
  params: Promise<{ id: string }>
}

// GET — fetch messages after a given timestamp (for polling)
export async function GET(request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) {
    return NextResponse.json({ error: access.error }, { status: access.status })
  }

  const after = request.nextUrl.searchParams.get('after')

  const where: { projectId: string; createdAt?: { gt: Date } } = { projectId: id }
  if (after) {
    where.createdAt = { gt: new Date(after) }
  }

  const messages = await prisma.chatMessage.findMany({
    where,
    select: {
      id: true,
      content: true,
      sender: true,
      mode: true,
      activeSkillId: true,
      report: true,
      sessionId: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
  })

  return NextResponse.json({ messages })
}
