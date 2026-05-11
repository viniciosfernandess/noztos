'use client'

import type { ChatMessage, ClaudeEvent, CompanionStatus } from '@/lib/hooks/useCompanionStream'

// ── Companion store ─────────────────────────────────────────────────
//
// A single, module-level store that owns every chat's message state
// for the whole app session. The move here is inspired by the way
// Conductor works: one in-memory source of truth, UI is a view over
// it. Switching chats is just "render a different slice of the same
// map" — no remount, no re-fetch, no SSE reconnect.
//
// Structurally:
//
//   store
//    └─ slices: Map<sessionId, ChatSlice>
//                └─ messages: Map<msgId, ChatMessage>   ← id-indexed, dedup-free
//                └─ claudeSessionId, costUsd
//    └─ runningSessionIds: Set<sessionId>               ← authoritative busy list
//    └─ unreadSessionIds:  Set<sessionId>
//    └─ status, companionInfo                           ← daemon health
//
// Subscribers use `useSyncExternalStore` with a scoped subscribe
// (per-slice, per-field), so a token arriving on chat A only re-renders
// consumers of chat A's messages — chat B / sidebar / etc. stay idle.

// ── Tunable memory budget ──────────────────────────────────────────
//
// These four knobs bound the browser-side "ponta A" cache. Total memory
// stays predictable regardless of how long the tab stays open or how
// many chats the user visits. Cold slices rehydrate from the server
// ring (/session-state) in ~5ms, imperceptible.
//
// Review via telemetry post-launch — adjust if real usage diverges.

// Global ceiling: total messages across ALL slices in RAM. This is
// the whole pool — no per-chat cap. A lone chat can use the full 5000
// via scroll-up; when multiple chats are active they share the pool
// water-filling style (each grows as needed, inactive ones cede space
// when pressure arrives).
const MAX_TOTAL_MESSAGES = 5000
// Max number of distinct chat slices in RAM. Beyond this, LRU evicts
// the least-recently-accessed slice entirely.
const MAX_SLICE_COUNT = 15
// Idle eviction: a slice untouched (no read, write, or subscribe) for
// this long is dropped. Running chats are exempt.
const IDLE_EVICTION_MS = 30 * 60 * 1000
// How often the idle sweeper runs.
const IDLE_SWEEP_INTERVAL_MS = 60 * 1000
// Fuzzy-match window for adopting a hydrated row under a live id when
// exact-id match fails. Kept tight (5s) so a clock skew on the daemon
// can't merge two genuinely different messages that happen to share
// role + content. The exact-id path covers 99% of cases; this is a
// narrow fallback, not a primary matcher.
const FUZZY_MATCH_WINDOW_MS = 5_000

interface ChatSlice {
  messages: Map<string, ChatMessage>
  claudeSessionId: string | null
  costUsd: number
  // Sorted-by-timestamp snapshot used by the messages selector. We
  // cache it so `useSyncExternalStore`'s getSnapshot stays referentially
  // stable while nothing relevant changed (React bails out of re-render
  // when the reference matches).
  sortedCache: ChatMessage[] | null
  // Last time any code touched this slice — read, write, or a
  // ChatPanel subscribing to it. Drives LRU + idle eviction.
  lastAccessedAt: number
  // Active Builder Workflow run attached to this chat. When set, UI
  // renders WorkflowRunCard polling /api/workflow/[runId]. Cleared
  // when run reaches terminal status.
  workflowRunId: string | null
}

export interface CompanionInfo {
  email?: string
  plan?: string
  version?: string
  projects?: Array<{ id: string; path: string; name: string }>
  // Human-friendly name of the Mac running the companion. Surfaces in
  // the sidebar tooltip so a user juggling multiple machines can tell
  // which one is currently driving this tab.
  machineName?: string
}

type Listener = () => void

// Shape held in the store for a live Builder Workflow run. Mirrors the
// `/api/workflow/[runId]` response (the DB row) so cold-load + SSE deltas
// converge on the same object. The `progress` payload is the structured
// `RunSnapshot` (blocks, currentStep, transcripts) the card renders.
export interface WorkflowRunUIState {
  id: string
  sessionId: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  workflowType: string
  userMessage: string
  plan: unknown
  progress: unknown
  finalResponse: string | null
  errorReason: string | null
  createdAt: string
  completedAt: string | null
}

function emptySlice(): ChatSlice {
  return {
    messages: new Map(),
    claudeSessionId: null,
    costUsd: 0,
    sortedCache: null,
    lastAccessedAt: Date.now(),
    workflowRunId: null,
  }
}

class CompanionStore {
  // ── State ──────────────────────────────────────────────────────
  private slices: Map<string, ChatSlice> = new Map()
  private status: CompanionStatus = 'disconnected'
  private companionInfo: CompanionInfo | null = null
  private runningSessionIds: Set<string> = new Set()
  private unreadSessionIds: Set<string> = new Set()
  // Sessions that are mid-creation on the server — the optimistic UI
  // already shows them in the sidebar (and may have selected them), but
  // the POST to /chat-sessions hasn't returned yet. Reading endpoints
  // (/session-state, /messages, /mark-read) 404 during this window
  // because the row literally doesn't exist in the DB. ChatPanel reads
  // this set to skip its hydrate during the gap. Cleared on success or
  // on rollback after a failed create.
  private pendingSessionIds: Set<string> = new Set()
  // Bumped on reconnect() so provider's SSE useEffect can re-run.
  private connectionEpoch = 0
  // Background sweeper handle. Null on SSR; started lazily in the
  // browser the first time any mutating/observing method runs.
  private idleSweeper: ReturnType<typeof setInterval> | null = null

  // ── Scoped listeners ───────────────────────────────────────────
  private sliceListeners: Map<string, Set<Listener>> = new Map()
  private runningListeners: Set<Listener> = new Set()
  private unreadListeners: Set<Listener> = new Set()
  private pendingListeners: Set<Listener> = new Set()
  private statusListeners: Set<Listener> = new Set()
  private epochListeners: Set<Listener> = new Set()

  // Per-chat draft text the user typed but didn't send. Kept alive as
  // long as the WorkPanel is mounted so switching chats doesn't lose
  // what they were typing. Not persisted to disk/DB — reload clears.
  private drafts: Map<string, string> = new Map()

  // Per-chat pending hunk attachments — diffs the user clicked "attach"
  // on but hasn't sent yet. Mirrors the drafts pattern but with a
  // listener fanout (DiffHunkView writes from one component, ChatPanel
  // reads from another). Switching chats no longer leaks attachments
  // between sessions: each chat owns its own list.
  private pendingAttachments: Map<string, PendingAttachment[]> = new Map()
  private pendingAttachmentListeners: Map<string, Set<Listener>> = new Map()

