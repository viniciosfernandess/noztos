'use client'

import { useEffect, useRef } from 'react'
import { companionStore } from '@/lib/companion-store'
import { markPtyExited } from '@/lib/worktree-cache'
import type { ClaudeEvent } from '@/lib/hooks/useCompanionStream'

// ── CompanionProvider ───────────────────────────────────────────────
//
// Mount once inside WorkPanel. Owns the ONLY SSE connection to
// /api/companion/stream, parses every frame and dispatches into the
// module-level `companionStore` — which every ChatPanel then subscribes
// to via selectors.
//
// Renders nothing by default; wraps children so React's tree wiring
// is unchanged. Visibility-aware: iOS Safari / Chrome background tabs
// suspend fetch streams, so when the tab becomes visible again we
// bump the store's connection epoch — the SSE effect re-runs and
// reconnects.
export function CompanionProvider({ children }: { children: React.ReactNode }) {
  // Track the current epoch value with a ref so the effect below only
  // re-runs when reconnect() is explicitly called (not on every render).
  const epochRef = useRef(companionStore.getConnectionEpoch())

  useEffect(() => {
    let controller = new AbortController()
    let disposed = false
    // Auto-reconnect with exponential backoff. The stream can close for
    // many reasons that aren't bugs — a server restart, a hot reload, a
    // proxy timeout, the daemon flipping offline, a transient network
    // blip. Without a retry loop the only way back was a tab refresh
    // (browser visibility change), which the user shouldn't have to
    // perform. retryDelay doubles each failure up to 30s, then resets
    // to 1s as soon as we successfully read a frame again.
    const INITIAL_RETRY_MS = 1_000
    const MAX_RETRY_MS = 30_000
    let retryDelay = INITIAL_RETRY_MS
    let retryTimer: ReturnType<typeof setTimeout> | null = null

    function scheduleReconnect(): void {
      if (disposed) return
      if (retryTimer) return // already scheduled
      console.log(`[provider] reconnecting in ${retryDelay}ms`)
      retryTimer = setTimeout(() => {
        retryTimer = null
        if (disposed) return
        controller = new AbortController()
        connect()
      }, retryDelay)
      retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS)
    }

    async function connect() {
      console.log('[provider] SSE connecting...')
      companionStore.setStatus('connecting')
      try {
        const res = await fetch('/api/companion/stream', { signal: controller.signal })
        if (!res.ok || !res.body) {
          console.warn('[provider] SSE open failed status=' + res.status)
          companionStore.setStatus('error')
          scheduleReconnect()
          return
        }
        console.log('[provider] SSE open')
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        while (true) {
          const { done, value } = await reader.read()
          if (done) {
            console.log('[provider] SSE closed by server — scheduling reconnect')
            companionStore.setStatus('disconnected')
            scheduleReconnect()
            return
          }
          // Got real data — connection is healthy, reset the backoff so
          // the next failure starts from 1s again.
          retryDelay = INITIAL_RETRY_MS
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue
            try {
              const event = JSON.parse(line.slice(6)) as ClaudeEvent
              // fs_change is a DOM event for the file explorer, not a
              // store concern — dispatch and skip. It's not part of
              // ClaudeEvent's declared type union so we check via a
              // loose string compare.
              const rawType = (event as { type?: string }).type
              if (rawType === 'fs_change') {
                // Daemon batches carry `source` so the cache layer knows
                // which root (`project` = main view, `worktrees` =
                // `~/.bornastar/worktrees/<projectId>/`) the paths are
                // relative to. See lib/worktree-cache.ts FsChangeBatch.
                const payload = event.payload as unknown as { projectPath?: string; source?: 'project' | 'worktrees'; paths?: string[] } | undefined
                window.dispatchEvent(new CustomEvent('bornastar-fs-change', {
                  detail: {
                    projectPath: payload?.projectPath,
                    source: payload?.source ?? 'project',
                    paths: payload?.paths ?? [],
                  },
                }))
                continue
              }
              // PTY data/exit go to the XTermPanel for the matching
              // contextKey via window CustomEvents — same dispatch
              // pattern as fs_change. The store has nothing to do with
              // terminal bytes (no slice, no DB persistence), so
              // routing through companionStore.ingestClaudeEvent
              // would just burn a no-op switch case.
              if (rawType === 'pty_data') {
                const payload = event.payload as unknown as { contextKey?: string; data?: string; reattached?: boolean } | undefined
                if (payload?.contextKey && payload.data != null) {
                  console.log(`[pty] SSE pty_data ctx=${payload.contextKey.slice(0, 8)} bytes=${payload.data.length}${payload.reattached ? ' (reattach replay)' : ''}`)
                  window.dispatchEvent(new CustomEvent('bornastar-pty-data', {
                    detail: { contextKey: payload.contextKey, data: payload.data, reattached: !!payload.reattached },
                  }))
                }
                continue
              }
              if (rawType === 'pty_exit') {
                const payload = event.payload as unknown as { contextKey?: string; exitCode?: number } | undefined
                if (payload?.contextKey) {
                  console.log(`[pty] SSE pty_exit ctx=${payload.contextKey.slice(0, 8)} code=${payload.exitCode ?? 0}`)
                  // Clear the global PTY-active flag here — NOT inside
                  // XTermPanel's listener. If the user navigated away
                  // from this worktree's terminal (panel unmounted),
                  // the panel-scoped listener is gone but the daemon
                  // still emits pty_exit when its TTL fires. Without
                  // this global hook, ptyActiveContexts would leak
                  // forever and cacheProtector would protect a dead
                  // worktree's slices indefinitely.
                  markPtyExited(payload.contextKey)
                  window.dispatchEvent(new CustomEvent('bornastar-pty-exit', {
                    detail: { contextKey: payload.contextKey, exitCode: payload.exitCode ?? 0 },
                  }))
                }
                continue
              }
              // workflow_progress: live delta from a running Builder
              // workflow run. Bypasses ingestClaudeEvent (chat-message
              // path) and lands directly on the per-run snapshot in the
              // store. The card subscribes by runId.
              if (rawType === 'workflow_progress') {
                const payload = event.payload as unknown as {
                  bornastarSessionId?: string
                  runId?: string
                  seq?: number
                  role?: 'planner' | 'architect' | 'builder' | 'reviewer'
                  blockIndex?: number
                  attempt?: number
                  chunk?: unknown
                } | undefined
                if (payload?.runId && typeof payload.seq === 'number' && payload.role && typeof payload.blockIndex === 'number' && typeof payload.attempt === 'number' && payload.chunk) {
                  companionStore.ingestWorkflowProgress({
                    runId: payload.runId,
                    seq: payload.seq,
                    role: payload.role,
                    blockIndex: payload.blockIndex,
                    attempt: payload.attempt,
                    chunk: payload.chunk,
                  })
                }
                continue
              }
              // Unread tagging: a claude_event for a chat that isn't
              // the one on screen marks that chat as unread. The
              // active chat clears its own unread via the mark-read
              // endpoint + store.clearUnread when focused.
              if (event.type === 'claude_event') {
                const sid = event.payload?.bornastarSessionId
                const inner = event.payload?.event
                const contentEvent =
                  inner?.type === 'assistant'
                  || (inner?.type === 'user' && inner.message?.content?.some((c) => c.type === 'tool_result'))
                if (sid && contentEvent && sid !== getActiveSessionId()) {
                  companionStore.markUnread(sid)
                }
                // Trace key fields to diagnose context / ordering issues
                // without dumping the whole payload.
                const innerType = inner?.type ?? '(none)'
                const claudeSid = inner?.session_id?.slice(0, 8) ?? '-'
                const persistRowsN = Array.isArray(event.payload?.persistRows) ? event.payload.persistRows.length : 0
                console.log(`[provider] claude_event sid=${sid?.slice(0, 8) ?? '-'} inner=${innerType} claude=${claudeSid} rows=${persistRowsN}`)
              } else if (event.type !== 'running_sessions' && event.type !== 'companion_status') {
                console.log(`[provider] event type=${event.type}`)
              }
              companionStore.ingestClaudeEvent(event)
            } catch { /* non-JSON line */ }
          }
        }
      } catch (err) {
        if (!disposed && (err as Error).name !== 'AbortError') {
          console.warn('[provider] SSE error: ' + (err as Error).message)
          companionStore.setStatus('error')
          scheduleReconnect()
        }
      }
    }

    const unsubscribeEpoch = companionStore.subscribeEpoch(() => {
      const next = companionStore.getConnectionEpoch()
      if (next === epochRef.current) return
      epochRef.current = next
      console.log(`[provider] reconnect (epoch=${next})`)
      // Explicit reconnect — cancel any pending retry, abort the current
      // stream (caught as AbortError → no auto-retry), then open fresh.
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
      retryDelay = INITIAL_RETRY_MS
      controller.abort()
      controller = new AbortController()
      connect()
    })

    connect()

    return () => {
      disposed = true
      unsubscribeEpoch()
      if (retryTimer) clearTimeout(retryTimer)
      controller.abort()
    }
  }, [])

  // Visibility-aware reconnect. iOS Safari suspends the fetch stream
  // when the tab goes to background; when it returns, we bump the
  // store's epoch to force a reconnect + the ChatPanel's hydrate
  // effect refires via /session-state.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        companionStore.reconnect()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  return <>{children}</>
}

// The active session id is read at event-dispatch time so unread
// tagging knows which chat the user is currently viewing. Stored at
// module level + updated by ChatPanel on mount; no re-render cost.
let activeSessionId: string | null = null
export function setActiveSessionIdForUnread(sid: string | null): void {
  activeSessionId = sid
}
function getActiveSessionId(): string | null {
  return activeSessionId
}
