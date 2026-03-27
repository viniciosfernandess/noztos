import { prisma } from '@/lib/db'
import { runTask } from '@/lib/task-runner'
import { getRepoLockStatus } from '@/lib/repo-lock'

// ── Queue Worker ──────────────────────────────────────────────────────────
//
// Chain-based execution: task finishes → check next → run → repeat.
// No polling. Triggered by:
//   1. "Start Queue" button
//   2. "Run Now" on a specific task (after it finishes, chain continues)
//   3. Auto-idle (30 min no activity)
//
// Rules:
//   - Never interrupt a running task
//   - If user is active, pause chain after current task
//   - Scheduled tasks have priority when their time arrives
//   - If scheduled task's time arrives but user is active → reschedule +1h
//   - Never start anytime if scheduled is within 15 min
//   - One task at a time per project
//   - Always check repo lock (chat) before starting

const IDLE_THRESHOLD_AUTO = 30 * 60 * 1000    // 30 min — auto-start queue
const IDLE_THRESHOLD_CHAIN = 15 * 60 * 1000   // 15 min — continue chain after Run Now
const SCHEDULED_BUFFER = 15 * 60 * 1000       // 15 min — don't start anytime if scheduled near
const RESCHEDULE_INCREMENT = 60 * 60 * 1000   // 1 hour — reschedule increment
const RESCHEDULE_CONFLICT_STEP = 30 * 60 * 1000 // 30 min — step if slot is taken

/**
 * Start the queue for a project. Finds the next task and runs it.
 */
export async function startQueue(projectId: string): Promise<{ started: boolean; taskId?: string; reason?: string }> {
  // Check repo lock (chat might be building)
  const lockStatus = await getRepoLockStatus(projectId)
  if (lockStatus.locked && lockStatus.lockedBy === 'chat') {
    return { started: false, reason: 'Repository is being used in chat. Wait for the build to finish.' }
  }
  if (lockStatus.locked && lockStatus.lockedBy === 'task') {
    return { started: false, reason: 'A task is already running.' }
  }

  // Check for running task
  const running = await prisma.task.findFirst({
    where: { projectId, status: 'progress' },
    select: { id: true },
  })
  if (running) return { started: false, reason: 'A task is already running.' }

  // Handle scheduled tasks that missed their time (user was active)
  await rescheduleOverdueTasks(projectId)

  const nextTask = await pickNextTask(projectId)
  if (!nextTask) return { started: false, reason: 'No tasks in queue.' }

  executeAndChain(projectId, nextTask.id)
  return { started: true, taskId: nextTask.id }
}

/**
 * Run a specific task (Run Now), then continue the chain.
 */
export async function runAndChain(projectId: string, taskId: string): Promise<{ started: boolean; reason?: string }> {
  // Check repo lock
  const lockStatus = await getRepoLockStatus(projectId)
  if (lockStatus.locked && lockStatus.lockedBy === 'chat') {
    return { started: false, reason: 'Repository is being used in chat. Wait for the build to finish.' }
  }
  if (lockStatus.locked && lockStatus.lockedBy === 'task') {
    return { started: false, reason: 'A task is already running.' }
  }

  const running = await prisma.task.findFirst({
    where: { projectId, status: 'progress' },
    select: { id: true },
  })
  if (running) return { started: false, reason: 'A task is already running.' }

  executeAndChain(projectId, taskId)
  return { started: true }
}

/**
 * Execute a task, then when it finishes, check if we should continue.
 */
async function executeAndChain(projectId: string, taskId: string): Promise<void> {
  try {
    await runTask(taskId)
  } catch (err) {
    console.error(`[queue-worker] Task ${taskId} failed:`, err)
  }

  // Task finished — should we continue the chain?
  const shouldContinue = await checkShouldContinue(projectId)
  if (!shouldContinue) return

  // Handle any overdue scheduled tasks before picking next
  await rescheduleOverdueTasks(projectId)

  const nextTask = await pickNextTask(projectId)
  if (!nextTask) return

  // Small delay to avoid tight loops
  await new Promise((r) => setTimeout(r, 2000))

  // Check repo lock again (user might have started a build)
  const lockStatus = await getRepoLockStatus(projectId)
  if (lockStatus.locked && lockStatus.lockedBy === 'chat') return

  executeAndChain(projectId, nextTask.id)
}

/**
 * Determine if the queue should continue running.
 */