  // Per-worktree send queue. When a user sends a prompt to a chat
  // inside a worktree that's still being provisioned on the server
  // (state='pending' on the optimistic UI), we don't fire the POST
  // right away — the daemon doesn't know the chat exists yet and
  // would error with "session not found". Instead the prompt sits
  // here, and when the worktree finalises (markWorktreeReady) the
  // queue drains and the POSTs go out in order.
  // Queue is keyed by worktreeId because that's what transitions from
  // pending → ready. Inside each entry we capture (sessionId, prompt,
  // userMsgId, opts) so the drainer can call companionStore.sendPrompt
  // verbatim and reuse the SAME id the caller already inserted
  // optimistically. Without that id, sendPrompt would mint a new one
  // and the optimistic row + the daemon-echoed row would render as
  // two separate bubbles (visible duplicate until reload).
  private worktreeSendQueue: Map<string, Array<{
    sessionId: string
    projectId: string
    prompt: string
    userMsgId?: string
    // Optional display split — see queueSendForWorktree() for details.
    // Forwarded into sendPrompt on drain so the user-facing bubble shows
    // only what the user typed, with attachment chips, instead of the
    // raw diff text the model receives.
    display?: { content: string; attachments?: Array<{ filePath: string; lineRange: string; bulkFiles?: Array<{ filePath: string; fileStatus: 'M' | 'A' | 'D'; hunkCount: number }> }> }
    // Auto-rename title computed by the caller (first words of the first
    // user message). Threaded through the queue so handleNewWorktree's
    // success path can apply the rename AFTER the row is created on the
    // server — without this, a PATCH fired upfront 404s because the
    // chat-session/worktree don't exist yet during provisioning.
    pendingRename?: string
    opts?: { mode?: 'plan' | 'ask' | 'agent'; model?: string; thinking?: 'off' | 'low' | 'medium' | 'high'; skillId?: string | null }
  }>> = new Map()

  // ── Workflow live snapshot (per runId) ─────────────────────────
  //
  // Holds the live RunSnapshot fed by SSE `workflow_progress` frames +
  // initial cold-load from `/api/workflow/[runId]`. The WorkflowRunCard
  // subscribes to this map by runId; deltas land here in ~ms and the
  // card re-renders. Survives terminal status until the user dismisses
  // (so a finished/cancelled run stays visible exactly as it was).
  //
  // `lastSeq` per run dedupes SSE replay on reconnect.
  private workflowSnapshots: Map<string, WorkflowRunUIState> = new Map()
  private workflowLastSeq: Map<string, number> = new Map()
  private workflowListeners: Map<string, Set<Listener>> = new Map()

  // ── Snapshot helpers (referentially stable between notifies) ──

  getMessages(sessionId: string): ChatMessage[] {
    const slice = this.slices.get(sessionId)
    if (!slice) return EMPTY_MESSAGES
    slice.lastAccessedAt = Date.now()
    if (slice.sortedCache) return slice.sortedCache
    const arr = Array.from(slice.messages.values()).sort((a, b) => a.timestamp - b.timestamp)
    slice.sortedCache = arr
    return arr
  }

  getClaudeSessionId(sessionId: string): string | null {
    return this.slices.get(sessionId)?.claudeSessionId ?? null
  }

  getCostUsd(sessionId: string): number {
    return this.slices.get(sessionId)?.costUsd ?? 0
  }

  getRunningSessions(): Set<string> {
    return this.runningSessionIds
  }

  getUnreadSessions(): Set<string> {
    return this.unreadSessionIds
  }

  getPendingSessions(): Set<string> {
    return this.pendingSessionIds
  }

  getStatus(): CompanionStatus {
    return this.status
  }

  getCompanionInfo(): CompanionInfo | null {
    return this.companionInfo
  }

  getConnectionEpoch(): number {
    return this.connectionEpoch
  }

  // ── Subscriptions (one per selector shape) ─────────────────────

  subscribeSlice(sessionId: string, cb: Listener): () => void {
    let set = this.sliceListeners.get(sessionId)
    if (!set) { set = new Set(); this.sliceListeners.set(sessionId, set) }
    set.add(cb)
    // A fresh subscriber means someone is viewing this chat now.
    // Bump so LRU eviction doesn't kick a just-opened slice.
    const slice = this.slices.get(sessionId)
    if (slice) slice.lastAccessedAt = Date.now()
    return () => {
      const s = this.sliceListeners.get(sessionId)
      s?.delete(cb)
      if (s && s.size === 0) this.sliceListeners.delete(sessionId)
    }
  }

  subscribeRunning(cb: Listener): () => void {
    this.runningListeners.add(cb)
    return () => { this.runningListeners.delete(cb) }
  }

  subscribeUnread(cb: Listener): () => void {
    this.unreadListeners.add(cb)
    return () => { this.unreadListeners.delete(cb) }
  }

  subscribePending(cb: Listener): () => void {
    this.pendingListeners.add(cb)
    return () => { this.pendingListeners.delete(cb) }
  }

  subscribeStatus(cb: Listener): () => void {
    this.statusListeners.add(cb)
    return () => { this.statusListeners.delete(cb) }
  }

  subscribeEpoch(cb: Listener): () => void {
    this.epochListeners.add(cb)
    return () => { this.epochListeners.delete(cb) }
  }

  private notifySlice(sessionId: string): void {
    const set = this.sliceListeners.get(sessionId)
    if (set) for (const l of set) l()
  }
  private notifyRunning(): void { for (const l of this.runningListeners) l() }
  private notifyUnread(): void { for (const l of this.unreadListeners) l() }
  private notifyPending(): void { for (const l of this.pendingListeners) l() }
  private notifyStatus(): void { for (const l of this.statusListeners) l() }
  private notifyEpoch(): void { for (const l of this.epochListeners) l() }

  // ── Drafts (unsent text, per chat) ─────────────────────────────

  getDraft(sessionId: string): string {
    return this.drafts.get(sessionId) ?? ''
  }

  setDraft(sessionId: string, value: string): void {
    if (value === '') this.drafts.delete(sessionId)
    else this.drafts.set(sessionId, value)
    // No listener notify — the only consumer is the active ChatPanel
    // which syncs synchronously on its own text-change handler.
  }

  clearDraft(sessionId: string): void {
    this.drafts.delete(sessionId)
  }

  // ── Pending hunk attachments (per chat) ───────────────────────────

  getPendingAttachments(sessionId: string): PendingAttachment[] {
    return this.pendingAttachments.get(sessionId) ?? EMPTY_ATTACHMENTS
  }

  setPendingAttachments(sessionId: string, list: PendingAttachment[]): void {
    if (list.length === 0) this.pendingAttachments.delete(sessionId)
    else this.pendingAttachments.set(sessionId, list)
    this.notifyPendingAttachments(sessionId)
  }

