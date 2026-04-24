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

interface ChatSlice {
  messages: Map<string, ChatMessage>
  claudeSessionId: string | null
  costUsd: number
  // Sorted-by-timestamp snapshot used by the messages selector. We
  // cache it so `useSyncExternalStore`'s getSnapshot stays referentially
  // stable while nothing relevant changed (React bails out of re-render
  // when the reference matches).
  sortedCache: ChatMessage[] | null
}

export interface CompanionInfo {
  email?: string
  plan?: string
  version?: string
  projects?: Array<{ id: string; path: string; name: string }>
}

type Listener = () => void

function emptySlice(): ChatSlice {
  return { messages: new Map(), claudeSessionId: null, costUsd: 0, sortedCache: null }
}

class CompanionStore {
  // ── State ──────────────────────────────────────────────────────
  private slices: Map<string, ChatSlice> = new Map()
  private status: CompanionStatus = 'disconnected'
  private companionInfo: CompanionInfo | null = null
  private runningSessionIds: Set<string> = new Set()
  private unreadSessionIds: Set<string> = new Set()
  // Bumped on reconnect() so provider's SSE useEffect can re-run.
  private connectionEpoch = 0

  // ── Scoped listeners ───────────────────────────────────────────
  private sliceListeners: Map<string, Set<Listener>> = new Map()
  private runningListeners: Set<Listener> = new Set()
  private unreadListeners: Set<Listener> = new Set()
  private statusListeners: Set<Listener> = new Set()
  private epochListeners: Set<Listener> = new Set()

  // ── Snapshot helpers (referentially stable between notifies) ──

  getMessages(sessionId: string): ChatMessage[] {
    const slice = this.slices.get(sessionId)
    if (!slice) return EMPTY_MESSAGES
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
  private notifyStatus(): void { for (const l of this.statusListeners) l() }
  private notifyEpoch(): void { for (const l of this.epochListeners) l() }

  // ── Actions ────────────────────────────────────────────────────

  private getOrCreateSlice(sessionId: string): ChatSlice {
    let slice = this.slices.get(sessionId)
    if (!slice) { slice = emptySlice(); this.slices.set(sessionId, slice) }
    return slice
  }

  private invalidateSortedCache(slice: ChatSlice): void {
    slice.sortedCache = null
  }

  upsertMessage(sessionId: string, incoming: ChatMessage, opts?: { fuzzyMatch?: boolean }): void {
    const slice = this.getOrCreateSlice(sessionId)
    if (slice.messages.has(incoming.id)) {
      const existing = slice.messages.get(incoming.id)!
      slice.messages.set(incoming.id, { ...existing, ...incoming })
    } else if (opts?.fuzzyMatch) {
      let adopted = false
      for (const [existingId, existing] of slice.messages) {
        if (
          existing.role === incoming.role
          && existing.content === incoming.content
          && Math.abs(existing.timestamp - incoming.timestamp) < 30_000
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
    slice.claudeSessionId = value
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
      mode?: 'plan' | 'edit' | 'auto' | 'agent'
      model?: string
      thinking?: 'off' | 'low' | 'medium' | 'high'
    },
  ): Promise<void> {
    this.markBusy(sessionId)
    const userMsgId = this.mintStableId()
    this.upsertMessage(sessionId, {
      id: userMsgId,
      role: 'user',
      content: prompt,
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
          userMsgId,
          claudeSessionId: this.getClaudeSessionId(sessionId),
          bornastarSessionId: sessionId,
          mode: opts?.mode ?? 'auto',
          model: opts?.model,
          thinking: opts?.thinking ?? 'off',
        }),
      })
      if (!res.ok) {
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
    } catch {
      this.upsertMessage(sessionId, {
        id: localId(),
        role: 'system',
        content: 'Error: Network failed reaching the companion. Try again.',
        timestamp: Date.now(),
      })
    }
  }

  async interrupt(sessionId: string, projectId: string): Promise<void> {
    await fetch('/api/companion/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'interrupt', projectId, bornastarSessionId: sessionId }),
    })
  }

  // Apply a batch of server-provided messages to a slice. Used by the
  // WorkPanel on chat open to fill the slice from /session-state (ring
  // buffer, ~0-50ms) or /messages (Supabase fallback). Idempotent:
  // safe to re-run on visibility-resume or whenever the client wants
  // to refresh the slice.
  hydrateSlice(sessionId: string, msgs: ChatMessage[], claudeSessionId?: string | null): void {
    for (const m of msgs) this.upsertMessage(sessionId, m, { fuzzyMatch: true })
    if (claudeSessionId) this.setClaudeSessionId(sessionId, claudeSessionId)
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
      for (const r of event.payload.persistRows) {
        if (!r?.id) continue
        this.upsertMessage(sid, {
          id: r.id,
          role: r.role as ChatMessage['role'],
          content: r.content ?? '',
          timestamp: typeof r.createdAt === 'number' ? r.createdAt : Date.now(),
        }, { fuzzyMatch: true })
      }
      return
    }

    // Non-claude bookkeeping events ─ status, running list, fs change ─
    // handled separately; they don't belong to a specific chat slice.
    if (event.type === 'companion_status') {
      this.setStatus(
        event.connected ? 'connected' : 'disconnected',
        event.connected
          ? { email: event.authInfo?.email, plan: event.authInfo?.plan, version: event.authInfo?.version, projects: event.projects }
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

let _localCounter = 0
function localId(): string {
  return `msg-${Date.now()}-${++_localCounter}`
}

// Singleton instance used across the whole app session. Persisting the
// store at module scope is what gives us "chat B still receives events
// while chat A is open" — the slices stay alive regardless of which
// ChatPanel is mounted.
export const companionStore = new CompanionStore()
