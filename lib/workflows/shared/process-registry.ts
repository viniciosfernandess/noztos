// Per-run handles of the spawned `claude -p` child processes.
//
// Cancel via DB flag alone takes effect only at the next runner checkpoint
// (between steps/blocks) — meanwhile the in-flight steps keep editing files.
// The registry lets the cancel endpoint deliver SIGTERM directly so "pausa"
// is instantaneous from the user's perspective.
//
// A single run can have multiple concurrent children — /debug fans out N
// detectives in parallel. We track a Set per runId so killRun() takes them
// all down at once. Cancelling never has to know which agent is in flight.
//
// V1 lives in the Next.js server process memory. When the daemon adapter
// lands, this becomes a thin RPC to "kill remote children for run X".
//
// HMR-stable: Next.js dev re-imports module on edit; a plain Map would
// reset and lose track of in-flight runs. Bind to `globalThis` so the
// instance survives reloads.

import type { ChildProcess } from 'node:child_process'

type Registry = Map<string, Set<ChildProcess>>
const g = globalThis as unknown as { __workflowProcessRegistry?: Registry }
const registry: Registry = g.__workflowProcessRegistry ?? new Map()
g.__workflowProcessRegistry = registry

export function registerChild(runId: string, child: ChildProcess): void {
  let set = registry.get(runId)
  if (!set) { set = new Set(); registry.set(runId, set) }
  set.add(child)
}

// Idempotent: only removes the matching handle. When the last child of
// the run exits, the empty set is cleaned up so isRunActive returns false.
export function unregisterChild(runId: string, child: ChildProcess): void {
  const set = registry.get(runId)
  if (!set) return
  set.delete(child)
  if (set.size === 0) registry.delete(runId)
}

// Deliver SIGTERM to every live child of the run; SIGKILL fallback after
// 2s for any that ignore the first signal. Returns the number of handles
// that were live and signalled — useful for logs.
export function killRun(runId: string): number {
  const set = registry.get(runId)
  if (!set || set.size === 0) return 0
  let signalled = 0
  for (const child of set) {
    if (child.killed) continue
    try {
      child.kill('SIGTERM')
      signalled++
      const fallback = setTimeout(() => {
        if (!child.killed && registry.get(runId)?.has(child)) {
          try { child.kill('SIGKILL') } catch { /* swallow */ }
        }
      }, 2000)
      if (typeof fallback.unref === 'function') fallback.unref()
    } catch { /* per-child best-effort */ }
  }
  return signalled
}

export function isRunActive(runId: string): boolean {
  const set = registry.get(runId)
  if (!set) return false
  for (const child of set) if (!child.killed) return true
  return false
}
