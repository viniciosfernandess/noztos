'use client'

import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { getCachedTerminal, setCachedTerminal, markPtyAttached } from '@/lib/worktree-cache'

// ── XTerm panel ──────────────────────────────────────────────────────
//
// Real shell terminal (zsh PTY) inside the right-panel "Terminal" tab.
// Replaces the line-buffered console that ran each command as a fresh
// child_process.exec() — now we keep ONE shell PTY per worktree alive
// in the daemon, stream bytes both directions, and let xterm.js handle
// every quirk of terminal emulation (cursor, ANSI colors, alt-screen
// for vim, ctrl-c, etc).
//
// Lifecycle (mirrors the cache pontas pattern):
//   • Mount: paint the cached snapshot for instant continuity, then
//     POST attach — the daemon either spawns a fresh PTY or reattaches
//     to the existing one and replays its ring buffer so live bytes
//     pick up where they left off.
//   • While mounted: keystrokes → POST /pty input. SSE push pty_data
//     → window event → term.write(). ResizeObserver → POST /pty resize.
//   • Unmount: POST detach (soft). Daemon starts the post-detach TTL
//     so a remount within the window picks up the same bash session
//     intact (vim still open, cd preserved, env intact).
//
// Cache integration:
//   • terminalCache snapshot = a plain-text dump of the last N rows
//     from xterm's serializer. Lets a fully cold worktree (PTY died,
//     daemon restarted) still show what the user last saw before the
//     next attach repopulates the live PTY.
//
// Wipe-before-write semantics:
//   The cached snapshot we paint on init is browser-only memory —
//   potentially stale (captured by an earlier daemon run, by a
//   previous mount, or by StrictMode's mount→cleanup→remount cycle in
//   dev). When the daemon's authoritative bytes arrive we have to
//   wipe whatever the cache painted, otherwise the two layers stack
//   visually (e.g. the prompt shows up twice). We use the VT100 RIS
//   escape (`\x1bc`) which clears scrollback + screen + cursor +
//   attributes — same primitive VSCode / Hyper / xterm-addon-serialize
//   use when restoring serialized state. We wipe both on the first
//   data of this mount cycle AND on every reattach replay (which can
//   arrive AFTER a live event in StrictMode races, so the
//   firstDataReceived flag alone isn't enough).

interface PtyDataEvent extends CustomEvent {
  detail: { contextKey: string; data: string; reattached: boolean }
}

interface PtyExitEvent extends CustomEvent {
  detail: { contextKey: string; exitCode: number }
}

const SNAPSHOT_PERSIST_INTERVAL_MS = 1500

