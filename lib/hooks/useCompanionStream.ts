'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'

// ── Stream-JSON event types from Claude Code CLI ──────────────────────

export interface ClaudeContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking' | 'redacted_thinking'
  // text
  text?: string
  // thinking (extended-thinking mode only)
  thinking?: string
  // tool_use
  id?: string
  name?: string
  input?: Record<string, unknown>
  // tool_result
  tool_use_id?: string
  content?: string | Array<{ type: string; text: string }>
  is_error?: boolean
}

export interface ClaudeMessage {
  id: string
  type: string
  role: 'assistant' | 'user'
  content: ClaudeContentBlock[]
  usage?: { input_tokens: number; output_tokens: number }
}

export interface ClaudeEvent {
  type: 'system' | 'assistant' | 'user' | 'result' | 'error' | 'companion_status' | 'claude_event' | 'running_sessions'
  subtype?: string
  session_id?: string
  // system init
  tools?: string[]
  model?: string
  permissionMode?: string
  // assistant / user
  message?: ClaudeMessage
  // result
  total_cost_usd?: number
  is_error?: boolean
  duration_ms?: number
  num_turns?: number
  result?: string
  // error
  error?: string
  // companion_status
  connected?: boolean
  authInfo?: { email?: string; plan?: string; version?: string }
  projects?: Array<{ id: string; path: string; name: string }>
  // claude_event wrapper (from relay) — also reused for running_sessions
  // (sessionIds) and error envelopes (message).
  // `persistRows` are the ChatMessage-shaped rows the daemon stamped
  // before relay — we read their ids here so the live-stream render
  // uses the same id as the server/DB will see.
  payload?: {
    projectId?: string
    bornastarSessionId?: string
    event?: ClaudeEvent
    message?: string
    sessionIds?: string[]
    persistRows?: Array<{ id: string; role: string; content?: string; createdAt?: number }>
  }
}

// Parsed message for rendering — flattened from stream events
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool' | 'thinking'
  content: string
  timestamp: number
  // Tool info (when role = 'tool')
  toolName?: string
  toolInput?: Record<string, unknown>
  toolResult?: string
  toolError?: boolean
  toolUseId?: string
  // Diff info (for Edit tool)
  oldString?: string
  newString?: string
  filePath?: string
  // Bash info
  command?: string
  bashOutput?: string
  // Session metrics (when role = 'system' and it's a result)
  costUsd?: number
  durationMs?: number
  numTurns?: number
  // Search results
  searchPattern?: string
  searchResults?: string[]
}

export type CompanionStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

interface UseCompanionStreamReturn {
  messages: ChatMessage[]
  status: CompanionStatus
  isRunning: boolean
  companionInfo: {
    email?: string
    plan?: string
    version?: string
    projects?: Array<{ id: string; path: string; name: string }>
  } | null
  sessionId: string | null
  costUsd: number
  sendPrompt: (
    projectId: string,
    prompt: string,
    mode?: 'plan' | 'edit' | 'auto' | 'agent',
    bornastarSessionId?: string,
    opts?: { model?: string; thinking?: 'off' | 'low' | 'medium' | 'high' },
  ) => Promise<void>
  interrupt: (projectId: string, bornastarSessionId?: string) => Promise<void>
  clearMessages: () => void
  // Pagination — older pages from the DB. Each msg goes through the
  // reducer so duplicates are impossible regardless of call order.
  prependMessages: (msgs: ChatMessage[]) => void
  // Late hydrate — push the server's view into the store. Idempotent:
  // safe to call multiple times (e.g. on tab-resume after mobile
  // background suspend). Reducer dedups by id + fuzzy reconciles any
  // optimistic `msg-*` rows the browser minted before the server
  // echoed them with stable `evt-*` ids.
  hydrate: (msgs: ChatMessage[], claudeSessionId?: string | null) => void
  // Drop and re-open the SSE connection. Mobile Safari kills fetch
  // streams when the tab goes to background; ChatPanel calls this
  // on `visibilitychange → visible` to pick up the missed events.
  reconnect: () => void
}

