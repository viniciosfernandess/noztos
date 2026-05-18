// Request/response shell execution over the companion SSE relay.
//
// The server (this Next.js process) needs to run shell commands on the
// user's Mac — e.g. `git worktree add` during worktree provisioning.
// When Next.js is hosted on Railway, child_process.exec runs in the
// container, NOT on the user's machine, so the local-first paths
// (LocalProvider) silently fail.
//
// Flow:
//   1. server calls execOnCompanion(userId, cwd, command)
//   2. we register a pending promise keyed by reqId
//   3. push { type:'exec', reqId, cwd, command } onto the user's
//      channel — the daemon picks it up via /api/companion/stream
//   4. daemon runs the command locally, posts the result back to
//      /api/companion/response with { type:'exec_response', reqId, ... }
//   5. the response route calls resolveCompanionExec(reqId, result)
//      which resolves the pending promise
//
// Timeouts default to 60 s. Pending entries are cleaned up on timeout
// or response. There's no retry — the caller (provisionWorktree, etc)
// handles its own idempotency.

import { randomUUID } from 'node:crypto'
import { pushCommandToCompanion } from './companion-relay'

export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
}

interface Pending {
  resolve: (r: ExecResult) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
  // Snippet of the command for richer timeout / orphan-response logging.
  commandSnippet: string
}

const pending = new Map<string, Pending>()

/**
 * Run a shell command on the user's machine via their companion
 * daemon. Resolves with the exec result, or rejects on timeout / no
 * companion connected.
 */
export function execOnCompanion(
  userId: string,
  cwd: string,
  command: string,
  timeoutMs = 60_000,
): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve, reject) => {
    const reqId = randomUUID()
    const commandSnippet = command.slice(0, 80)

    const timer = setTimeout(() => {
      pending.delete(reqId)
      reject(new Error(`Companion exec timed out (${timeoutMs}ms): ${commandSnippet}`))
    }, timeoutMs)

    pending.set(reqId, { resolve, reject, timer, commandSnippet })

    const pushed = pushCommandToCompanion(userId, {
      type: 'exec',
      reqId,
      cwd,
      command,
    })

    if (!pushed) {
      clearTimeout(timer)
      pending.delete(reqId)
      reject(new Error('Companion not connected — cannot run local command'))
    }
  })
}

/**
 * Called by /api/companion/response when the daemon reports back the
 * result of an exec it ran. Returns true if we had a pending request
 * for this reqId (so the route can log orphan responses).
 */
export function resolveCompanionExec(reqId: string, result: ExecResult): boolean {
  const p = pending.get(reqId)
  if (!p) return false
  clearTimeout(p.timer)
  pending.delete(reqId)
  p.resolve(result)
  return true
}