export function XTermPanel({
  projectId,
  contextKey,
  worktreeId,
}: {
  projectId: string
  contextKey: string
  worktreeId: string
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const persistTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const cached = getCachedTerminal(contextKey)
    console.log(`[term] mount ctx=${contextKey.slice(0, 8)} ${cached ? `cache HIT snapshot=${cached.snapshot.length}b cols=${cached.cols}x${cached.rows}` : 'cache MISS'}`)

    // xterm rejects `undefined` for cols/rows (must be numeric). Build
    // the options object so the keys are absent when we have no cached
    // size — xterm uses its own defaults, then FitAddon below recomputes
    // from the container.
    const termOpts: ConstructorParameters<typeof Terminal>[0] = {
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      theme: { background: '#181818' },
      // Default is 1000 — keep at 1000 so a single panel never
      // dominates browser RAM, but big enough for a typical session.
      scrollback: 1000,
      convertEol: true,
    }
    if (cached?.cols && cached?.rows) {
      termOpts.cols = cached.cols
      termOpts.rows = cached.rows
    }
    const term = new Terminal(termOpts)
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    fit.fit()
    termRef.current = term
    fitRef.current = fit

    // Replay the cached snapshot before the daemon's ring buffer
    // arrives. The reattach path replays the (richer, ANSI-coloured)
    // ring buffer right after, RIS-wiping over the plain-text
    // snapshot. If the daemon's PTY died and the worktree is fully
    // cold, the snapshot is the only continuity the user gets — better
    // than a blank screen.
    if (cached?.snapshot) {
      term.write(cached.snapshot)
    }

    // Attach to the daemon-side PTY. Flip the protector flag
    // immediately so even a fast-clicking user (mount → switch
    // worktree before the POST resolves) keeps the source worktree's
    // caches warm. If the attach fetch fails the next pty_exit event
    // will clear it; the inconsistency window is at most one round-trip.
    const cols = term.cols
    const rows = term.rows
    markPtyAttached(contextKey)
    console.log(`[term] /pty attach ctx=${contextKey.slice(0, 8)} cols=${cols}x${rows} wt=${worktreeId.slice(0, 8)}`)
    void fetch(`/api/projects/${projectId}/pty`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'attach',
        contextKey,
        worktreeId,
        cols,
        rows,
      }),
    }).catch(() => {})

    // Forward keystrokes. xterm's onData fires for every byte the
    // user produces, including arrow keys and terminal escape
    // sequences — bash receives a faithful stream identical to a
    // native tty.
    const onDataDispose = term.onData((data) => {
      void fetch(`/api/projects/${projectId}/pty`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'input', contextKey, data }),
      }).catch(() => {})
    })

    // Push PTY output coming back from the daemon. Filter by
    // contextKey because the same window receives events for every
    // active panel.
    let firstDataReceived = false
    function handlePtyData(e: Event) {
      const detail = (e as PtyDataEvent).detail
      if (detail.contextKey !== contextKey) return
      // Wipe the screen before painting whenever:
      //   • This is the first data event of the mount (cached snapshot
      //     we painted on init is now superseded), OR
      //   • The frame is a reattach replay (`reattached: true`) — the
      //     daemon's ring buffer is the authoritative version, even
      //     if a prior live event already arrived in this cycle
      //     (StrictMode dev can deliver both in the same mount).
      if (detail.reattached || !firstDataReceived) {
        firstDataReceived = true
        term.write('\x1bc')
      }
      term.write(detail.data)
    }
    function handlePtyExit(e: Event) {
      const detail = (e as PtyExitEvent).detail
      if (detail.contextKey !== contextKey) return
      // Surface the goodbye line briefly so the user sees what
      // happened (user typed `exit`, daemon restarted, zsh crashed,
      // or the worktree went cold and got swept). Then auto-respawn
      // since this panel is still mounted: that's exactly the local-
      // terminal feel — a dead shell isn't a dead terminal, you just
      // get a fresh one. Daemon's attach handles the no-handle case
      // by spawning a new PTY (see companion/src/pty-manager.ts).
      term.write(`\r\n\x1b[2m[shell exited with code ${detail.exitCode}, restarting…]\x1b[0m\r\n`)
      firstDataReceived = false
      const c = term.cols
      const r = term.rows
      markPtyAttached(contextKey)
      console.log(`[term] auto-respawn ctx=${contextKey.slice(0, 8)} cols=${c}x${r} wt=${worktreeId.slice(0, 8)}`)
      void fetch(`/api/projects/${projectId}/pty`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'attach',
          contextKey,
          worktreeId,
          cols: c,
          rows: r,
        }),
      }).catch(() => {})
    }
    window.addEventListener('bornastar-pty-data', handlePtyData as EventListener)
    window.addEventListener('bornastar-pty-exit', handlePtyExit as EventListener)

    // Track size changes and propagate to the daemon. ResizeObserver
    // fires on container layout changes — fit.fit() recomputes
    // cols/rows from pixel dimensions, then we tell the PTY.
    let lastCols = cols
    let lastRows = rows
    const resizeObserver = new ResizeObserver(() => {
      try { fit.fit() } catch { return }
      const c = term.cols
      const r = term.rows
      if (c === lastCols && r === lastRows) return
      lastCols = c
      lastRows = r
      void fetch(`/api/projects/${projectId}/pty`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'resize', contextKey, cols: c, rows: r }),
      }).catch(() => {})
    })
    resizeObserver.observe(container)

    // Periodically snapshot the visible buffer to terminalCache so a
    // cold remount (PTY dead, daemon restarted) still shows the user
    // what they last saw before live bytes arrive. We sample on a
    // timer instead of every onWriteParsed because the latter fires
    // hundreds of times per second during a build.
    let lastPersistedBytes = 0
    const persistSnapshot = () => {
      try {
        const buffer = term.buffer.active
        const lines: string[] = []
        for (let i = 0; i < buffer.length; i++) {
          const ln = buffer.getLine(i)
          if (!ln) continue
          const text = ln.translateToString(true)
          if (text.length === 0) continue
          lines.push(text)
        }
        // Last ~200 lines is plenty for "what the user just saw".
        // setCachedTerminal further caps by bytes so a noisy build
        // log can't blow the cache budget.
        const snapshot = lines.slice(-200).join('\r\n') + '\r\n'
        setCachedTerminal(contextKey, {
          snapshot,
          cols: term.cols,
          rows: term.rows,
        })
        // Only log when the snapshot grew/shrank meaningfully so the
        // 1.5s tick during a build doesn't spam.
        if (Math.abs(snapshot.length - lastPersistedBytes) > 256) {
          console.log(`[term] persist ctx=${contextKey.slice(0, 8)} snapshot=${snapshot.length}b lines=${lines.length} (was ${lastPersistedBytes}b)`)
          lastPersistedBytes = snapshot.length
        }
      } catch {}
    }
    persistTimerRef.current = setInterval(persistSnapshot, SNAPSHOT_PERSIST_INTERVAL_MS)

    return () => {
      console.log(`[term] unmount ctx=${contextKey.slice(0, 8)} → /pty detach`)
      // Soft detach — daemon keeps PTY alive within TTL so a remount
      // within the window picks up the same bash session.
      void fetch(`/api/projects/${projectId}/pty`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'detach', contextKey }),
      }).catch(() => {})

      window.removeEventListener('bornastar-pty-data', handlePtyData as EventListener)
      window.removeEventListener('bornastar-pty-exit', handlePtyExit as EventListener)
      resizeObserver.disconnect()
      onDataDispose.dispose()
      if (persistTimerRef.current) clearInterval(persistTimerRef.current)
      // Final snapshot so the remount path sees the freshest tail.
      persistSnapshot()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // Only remount when the addressable PTY changes. worktreeId is
    // passed in the /pty/attach body for server-side cwd resolution,
    // but it's already encoded in `contextKey` — switching between
    // chats inside the same worktree changes nothing here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, contextKey])

  return (
    <div
      ref={containerRef}
      className="h-full w-full"
      style={{ backgroundColor: '#181818' }}
      onClick={() => termRef.current?.focus()}
    />
  )
}
