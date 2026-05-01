import { execSync, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { addProject, removeProject, loadConfig, relabelProject } from './config.js'
import type { ProjectConfig } from './types.js'

export function isGitRepo(dir: string): boolean {
  try {
    execSync('git rev-parse --is-inside-work-tree 2>/dev/null', {
      cwd: dir,
      encoding: 'utf-8',
    })
    return true
  } catch {
    return false
  }
}

export function getGitRemote(dir: string): string | null {
  try {
    return execSync('git remote get-url origin 2>/dev/null', {
      cwd: dir,
      encoding: 'utf-8',
    }).trim() || null
  } catch {
    return null
  }
}

export function getRepoName(dir: string): string {
  const remote = getGitRemote(dir)
  if (remote) {
    const match = remote.match(/\/([^/]+?)(?:\.git)?$/)
    if (match) return match[1]
  }
  return basename(dir)
}

// `providedId` lets the web pass the DB cuid through, so the daemon's
// project id matches the DB id from the start (fs-watcher path,
// worktrees dir, etc. all line up). When omitted, the daemon mints its
// own legacy hex id; the register-time reconciliation will relabel it
// later when the DB pairing is discovered.
export function initProject(dirPath: string, providedId?: string): ProjectConfig {
  const absPath = resolve(dirPath)
  if (!existsSync(absPath)) {
    throw new Error(`Directory does not exist: ${absPath}`)
  }
  if (!isGitRepo(absPath)) {
    throw new Error(`Not a git repository: ${absPath}. Run 'git init' first.`)
  }

  const project: ProjectConfig = {
    id: providedId ?? randomBytes(12).toString('hex'),
    path: absPath,
    name: getRepoName(absPath),
    registeredAt: new Date().toISOString(),
    gitRemote: getGitRemote(absPath) ?? undefined,
  }

  addProject(project)
  return project
}

// Re-export for daemon command handlers. Same idempotency semantics
// as relabelProject in config.ts — true if applied, false when the
// old id is unknown.
export function relabelProjectId(oldId: string, newId: string): boolean {
  return relabelProject(oldId, newId)
}

export function listProjects(): ProjectConfig[] {
  return loadConfig().projects
}

export function unregisterProject(dirPath: string): void {
  const absPath = resolve(dirPath)
  removeProject(absPath)
}

// Recursively remove the worktrees directory of a project. Best-effort:
// errors (permission, in-use) are swallowed because the DB row is
// already in 'deleted' state by the time this runs — disk inconsistency
// is recoverable on the next reconciliation pass; a thrown error here
// would break the daemon command pipeline for unrelated commands.
export function cleanupProjectWorktreesDir(worktreesPath: string): void {
  try {
    rmSync(worktreesPath, { recursive: true, force: true })
  } catch (err) {
    console.warn(`[project] cleanup ${worktreesPath} failed: ${(err as Error).message}`)
  }
}

export function cloneRepo(repoUrl: string, targetDir: string): ProjectConfig {
  if (existsSync(targetDir)) {
    throw new Error(`Target directory already exists: ${targetDir}`)
  }

  mkdirSync(targetDir, { recursive: true })

  try {
    execFileSync('git', ['clone', repoUrl, targetDir], {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 120_000,
    })
  } catch (err) {
    throw new Error(`Failed to clone: ${(err as Error).message}`)
  }

  return initProject(targetDir)
}

export function createProject(
  targetDir: string,
  options?: { template?: string; providedId?: string },
): ProjectConfig {
  // Resolve ~ to home directory
  const resolvedDir = targetDir.startsWith('~')
    ? targetDir.replace('~', homedir())
    : targetDir

  if (existsSync(resolvedDir)) {
    throw new Error(`Directory already exists: ${resolvedDir}`)
  }

  mkdirSync(resolvedDir, { recursive: true })

  // Initialize git
  execSync('git init', { cwd: resolvedDir, encoding: 'utf-8', stdio: 'pipe' })

  // Scaffold template if requested
  if (options?.template) {
    const scaffoldCmd = getScaffoldCommand(options.template, resolvedDir)
    if (scaffoldCmd) {
      try {
        execSync(scaffoldCmd, { cwd: resolvedDir, encoding: 'utf-8', stdio: 'pipe', timeout: 120_000 })
      } catch {
        // Template scaffold failed — project still usable with empty git
      }
    }
  }

  return initProject(resolvedDir, options?.providedId)
}

function getScaffoldCommand(template: string, _dir: string): string | null {
  switch (template.toLowerCase()) {
    case 'nextjs':
    case 'next':
      return 'npx create-next-app@latest . --ts --tailwind --eslint --app --no-src --no-import-alias --yes'
    case 'vite':
    case 'react':
      return 'npm create vite@latest . -- --template react-ts'
    case 'python':
      return 'python3 -m venv venv && echo "# My Project" > README.md'
    case 'node':
      return 'npm init -y'
    default:
      return null
  }
}
