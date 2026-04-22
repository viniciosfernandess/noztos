import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'

interface RouteContext {
  params: Promise<{ id: string; sessionId: string }>
}

// POST — soft-delete a chat session permanently. The chat row stays in the
// database for analytics, but disappears from every user-facing view.
//
// This is a chat-only operation — the worktree (if any) belongs to a parent
// Worktree row and is managed independently through /worktrees/[id]/delete-forever.
export async function POST(_request: NextRequest, context: RouteContext) {
  const { id, sessionId } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) {
    return NextResponse.json({ error: access.error }, { status: access.status })
  }

  const session = await prisma.chatSession.findUnique({
    where: { id: sessionId },
    select: {
      projectId: true, worktreeId: true,
      worktree: { select: { status: true } },
    },
  })
  if (!session || session.projectId !== id) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  }
  // Don't allow deleting an individual chat that lives under a trashed
  // worktree — that chat is bundled in the worktree's trash group, and
  // killing it here would split the atomic restore. The UI surfaces
  // "Delete forever" only on the worktree in that case.
  if (session.worktree && session.worktree.status !== 'open') {
    return NextResponse.json(
      { error: 'Cannot delete chat individually — worktree is archived/trashed. Delete the worktree instead.' },
      { status: 409 },
    )
  }

  // Mark both `status` and `deletedAt` so every query layer sees the row
  // as gone. Messages inside this session soft-delete too so the audit
  // trail stays consistent (same timestamp = same "delete event").
  const now = new Date()
  await prisma.$transaction([
    prisma.chatSession.update({
      where: { id: sessionId },
      data: { status: 'deleted', deletedAt: now },
    }),
    prisma.chatMessage.updateMany({
      where: { sessionId, deletedAt: null },
      data: { deletedAt: now },
    }),
  ])

  return NextResponse.json({ success: true })
}
