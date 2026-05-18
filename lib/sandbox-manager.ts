import { prisma } from '@/lib/db'
import { LocalProvider } from '@/lib/compute-local'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// ── Sandbox Manager ───────────────────────────────────────────────────────
//
// In LOCAL MODE, the user's machine IS the sandbox. No container lifecycle
// needed — the project is always "running" on disk.
//
// `ensureSandboxRunning()` returns the project's LOCAL PATH instead of a
// All callers pass this into `compute.exec(path, cmd)`
// and LocalProvider executes in that directory.
//
// The local path is stored in `Repository.sandboxId` (repurposed — it's
// just a string identifier, doesn't have to be a UUID).
//

const provider = new LocalProvider()

// Common directories where devs keep projects — used as fallback when
// the companion hasn't explicitly registered a path.
const PROJECT_SEARCH_DIRS = [
  join(homedir(), 'projects'),
  join(homedir(), 'Desktop', 'projects'),
  join(homedir(), 'dev'),
  join(homedir(), 'code'),
  join(homedir(), 'repos'),
  join(homedir(), 'Documents', 'projects'),
]

/**
 * Ensure a project is accessible. In local mode, this finds (or clones)
 * the project on the user's disk and returns the absolute path.
 *
 * The path is persisted in `Repository.sandboxId` so subsequent calls
 * return instantly without re-scanning.
 */
export async function ensureSandboxRunning(projectId: string): Promise<string | null> {
  const repo = await prisma.repository.findUnique({
    where: { projectId },
    select: {
      id: true,
      sandboxId: true,
      sandboxStatus: true,
      githubOwner: true,
      githubRepo: true,
    },
  })

  if (!repo) return null

  // Resolve ~ to homedir if stored with tilde
  if (repo.sandboxId?.startsWith('~')) {
    const resolved = repo.sandboxId.replace('~', homedir())
    await prisma.repository.update({ where: { projectId }, data: { sandboxId: resolved } })
    repo.sandboxId = resolved
  }

  // Already resolved to a local path? Trust it — the actual existence
  // check happens on the user's Mac via execOnCompanion (the companion
  // round-trip surfaces "no such directory" naturally). Calling
  // existsSync here is harmful in production: this Next.js process
  // runs on Railway, where /Users/... paths from the daemon never
  // exist, and the previous code would clobber a perfectly good
  // sandboxId with null. Single-machine dev (Next.js on the same Mac)
  // still works because the path is honored either way.
  if (repo.sandboxId && repo.sandboxId.startsWith('/')) {
    return repo.sandboxId
  }

  // Cloud sandbox ID from before? Ignore it in local mode — resolve fresh.
  const repoName = repo.githubRepo ?? 'project'

  // 1. Check common project directories for existing clone
  for (const dir of PROJECT_SEARCH_DIRS) {
    const candidate = join(dir, repoName)
    if (existsSync(join(candidate, '.git'))) {
      await prisma.repository.update({
        where: { projectId },
        data: { sandboxId: candidate, sandboxStatus: 'running' },
      })
      await buildFileTree(projectId, candidate)
      return candidate
    }
  }

  // 2. Try CWD (dev might be running Next.js from the project itself)
  const cwdCandidate = process.cwd()
  if (existsSync(join(cwdCandidate, '.git'))) {
    await prisma.repository.update({
      where: { projectId },
      data: { sandboxId: cwdCandidate, sandboxStatus: 'running' },
    })
    await buildFileTree(projectId, cwdCandidate)
    return cwdCandidate
  }

  // 3. Clone fresh to ~/projects/
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
    await buildFileTree(projectId, sandbox.id)
    return sandbox.id
  } catch (err) {
    console.error('[sandbox-manager] Failed to resolve local project:', err)
    return null
  }
}

/**
 * Build and persist the file tree for a project.
 */
async function buildFileTree(projectId: string, projectPath: string): Promise<void> {
  try {
    const findResult = await provider.exec(
      projectPath,
      `find ${projectPath} -type f -not -path '*/.git/*' -not -path '*/node_modules/*' -not -path '*/__pycache__/*' -not -path '*/.next/*' -not -path '*/dist/*' | sed 's|${projectPath}/||' | sort`,
    )
    if (findResult.stdout.trim()) {
      await prisma.repository.update({
        where: { projectId },
        data: { fileTree: findResult.stdout.trim(), fileTreeUpdatedAt: new Date() },
      })
    }
  } catch (err) {
    console.error('[filetree] Failed to build:', err)
  }
}

/**
 * Stop/cleanup. No-op in local mode (disk doesn't stop).
 */
export async function stopSandbox(projectId: string): Promise<void> {
  await prisma.repository.update({
    where: { projectId },
    data: { sandboxStatus: 'stopped' },
  })
}

/**
 * Execute a command in the project directory. In local mode, runs directly
 * on the user's filesystem. The `cwd` option overrides the working
 * directory (used for worktree-scoped terminals).
 */
export async function execInSandbox(
  projectId: string,
  command: string,
  options?: { cwd?: string; env?: Record<string, string> },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const projectPath = await ensureSandboxRunning(projectId)
  if (!projectPath) throw new Error('Project not found or could not be resolved locally')

  const envParts = options?.env
    ? Object.entries(options.env).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ')
    : ''
  const cdPart = options?.cwd ? `cd ${options.cwd} && ` : ''

  if (!envParts && !cdPart) {
    return provider.exec(projectPath, command)
  }

  const wrapped = `${envParts ? `export ${envParts} && ` : ''}${cdPart}${command}`
  return provider.exec(projectPath, wrapped)
}