  clearPendingAttachments(sessionId: string): void {
    if (!this.pendingAttachments.has(sessionId)) return
    this.pendingAttachments.delete(sessionId)
    this.notifyPendingAttachments(sessionId)
  }

  subscribePendingAttachments(sessionId: string, cb: Listener): () => void {
    let set = this.pendingAttachmentListeners.get(sessionId)
    if (!set) { set = new Set(); this.pendingAttachmentListeners.set(sessionId, set) }
    set.add(cb)
    return () => {
      const s = this.pendingAttachmentListeners.get(sessionId)
      s?.delete(cb)
      if (s && s.size === 0) this.pendingAttachmentListeners.delete(sessionId)
    }
  }

  private notifyPendingAttachments(sessionId: string): void {
    const set = this.pendingAttachmentListeners.get(sessionId)
    if (!set) return
    for (const l of set) l()
  }

  // ── Per-worktree send queue (used by optimistic worktree creation) ─

  // Mint a stable client-side id. Same scheme used elsewhere in the
  // codebase: short prefix + Date.now + random suffix. Ids generated
  // here flow through the request body to the server's idempotent
  // upsert path, so a retry never duplicates state.
  mintCuid(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  }

  // User pressed Send while their worktree is still creating. Stash
  // the prompt; we'll fire it the moment the worktree finalises.
  queueSendForWorktree(
    worktreeId: string,
    payload: {
      sessionId: string
      projectId: string
      prompt: string
      // The id minted by the caller for the optimistic user-row insert.
      // Threaded through the queue so the eventual sendPrompt call can
      // reuse it instead of minting a fresh id (and double-inserting).
      userMsgId?: string
      // Title to apply after the worktree finalises (server-confirmed).
      pendingRename?: string
      opts?: { mode?: 'plan' | 'ask' | 'agent'; model?: string; thinking?: 'off' | 'low' | 'medium' | 'high'; skillId?: string | null }
      // Display split — see sendPrompt() for the full rationale. Forwarded
      // through the queue so the eventual drain preserves the user-only
      // bubble content + chips instead of dumping raw diff text.
      display?: { content: string; attachments?: Array<{ filePath: string; lineRange: string; bulkFiles?: Array<{ filePath: string; fileStatus: 'M' | 'A' | 'D'; hunkCount: number }> }> }
    },
  ): void {
    const list = this.worktreeSendQueue.get(worktreeId) ?? []
    list.push(payload)
    this.worktreeSendQueue.set(worktreeId, list)
    // Surface as busy locally so the spinner shows immediately — we
    // already added the optimistic user msg via upsertMessage in the
    // caller, this keeps the UI honest about the in-flight turn.
    this.markBusy(payload.sessionId)
    console.log(`[store] queueSendForWorktree wt=${worktreeId.slice(0, 8)} sid=${payload.sessionId.slice(0, 8)} queued=${list.length}`)
  }

  // Read-only view of the queue for a worktree. Used by the worktree-
  // success path to apply pending renames before draining (PATCH against
  // session/worktree rows that now exist on the server). Doesn't mutate
  // the queue — drainSendsForWorktree is still the consumer.
  peekSendQueueForWorktree(worktreeId: string): ReadonlyArray<{
    sessionId: string
    projectId: string
    prompt: string
    userMsgId?: string
    pendingRename?: string
    opts?: { mode?: 'plan' | 'ask' | 'agent'; model?: string; thinking?: 'off' | 'low' | 'medium' | 'high' }
    display?: { content: string; attachments?: Array<{ filePath: string; lineRange: string; bulkFiles?: Array<{ filePath: string; fileStatus: 'M' | 'A' | 'D'; hunkCount: number }> }> }
  }> {
    return this.worktreeSendQueue.get(worktreeId) ?? []
  }

  // Worktree creation succeeded — drain its queue. Each entry replays
  // the normal sendPrompt path; markBusy was already set when queued.
  async drainSendsForWorktree(worktreeId: string): Promise<void> {
    const list = this.worktreeSendQueue.get(worktreeId)
    if (!list || list.length === 0) return
    this.worktreeSendQueue.delete(worktreeId)
    console.log(`[store] drainSendsForWorktree wt=${worktreeId.slice(0, 8)} count=${list.length}`)
    for (const item of list) {
      // markIdle first so sendPrompt's own markBusy works clean. The
      // optimistic user msg is already in the slice — pass its id
      // through so sendPrompt's upsertMessage hits the same row
      // instead of minting a fresh id (which would double-insert).
      this.markIdle(item.sessionId)
      await this.sendPrompt(item.sessionId, item.projectId, item.prompt, item.opts, item.userMsgId, item.display)
    }
  }

  // Worktree creation failed and the user dismissed it. Drop any
  // pending sends; the caller restores their text to the drafts.
  discardSendsForWorktree(worktreeId: string): Array<{
    sessionId: string
    prompt: string
  }> {
    const list = this.worktreeSendQueue.get(worktreeId)
    if (!list || list.length === 0) return []
    this.worktreeSendQueue.delete(worktreeId)
    for (const item of list) {
      this.markIdle(item.sessionId)
    }
    console.log(`[store] discardSendsForWorktree wt=${worktreeId.slice(0, 8)} count=${list.length}`)
    return list.map((i) => ({ sessionId: i.sessionId, prompt: i.prompt }))
  }

  // ── Actions ────────────────────────────────────────────────────

  private getOrCreateSlice(sessionId: string): ChatSlice {
    let slice = this.slices.get(sessionId)
    if (!slice) { slice = emptySlice(); this.slices.set(sessionId, slice); this.ensureIdleSweeper() }
    slice.lastAccessedAt = Date.now()
    return slice
  }

  private invalidateSortedCache(slice: ChatSlice): void {
    slice.sortedCache = null
  }

  // Sum of messages across every slice in RAM — the number we compare
  // against MAX_TOTAL_MESSAGES.
  private totalMessageCount(): number {
    let n = 0
    for (const s of this.slices.values()) n += s.messages.size
    return n
  }

  // Drop the N oldest messages from a slice (by timestamp). Used by
  // the global budget enforcer to shrink the least-active chat instead
  // of evicting it whole. Returns the number actually dropped.
  private trimOldestFromSlice(sessionId: string, slice: ChatSlice, drop: number): number {
    if (drop <= 0 || slice.messages.size === 0) return 0
    const sorted = Array.from(slice.messages.values()).sort((a, b) => a.timestamp - b.timestamp)
    const n = Math.min(drop, sorted.length)
    for (let i = 0; i < n; i++) slice.messages.delete(sorted[i].id)
    slice.sortedCache = null
    console.log(`[store] trim sid=${sessionId.slice(0, 8)} dropped=${n} now=${slice.messages.size}`)
    this.notifySlice(sessionId)
    return n
  }

