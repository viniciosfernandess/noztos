'use client'

import { useEffect, useRef } from 'react'
import { companionStore } from '@/lib/companion-store'
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

    async function connect() {
      console.log('[provider] SSE connecting...')
      companionStore.setStatus('connecting')
      try {
        const res = await fetch('/api/companion/stream', { signal: controller.signal })
        if (!res.ok || !res.body) { console.warn('[provider] SSE open failed'); companionStore.setStatus('error'); return }
        console.log('[provider] SSE open')
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        while (true) {
          const { done, value } = await reader.read()
          if (done) { console.log('[provider] SSE closed by server'); break }
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
                const payload = event.payload as unknown as { projectPath?: string; paths?: string[] } | undefined
                window.dispatchEvent(new CustomEvent('bornastar-fs-change', {
                  detail: { projectPath: payload?.projectPath, paths: payload?.paths ?? [] },
                }))
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
          companionStore.setStatus('error')
        }
      }
    }

    const unsubscribeEpoch = companionStore.subscribeEpoch(() => {
      const next = companionStore.getConnectionEpoch()
      if (next === epochRef.current) return
      epochRef.current = next
      console.log(`[provider] reconnect (epoch=${next})`)
      // Abort and reopen. No wait — keep event loop tight.
      controller.abort()
      controller = new AbortController()
      connect()
    })

    connect()

    return () => {
      disposed = true
      unsubscribeEpoch()
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
