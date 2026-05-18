import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'
import { cleanupWorktreeOnDisk } from '@/lib/worktree'

interface RouteContext {
  params: Promise<{ id: string }>
}

const TRASH_TTL_DAYS = 7

// GET — list trashed worktrees with their grouped chats. Each entry
// bundles the worktree plus every chat that's in the trash under it, so
// the UI can render one card per worktree with its chats nested.
//
// Also runs lazy retention: anything older than TRASH_TTL_DAYS is
// promoted to status='deleted' (unlinked from the user but preserved
// in DB for audit / training). Saves running a real cron for MVP.
export async function GET(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) {
    return NextResponse.json({ error: access.error }, { status: access.status })
  }

  const cutoff = new Date(Date.now() - TRASH_TTL_DAYS * 24 * 60 * 60 * 1000)

  // Lazy retention — promote expired trashed worktrees AND their chats
  // to 'deleted'. These rows stay in the DB; the user just stops seeing
  // them. Runs before the listing query so the response is clean.
  //
  // The transition trashed → deleted is the point where the on-disk
  // worktree and its branch finally get cleaned up. Up to this point
  // both have been preserved so restore could bring them back. After
  // 7 days untouched the user has effectively abandoned the worktree,
  // so we free the disk + git refs (best-effort, errors logged only).
  const expired = await prisma.worktree.findMany({
    where: { projectId: id, status: 'trashed', trashedAt: { lt: cutoff } },
    select: { id: true, worktreePath: true, branchName: true },
  })
  if (expired.length > 0) {
    const expiredIds = expired.map((w) => w.id)
    const now = new Date()
    const expiredSessionIds = (await prisma.chatSession.findMany({
      where: { worktreeId: { in: expiredIds }, status: 'trashed' },
      select: { id: true },
    })).map((s) => s.id)
    await prisma.$transaction([
      prisma.chatMessage.updateMany({
        where: { sessionId: { in: expiredSessionIds }, deletedAt: null },
        data: { deletedAt: now },
      }),
      prisma.chatSession.updateMany({
        where: { worktreeId: { in: expiredIds }, status: 'trashed' },
        data: { status: 'deleted', deletedAt: now },
      }),
      prisma.worktree.updateMany({
        where: { id: { in: expiredIds } },
        data: { status: 'deleted', deletedAt: now },
      }),
    ])
    // Disk + git cleanup runs after the DB flip. Sequential rather than
    // parallel because each call ensures the same sandbox is up — there's
    // no benefit to fan-out, and serial keeps the log order readable.
    for (const w of expired) {
      await cleanupWorktreeOnDisk(id, w.worktreePath, w.branchName, 'trash-expire')
    }
  }

  const worktrees = await prisma.worktree.findMany({
    where: {
      projectId: id,
      status: 'trashed',
      trashedAt: { gte: cutoff },
    },
    select: {
      id: true, name: true, branchName: true, trashedAt: true, createdAt: true,
      sessions: {
        where: { status: 'trashed' },
        select: { id: true, name: true, trashedAt: true, createdAt: true },
        orderBy: { trashedAt: 'desc' },
      },
    },
    orderBy: { trashedAt: 'desc' },
  })

  const enriched = worktrees.map((w) => {
    const expiresAt = w.trashedAt
      ? new Date(w.trashedAt.getTime() + TRASH_TTL_DAYS * 24 * 60 * 60 * 1000)
      : null
    const daysLeft = expiresAt
      ? Math.max(0, Math.ceil((expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000)))
      : 0
    return { ...w, expiresAt, daysLeft }
  })

  return NextResponse.json({ worktrees: enriched })
}