  // Evict the single oldest-accessed slice entirely. A "safe" slice is
  // one not currently running on the daemon — dropping a running slice
  // mid-stream would lose incoming deltas. Used only for slot-cap
  // enforcement. Returns the evicted sessionId, or null if nothing can
  // be dropped.
  private evictOneLRU(reason: string): string | null {
    let oldestSid: string | null = null
    let oldestAt = Infinity
    for (const [sid, slice] of this.slices) {
      if (this.runningSessionIds.has(sid)) continue
      if (slice.lastAccessedAt < oldestAt) {
        oldestAt = slice.lastAccessedAt
        oldestSid = sid
      }
    }
    if (!oldestSid) return null
    const msgs = this.slices.get(oldestSid)?.messages.size ?? 0
    this.slices.delete(oldestSid)
    console.log(`[store] evict sid=${oldestSid.slice(0, 8)} reason=${reason} msgs=${msgs}`)
    this.notifySlice(oldestSid)
    return oldestSid
  }

  // Global budget enforcement. Two independent ceilings:
  //
  // (1) MAX_SLICE_COUNT — too many distinct chats in RAM. Evict whole
  //     least-active slice (LRU, excluding running).
  //
  // (2) MAX_TOTAL_MESSAGES — too many messages across all slices.
  //     Shed msgs from the LEAST-ACCESSED slice first (don't kill the
  //     slice, just trim its oldest). If that slice is exhausted and
  //     still over budget, move to next least-accessed. Currently
  //     running or just-touched chats are last to lose content.
  private enforceGlobalCaps(): void {
    const totalBefore = this.totalMessageCount()
    const slicesBefore = this.slices.size
    let slotEvictions = 0
    let totalTrims = 0

    let guard = this.slices.size + 1
    while (this.slices.size > MAX_SLICE_COUNT && guard-- > 0) {
      if (!this.evictOneLRU('slot-cap')) break
      slotEvictions++
    }

    // Total-message cap: shrink from the least-active slice outward.
    // Running chats are NOT excluded — trimming *oldest* messages from
    // a running slice is safe (live SSE events land at the tail, not
    // the head). Only whole-slice eviction must avoid running chats.
    guard = MAX_SLICE_COUNT * 2 + 1
    while (this.totalMessageCount() > MAX_TOTAL_MESSAGES && guard-- > 0) {
      const sorted = Array.from(this.slices.entries())
        .sort((a, b) => a[1].lastAccessedAt - b[1].lastAccessedAt)
      if (sorted.length === 0) break
      const overBy = this.totalMessageCount() - MAX_TOTAL_MESSAGES
      // Take the oldest-accessed slice; trim up to what it can offer.
      // If it can't cover the overage alone, the outer loop picks the
      // next oldest on the following iteration.
      const [sid, slice] = sorted[0]
      const dropped = this.trimOldestFromSlice(sid, slice, Math.min(overBy, slice.messages.size))
      if (dropped === 0) break
      totalTrims++
    }

    // Only log when something actually happened — otherwise silent to
    // avoid spam on every single upsert.
    if (slotEvictions > 0 || totalTrims > 0) {
      const totalAfter = this.totalMessageCount()
      console.log(
        `[store] enforceCaps slices=${slicesBefore}→${this.slices.size} total=${totalBefore}→${totalAfter} `
        + `slotEvictions=${slotEvictions} totalTrims=${totalTrims} `
        + `cap=${MAX_TOTAL_MESSAGES}/${MAX_SLICE_COUNT}`,
      )
    }
  }

  // Called by the ChatPanel before a scroll-up fetch. Returns true if
  // the chat has room under the shared global budget — i.e. the sum
  // of all OTHER slices leaves headroom for this one to grow. When
  // false, the UI stops showing the load-more spinner (the chat has
  // "filled its share" given what other chats are using).
  canLoadMore(sessionId: string): boolean {
    const mine = this.slices.get(sessionId)?.messages.size ?? 0
    let others = 0
    const otherDetails: string[] = []
    for (const [sid, s] of this.slices) {
      if (sid !== sessionId) {
        others += s.messages.size
        otherDetails.push(`${sid.slice(0, 8)}:${s.messages.size}`)
      }
    }
    const headroom = MAX_TOTAL_MESSAGES - others
    const ok = mine < headroom
    console.log(
      `[store] canLoadMore sid=${sessionId.slice(0, 8)} mine=${mine} others=[${otherDetails.join(',')}]=${others} `
      + `headroom=${headroom} result=${ok ? 'yes' : 'no'}`,
    )
    return ok
  }

  // Start the idle sweeper on first use in the browser. Running chats
  // never get evicted — daemon may still stream to them. setInterval is
  // unref'd implicitly (browser always treats it that way).
  private ensureIdleSweeper(): void {
    if (this.idleSweeper || typeof window === 'undefined') return
    this.idleSweeper = setInterval(() => {
      const now = Date.now()
      const expired: string[] = []
      for (const [sid, slice] of this.slices) {
        if (this.runningSessionIds.has(sid)) continue
        if (now - slice.lastAccessedAt > IDLE_EVICTION_MS) expired.push(sid)
      }
      for (const sid of expired) {
        const msgs = this.slices.get(sid)?.messages.size ?? 0
        this.slices.delete(sid)
        console.log(`[store] evict sid=${sid.slice(0, 8)} reason=idle msgs=${msgs}`)
        this.notifySlice(sid)
      }
    }, IDLE_SWEEP_INTERVAL_MS)
  }

  upsertMessage(sessionId: string, incoming: ChatMessage, opts?: { fuzzyMatch?: boolean }): void {
    const slice = this.getOrCreateSlice(sessionId)
    if (slice.messages.has(incoming.id)) {
      const existing = slice.messages.get(incoming.id)!
      // Filter out explicit `undefined` fields BEFORE merging — without
      // this, a sync-replay frame that doesn't carry e.g. `toolName`
      // would set `incoming.toolName = undefined` and the spread below
      // would override the existing live tool row's name with undefined.
      // This is exactly how the pinned TodoBlock kept "disappearing"
      // mid-stream: the replay clobbered toolName='TodoWrite' on the
      // live row, so `pinnedTodo` extraction (group[j].toolName ===
      // 'TodoWrite') stopped finding it. Filtering keeps replays as
      // strict additions — they fill in fields the live row didn't
      // know yet, never erase fields the live row already carried.
      const definedFields: Partial<ChatMessage> = {}
      for (const [k, v] of Object.entries(incoming)) {
        if (v !== undefined) (definedFields as Record<string, unknown>)[k] = v
      }
      slice.messages.set(incoming.id, { ...existing, ...definedFields } as ChatMessage)
    } else if (opts?.fuzzyMatch) {
      let adopted = false
      for (const [existingId, existing] of slice.messages) {
        if (
          existing.role === incoming.role
          && existing.content === incoming.content
          && Math.abs(existing.timestamp - incoming.timestamp) < FUZZY_MATCH_WINDOW_MS
        ) {
          slice.messages.delete(existingId)
          slice.messages.set(incoming.id, { ...existing, id: incoming.id })
          adopted = true
          break
        }
      }
      if (!adopted) slice.messages.set(incoming.id, incoming)
    } else {
      slice.messages.set(incoming.id, incoming)
    }
    this.invalidateSortedCache(slice)
    this.enforceGlobalCaps()
    this.notifySlice(sessionId)
  }

