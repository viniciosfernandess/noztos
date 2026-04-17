// ── Local Compute Provider ─────────────────────────────────────────────
//
// Executes commands directly on the user's machine instead of in a
// remote E2B sandbox. Used when the Bornastar companion is running
// locally and the user's Claude Code handles all AI interactions.
//
// The `sandboxId` parameter on every method is repurposed as the
// project root path (e.g. "/Users/vini/projects/my-app"). This
// keeps the ComputeProvider interface unchanged — callers don't
// need to know whether they're talking to E2B or local disk.

import { exec as execCb } from 'node:child_process'
import { readFile as fsReadFile, writeFile as fsWriteFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { ComputeProvider, SandboxInfo, ExecResult } from './compute'

const execPromise = promisify(execCb)

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_BUFFER = 10 * 1024 * 1024 // 10 MB

export class LocalProvider implements ComputeProvider {
  // In local mode, "creating a sandbox" just means verifying the
  // project directory exists. Returns the absolute path as the id.
  async createSandbox(repoUrl?: string): Promise<SandboxInfo> {
    if (repoUrl && repoUrl.startsWith('/')) {
      // Local path — just verify it exists
      if (!existsSync(repoUrl)) {
        throw new Error(`Project directory does not exist: ${repoUrl}`)
      }
      return { id: resolve(repoUrl), status: 'running' }
    }

    if (repoUrl) {
      // Git URL — clone to a temp location
      const repoName = repoUrl.split('/').pop()?.replace('.git', '') ?? 'project'
      const targetDir = join(process.env.HOME ?? '/tmp', 'bornastar-projects', repoName)
      if (!existsSync(targetDir)) {
        await mkdir(dirname(targetDir), { recursive: true })
        await execPromise(`git clone ${repoUrl} ${targetDir}`, {
          timeout: 120_000,
        })
      }
      return { id: resolve(targetDir), status: 'running' }
    }

    return { id: process.cwd(), status: 'running' }
  }

  // Execute a command. The `sandboxId` is actually the project root
  // path. Commands may include `cd /some/path && ...` — we extract
  // the cwd from the command prefix when present, otherwise default
  // to the project root.
  async exec(sandboxId: string, command: string): Promise<ExecResult> {
    // Many callers do `cd ${path} && actual_command`. Extract the
    // cwd so child_process runs in the right directory.
    let cwd = sandboxId
    let cmd = command

    const cdMatch = command.match(/^cd\s+(\S+)\s*&&\s*([\s\S]+)$/)
    if (cdMatch) {
      cwd = cdMatch[1]
      cmd = cdMatch[2]
    }

    // Resolve relative paths against sandboxId
    if (!cwd.startsWith('/')) {
      cwd = resolve(sandboxId, cwd)
    }

    try {
      const { stdout, stderr } = await execPromise(cmd, {
        cwd,
        timeout: DEFAULT_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        env: { ...process.env },
        shell: '/bin/bash',
      })
      return {
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        exitCode: 0,
      }
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; code?: number; signal?: string }
      return {
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? (err as Error).message ?? '',
        exitCode: e.code ?? 1,
      }
    }
  }

  // No-op in local mode — nothing to stop.
  async stopSandbox(_sandboxId: string): Promise<void> {
    // Local filesystem doesn't need cleanup
  }

  // Always "running" in local mode.
  async isRunning(_sandboxId: string): Promise<boolean> {
    return true
  }

  // List files in a directory.
  async listFiles(sandboxId: string, path: string): Promise<string[]> {
    const fullPath = path.startsWith('/') ? path : join(sandboxId, path)
    try {
      const { stdout } = await execPromise(
        `find "${fullPath}" -type f -not -path '*/.git/*' -not -path '*/node_modules/*' -not -path '*/__pycache__/*' -not -path '*/.next/*' -not -path '*/dist/*' | sort`,
        { cwd: sandboxId, timeout: DEFAULT_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
      )
      return stdout.split('\n').filter(Boolean)
    } catch {
      return []
    }
  }

  // Read a file from the local filesystem.
  async readFile(_sandboxId: string, path: string): Promise<string> {
    const fullPath = resolve(path)
    return fsReadFile(fullPath, 'utf-8')
  }

  // Write a file to the local filesystem.
  async writeFile(_sandboxId: string, path: string, content: string): Promise<void> {
    const fullPath = resolve(path)
    await mkdir(dirname(fullPath), { recursive: true })
    await fsWriteFile(fullPath, content, 'utf-8')
  }
}
