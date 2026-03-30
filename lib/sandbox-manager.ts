import { prisma } from '@/lib/db'
import { E2BProvider } from '@/lib/compute-e2b'

// ── Sandbox Manager ───────────────────────────────────────────────────────
//
// Container is the SINGLE SOURCE OF TRUTH for all code.
// DB stores only metadata (tasks, chat, teams, configs).
//
// Rules:
//   - Container auto-starts when ANY file operation is needed
//   - Container stays alive for 15 min after last activity
//   - All reads and writes go to container
//
// Idle timer: 15 min of no activity → container stops
// Any new activity resets the timer and restarts if needed

const provider = new E2BProvider()
const IDLE_TIMEOUT = 15 * 60 * 1000 // 15 minutes
const idleTimers = new Map<string, NodeJS.Timeout>()

/**
 * Reset the idle timer for a project. Called on every activity.
 */
function resetIdleTimer(projectId: string) {
  // Clear existing timer
  const existing = idleTimers.get(projectId)
  if (existing) clearTimeout(existing)

  // Set new timer
  const timer = setTimeout(async () => {
    idleTimers.delete(projectId)
    // Check if still not needed before stopping
    const needed = await isSandboxNeeded(projectId)
    if (!needed) {
      console.log(`[sandbox-manager] Idle 15 min — stopping sandbox for ${projectId}`)
      await stopSandbox(projectId)
    } else {
      // Still needed — reset timer again
      resetIdleTimer(projectId)
    }
  }, IDLE_TIMEOUT)

  idleTimers.set(projectId, timer)
}

/**
 * Ensure a sandbox is running for a project. Creates or reconnects.
 * Resets the idle timer on every call.
 */
export async function ensureSandboxRunning(projectId: string): Promise<string | null> {
  const repo = await prisma.repository.findUnique({
    where: { projectId },
    select: { id: true, sandboxId: true, sandboxStatus: true, githubOwner: true, githubRepo: true },
  })

  if (!repo) return null

  // Already running? Check if still alive
  if (repo.sandboxId && repo.sandboxStatus === 'running') {
    const running = await provider.isRunning(repo.sandboxId)
    if (running) {
      resetIdleTimer(projectId)
      return repo.sandboxId
    }

    // Dead — clean up
    await prisma.repository.update({
      where: { projectId },
      data: { sandboxId: null, sandboxStatus: 'stopped' },
    })
  }

  // Start new sandbox
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { userId: true },
  })
  if (!project) return null

  const user = await prisma.user.findUnique({
    where: { id: project.userId },
    select: { githubToken: true },
  })

  let ghToken: string | null = null
  if (user?.githubToken) {
    try {
      const { decrypt } = await import('@/lib/crypto')
      ghToken = decrypt(user.githubToken)
    } catch {}
  }

  const repoUrl = ghToken
    ? `https://${ghToken}@github.com/${repo.githubOwner}/${repo.githubRepo}.git`
    : `https://github.com/${repo.githubOwner}/${repo.githubRepo}.git`

  try {
    const sandbox = await provider.createSandbox(repoUrl)

    await prisma.repository.update({
      where: { projectId },
      data: { sandboxId: sandbox.id, sandboxStatus: 'running', sandboxStartedAt: new Date() },
    })

    resetIdleTimer(projectId)
    return sandbox.id
  } catch (err) {
    console.error('[sandbox-manager] Failed to start:', err)
    return null
  }
}

/**
 * Stop a sandbox.
 */
export async function stopSandbox(projectId: string): Promise<void> {
  // Clear idle timer
  const timer = idleTimers.get(projectId)
  if (timer) { clearTimeout(timer); idleTimers.delete(projectId) }

  const repo = await prisma.repository.findUnique({
    where: { projectId },
    select: { sandboxId: true },
  })

  if (repo?.sandboxId) {
    try { await provider.stopSandbox(repo.sandboxId) } catch {}
    await prisma.repository.update({
      where: { projectId },
      data: { sandboxId: null, sandboxStatus: 'stopped' },
    })
  }
}

/**
 * Execute a command in the project's sandbox. Auto-starts if needed.
 */
export async function execInSandbox(projectId: string, command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const sandboxId = await ensureSandboxRunning(projectId)
  if (!sandboxId) throw new Error('No repository connected or sandbox failed to start')
  return provider.exec(sandboxId, command)
}

/**
 * Check if sandbox is still needed (active tasks or terminal).
 */
export async function isSandboxNeeded(projectId: string): Promise<boolean> {
  const runningTask = await prisma.task.findFirst({
    where: { projectId, status: 'progress' },
    select: { id: true },
  })
  return !!runningTask
}