  patchMessage(
    sessionId: string,
    id: string,
    patch: Partial<ChatMessage> | ((existing: ChatMessage) => Partial<ChatMessage>),
  ): void {
    const slice = this.slices.get(sessionId)
    if (!slice) return
    const existing = slice.messages.get(id)
    if (!existing) return
    const updates = typeof patch === 'function' ? patch(existing) : patch
    slice.messages.set(id, { ...existing, ...updates })
    this.invalidateSortedCache(slice)
    this.notifySlice(sessionId)
  }

  setClaudeSessionId(sessionId: string, value: string | null): void {
    const slice = this.getOrCreateSlice(sessionId)
    if (slice.claudeSessionId === value) return
    const prev = slice.claudeSessionId
    slice.claudeSessionId = value
    console.log(`[store] claudeSessionId sid=${sessionId.slice(0, 8)} ${prev ?? 'null'} → ${value ?? 'null'}`)
    this.notifySlice(sessionId)
  }

  addCost(sessionId: string, delta: number): void {
    if (!delta) return
    const slice = this.getOrCreateSlice(sessionId)
    slice.costUsd += delta
    this.notifySlice(sessionId)
  }

  clearSlice(sessionId: string): void {
    if (!this.slices.has(sessionId)) return
    this.slices.delete(sessionId)
    this.notifySlice(sessionId)
  }

  setRunningSessions(ids: string[]): void {
    const next = new Set(ids)
    // Only notify when the membership actually changed — avoids thrash
    // on repeated identical broadcasts.
    if (next.size === this.runningSessionIds.size) {
      let same = true
      for (const id of next) if (!this.runningSessionIds.has(id)) { same = false; break }
      if (same) return
    }
    console.log(`[store] running ids=[${ids.map(i => i.slice(0, 8)).join(',')}]`)
    this.runningSessionIds = next
    this.notifyRunning()
  }

  markBusy(sessionId: string): void {
    if (this.runningSessionIds.has(sessionId)) return
    const next = new Set(this.runningSessionIds)
    next.add(sessionId)
    this.runningSessionIds = next
    this.notifyRunning()
  }

  // Counterpart of markBusy — used after a successful Stop click so the
  // spinner clears immediately instead of waiting for the daemon's
  // running_sessions broadcast (which arrives ~50-200ms later).
  markIdle(sessionId: string): void {
    if (!this.runningSessionIds.has(sessionId)) return
    const next = new Set(this.runningSessionIds)
    next.delete(sessionId)
    this.runningSessionIds = next
    this.notifyRunning()
  }

  // ── Workflow run attachment ──────────────────────────────────
  // Quando user invoca /build, o workflow runner cria uma WorkflowRun
  // e a UI precisa saber: "esse chat tá com workflow X rodando, poll
  // /api/workflow/X". O store carrega esse runId por slice.

  attachWorkflowRun(sessionId: string, runId: string): void {
    const slice = this.getOrCreateSlice(sessionId)
    if (slice.workflowRunId === runId) return
    slice.workflowRunId = runId
    this.markBusy(sessionId)
    this.notifySlice(sessionId)
  }

  detachWorkflowRun(sessionId: string): void {
    const slice = this.slices.get(sessionId)
    if (!slice || slice.workflowRunId === null) return
    slice.workflowRunId = null
    this.markIdle(sessionId)
    this.notifySlice(sessionId)
  }

  getWorkflowRunId(sessionId: string): string | null {
    return this.slices.get(sessionId)?.workflowRunId ?? null
  }

  // ── Workflow live snapshot — SSE + DB cold-load merge ──────────
  //
  // Mirrors the chat-message pattern: cache primary (SSE deltas flow into
  // `workflowSnapshots` instantly), DB fallback (cold-load on first mount
  // / reconnect via `/api/workflow/[runId]`). The card subscribes by runId
  // and re-renders on every notify.
  //
  // Snapshot survives terminal status — user dismisses explicitly via
  // `dismissWorkflowRun`, which also detaches the slice's runId so the
  // card unmounts. Detach alone (e.g. on chat delete) keeps the snapshot
  // for any other consumer; dismiss is the user-driven cleanup.

  private notifyWorkflow(runId: string): void {
    const set = this.workflowListeners.get(runId)
    if (set) for (const l of set) l()
  }

  subscribeWorkflowSnapshot(runId: string, cb: Listener): () => void {
    let set = this.workflowListeners.get(runId)
    if (!set) { set = new Set(); this.workflowListeners.set(runId, set) }
    set.add(cb)
    return () => {
      const s = this.workflowListeners.get(runId)
      s?.delete(cb)
      if (s && s.size === 0) this.workflowListeners.delete(runId)
    }
  }

  getWorkflowSnapshot(runId: string): WorkflowRunUIState | undefined {
    return this.workflowSnapshots.get(runId)
  }

  // Cold-load: replace the snapshot wholesale from a DB fetch. Reads
  // `progress.chunkSeq` to seed the dedupe cursor — without it, an SSE
  // delta drained on reconnect whose seq is already covered by the DB
  // snapshot would double-apply to the transcript.
  hydrateWorkflowSnapshot(runId: string, snapshot: WorkflowRunUIState): void {
    const progress = snapshot.progress as { chunkSeq?: number } | null
    const cursor = typeof progress?.chunkSeq === 'number' ? progress.chunkSeq : 0
    this.workflowSnapshots.set(runId, snapshot)
    this.workflowLastSeq.set(runId, cursor)
    this.notifyWorkflow(runId)
  }

