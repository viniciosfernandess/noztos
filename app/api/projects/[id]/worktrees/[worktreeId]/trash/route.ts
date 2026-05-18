import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'
import { dropSessionBuffer } from '@/lib/companion-relay'

interface RouteContext {
  params: Promise<{ id: string; worktreeId: string }>
}

// POST — soft-delete the worktree and every chat it owns.
//
// Trash is **DB-only** — the on-disk worktree dir and the git branch
// stay completely untouched. This is the user's "Mac Trash" model:
// uncommitted changes, staged files, the branch HEAD, the PR — all
// preserved, so restore brings everything back exactly as it was.
//
// Real disk + git cleanup happens later, on either of these paths:
//   - 7-day trash expiration → GET /trash promotes to status='deleted'
//     and calls cleanupWorktreeOnDisk
//   - Manual "delete forever" → /delete-forever calls the same helper
//
// Codename uniqueness is preserved across all of this because
// generateWorktreeCodename queries every worktree row regardless of
// status, so a trashed/deleted branchName is never reissued.
export async function POST(_request: NextRequest, context: RouteContext) {
  const { id, worktreeId } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) {
    return NextResponse.json({ error: access.error }, { status: access.status })
  }

  const wt = await prisma.worktree.findUnique({
    where: { id: worktreeId },
    select: { projectId: true },
  })
  if (!wt || wt.projectId !== id) {
    return NextResponse.json({ error: 'Worktree not found' }, { status: 404 })
  }

  // Group every chat inside into the worktree's trash bucket so they come
  // back together on restore. Previously-individually-trashed chats keep
  // their own trashedAt — the restore route pulls them back anyway.
  const openSessions = await prisma.chatSession.findMany({
    where: { worktreeId, status: 'open' },
    select: { id: true },
  })
  const trashedAt = new Date()
  await prisma.worktree.update({
    where: { id: worktreeId },
    data: { status: 'trashed', trashedAt },
  })
  await prisma.chatSession.updateMany({
    where: { worktreeId, status: 'open' },
    data: { status: 'trashed', trashedAt },
  })

  // Cascade soft-delete to every task in this worktree. Tasks are
  // worktree-bound (Task.worktreeId FK) and the user's mental model
  // is "deleted the branch → all the work inside, chat AND tasks,
  // goes". Audit trail stays: row preserved, deletedAt stamped so
  // every list query hides it. Same Date as the worktree trashedAt
  // so restore (when wired) can bring them back as a group.
  await prisma.task.updateMany({
    where: { worktreeId, deletedAt: null },
    data: { deletedAt: trashedAt },
  })

  for (const s of openSessions) dropSessionBuffer(s.id)

  return NextResponse.json({ success: true })
}
