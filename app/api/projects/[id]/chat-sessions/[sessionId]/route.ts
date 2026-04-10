import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'
import { invalidateWorktreeCache } from '@/lib/tools'

interface RouteContext {
  params: Promise<{ id: string; sessionId: string }>
}

// PATCH — rename or close a chat session.
//
// Closing a chat is purely a session-level operation now: chats live inside
// a Worktree (or directly on main), so closing a single chat never destroys
// a worktree. Worktree lifecycle is handled by /worktrees/[id] endpoints.
export async function PATCH(request: NextRequest, context: RouteContext) {
  const { id, sessionId } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) return NextResponse.json({ error: access.error }, { status: access.status })

  const body = await request.json() as { name?: string; status?: string }

  const data: { name?: string; status?: string } = {}
  if (body.name) data.name = body.name.trim()
  if (body.status) data.status = body.status

  const session = await prisma.chatSession.update({
    where: { id: sessionId },
    data,
    select: { id: true, name: true, status: true, worktreeId: true },
  })

  // Clear the cached worktree resolution so subsequent tool calls re-read.
  invalidateWorktreeCache(sessionId)

  return NextResponse.json(session)
}

// GET — get messages for a specific session
export async function GET(_request: NextRequest, context: RouteContext) {
  const { id, sessionId } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) return NextResponse.json({ error: access.error }, { status: access.status })

  const messages = await prisma.chatMessage.findMany({
    where: { sessionId },
    select: {
      id: true,
      content: true,
      sender: true,
      mode: true,
      activeSkillId: true,
      report: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
  })

  return NextResponse.json({ messages })
}
