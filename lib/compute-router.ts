// ── Compute provider routing ────────────────────────────────────────
//
// All FS-touching helpers (lib/git.ts, lib/worktree.ts, lib/tools.ts)
// instantiate a single `compute` at module load and call its methods
// with a `sandboxId` (which in practice is either the project root
// path or a worktree path).
//
// Cloud Mirror introduces a second backend (E2B sandbox). To keep the
// existing helpers and ~10 endpoint callers unchanged, this module
// exposes `CloudAwareCompute` — a ComputeProvider that inspects the
// path at every call, detects whether it belongs to a worktree in
// cloud mode, and routes to E2BProvider; otherwise delegates to the
// existing LocalProvider.
//
// Detection: worktrees always live at
//   <homeDir>/.bornastar/worktrees/<projectId>/<worktreeId>/<...>
// so we extract <worktreeId> by pattern. Anything outside that prefix
// is a main-branch path and stays on local.

import type { ComputeProvider, SandboxInfo, ExecResult } from './compute'
import { LocalProvider } from './compute-local'
import { E2BProvider } from './compute-e2b'
import { prisma } from './db'

const WORKTREE_PATH_PATTERN = /[/\\]\.bornastar[/\\]worktrees[/\\][^/\\]+[/\\]([^/\\]+)(?:[/\\]|$)/

/**
 * Pull the worktreeId out of any absolute path that lives inside the
 * canonical worktrees directory. Returns null for project-root paths,
 * cwds, or anything outside the .bornastar/worktrees tree.
 */
export function extractWorktreeIdFromPath(path: string): string | null {
  const m = path.match(WORKTREE_PATH_PATTERN)
  return m ? m[1] : null
}

/**
 * Cached lookup of activeContext per worktree. Each request handler is
 * a fresh module evaluation in Next.js dev, but in prod the cache
 * survives across requests. TTL is short — a cloud→local switch should
 * propagate within seconds without forcing a process restart.
 */
const contextCache = new Map<string, { context: string; expiresAt: number }>()
const CONTEXT_CACHE_TTL_MS = 5_000

async function getActiveContext(worktreeId: string): Promise<string> {
  const now = Date.now()
  const cached = contextCache.get(worktreeId)
  if (cached && cached.expiresAt > now) return cached.context

  const wt = await prisma.worktree.findUnique({
    where: { id: worktreeId },
    select: { activeContext: true },
  })
  const context = wt?.activeContext ?? 'local'
  contextCache.set(worktreeId, { context, expiresAt: now + CONTEXT_CACHE_TTL_MS })
  return context
}

/**
 * Manual cache eviction — call from the cloud→local switch endpoint
 * so the routing flip is visible immediately rather than after the
 * TTL expires.
 */
export function evictContextCache(worktreeId?: string): void {
  if (worktreeId) contextCache.delete(worktreeId)
  else contextCache.clear()
}

export class CloudAwareCompute implements ComputeProvider {
  private readonly local = new LocalProvider()

  private async pickProvider(sandboxId: string): Promise<ComputeProvider> {
    const wtId = extractWorktreeIdFromPath(sandboxId)
    if (!wtId) return this.local
    const ctx = await getActiveContext(wtId)
    if (ctx === 'cloud') return new E2BProvider(wtId)
    return this.local
  }

  async createSandbox(repoUrl?: string): Promise<SandboxInfo> {
    // createSandbox is called only for main-branch / project setup, not
    // for individual worktrees — those are managed by provisionWorktree.
    // Always delegate to local; cloud sandboxes are provisioned via
    // /api/cloud/switch on demand.
    return this.local.createSandbox(repoUrl)
  }

  async exec(sandboxId: string, command: string): Promise<ExecResult> {
    const provider = await this.pickProvider(sandboxId)
    return provider.exec(sandboxId, command)
  }

  async stopSandbox(sandboxId: string): Promise<void> {
    const provider = await this.pickProvider(sandboxId)
    return provider.stopSandbox(sandboxId)
  }

  async readFile(sandboxId: string, path: string): Promise<string> {
    const provider = await this.pickProvider(sandboxId)
    return provider.readFile(sandboxId, path)
  }

  async writeFile(sandboxId: string, path: string, content: string): Promise<void> {
    const provider = await this.pickProvider(sandboxId)
    return provider.writeFile(sandboxId, path, content)
  }
}

/**
 * Shared singleton — use this in module-scope `const compute = ...`
 * declarations across lib/* and app/api/* in place of `new LocalProvider()`.
 */
export const cloudAwareCompute = new CloudAwareCompute()
