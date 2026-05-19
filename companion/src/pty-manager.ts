import * as pty from 'node-pty'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'

// ── PTY manager ─────────────────────────────────────────────────────────
//
// One persistent shell PTY per terminal "context" — a context is a
// worktreeId. Mirrors how the daemon already keeps one ClaudeBridge per
// chat session: same long-lived process pattern, just for the terminal
// panel instead of the agent runner.
//
// We spawn /bin/zsh, NOT bash. macOS's patched bash 3.2 hardcodes the
// "default interactive shell is now zsh" notice into the binary itself
// — it fires for every interactive bash session regardless of --norc /
// --noprofile. zsh has been the macOS default since 10.15 and emits
// no such banner when started with --no-rcs --no-globalrcs.
//
// Lifecycle
// ─────────
// • attach(ctx, opts) — spawn fresh OR reattach to an existing PTY.
//   Returns the ring buffer so the browser can repaint the recent
//   scrollback before live data starts arriving. Always (re)arms the
//   activity-TTL: a tab that closes without sending detach won't leak
//   the PTY forever.
// • input(ctx, data) — write keystrokes to the PTY's stdin AND reset
//   the activity-TTL (real user engagement = keep alive).
// • resize(ctx, cols, rows) — propagate terminal size to the PTY.
// • detach(ctx) — soft detach: shorten TTL to the post-detach window
//   (10 min). A reattach within the window cancels the kill.
// • kill(ctx) — hard kill (used on shutdown / hard close).
//
// What survives what
// ──────────────────
// • Browser tab closes → daemon doesn't immediately get detach. The
//   activity-TTL (last reset on most-recent input) eventually fires;
//   if a child process is still running (build, vim, etc.) we extend,
//   otherwise we kill.
// • Reattach within 10 min after detach → same bash session intact:
//   vim still open, cd preserved, env intact.
// • Mac sleeps → PTY pauses, resumes when Mac wakes.
// • Mac powers off → daemon dies, PTYs die. Inevitable.
//
// Ring buffer
// ───────────
// Capped at RING_BUFFER_CAP_BYTES (~200KB) of recent output, including
// ANSI escape sequences. Browser-side `terminalCache` keeps a separate,
// smaller plain-text snapshot for instant re-render across remounts
// when the daemon-side PTY has died (worktree fully cold).

const RING_BUFFER_CAP_BYTES = 200_000
// Post-detach TTL: only timer left on a PTY. Armed by detach() when
// the browser panel unmounts (worktree switch / right-panel close /
// page refresh). Aligned with the browser's IDLE_EVICTION_MS so a
// PTY dies in the same moment its worktree cache slice is evicted —
// one consistent "this worktree went cold" beat across the system.
// A still-mounted panel never has this armed: keystroke idleness
// does NOT kill the shell, matching local-terminal mental model.
const DETACH_TTL_MS = 60 * 60 * 1000  // 1h
// When TTL fires but a child process is running (npm test, vim, etc.),
// extend by this much before checking again. Long enough to not burn
// ps polls in tight loops; bounded so a truly stuck process can't sit
// forever.
const CHILD_EXTENSION_MS = 30 * 60 * 1000  // 30 min

interface PtyHandle {
  pty: pty.IPty
  // Concatenated tail of bytes the PTY has emitted, capped to
  // RING_BUFFER_CAP_BYTES. Stored as a string because node-pty already
  // hands us UTF-8 — TextDecoder gymnastics aren't worth it and the
  // size cap is char-based in practice.
  ringBuffer: string
  ttlTimer: NodeJS.Timeout | null
  cols: number
  rows: number
}

export class PtyManager extends EventEmitter {
  private handles: Map<string, PtyHandle> = new Map()
  private readonly detachTtlMs: number

  constructor(opts: { detachTtlMs?: number } = {}) {
    super()
    this.detachTtlMs = opts.detachTtlMs ?? DETACH_TTL_MS
  }

