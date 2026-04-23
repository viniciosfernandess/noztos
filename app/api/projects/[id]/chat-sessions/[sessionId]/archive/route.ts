import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'
import { dropSessionBuffer } from '@/lib/companion-relay'

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
    select: { projectId: true, worktreeId: true },
  })
  if (!session || session.projectId !== id) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  }

  // Same invariant as /trash — an active worktree must keep at least one
  // active chat. If the user wants to put everything away, they archive
  // the worktree itself (which takes every chat inside with it).
  if (session.worktreeId) {
    const activeSiblings = await prisma.chatSession.count({
      where: {
        worktreeId: session.worktreeId,
        status: 'open',
        id: { not: sessionId },
      },
    })
    if (activeSiblings === 0) {
      return NextResponse.json(
        { error: 'Cannot archive the last chat of an active worktree — archive the worktree instead' },
        { status: 409 },
      )
    }
  }

  await prisma.chatSession.update({
    where: { id: sessionId },
    data: { status: 'archived' },
  })

  // Free the in-memory ring buffer — archived sessions must re-hydrate
  // from Supabase on next open (and typically stay cold after).
  dropSessionBuffer(sessionId)

  return NextResponse.json({ success: true })
}
