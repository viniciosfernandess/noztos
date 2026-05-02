'use client'

import { useCallback, useSyncExternalStore } from 'react'
import { companionStore, type CompanionInfo, type PendingAttachment } from '@/lib/companion-store'
import type { ChatMessage, CompanionStatus } from '@/lib/hooks/useCompanionStream'

// ── Selectors ──────────────────────────────────────────────────────
//
// Each hook subscribes to a narrow slice of the module-level store via
// `useSyncExternalStore`. Only components reading a given slice
// re-render when that slice changes — chat A getting a new token does
// not wake up chat B's ChatPanel or the sidebar's status badge.

export function useChatMessages(sessionId: string | null | undefined): ChatMessage[] {
  const subscribe = useCallback(
    (cb: () => void) => sessionId ? companionStore.subscribeSlice(sessionId, cb) : () => {},
    [sessionId],
  )
  const getSnapshot = useCallback(
    () => sessionId ? companionStore.getMessages(sessionId) : EMPTY_MESSAGES,
    [sessionId],
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useChatClaudeSessionId(sessionId: string | null | undefined): string | null {
  const subscribe = useCallback(
    (cb: () => void) => sessionId ? companionStore.subscribeSlice(sessionId, cb) : () => {},
    [sessionId],
  )
  const getSnapshot = useCallback(
    () => sessionId ? companionStore.getClaudeSessionId(sessionId) : null,
    [sessionId],
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useChatCost(sessionId: string | null | undefined): number {
  const subscribe = useCallback(
    (cb: () => void) => sessionId ? companionStore.subscribeSlice(sessionId, cb) : () => {},
    [sessionId],
  )
  const getSnapshot = useCallback(
    () => sessionId ? companionStore.getCostUsd(sessionId) : 0,
    [sessionId],
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useBusySessions(): Set<string> {
  return useSyncExternalStore(
    (cb) => companionStore.subscribeRunning(cb),
    () => companionStore.getRunningSessions(),
    () => EMPTY_SET,
  )
}

export function useChatIsRunning(sessionId: string | null | undefined): boolean {
  const busy = useBusySessions()
  return !!sessionId && busy.has(sessionId)
}

export function useUnreadSessions(): Set<string> {
  return useSyncExternalStore(
    (cb) => companionStore.subscribeUnread(cb),
    () => companionStore.getUnreadSessions(),
    () => EMPTY_SET,
  )
}

export function usePendingSessions(): Set<string> {
  return useSyncExternalStore(
    (cb) => companionStore.subscribePending(cb),
    () => companionStore.getPendingSessions(),
    () => EMPTY_SET,
  )
}

const EMPTY_ATTACHMENTS_HOOK: PendingAttachment[] = []

// Per-chat pending hunk attachments. Switching chats re-binds to the
// new sessionId's list; cross-chat attachment leakage is impossible
// because each session owns its own slot in the store.
export function usePendingAttachments(sessionId: string | null | undefined): PendingAttachment[] {
  return useSyncExternalStore(
    (cb: () => void) => sessionId ? companionStore.subscribePendingAttachments(sessionId, cb) : () => {},
    () => sessionId ? companionStore.getPendingAttachments(sessionId) : EMPTY_ATTACHMENTS_HOOK,
    () => EMPTY_ATTACHMENTS_HOOK,
  )
}

export function useCompanionStatus(): CompanionStatus {
  return useSyncExternalStore(
    (cb) => companionStore.subscribeStatus(cb),
    () => companionStore.getStatus(),
    () => 'disconnected' as const,
  )
}

export function useCompanionInfo(): CompanionInfo | null {
  return useSyncExternalStore(
    (cb) => companionStore.subscribeStatus(cb),
    () => companionStore.getCompanionInfo(),
    () => null,
  )
}

// ── Stable snapshots for empty cases ───────────────────────────────
// `useSyncExternalStore`'s default-snapshot callback is used during
// SSR / very first render; giving it a constant ref prevents React
// from treating every first render as a state change.
const EMPTY_MESSAGES: ChatMessage[] = []
const EMPTY_SET: Set<string> = new Set()
