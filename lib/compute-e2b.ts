// ── Cloud (E2B) Compute Provider ────────────────────────────────────
//
// When a worktree's activeContext='cloud', this provider routes exec /
// readFile / writeFile to the E2B sandbox we provisioned via
// /api/cloud/switch. The sandbox materialised /workspace bit-perfect
// with the worktree's content; from a caller's perspective the only
// difference vs LocalProvider is that file operations now travel over
// the network instead of through libc.
//
// The `sandboxId` param on the ComputeProvider interface is interpreted
// differently per provider:
//   - LocalProvider: absolute path on disk (worktreePath or projectRoot)
//   - E2BProvider:   absolute path under /workspace inside the sandbox
//
// To keep the existing callers (lib/git.ts, lib/worktree.ts, etc) from
// having to know which mode they're in, the cloud-aware wrapper in
// compute-router.ts translates the local path → /workspace-relative
// path before delegating here.
//
// Connection caching: connecting to an E2B sandbox is ~200ms. We cache
// per-worktree handles so a burst of file reads doesn't repeatedly
// re-connect. Cache entries are evicted when the SandboxSession is
// marked destroyed (cloud→local switch or GC).

import { Sandbox } from 'e2b'
import type { ComputeProvider, SandboxInfo, ExecResult } from './compute'
import { prisma } from './db'

const E2B_API_KEY = process.env.E2B_API_KEY
const sandboxCache = new Map<string, { sandbox: Sandbox; expiresAt: number }>()
const CACHE_TTL_MS = 5 * 60 * 1000

async function getSandbox(worktreeId: string): Promise<Sandbox> {
  if (!E2B_API_KEY) {
    throw new Error('E2B_API_KEY not configured — cloud mode unavailable')
  }
  const now = Date.now()
  const cached = sandboxCache.get(worktreeId)
  if (cached && cached.expiresAt > now) return cached.sandbox

  const session = await prisma.sandboxSession.findFirst({
    where: {
      worktreeId,
      status: 'ready',
      destroyedAt: null,
    },
    orderBy: { createdAt: 'desc' },
  })
  if (!session || !session.e2bSandboxId) {
    throw new Error(`No ready sandbox for worktree ${worktreeId}`)
  }

  const sandbox = await Sandbox.connect(session.e2bSandboxId, { apiKey: E2B_API_KEY })
  sandboxCache.set(worktreeId, { sandbox, expiresAt: now + CACHE_TTL_MS })
  return sandbox
}

export function evictSandboxCache(worktreeId: string): void {
  sandboxCache.delete(worktreeId)
}

export class E2BProvider implements ComputeProvider {
  constructor(private readonly worktreeId: string) {}

  // No-op — sandbox lifecycle is managed by /api/cloud/switch (provision)
  // and /api/cloud/back-to-local (destroy). This method exists only to
  // satisfy the interface.
  async createSandbox(_repoUrl?: string): Promise<SandboxInfo> {
    const session = await prisma.sandboxSession.findFirst({
      where: { worktreeId: this.worktreeId, status: 'ready', destroyedAt: null },
    })
    return { id: session?.e2bSandboxId ?? '', status: session ? 'running' : 'stopped' }
  }

  async exec(sandboxId: string, command: string): Promise<ExecResult> {
    const sandbox = await getSandbox(this.worktreeId)
    // Many callers do "cd /local/path && actual_command" — strip the
    // cd prefix since /workspace inside the sandbox is already the
    // worktree root. We also rewrite any inline references to the
    // local sandbox path to /workspace so commands like
    //   cp /Users/x/.bornastar/worktrees/.../foo.ts dest
    // don't reference a path that doesn't exist inside the sandbox.
    let cmd = command
    const cdMatch = command.match(/^cd\s+\S+\s*&&\s*([\s\S]+)$/)
    if (cdMatch) cmd = cdMatch[1]
    if (sandboxId && sandboxId !== '/') {
      cmd = cmd.split(sandboxId).join('/workspace')
    }

    try {
      const result = await sandbox.commands.run(cmd, {
        cwd: '/workspace',
        timeoutMs: 30_000,
      })
      return {
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        exitCode: result.exitCode ?? 0,
      }
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; exitCode?: number; message?: string }
      return {
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? e.message ?? '',
        exitCode: typeof e.exitCode === 'number' ? e.exitCode : 1,
      }
    }
  }

  async stopSandbox(_sandboxId: string): Promise<void> {
    // No-op — see createSandbox comment.
  }

  // For readFile/writeFile, the caller passes a local path. We need to
  // translate it to a /workspace-relative path. The convention: the
  // path inside the sandbox is the same as the path relative to the
  // worktree root on the local machine. compute-router does that
  // translation before calling here, so by the time we receive `path`
  // it's already /workspace-relative (or just relative).
  async readFile(sandboxId: string, path: string): Promise<string> {
    const sandbox = await getSandbox(this.worktreeId)
    const resolved = this.translatePath(sandboxId, path)
    const content = await sandbox.files.read(resolved)
    return typeof content === 'string' ? content : Buffer.from(content).toString('utf-8')
  }

  async writeFile(sandboxId: string, path: string, content: string): Promise<void> {
    const sandbox = await getSandbox(this.worktreeId)
    const resolved = this.translatePath(sandboxId, path)
    await sandbox.files.write(resolved, content)
  }

  // Translate any local-side path into the sandbox-side equivalent.
  // - Absolute paths under sandboxId (the worktree root locally) → /workspace/<rest>
  // - Absolute paths outside sandboxId → preserved (caller's responsibility)
  // - Relative paths → /workspace/<path>
  private translatePath(sandboxId: string, path: string): string {
    if (path.startsWith('/')) {
      if (sandboxId && sandboxId !== '/' && path.startsWith(sandboxId)) {
        const rest = path.slice(sandboxId.length).replace(/^\/+/, '')
        return rest ? `/workspace/${rest}` : '/workspace'
      }
      return path
    }
    return `/workspace/${path}`
  }
}
