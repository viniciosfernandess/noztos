// Scheduled-task worker.
//
// Single setInterval, runs every 60s on the Node.js server process. On
// each tick: find tasks whose status is `scheduled` and whose
// scheduledAt has passed, and for each one whose owning user has a
// companion daemon currently online, hand it off to the task runner.
// Tasks whose user is offline stay in `scheduled` and get re-checked
// next tick — they fire as soon as the daemon reconnects.
//
// The interval handle is parked on globalThis so HMR / re-imports
// during dev don't multiply the timer. Only the first call to
// startTaskScheduler() spins it up; subsequent calls are no-ops.

import { prisma } from '@/lib/db'
import { getCompanionStatus } from '@/lib/companion-relay'
import { triggerTaskIteration } from '@/lib/tasks/runner'

const TICK_MS = 60_000

type Globals = typeof globalThis & {
  __taskSchedulerInterval?: ReturnType<typeof setInterval>
  __taskSchedulerStartedAt?: number
}

const g = globalThis as Globals

export function startTaskScheduler(): void {
  if (g.__taskSchedulerInterval) {
    return
  }
  g.__taskSchedulerStartedAt = Date.now()
  g.__taskSchedulerInterval = setInterval(() => {
    void tick().catch((err) => {
      console.warn('[task-scheduler] tick failed:', (err as Error).message)
    })
  }, TICK_MS)
  console.log('[task-scheduler] started (tick=60s)')
}

async function tick(): Promise<void> {
  const now = new Date()
  const due = await prisma.task.findMany({
    where: { status: 'scheduled', scheduledAt: { lte: now } },
    select: {
      id: true,
      userId: true,
      instruction: true,
      executorKind: true,
      executorId: true,
      chatMode: true,
    },
    orderBy: { scheduledAt: 'asc' },
    take: 20, // soft cap per tick — anything beyond falls into the next minute
  })
  if (due.length === 0) return

  for (const task of due) {
    // Skip incomplete tasks defensively — they shouldn't be in
    // `scheduled` without full config, but if they sneak through we
    // park them back in `pending` so the user can finish configuring.
    if (!task.instruction || !task.executorKind || !task.executorId || !task.chatMode) {
      await prisma.task.update({
        where: { id: task.id },
        data: { status: 'pending', scheduledAt: null },
      })
      console.warn(`[task-scheduler] task=${task.id.slice(0, 8)} dropped from scheduled (incomplete config)`)
      continue
    }

    const status = getCompanionStatus(task.userId)
    if (!status.connected) {
      // User offline — leave scheduled, retry next tick when daemon
      // reconnects. Surface a single info log per task per tick so
      // the user can see why their scheduled task is delayed.
      console.log(`[task-scheduler] task=${task.id.slice(0, 8)} deferred (companion offline for user=${task.userId.slice(0, 8)})`)
      continue
    }

    try {
      await triggerTaskIteration({
        taskId: task.id,
        instruction: task.instruction,
        executorKind: task.executorKind as 'workflow' | 'skill',
        executorId: task.executorId,
        chatMode: task.chatMode as 'agent' | 'plan' | 'ask',
      })
      // Mark consumed: scheduledAt cleared, status flips to running
      // (runner already did that, but clearing scheduledAt prevents a
      // re-fire if the runner crashes mid-init).
      await prisma.task.update({
        where: { id: task.id },
        data: { scheduledAt: null },
      })
      console.log(`[task-scheduler] task=${task.id.slice(0, 8)} fired`)
    } catch (err) {
      console.warn(`[task-scheduler] task=${task.id.slice(0, 8)} trigger failed:`, (err as Error).message)
    }
  }
}