  // Open or reuse the PTY for a context. The browser calls this once
  // per mount (and once when reconnecting after SSE drops). Reattach
  // cancels the post-detach kill timer and resizes if the browser
  // dims changed while detached.
  attach(contextKey: string, opts: { cwd: string; cols: number; rows: number; displayName?: string }): { snapshot: string; reattached: boolean } {
    const existing = this.handles.get(contextKey)
    if (existing) {
      // Cancel any pending post-detach kill: the panel is back.
      if (existing.ttlTimer) { clearTimeout(existing.ttlTimer); existing.ttlTimer = null }
      if (opts.cols !== existing.cols || opts.rows !== existing.rows) {
        try { existing.pty.resize(opts.cols, opts.rows) } catch {}
        existing.cols = opts.cols
        existing.rows = opts.rows
      }
      console.log(`[pty] reattach ctx=${contextKey.slice(0, 8)} buffer=${existing.ringBuffer.length}b`)
      return { snapshot: existing.ringBuffer, reattached: true }
    }

    // PS1 in zsh prompt-escape notation: %F{36} = foreground 36 (cyan),
    // %f = reset. We use the worktree's `branchName` as displayName —
    // it's stable and matches what `git branch` shows. The auto-rename
    // feature changes the worktree's display name when the user sends
    // a chat message, but branchName stays put — that's the right
    // identifier in a terminal context.
    //
    // PROMPT_EOL_MARK='' suppresses zsh's `%` indicator that appears
    // when previous output didn't end with a newline. On a fresh
    // terminal it's misleading and visually noisy.
    const displayName = (opts.displayName ?? 'bornastar').replace(/'/g, '')
    const ps1 = `%F{36}${displayName}%f $ `
    const ptyProcess = pty.spawn('/bin/zsh', ['--no-rcs', '--no-globalrcs'], {
      cwd: opts.cwd,
      cols: opts.cols,
      rows: opts.rows,
      env: {
        ...process.env,
        PS1: ps1,
        PROMPT_EOL_MARK: '',
        TERM: 'xterm-256color',
      } as { [key: string]: string },
      name: 'xterm-256color',
    })

    const handle: PtyHandle = {
      pty: ptyProcess,
      ringBuffer: '',
      ttlTimer: null,
      cols: opts.cols,
      rows: opts.rows,
    }
    this.handles.set(contextKey, handle)

    ptyProcess.onData((data) => {
      const h = this.handles.get(contextKey)
      if (!h) return
      // Append + tail-cap. Slicing a long string is O(n) but n ~= 200KB,
      // happens at most once per output chunk — imperceptible.
      h.ringBuffer = (h.ringBuffer + data).slice(-RING_BUFFER_CAP_BYTES)
      this.emit('data', contextKey, data)
    })

    ptyProcess.onExit(({ exitCode }) => {
      const h = this.handles.get(contextKey)
      if (h?.ttlTimer) clearTimeout(h.ttlTimer)
      this.handles.delete(contextKey)
      console.log(`[pty] exit ctx=${contextKey.slice(0, 8)} code=${exitCode}`)
      this.emit('exit', contextKey, exitCode)
    })

    // Fresh PTY starts with no kill timer armed. A timer only exists
    // while the panel is detached (see detach() below) — keystroke
    // idleness alone never kills the shell.
    console.log(`[pty] spawn ctx=${contextKey.slice(0, 8)} pid=${ptyProcess.pid} cwd=${opts.cwd} name="${displayName}"`)
    return { snapshot: '', reattached: false }
  }

  input(contextKey: string, data: string): void {
    const h = this.handles.get(contextKey)
    if (!h) return
    h.pty.write(data)
  }

  resize(contextKey: string, cols: number, rows: number): void {
    const h = this.handles.get(contextKey)
    if (!h) return
    if (h.cols === cols && h.rows === rows) return
    try { h.pty.resize(cols, rows) } catch {}
    h.cols = cols
    h.rows = rows
  }

  detach(contextKey: string): void {
    const h = this.handles.get(contextKey)
    if (!h) return
    if (h.ttlTimer) clearTimeout(h.ttlTimer)
    h.ttlTimer = setTimeout(() => this.handleTtlExpiry(contextKey), this.detachTtlMs)
    console.log(`[pty] detach ctx=${contextKey.slice(0, 8)} ttl=${this.detachTtlMs}ms`)
  }

  kill(contextKey: string): void {
    const h = this.handles.get(contextKey)
    if (!h) return
    if (h.ttlTimer) { clearTimeout(h.ttlTimer); h.ttlTimer = null }
    try { h.pty.kill() } catch {}
    // map cleanup happens in onExit handler
  }

  // Shutdown fast-path. SIGKILL skips the shell's signal handlers
  // entirely — process dies in the kernel without flushing buffers,
  // running EXIT traps, or forwarding to children gracefully. That's
  // what we want when the user Ctrl+C's the daemon: stop NOW. The
  // graceful `kill()` above is for runtime scenarios where the shell
  // should get a chance to clean up (none today, but kept for parity
  // with claude-bridge's SIGINT→SIGTERM ladder). Without SIGKILL the
  // daemon process hangs ~2s waiting for the PTY master fds to flush
  // after SIGHUP — perceptible lag the user noticed.
  killAll(): void {
    for (const ctx of Array.from(this.handles.keys())) {
      const h = this.handles.get(ctx)
      if (!h) continue
      if (h.ttlTimer) { clearTimeout(h.ttlTimer); h.ttlTimer = null }
      try { h.pty.kill('SIGKILL') } catch {}
    }
  }

  // ── private ──────────────────────────────────────────────────────

  private async handleTtlExpiry(contextKey: string): Promise<void> {
    const h = this.handles.get(contextKey)
    if (!h) return
    h.ttlTimer = null
    const hasChild = await this.hasRunningChild(h.pty.pid)
    if (hasChild) {
      // User left a build / test / vim running while away — keep the
      // PTY alive and check again later. CHILD_EXTENSION_MS is long
      // enough that we don't churn `ps` checks in a tight loop, but
      // bounded so a truly stuck process doesn't sit forever.
      h.ttlTimer = setTimeout(() => this.handleTtlExpiry(contextKey), CHILD_EXTENSION_MS)
      console.log(`[pty] ttl expired but child running ctx=${contextKey.slice(0, 8)} — extending ${CHILD_EXTENSION_MS}ms`)
      return
    }
    console.log(`[pty] ttl expired killing ctx=${contextKey.slice(0, 8)}`)
    this.kill(contextKey)
  }

  // Check whether the shell (PID `parentPid`) has any child processes
  // alive by listing its process group. The PTY-spawned shell is the
  // head of its own group; foreground children join it automatically.
  // Returns false on errors so a flaky `ps` doesn't keep PTYs alive
  // forever.
  private hasRunningChild(parentPid: number): Promise<boolean> {
    return new Promise((resolve) => {
      const ps = spawn('ps', ['-o', 'pid=', '-g', String(parentPid)])
      let out = ''
      ps.stdout.on('data', (d) => { out += d.toString() })
      ps.on('exit', () => {
        const pids = out.split('\n').map((p) => p.trim()).filter(Boolean)
        // The shell itself is always in its own group, so >1 means at
        // least one child is alive.
        resolve(pids.length > 1)
      })
      ps.on('error', () => resolve(false))
    })
  }
}
