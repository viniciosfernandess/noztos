import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'

interface RouteContext {
  params: Promise<{ id: string }>
}

const TRASH_TTL_DAYS = 7

// GET — list STANDALONE trashed chats: those trashed individually while
// their parent worktree is still active (main-level chats or chats that
// sat alone in the trash before the worktree followed). Chats whose
// parent worktree is itself trashed surface grouped under that
// worktree's card, served by /worktrees/trash — never here.
//
// Also runs lazy retention for expired individual chats (parent still
// active, but chat's own TTL ran out).
export async function GET(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) {
    return NextResponse.json({ error: access.error }, { status: access.status })
  }

  const cutoff = new Date(Date.now() - TRASH_TTL_DAYS * 24 * 60 * 60 * 1000)

  // Lazy retention — standalone trashed chats past TTL get promoted to
  // 'deleted'. Grouped-under-worktree chats are promoted by the worktree
  // trash GET so we don't double-handle them here. Messages inside
  // promote to deleted too so every query stays consistent.
  const expiredStandalone = await prisma.chatSession.findMany({
    where: {
      projectId: id,
      status: 'trashed',
      trashedAt: { lt: cutoff },
      OR: [
        { worktreeId: null },
        { worktree: { status: { not: 'trashed' } } },
      ],
    },
    select: { id: true },
  })
  if (expiredStandalone.length > 0) {
    const expiredIds = expiredStandalone.map((s) => s.id)
    const now = new Date()
    await prisma.$transaction([
      prisma.chatMessage.updateMany({
        where: { sessionId: { in: expiredIds }, deletedAt: null },
        data: { deletedAt: now },
      }),
      prisma.chatSession.updateMany({
        where: { id: { in: expiredIds } },
        data: { status: 'deleted', deletedAt: now },
      }),
    ])
  }

  const sessions = await prisma.chatSession.findMany({
    where: {
      projectId: id,
      status: 'trashed',
      trashedAt: { gte: cutoff },
      // Exclude chats whose parent worktree is also trashed — they live
      // nested inside the worktree's trash card, not as loose items.
      OR: [
        { worktreeId: null },
        { worktree: { status: { not: 'trashed' } } },
      ],
    },
    select: { id: true, name: true, trashedAt: true, createdAt: true, worktreeId: true },
    orderBy: { trashedAt: 'desc' },
  })

  const enriched = sessions.map((s) => {
    const expiresAt = s.trashedAt
      ? new Date(s.trashedAt.getTime() + TRASH_TTL_DAYS * 24 * 60 * 60 * 1000)
      : null
    const daysLeft = expiresAt
      ? Math.max(0, Math.ceil((expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000)))
      : 0
    return { ...s, expiresAt, daysLeft }
  })

  return NextResponse.json({ sessions: enriched })
}