  // SSE delta apply. Routes the chunk into both:
  //   • snapshot.currentStep.transcript (live tip the card renders)
  //   • the historical step entry under blocks[i].steps[j] when the
  //     step has already been logged, so a user scrolling back sees the
  //     full transcript for completed steps too.
  // Idempotent via monotonic seq — replays from SSE reconnect are dropped.
  ingestWorkflowProgress(payload: {
    runId: string
    seq: number
    role: 'planner' | 'architect' | 'builder' | 'reviewer'
    blockIndex: number
    attempt: number
    chunk: unknown
  }): void {
    const last = this.workflowLastSeq.get(payload.runId) ?? -1
    if (payload.seq <= last) return
    const state = this.workflowSnapshots.get(payload.runId)
    if (!state) return  // not hydrated yet — initial cold-load handles catch-up

    const progress = state.progress as {
      blocks?: Array<{
        index: number
        steps?: Array<{
          role: string
          attempt: number
          transcript?: unknown[]
        }>
      }>
      currentStep?: {
        role: string
        blockIndex: number
        attempt: number
        transcript?: unknown[]
      } | null
    } | null

    if (!progress) return

    // Live tip.
    if (progress.currentStep
      && progress.currentStep.role === payload.role
      && progress.currentStep.blockIndex === payload.blockIndex
      && progress.currentStep.attempt === payload.attempt) {
      if (!progress.currentStep.transcript) progress.currentStep.transcript = []
      progress.currentStep.transcript.push(payload.chunk)
    }

    // Historical step entry (for scrollback to completed/in-flight steps).
    if (payload.blockIndex >= 0 && Array.isArray(progress.blocks)) {
      const block = progress.blocks.find((b) => b.index === payload.blockIndex)
      const step = block?.steps?.find((s) => s.role === payload.role && s.attempt === payload.attempt)
      if (step) {
        if (!step.transcript) step.transcript = []
        step.transcript.push(payload.chunk)
      }
    }

    this.workflowLastSeq.set(payload.runId, payload.seq)
    // Force a new object identity so React's useSyncExternalStore notices.
    this.workflowSnapshots.set(payload.runId, { ...state, progress: { ...progress } })
    this.notifyWorkflow(payload.runId)
  }

  // User-driven dismissal of a terminal-state card: drop snapshot from
  // memory, clear the slice's runId so the card unmounts, free listeners.
  dismissWorkflowRun(runId: string, sessionId: string): void {
    this.workflowSnapshots.delete(runId)
    this.workflowLastSeq.delete(runId)
    this.notifyWorkflow(runId)
    this.detachWorkflowRun(sessionId)
  }

  markUnread(sessionId: string): void {
    if (this.unreadSessionIds.has(sessionId)) return
    const next = new Set(this.unreadSessionIds)
    next.add(sessionId)
    this.unreadSessionIds = next
    this.notifyUnread()
  }

  clearUnread(sessionId: string): void {
    if (!this.unreadSessionIds.has(sessionId)) return
    const next = new Set(this.unreadSessionIds)
    next.delete(sessionId)
    this.unreadSessionIds = next
    this.notifyUnread()
  }

  // Marks a session as "being created on the server right now". Set the
  // moment a client-minted cuid goes into an optimistic insert; cleared
  // on POST success or on rollback. ChatPanel checks this set to skip
  // its hydrate calls (which would 404 otherwise) during the gap.
  markPending(sessionId: string): void {
    if (this.pendingSessionIds.has(sessionId)) return
    const next = new Set(this.pendingSessionIds)
    next.add(sessionId)
    this.pendingSessionIds = next
    this.notifyPending()
  }

  clearPending(sessionId: string): void {
    if (!this.pendingSessionIds.has(sessionId)) return
    const next = new Set(this.pendingSessionIds)
    next.delete(sessionId)
    this.pendingSessionIds = next
    this.notifyPending()
  }

  setStatus(status: CompanionStatus, info?: CompanionInfo | null): void {
    const changed = this.status !== status || (info !== undefined && info !== this.companionInfo)
    if (!changed) return
    this.status = status
    if (info !== undefined) this.companionInfo = info
    this.notifyStatus()
  }

  reconnect(): void {
    this.connectionEpoch++
    this.notifyEpoch()
  }

  // ── Actions (network + state) ──────────────────────────────────

