'use client'

import { useEffect, useRef, useSyncExternalStore } from 'react'
import { companionStore, type WorkflowRunUIState } from '@/lib/companion-store'

// Subscribe to a Builder Workflow run's live snapshot in the store.
//
// Two paths feed the store:
//   1. SSE `workflow_progress` deltas — instant, fed by the relay
//      (CompanionProvider routes them on arrival).
//   2. Cold-load via GET /api/workflow/[runId] — first mount + reconnect
//      fallback. Hydrates the snapshot wholesale; SSE deltas layer on top.
//
// While the run is non-terminal, a low-frequency backup poll runs every
// `BACKUP_POLL_MS` to recover from missed SSE frames or partial outages.
// On terminal status, polling stops but the snapshot stays in the store
// — the WorkflowRunCard keeps rendering the final state until the user
// dismisses it (companionStore.dismissWorkflowRun).

const BACKUP_POLL_MS = 10_000
const TERMINAL = new Set(['completed', 'failed', 'cancelled'])

export type { WorkflowRunUIState }

export function useWorkflowSnapshot(runId: string | null): WorkflowRunUIState | null {
  const snapshot = useSyncExternalStore(
    (cb) => (runId ? companionStore.subscribeWorkflowSnapshot(runId, cb) : () => {}),
    () => (runId ? companionStore.getWorkflowSnapshot(runId) ?? null : null),
    () => null,
  )

  // Cold-load on mount + reconnect, low-freq poll while non-terminal.
  // Refs guard against React strict-mode double effects and against
  // racing a stale runId after the user dismisses.
  const cancelledRef = useRef(false)
  useEffect(() => {
    if (!runId) return
    cancelledRef.current = false
    let timer: ReturnType<typeof setTimeout> | null = null

    async function fetchOnce() {
      try {
        const res = await fetch(`/api/workflow/${runId}`)
        if (!res.ok) {
          console.warn(`[wf-snapshot] runId=${runId!.slice(0, 8)} fetch status=${res.status}`)
          return null
        }
        const data = (await res.json()) as WorkflowRunUIState
        if (cancelledRef.current) return null
        companionStore.hydrateWorkflowSnapshot(runId!, data)
        return data
      } catch (err) {
        console.warn(`[wf-snapshot] runId=${runId!.slice(0, 8)} fetch error:`, err)
        return null
      }
    }

    async function tick() {
      if (cancelledRef.current) return
      const data = await fetchOnce()
      if (cancelledRef.current) return
      if (data && TERMINAL.has(data.status)) {
        console.log(`[wf-snapshot] runId=${runId!.slice(0, 8)} terminal status=${data.status} → stop poll (snapshot retained)`)
        return
      }
      if (!cancelledRef.current) timer = setTimeout(tick, BACKUP_POLL_MS)
    }

    // Hydrate immediately so the card has a frame to render before any
    // SSE delta arrives (or in case the run is already terminal on mount).
    void tick()

    return () => {
      cancelledRef.current = true
      if (timer) clearTimeout(timer)
    }
  }, [runId])

  return snapshot
}
