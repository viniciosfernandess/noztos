import { execSync, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { addProject, removeProject, loadConfig } from './config.js'
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

export function initProject(dirPath: string): ProjectConfig {
  const absPath = resolve(dirPath)
  if (!existsSync(absPath)) {
    throw new Error(`Directory does not exist: ${absPath}`)
  }
  if (!isGitRepo(absPath)) {
    throw new Error(`Not a git repository: ${absPath}. Run 'git init' first.`)
  }

  const project: ProjectConfig = {
    id: randomBytes(12).toString('hex'),
    path: absPath,
    name: getRepoName(absPath),
    registeredAt: new Date().toISOString(),
    gitRemote: getGitRemote(absPath) ?? undefined,
  }

  addProject(project)
  return project
}

export function listProjects(): ProjectConfig[] {
  return loadConfig().projects
}

export function unregisterProject(dirPath: string): void {
  const absPath = resolve(dirPath)
  removeProject(absPath)
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
  options?: { template?: string },
): ProjectConfig {
  if (existsSync(targetDir)) {
    throw new Error(`Directory already exists: ${targetDir}`)
  }

  mkdirSync(targetDir, { recursive: true })

  // Initialize git
  execSync('git init', { cwd: targetDir, encoding: 'utf-8', stdio: 'pipe' })

  // Scaffold template if requested
  if (options?.template) {
    const scaffoldCmd = getScaffoldCommand(options.template, targetDir)
    if (scaffoldCmd) {
      try {
        execSync(scaffoldCmd, { cwd: targetDir, encoding: 'utf-8', stdio: 'pipe', timeout: 120_000 })
      } catch {
        // Template scaffold failed — project still usable with empty git
      }
    }
  }

  return initProject(targetDir)
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