  // Mint the id on the client so optimistic render + daemon persistRow +
  // Supabase row all share one id; hydrate-by-id becomes a no-op.
  mintStableId(): string {
    return `evt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  }

  // Send a prompt to a chat session. Optimistic user message lands in
  // the store immediately; daemon echoes the persistRow with the same
  // id, so no duplicate. Errors surface as a system message in the
  // chat and `setRunningSessions` from the daemon corrects spinner
  // state if the server bounced the request.
  async sendPrompt(
    sessionId: string,
    projectId: string,
    prompt: string,
    opts?: {
      mode?: 'plan' | 'ask' | 'agent'
      model?: string
      thinking?: 'off' | 'low' | 'medium' | 'high'
      // Active agent skill (e.g. 'ceo', 'tester'). When the user picked
      // an agent via the slash-command picker, this id is forwarded to
      // the daemon so it can prepend that agent's skillMd to the system
      // prompt. null/undefined = regular chat without an agent persona.
      skillId?: string | null
    },
    // Caller-provided id for the user message row. Used by the
    // worktree-pending queue path so the row inserted optimistically
    // before queueing matches the row inserted here on drain — without
    // this, the same prompt rendered twice (different ids → two
    // separate bubbles) until a hard reload deduped via the DB. When
    // omitted the function mints its own id, preserving the standard
    // single-call optimistic-render flow.
    userMsgId?: string,
    // Optional split between what the user actually typed (shown in the
    // bubble) and the full LLM payload (which may include attached diff
    // blocks above the prose). When provided, the user-message row stores
    // `display.content` + `display.attachments`; the daemon still gets
    // the raw `prompt` so the model sees the diffs. Without this the
    // user bubble would render the full diff text inline, which is
    // unreadable and not what they typed.
    display?: { content: string; attachments?: Array<{ filePath: string; lineRange: string; bulkFiles?: Array<{ filePath: string; fileStatus: 'M' | 'A' | 'D'; hunkCount: number }> }> },
  ): Promise<void> {
    this.markBusy(sessionId)
    const id = userMsgId ?? this.mintStableId()
    const claudeSid = this.getClaudeSessionId(sessionId)
    console.log(`[store] sendPrompt sid=${sessionId.slice(0, 8)} userMsgId=${id.slice(0, 16)}${userMsgId ? ' (reused)' : ''} claude=${claudeSid ?? 'new'} model=${opts?.model ?? '-'} thinking=${opts?.thinking ?? 'off'} skill=${opts?.skillId ?? '-'}`)
    this.upsertMessage(sessionId, {
      id,
      role: 'user',
      content: display?.content ?? prompt,
      attachments: display?.attachments,
      timestamp: Date.now(),
    })

    try {
      const res = await fetch('/api/companion/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'prompt',
          projectId,
          prompt,
          userMsgId: id,
          claudeSessionId: claudeSid,
          bornastarSessionId: sessionId,
          mode: opts?.mode ?? 'agent',
          model: opts?.model,
          thinking: opts?.thinking ?? 'off',
          skillId: opts?.skillId ?? null,
        }),
      })
      if (!res.ok) {
        // 503 = companion not connected (per command/route.ts). Treat
        // silently: the markBusy already fired so the spinner is up,
        // and the sweeper's offline broadcast will clear it within
        // the heartbeat-stale window. Adding a system error message
        // here would force the user to act on a state we already
        // surface globally (offline banner + dimmed send button).
        // Letting the spinner spin also keeps the door open: if the
        // daemon comes back inside the window, the request that's
        // still queued in commandQueue gets picked up and runs.
        if (res.status === 503) {
          console.log(`[store] sendPrompt 503 (companion offline) sid=${sessionId.slice(0, 8)} — letting spinner ride until sweeper clears`)
        } else {
          let msg = 'Failed to reach Claude Code companion.'
          try {
            const data = await res.json()
            if (data?.message) msg = data.message
            else if (data?.error) msg = data.error
          } catch { /* body wasn't JSON */ }
          this.upsertMessage(sessionId, {
            id: localId(),
            role: 'system',
            content: `Error: ${msg}`,
            timestamp: Date.now(),
          })
        }
      }
    } catch {
      this.upsertMessage(sessionId, {
        id: localId(),
        role: 'system',
        content: 'Error: Network failed reaching the companion. Try again.',
        timestamp: Date.now(),
      })
    }
  }

  // Send an interrupt to the daemon for the in-flight Claude turn on
  // this chat. Returns a status so the caller can branch on it:
  //   ok=true        → daemon got it, will stop Claude + emit result
  //   ok=false +
  //     offline=true → companion not connected (server returned 503)
  //     offline=false→ network error / bad status (best-effort silent)
  // The caller (Stop button handler) uses this to decide whether to
  // clear running locally + restore prompt (Caso 1) or to surface an
  // offline system message (Caso 2).
  async interrupt(sessionId: string, projectId: string): Promise<{ ok: boolean; offline: boolean }> {
    try {
      const res = await fetch('/api/companion/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'interrupt', projectId, bornastarSessionId: sessionId }),
      })
      if (res.ok) {
        console.log(`[store] interrupt ok sid=${sessionId.slice(0, 8)}`)
        return { ok: true, offline: false }
      }
      const offline = res.status === 503
      console.warn(`[store] interrupt failed sid=${sessionId.slice(0, 8)} status=${res.status} offline=${offline}`)
      return { ok: false, offline }
    } catch (err) {
      console.warn(`[store] interrupt threw sid=${sessionId.slice(0, 8)}: ${(err as Error).message}`)
      return { ok: false, offline: false }
    }
  }

  // Apply a batch of server-provided messages to a slice. Used by the
  // WorkPanel on chat open to fill the slice from /session-state (ring
  // buffer, ~0-50ms) or /messages (Supabase fallback). Idempotent:
  // safe to re-run on visibility-resume or whenever the client wants
  // to refresh the slice.
  hydrateSlice(sessionId: string, msgs: ChatMessage[], claudeSessionId?: string | null): void {
    const before = this.slices.get(sessionId)?.messages.size ?? 0
    for (const m of msgs) this.upsertMessage(sessionId, m, { fuzzyMatch: true })
    if (claudeSessionId) this.setClaudeSessionId(sessionId, claudeSessionId)
    const after = this.slices.get(sessionId)?.messages.size ?? 0
    console.log(`[store] hydrateSlice sid=${sessionId.slice(0, 8)} incoming=${msgs.length} before=${before} after=${after} claude=${claudeSessionId ?? 'null'}`)
  }

  // Poke the daemon for the current set of running chats. Daemon
  // answers via a running_sessions broadcast which we handle in
  // ingestClaudeEvent — this is just the trigger.
  async queryRunning(): Promise<void> {
    try {
      await fetch('/api/companion/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'query_running' }),
      })
    } catch {}
  }

  // ── Utilities for provider (event parsing) ─────────────────────

  // Feed a parsed ClaudeEvent into the store. Routes by the event's
  // bornastarSessionId so each chat's slice grows independently even
  // when its ChatPanel isn't mounted.
  ingestClaudeEvent(event: ClaudeEvent): void {
    // Persist-only frame (user prompt relay, done summary row): the
    // daemon sends these so every lane (buffer, write-through, browser
    // store) adopts the same id + timestamp. No inner .event to render.
    if (event.type === 'claude_event' && !event.payload?.event && Array.isArray(event.payload?.persistRows)) {
      const sid = event.payload.bornastarSessionId
      if (!sid) return
      // Persist-only frames now arrive in two situations:
      //   1. The daemon's user-prompt relay (only user rows — no tool data).
      //   2. The sync-messages replay path: when the daemon's local queue
      //      drains after a network gap, missed events come through here
      //      INCLUDING tool rows. So we copy every renderable field we
      //      know about, not just role + content. Fields the row doesn't
      //      carry stay undefined and the renderer falls through normally.
      for (const r of event.payload.persistRows) {
        if (!r?.id) continue
        const row = r as Record<string, unknown>
        const claudeSid = typeof row.claudeSessionId === 'string' ? row.claudeSessionId : undefined
        if (claudeSid) this.setClaudeSessionId(sid, claudeSid)
        // User-row writeback from the daemon carries the FULL prompt sent to
        // the model (including any concatenated `--- a/file +++ b/file` diff
        // blocks from attached changes). The optimistic local upsert in
        // sendPrompt already stored the user-only display text + attachment
        // chips — we don't want this writeback to clobber the bubble with
        // raw diff text. Skip user rows entirely whenever the local row
        // already exists; the optimistic insert is the source of truth.
        // Tool rows / assistant rows / sync-replay rows still merge through.
        if (r.role === 'user' && this.slices.get(sid)?.messages.has(r.id)) continue
        // Only fields that actually exist on PersistRow (see lib/chat-persist.ts).
        // filePath / oldString / command / etc. are derived browser-side from
        // toolInput at render time — not part of the wire shape — so we don't
        // pretend to read them here. Renderer falls back gracefully when
        // those derivations are absent (a replayed Bash tool row shows
        // "Using Bash" instead of the polished command preview, which is
        // an acceptable trade for the rare sync-replay path).
        this.upsertMessage(sid, {
          id: r.id,
          role: r.role as ChatMessage['role'],
          content: r.content ?? '',
          timestamp: typeof r.createdAt === 'number' ? r.createdAt : Date.now(),
          toolName: typeof row.toolName === 'string' ? row.toolName : undefined,
          toolInput: row.toolInput as Record<string, unknown> | undefined,
          toolResult: typeof row.toolResult === 'string' ? row.toolResult : undefined,
          toolUseId: typeof row.toolUseId === 'string' ? row.toolUseId : undefined,
          toolError: typeof row.toolError === 'boolean' ? row.toolError : undefined,
          costUsd: typeof row.costUsd === 'number' ? row.costUsd : undefined,
          durationMs: typeof row.durationMs === 'number' ? row.durationMs : undefined,
        }, { fuzzyMatch: true })
      }
      return
    }

    // Non-claude bookkeeping events ─ status, running list, fs change ─
    // handled separately; they don't belong to a specific chat slice.
    if (event.type === 'companion_status') {
      const projDigest = (event.projects ?? []).map((p) => `${p.name}:${p.id.slice(0, 8)}`).join(',')
      console.log(`[store] companion_status connected=${event.connected} plan=${event.authInfo?.plan ?? '-'} projects=[${projDigest}]`)
      this.setStatus(
        event.connected ? 'connected' : 'disconnected',
        event.connected
          ? {
              email: event.authInfo?.email,
              plan: event.authInfo?.plan,
              version: event.authInfo?.version,
              projects: event.projects,
              machineName: event.machineName,
            }
          : null,
      )
      return
    }
    if (event.type === 'running_sessions') {
      this.setRunningSessions(event.payload?.sessionIds ?? [])
      return
    }

    // Everything else is a Claude stream event wrapped in claude_event.
    if (event.type !== 'claude_event' || !event.payload?.event) return
    const sid = event.payload.bornastarSessionId
    if (!sid) return
    const actual = event.payload.event

    if (actual.session_id) this.setClaudeSessionId(sid, actual.session_id)

    switch (actual.type) {
      case 'assistant': {
        if (!actual.message?.content) return
        const rows = event.payload?.persistRows ?? []
        let cursor = 0
        const takeRow = (role: 'assistant' | 'thinking'): { id: string; ts: number } => {
          for (let i = cursor; i < rows.length; i++) {
            if (rows[i].role === role) {
              cursor = i + 1
              const r = rows[i]
              return { id: r.id, ts: typeof r.createdAt === 'number' ? r.createdAt : Date.now() }
            }
          }
          return { id: localId(), ts: Date.now() }
        }
        for (const block of actual.message.content) {
          if (block.type === 'thinking' && block.thinking) {
            const { id, ts } = takeRow('thinking')
            this.upsertMessage(sid, { id, role: 'thinking', content: block.thinking, timestamp: ts })
          }
          if (block.type === 'text' && block.text) {
            const { id, ts } = takeRow('assistant')
            this.upsertMessage(sid, { id, role: 'assistant', content: block.text, timestamp: ts })
          }
          if (block.type === 'tool_use' && block.name) {
            const msg: ChatMessage = {
              id: block.id ?? localId(),
              role: 'tool',
              content: '',
              timestamp: Date.now(),
              toolName: block.name,
              toolInput: block.input,
              toolUseId: block.id,
            }
            const input = block.input ?? {}
            switch (block.name) {
              case 'Read':
                msg.filePath = input.file_path as string
                msg.content = `Reading ${input.file_path}`
                break
              case 'Write':
                msg.filePath = input.file_path as string
                msg.content = `Creating ${input.file_path}`
                break
              case 'Edit':
              case 'MultiEdit':
                msg.filePath = input.file_path as string
                msg.oldString = input.old_string as string
                msg.newString = input.new_string as string
                msg.content = `Editing ${input.file_path}`
                break
              case 'Bash':
                msg.command = input.command as string
                msg.content = input.description as string ?? `Running: ${(input.command as string)?.slice(0, 80)}`
                break
              case 'Grep':
                msg.searchPattern = input.pattern as string
                msg.content = `Searching for "${input.pattern}"`
                break
              case 'Glob':
                msg.searchPattern = input.pattern as string
                msg.content = `Finding files: ${input.pattern}`
                break
              case 'LS':
                msg.filePath = input.path as string
                msg.content = `Listing ${input.path}`
                break
              case 'WebFetch':
                msg.content = `Fetching ${input.url}`
                break
              case 'WebSearch':
                msg.searchPattern = input.query as string
                msg.content = `Searching: "${input.query}"`
                break
              case 'Agent':
              case 'Task':
                msg.content = `Spawning agent: ${input.description ?? 'task'}`
                break
              case 'TodoWrite':
                msg.content = 'Updating task list'
                break
              case 'NotebookEdit':
                msg.filePath = input.notebook_path as string
                msg.content = `Editing notebook ${input.notebook_path}`
                break
              default:
                msg.content = `${block.name}`
            }
            this.upsertMessage(sid, msg)
          }
        }
        return
      }
      case 'user': {
        if (!actual.message?.content) return
        for (const block of actual.message.content) {
          if (block.type !== 'tool_result' || !block.tool_use_id) continue
          const resultText = typeof block.content === 'string'
            ? block.content
            : Array.isArray(block.content)
              ? block.content.map((c) => c.text).join('\n')
              : ''
          this.patchMessage(sid, block.tool_use_id, (existing) => ({
            toolResult: resultText,
            toolError: block.is_error ?? false,
            bashOutput: existing.toolName === 'Bash' ? resultText : existing.bashOutput,
          }))
        }
        return
      }
      case 'result': {
        if (typeof actual.total_cost_usd === 'number') this.addCost(sid, actual.total_cost_usd)
        // Daemon persists the per-turn metrics row itself via its own
        // persistRow. We only surface a visible system message when the
        // turn errored.
        if (actual.is_error) {
          this.upsertMessage(sid, {
            id: localId(),
            role: 'system',
            content: `Error: ${actual.error ?? actual.result ?? 'Unknown error'}`,
            timestamp: Date.now(),
            costUsd: actual.total_cost_usd,
            durationMs: actual.duration_ms,
            numTurns: actual.num_turns,
          })
        }
        return
      }
      case 'error': {
        this.upsertMessage(sid, {
          id: localId(),
          role: 'system',
          content: `Error: ${actual.error ?? 'Unknown'}`,
          timestamp: Date.now(),
        })
        return
      }
      case 'system':
        // Noise banner — no visible row.
        return
    }
  }
}

const EMPTY_MESSAGES: ChatMessage[] = []

// Hunk attachment shape — diff payload + display metadata for the chip.
// Lives here so both the producer (DiffHunkView click handler in WorkPanel)
// and the consumer (ChatPanel input bar) agree on the structure without
// re-importing across UI ↔ store boundaries.
export interface PendingAttachment {
  filePath: string
  fileStatus: 'M' | 'A' | 'D'
  focusStart: number
  focusEnd: number
  formattedContent: string
  lineRange: string
  // When present, this attachment represents a bulk multi-file selection
  // from the Changes panel. The chip renders as "N files · M changes"
  // instead of the single-file path; formattedContent already contains
  // the complete fenced diff for every file (no further per-file
  // grouping in sendMessage). Single-hunk attachments leave this absent.
  bulkFiles?: Array<{ filePath: string; fileStatus: 'M' | 'A' | 'D'; hunkCount: number }>
}

const EMPTY_ATTACHMENTS: PendingAttachment[] = []

let _localCounter = 0
function localId(): string {
  return `msg-${Date.now()}-${++_localCounter}`
}

// Singleton instance used across the whole app session. Persisting the
// store at module scope is what gives us "chat B still receives events
// while chat A is open" — the slices stay alive regardless of which
// ChatPanel is mounted.
export const companionStore = new CompanionStore()