export function useCompanionStream(
  bornastarSessionId?: string | null,
  initialMessages?: ChatMessage[],
  initialClaudeSessionId?: string | null,
): UseCompanionStreamReturn {
  // ── Messages store ───────────────────────────────────────────────
  // A single Map<id, ChatMessage> is the source of truth. Three inputs
  // funnel into it: the user's optimistic send, the SSE stream, and
  // the hydrate call (from /session-state or /messages). Dedup by id is
  // free; order comes from a derived sorted array.
  const [messagesMap, setMessagesMap] = useState<Map<string, ChatMessage>>(() => {
    const m = new Map<string, ChatMessage>()
    if (initialMessages) for (const msg of initialMessages) m.set(msg.id, msg)
    return m
  })
  const [status, setStatus] = useState<CompanionStatus>('disconnected')
  const [isRunning, setIsRunning] = useState(false)
  const [companionInfo, setCompanionInfo] = useState<UseCompanionStreamReturn['companionInfo']>(null)
  const [sessionId, setSessionId] = useState<string | null>(initialClaudeSessionId ?? null)
  const [costUsd, setCostUsd] = useState(0)
  // Bumped by `reconnect()` to retrigger the SSE useEffect.
  const [connectionEpoch, setConnectionEpoch] = useState(0)

  // ── Reducer primitives ───────────────────────────────────────────

  // Add or replace a message. If `fuzzyMatch` is true and the id is
  // new, we also look for an existing row with the same role + content
  // + close-in-time timestamp — that's almost certainly an optimistic
  // local render of the same logical message and we want to adopt the
  // server's stable id while keeping the richer local fields (e.g.
  // toolResult that may not have been buffered yet).
  const upsertMessage = useCallback((incoming: ChatMessage, opts?: { fuzzyMatch?: boolean }) => {
    setMessagesMap((prev) => {
      if (prev.has(incoming.id)) {
        const next = new Map(prev)
        const existing = next.get(incoming.id)!
        next.set(incoming.id, { ...existing, ...incoming })
        return next
      }
      if (opts?.fuzzyMatch) {
        for (const [existingId, existing] of prev) {
          if (
            existing.role === incoming.role
            && existing.content === incoming.content
            && Math.abs(existing.timestamp - incoming.timestamp) < 30_000
          ) {
            const next = new Map(prev)
            next.delete(existingId)
            // Preserve the local entry's data, swap in the server id.
            next.set(incoming.id, { ...existing, id: incoming.id })
            return next
          }
        }
      }
      const next = new Map(prev)
      next.set(incoming.id, incoming)
      return next
    })
  }, [])

  // Patch an existing message. Used when Claude follows up a tool_use
  // with its tool_result — same id, we merge in the result fields.
  // No-op if the target message hasn't been rendered yet.
  type PatchFn = (existing: ChatMessage) => Partial<ChatMessage>
  const patchMessage = useCallback((id: string, patch: Partial<ChatMessage> | PatchFn) => {
    setMessagesMap((prev) => {
      const existing = prev.get(id)
      if (!existing) return prev
      const updates = typeof patch === 'function' ? patch(existing) : patch
      const next = new Map(prev)
      next.set(id, { ...existing, ...updates })
      return next
    })
  }, [])

  // Derived sorted array — what components actually render. Sorting
  // here means every source (optimistic, SSE, hydrate) can insert in
  // any order and the UI stays chronological.
  const messages = useMemo(
    () => Array.from(messagesMap.values()).sort((a, b) => a.timestamp - b.timestamp),
    [messagesMap],
  )

  // ── Id helpers ───────────────────────────────────────────────────

  // Stable id that matches the daemon's format. Used for any row that
  // needs to round-trip through queue → buffer → Supabase. Keeping the
  // optimistic id and the server-persisted id identical means
  // /session-state hydrate is a no-op on re-mount.
  const stableEventId = () => `evt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  // Local-only id for rows the server never sees (pure UI state like
  // "network failed" system lines). Always increments so timestamps
  // stay monotonic within one session.
  const localIdCounter = useRef(0)
  const localId = () => `msg-${Date.now()}-${++localIdCounter.current}`

  // ── Parse & dispatch ─────────────────────────────────────────────

  const parseEvent = useCallback((event: ClaudeEvent): void => {
    // Per-chat isolation: claude_event / error payloads from the daemon
    // carry the originating Bornastar chat session id. Skip anything
    // that doesn't belong to this hook's chat — chat1 never sees chat2's
    // stream, even when both bridges are running on the same user channel.
    if (bornastarSessionId && (event.type === 'claude_event' || event.type === 'error')) {
      const evtSession = event.payload?.bornastarSessionId
      if (evtSession && evtSession !== bornastarSessionId) return
    }

    // Persist-only frame: the daemon relays the user prompt (and some
    // other bookkeeping rows) as claude_event with `persistRows` but no
    // inner `event`. We don't render these via the switch below — we
    // just upsert so the browser adopts the daemon's stable id AND
    // timestamp for the optimistic user row. That collapses the tiny
    // browser-vs-daemon clock gap that otherwise could sort a new
    // user prompt AFTER its own thinking row.
    if (event.type === 'claude_event' && !event.payload?.event && Array.isArray(event.payload?.persistRows)) {
      for (const r of event.payload.persistRows) {
        if (!r?.id) continue
        upsertMessage({
          id: r.id,
          role: r.role as ChatMessage['role'],
          content: r.content ?? '',
          timestamp: typeof r.createdAt === 'number' ? r.createdAt : Date.now(),
        }, { fuzzyMatch: true })
      }
      return
    }

    // Unwrap relay wrapper
    const actual = event.type === 'claude_event' && event.payload?.event
      ? event.payload.event
      : event

    if (actual.session_id) setSessionId(actual.session_id)

    switch (actual.type) {
      case 'companion_status':
        if (actual.connected) {
          setStatus('connected')
          setCompanionInfo({
            email: actual.authInfo?.email,
            plan: actual.authInfo?.plan,
            version: actual.authInfo?.version,
            projects: actual.projects,
          })
        } else {
          setStatus('disconnected')
        }
        break

      case 'system':
        // Intentionally quiet — the "Session started · Model: ..." banner
        // adds noise between the user message and the reply. The current
        // session/model is visible in the header + cost tracker already.
        break

      case 'assistant':
        if (actual.message?.content) {
          // Daemon emits persistRows in the same order as these content
          // blocks. Walk them in lock-step so every rendered message
          // carries the server's stable id AND the server's timestamp
          // — hydrate after remount becomes a no-op, no duplicates, no
          // visual reorder.
          const rows = event.payload?.persistRows ?? []
          let rowCursor = 0
          const takeRow = (role: 'assistant' | 'thinking'): { id: string; ts: number } => {
            for (let i = rowCursor; i < rows.length; i++) {
              if (rows[i].role === role) {
                rowCursor = i + 1
                const r = rows[i]
                return {
                  id: r.id,
                  ts: typeof r.createdAt === 'number' ? r.createdAt : Date.now(),
                }
              }
            }
            return { id: localId(), ts: Date.now() }
          }
          for (const block of actual.message.content) {
            if (block.type === 'thinking' && block.thinking) {
              const { id, ts } = takeRow('thinking')
              upsertMessage({
                id,
                role: 'thinking',
                content: block.thinking,
                timestamp: ts,
              })
            }
            if (block.type === 'text' && block.text) {
              const { id, ts } = takeRow('assistant')
              upsertMessage({
                id,
                role: 'assistant',
                content: block.text,
                timestamp: ts,
              })
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
              upsertMessage(msg)
            }
          }
        }
        break

      case 'user':
        // Tool results — patched into the existing tool_use row by id
        // (daemon uses Claude's tool_use_id as the persistRow id). If
        // the tool_use row isn't in memory yet, patchMessage no-ops and
        // the row will get the result via hydrate later.
        if (actual.message?.content) {
          for (const block of actual.message.content) {
            if (block.type !== 'tool_result' || !block.tool_use_id) continue
            const resultText = typeof block.content === 'string'
              ? block.content
              : Array.isArray(block.content)
                ? block.content.map((c) => c.text).join('\n')
                : ''
            patchMessage(block.tool_use_id, (existing) => ({
              toolResult: resultText,
              toolError: block.is_error ?? false,
              bashOutput: existing.toolName === 'Bash' ? resultText : existing.bashOutput,
            }))
          }
        }
        break

      case 'result': {
        setIsRunning(false)
        if (actual.total_cost_usd) setCostUsd((prev) => prev + actual.total_cost_usd!)
        // The daemon persists the per-turn metrics row itself; we only
        // surface a visible system message when the turn errored.
        if (actual.is_error) {
          upsertMessage({
            id: localId(),
            role: 'system',
            content: `Error: ${actual.error ?? actual.result ?? 'Unknown error'}`,
            timestamp: Date.now(),
            costUsd: actual.total_cost_usd,
            durationMs: actual.duration_ms,
            numTurns: actual.num_turns,
          })
        }
        break
      }

      case 'error': {
        setIsRunning(false)
        upsertMessage({
          id: localId(),
          role: 'system',
          content: `Error: ${actual.error ?? (actual.payload as { message?: string })?.message ?? 'Unknown'}`,
          timestamp: Date.now(),
        })
        break
      }

      case 'running_sessions': {
        // Daemon broadcasts which chats are currently running. A ChatPanel
        // remounting mid-prompt uses this to restore its spinner without
        // waiting for the next Claude event.
        const ids = actual.payload?.sessionIds ?? []
        if (bornastarSessionId) setIsRunning(ids.includes(bornastarSessionId))
        break
      }
    }
  }, [bornastarSessionId, upsertMessage, patchMessage])

  // ── SSE connection ───────────────────────────────────────────────
  //
  // Re-runs whenever `connectionEpoch` bumps. `reconnect()` is how the
  // caller forces a reopen — used by ChatPanel when the browser tab
  // wakes up from the background (mobile Safari kills streams).
  useEffect(() => {
    const controller = new AbortController()

    async function connect() {
      setStatus('connecting')
      try {
        const res = await fetch('/api/companion/stream', { signal: controller.signal })
        if (!res.ok || !res.body) { setStatus('error'); return }
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue
            try {
              parseEvent(JSON.parse(line.slice(6)) as ClaudeEvent)
            } catch { /* non-JSON line */ }
          }
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') setStatus('error')
      }
    }

    connect()
    return () => controller.abort()
  }, [parseEvent, connectionEpoch])

  const reconnect = useCallback(() => {
    setConnectionEpoch((n) => n + 1)
  }, [])

  // On mount (or when the chat id changes) ask the daemon which chats
  // are currently running so a ChatPanel re-mounted mid-prompt re-syncs
  // its spinner without waiting for the next Claude event.
  useEffect(() => {
    if (!bornastarSessionId) return
    fetch('/api/companion/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'query_running' }),
    }).catch(() => {})
  }, [bornastarSessionId])

  // ── User actions ─────────────────────────────────────────────────

  const sendPrompt = useCallback(async (
    projectId: string,
    prompt: string,
    mode?: 'plan' | 'edit' | 'auto' | 'agent',
    bornastarSessionId?: string,
    opts?: { model?: string; thinking?: 'off' | 'low' | 'medium' | 'high' },
  ) => {
    setIsRunning(true)
    // Mint the row id on the client so optimistic + daemon + DB all
    // share one id and /session-state hydrate is a no-op on remount.
    const userMsgId = stableEventId()
    upsertMessage({
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
          claudeSessionId: sessionId,
          bornastarSessionId,
          mode: mode ?? 'auto',
          model: opts?.model,
          thinking: opts?.thinking ?? 'off',
        }),
      })
      if (!res.ok) {
        setIsRunning(false)
        let msg = 'Failed to reach Claude Code companion.'
        try {
          const data = await res.json()
          if (data?.message) msg = data.message
          else if (data?.error) msg = data.error
        } catch { /* body wasn't JSON */ }
        upsertMessage({
          id: localId(),
          role: 'system',
          content: `Error: ${msg}`,
          timestamp: Date.now(),
        })
      }
    } catch {
      setIsRunning(false)
      upsertMessage({
        id: localId(),
        role: 'system',
        content: 'Error: Network failed reaching the companion. Try again.',
        timestamp: Date.now(),
      })
    }
  }, [sessionId, upsertMessage])

  const interrupt = useCallback(async (projectId: string, bornastarSessionId?: string) => {
    await fetch('/api/companion/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'interrupt', projectId, bornastarSessionId }),
    })
  }, [])

  const clearMessages = useCallback(() => {
    setMessagesMap(new Map())
    setCostUsd(0)
    setSessionId(null)
    setIsRunning(false)
  }, [])

  const prependMessages = useCallback((msgs: ChatMessage[]) => {
    if (msgs.length === 0) return
    for (const m of msgs) upsertMessage(m)
  }, [upsertMessage])

  const hydrate = useCallback((msgs: ChatMessage[], claudeSessionId?: string | null) => {
    for (const m of msgs) upsertMessage(m, { fuzzyMatch: true })
    if (claudeSessionId) setSessionId(claudeSessionId)
  }, [upsertMessage])

  return {
    messages,
    status,
    isRunning,
    companionInfo,
    sessionId,
    costUsd,
    sendPrompt,
    interrupt,
    clearMessages,
    prependMessages,
    hydrate,
    reconnect,
  }
}