async function checkShouldContinue(projectId: string): Promise<boolean> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { queueStatus: true, lastActivityAt: true },
  })

  if (!project) return false
  if (project.queueStatus === 'paused') return false

  // Check if user is active
  if (project.lastActivityAt) {
    const idleTime = Date.now() - new Date(project.lastActivityAt).getTime()
    if (idleTime < IDLE_THRESHOLD_CHAIN) return false
  }

  // Check repo lock
  const lockStatus = await getRepoLockStatus(projectId)
  if (lockStatus.locked && lockStatus.lockedBy === 'chat') return false

  return true
}

/**
 * Pick the next task to run from the queue.
 */
async function pickNextTask(projectId: string): Promise<{ id: string } | null> {
  const now = new Date()

  // 1. Scheduled task whose time has arrived
  const scheduledReady = await prisma.task.findFirst({
    where: {
      projectId,
      status: 'queue',
      scheduledAt: { lte: now },
    },
    select: { id: true },
    orderBy: { scheduledAt: 'asc' },
  })
  if (scheduledReady) return scheduledReady

  // 2. Scheduled task coming within 15 min → wait, don't start anytime
  const scheduledSoon = await prisma.task.findFirst({
    where: {
      projectId,
      status: 'queue',
      scheduledAt: {
        gt: now,
        lte: new Date(now.getTime() + SCHEDULED_BUFFER),
      },
    },
    select: { id: true },
  })
  if (scheduledSoon) return null

  // 3. Next anytime task by queue position
  const anytime = await prisma.task.findFirst({
    where: {
      projectId,
      status: 'queue',
      scheduledAt: null,
    },
    select: { id: true },
    orderBy: { queuePosition: 'asc' },
  })
  return anytime
}

// ── Reschedule Logic ──────────────────────────────────────────────────────

/**
 * Find scheduled tasks whose time has passed while user was active.
 * Reschedule them +1h, avoiding conflicts with other scheduled tasks.
 */
async function rescheduleOverdueTasks(projectId: string): Promise<void> {
  const now = new Date()

  // Check if user is currently active
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { lastActivityAt: true },
  })

  const isUserActive = project?.lastActivityAt
    ? (Date.now() - new Date(project.lastActivityAt).getTime()) < IDLE_THRESHOLD_AUTO
    : false

  if (!isUserActive) return // User is idle, scheduled tasks can run normally

  // Find overdue scheduled tasks
  const overdueTasks = await prisma.task.findMany({
    where: {
      projectId,
      status: 'queue',
      scheduledAt: { lte: now },
    },
    select: { id: true, scheduledAt: true, originalScheduledAt: true, rescheduledCount: true },
    orderBy: { scheduledAt: 'asc' },
  })

  for (const task of overdueTasks) {
    const newTime = await findFreeSlot(projectId, task.id, new Date(now.getTime() + RESCHEDULE_INCREMENT))

    await prisma.task.update({
      where: { id: task.id },
      data: {
        scheduledAt: newTime,
        originalScheduledAt: task.originalScheduledAt ?? task.scheduledAt,
        rescheduledReason: 'You were active at the scheduled time',
        rescheduledCount: { increment: 1 },
      },
    })
  }
}

/**
 * Find a free time slot starting from `startFrom`, checking every 30 min.
 * Returns a Date that doesn't conflict with other scheduled tasks.
 */
async function findFreeSlot(projectId: string, excludeTaskId: string, startFrom: Date): Promise<Date> {
  let candidate = startFrom

  for (let i = 0; i < 48; i++) { // max 24 hours of searching
    const windowStart = new Date(candidate.getTime() - 60000)
    const windowEnd = new Date(candidate.getTime() + 60000)

    const conflict = await prisma.task.findFirst({
      where: {
        projectId,
        id: { not: excludeTaskId },
        status: 'queue',
        scheduledAt: { gte: windowStart, lte: windowEnd },
      },
      select: { id: true },
    })

    if (!conflict) return candidate

    // Conflict found, try +30 min
    candidate = new Date(candidate.getTime() + RESCHEDULE_CONFLICT_STEP)
  }

  return candidate // fallback: return last candidate even if conflicting
}

/**
 * Check if auto-idle threshold has been reached.
 */
export async function checkAutoIdle(projectId: string): Promise<boolean> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { queueStatus: true, lastActivityAt: true },
  })

  if (!project) return false
  if (project.queueStatus !== 'running') return false
  if (!project.lastActivityAt) return true

  const idleTime = Date.now() - new Date(project.lastActivityAt).getTime()
  return idleTime >= IDLE_THRESHOLD_AUTO
}
