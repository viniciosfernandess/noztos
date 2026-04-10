import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'

interface RouteContext {
  params: Promise<{ id: string }>
}

// GET — list archived chats for this project (most recent first)
export async function GET(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) {
    return NextResponse.json({ error: access.error }, { status: access.status })
  }

  const sessions = await prisma.chatSession.findMany({
    where: { projectId: id, status: 'archived' },
    select: { id: true, name: true, updatedAt: true, createdAt: true },
    orderBy: { updatedAt: 'desc' },
  })

  return NextResponse.json({ sessions })
}
