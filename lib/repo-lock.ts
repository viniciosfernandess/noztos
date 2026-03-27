import { prisma } from '@/lib/db'

// ── Repo Lock ─────────────────────────────────────────────────────────────
//
// The repository can only be modified by one source at a time:
//   - "chat"  = user is building via chat
//   - "task"  = a task is executing and modifying files
//   - null    = repo is free
//
// Any task running (regardless of intent) locks the repo.
// Chat builds check the lock before starting.

export type LockHolder = 'chat' | 'task'

interface LockStatus {
  locked: boolean
  lockedBy: LockHolder | null
  lockedByTaskId: string | null
  lockedAt: Date | null
}

/**
 * Check if the repo is currently locked.
 */
export async function getRepoLockStatus(projectId: string): Promise<LockStatus> {
  const repo = await prisma.repository.findUnique({
    where: { projectId },
    select: { lockedBy: true, lockedByTaskId: true, lockedAt: true },
  })

  if (!repo) return { locked: false, lockedBy: null, lockedByTaskId: null, lockedAt: null }

  return {
    locked: !!repo.lockedBy,
    lockedBy: repo.lockedBy as LockHolder | null,
    lockedByTaskId: repo.lockedByTaskId,
    lockedAt: repo.lockedAt,
  }
}

/**
 * Get the name of the task that's locking the repo.
 */
export async function getLockerTaskName(projectId: string): Promise<string | null> {
  const repo = await prisma.repository.findUnique({
    where: { projectId },
    select: { lockedByTaskId: true },
  })
  if (!repo?.lockedByTaskId) return null

  const task = await prisma.task.findUnique({
    where: { id: repo.lockedByTaskId },
    select: { name: true },
  })
  return task?.name ?? null
}

/**
 * Acquire the repo lock. Returns true if acquired, false if already locked by someone else.
 */
export async function acquireRepoLock(projectId: string, holder: LockHolder, taskId?: string): Promise<boolean> {
  const status = await getRepoLockStatus(projectId)

  // Already locked by someone else
  if (status.locked && status.lockedBy !== holder) return false

  // Already locked by same holder (re-entrant)
  if (status.locked && status.lockedBy === holder) return true

  await prisma.repository.update({
    where: { projectId },
    data: {
      lockedBy: holder,
      lockedByTaskId: holder === 'task' ? (taskId ?? null) : null,
      lockedAt: new Date(),
    },
  })

  return true
}

/**
 * Release the repo lock. Only releases if held by the specified holder.
 */
export async function releaseRepoLock(projectId: string, holder: LockHolder): Promise<void> {
  const status = await getRepoLockStatus(projectId)
  if (status.lockedBy !== holder) return

  await prisma.repository.update({
    where: { projectId },
    data: {
      lockedBy: null,
      lockedByTaskId: null,
      lockedAt: null,
    },
  })
}

/**
 * Force release the repo lock (for admin/recovery).
 */
export async function forceReleaseRepoLock(projectId: string): Promise<void> {
  const repo = await prisma.repository.findUnique({ where: { projectId } })
  if (!repo) return

  await prisma.repository.update({
    where: { projectId },
    data: {
      lockedBy: null,
      lockedByTaskId: null,
      lockedAt: null,
    },
  })
}

/**
 * Update project last activity timestamp (for idle detection).
 */
export async function touchProjectActivity(projectId: string): Promise<void> {
  await prisma.project.update({
    where: { id: projectId },
    data: { lastActivityAt: new Date() },
  })
}
