'use client'

import { useState, useEffect, useCallback, useRef } from 'react'

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
  payload?: { projectId?: string; bornastarSessionId?: string; event?: ClaudeEvent; message?: string; sessionIds?: string[] }
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
  // Pagination / late hydrate — ChatPanel calls these to push DB pages into
  // the hook. prependMessages for older-page scroll, hydrate for the
  // initial async fetch (when parent had no cached state).
  prependMessages: (msgs: ChatMessage[]) => void
  hydrate: (msgs: ChatMessage[], claudeSessionId?: string | null) => void
}

export function useCompanionStream(
  bornastarSessionId?: string | null,
  initialMessages?: ChatMessage[],
  persist?: { projectId: string; initialClaudeSessionId?: string | null },
): UseCompanionStreamReturn {
  const [messages, setMessages] = useState<ChatMessage[]>(() => initialMessages ?? [])
  const [status, setStatus] = useState<CompanionStatus>('disconnected')
  const [isRunning, setIsRunning] = useState(false)
  const [companionInfo, setCompanionInfo] = useState<UseCompanionStreamReturn['companionInfo']>(null)
  const [sessionId, setSessionId] = useState<string | null>(persist?.initialClaudeSessionId ?? null)
  const [costUsd, setCostUsd] = useState(0)
  const eventSourceRef = useRef<AbortController | null>(null)
  const messageIdCounter = useRef(0)

  // ── Persistence with retry queue ─────────────────────────────────
  // Every stream event persists to the DB so refresh / device switch
  // restores the conversation. Writes are fire-and-forget in the happy
  // path, but failures (network flap, rate limit, 5xx) are parked in a
  // retry queue and replayed with exponential backoff. The queue is
  // mirrored to localStorage so even a tab close doesn't lose events.
  const persistTargetRef = useRef<{ projectId: string; sessionId: string } | null>(null)
  useEffect(() => {
    if (persist && bornastarSessionId) {
      persistTargetRef.current = { projectId: persist.projectId, sessionId: bornastarSessionId }
    } else {
      persistTargetRef.current = null
    }
  }, [persist, bornastarSessionId])

  const retryQueueRef = useRef<Record<string, unknown>[]>([])
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const retryAttemptRef = useRef(0)
  const queueStorageKey = bornastarSessionId ? `bornastar:persist-queue:${bornastarSessionId}` : null

  // Hydrate queue from localStorage on mount — a crashed tab might have
  // left pending events we should still flush.
  useEffect(() => {
    if (!queueStorageKey) return
    try {
      const raw = localStorage.getItem(queueStorageKey)
      if (!raw) return
      const parsed = JSON.parse(raw) as Record<string, unknown>[]
      if (Array.isArray(parsed) && parsed.length > 0) {
        retryQueueRef.current.push(...parsed)
        scheduleRetry()
      }
    } catch { /* ignore corrupt queue */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueStorageKey])

  function saveQueue(): void {
    if (!queueStorageKey) return
    try {
      if (retryQueueRef.current.length === 0) localStorage.removeItem(queueStorageKey)
      else localStorage.setItem(queueStorageKey, JSON.stringify(retryQueueRef.current))
    } catch { /* quota exceeded, drop silently */ }
  }

  function scheduleRetry(): void {
    if (retryTimerRef.current) return
    const attempt = retryAttemptRef.current
    const delay = Math.min(30_000, 500 * Math.pow(2, attempt))  // 0.5s, 1s, 2s, 4s… cap 30s
    retryTimerRef.current = setTimeout(async () => {
      retryTimerRef.current = null
      const target = persistTargetRef.current
      if (!target) return
      const batch = retryQueueRef.current.splice(0, 100)  // drain in chunks to bound request size
      if (batch.length === 0) return
      try {
        const res = await fetch(`/api/projects/${target.projectId}/chat-sessions/${target.sessionId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ events: batch }),
        })
        if (!res.ok) throw new Error(`persist ${res.status}`)
        retryAttemptRef.current = 0
        saveQueue()
        if (retryQueueRef.current.length > 0) scheduleRetry()
      } catch {
        // Re-queue at the FRONT so ordering is preserved.
        retryQueueRef.current.unshift(...batch)
        retryAttemptRef.current = Math.min(retryAttemptRef.current + 1, 8)
        saveQueue()
        scheduleRetry()
      }
    }, delay)
  }

  const persistEvents = useCallback((events: Record<string, unknown>[]) => {
    const target = persistTargetRef.current
    if (!target || events.length === 0) return
    // Stamp a client-side timestamp so the server can keep true order
    // even if POSTs arrive out of network order.
    const stamped = events.map((e) => ({ clientCreatedAt: Date.now(), ...e }))
    fetch(`/api/projects/${target.projectId}/chat-sessions/${target.sessionId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: stamped }),
    }).then((res) => {
      if (!res.ok) throw new Error(`persist ${res.status}`)
    }).catch(() => {
      retryQueueRef.current.push(...stamped)
      saveQueue()
      scheduleRetry()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const nextId = () => `msg-${Date.now()}-${++messageIdCounter.current}`

  // Parse a Claude stream event into ChatMessage(s)
  const parseEvent = useCallback((event: ClaudeEvent): ChatMessage[] => {
    const parsed: ChatMessage[] = []

    // Per-chat isolation: claude_event / error payloads from the daemon carry
    // the originating Bornastar chat session id. Skip anything that doesn't
    // belong to this hook's chat so chat1 never sees chat2's stream, even
    // when both bridges are running concurrently on the same user channel.
    if (bornastarSessionId && (event.type === 'claude_event' || event.type === 'error')) {
      const evtSession = event.payload?.bornastarSessionId
      if (evtSession && evtSession !== bornastarSessionId) return []
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
          for (const block of actual.message.content) {
            if (block.type === 'thinking' && block.thinking) {
              // Extended-thinking content — Claude's private reasoning
              // before it starts acting. Rendered as a row inside the
              // work block so the user can follow the chain of thought.
              parsed.push({
                id: nextId(),
                role: 'thinking',
                content: block.thinking,
                timestamp: Date.now(),
              })
            }
            if (block.type === 'text' && block.text) {
              parsed.push({
                id: nextId(),
                role: 'assistant',
                content: block.text,
                timestamp: Date.now(),
              })
            }
            if (block.type === 'tool_use' && block.name) {
              const msg: ChatMessage = {
                id: block.id ?? nextId(),
                role: 'tool',
                content: '',
                timestamp: Date.now(),
                toolName: block.name,
                toolInput: block.input,
                toolUseId: block.id,
              }

              // Extract common fields for rich rendering
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
              parsed.push(msg)
            }
          }
        }
        break

      case 'user':
        // Tool results — match back to tool_use by id
        if (actual.message?.content) {
          for (const block of actual.message.content) {
            if (block.type === 'tool_result') {
              const resultText = typeof block.content === 'string'
                ? block.content
                : Array.isArray(block.content)
                  ? block.content.map((c) => c.text).join('\n')
                  : ''

              // Update existing tool message with result
              setMessages((prev) => prev.map((m) => {
                if (m.toolUseId === block.tool_use_id) {
                  const updated: ChatMessage = {
                    ...m,
                    toolResult: resultText,
                    toolError: block.is_error ?? false,
                    bashOutput: m.toolName === 'Bash' ? resultText : m.bashOutput,
                  }
                  // Write-through: update the row in place so a refresh
                  // restores the tool result, not just the tool call.
                  persistEvents([{
                    id: updated.id,
                    role: 'tool',
                    content: updated.content,
                    toolName: updated.toolName,
                    toolInput: updated.toolInput,
                    toolResult: resultText,
                    toolUseId: updated.toolUseId,
                    toolError: updated.toolError,
                  }])
                  return updated
                }
                return m
              }))
            }
          }
        }
        break

      case 'result': {
        setIsRunning(false)
        if (actual.total_cost_usd) setCostUsd((prev) => prev + actual.total_cost_usd!)
        // Per-turn metrics land on a 'system' marker row. We hide it from
        // the UI (noise), but persist it so the DB keeps the full audit
        // trail (cost, tokens, duration, model, session id) for training.
        const metricsMsg: ChatMessage = {
          id: nextId(),
          role: 'system',
          content: actual.is_error
            ? `Error: ${actual.error ?? actual.result ?? 'Unknown error'}`
            : '',
          timestamp: Date.now(),
          costUsd: actual.total_cost_usd,
          durationMs: actual.duration_ms,
          numTurns: actual.num_turns,
        }
        persistEvents([{
          id: metricsMsg.id,
          role: 'system',
          content: metricsMsg.content,
          costUsd: metricsMsg.costUsd,
          durationMs: metricsMsg.durationMs,
          claudeSessionId: actual.session_id,
        }])
        if (actual.is_error) parsed.push(metricsMsg)
        break
      }

      case 'error': {
        setIsRunning(false)
        const errMsg: ChatMessage = {
          id: nextId(),
          role: 'system',
          content: `Error: ${actual.error ?? (actual.payload as { message?: string })?.message ?? 'Unknown'}`,
          timestamp: Date.now(),
        }
        persistEvents([{ id: errMsg.id, role: 'system', content: errMsg.content }])
        parsed.push(errMsg)
        break
      }

      case 'running_sessions': {
        // Daemon broadcasts which chats are currently running. A ChatPanel
        // remounting mid-prompt uses this to restore its spinner.
        const ids = actual.payload?.sessionIds ?? []
        if (bornastarSessionId) {
          setIsRunning(ids.includes(bornastarSessionId))
        }
        break
      }
    }

    return parsed
  }, [bornastarSessionId])

  // Connect to SSE stream
  useEffect(() => {
    const controller = new AbortController()
    eventSourceRef.current = controller

    async function connect() {
      setStatus('connecting')
      try {
        const res = await fetch('/api/companion/stream', {
          signal: controller.signal,
        })
        if (!res.ok || !res.body) {
          setStatus('error')
          return
        }

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
            if (line.startsWith('data: ')) {
              try {
                const event = JSON.parse(line.slice(6)) as ClaudeEvent
                const newMessages = parseEvent(event)
                if (newMessages.length > 0) {
                  setMessages((prev) => [...prev, ...newMessages])
                  // Persist the freshly-created messages (assistant text,
                  // tool_use calls). Tool results and final result rows
                  // were already persisted inline inside parseEvent.
                  persistEvents(newMessages.map((m) => ({
                    id: m.id,
                    role: m.role,
                    content: m.content,
                    toolName: m.toolName,
                    toolInput: m.toolInput,
                    toolUseId: m.toolUseId,
                    toolError: m.toolError,
                  })))
                }
              } catch {
                // Non-JSON, skip
              }
            }
          }
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setStatus('error')
        }
      }
    }

    connect()
    return () => controller.abort()
  }, [parseEvent])

  // On mount (or when the chat id changes) ask the daemon which chats are
  // currently running so a ChatPanel re-mounted mid-prompt re-syncs its
  // "Claude is working" spinner without waiting for the next Claude event.
  useEffect(() => {
    if (!bornastarSessionId) return
    fetch('/api/companion/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'query_running' }),
    }).catch(() => {})
  }, [bornastarSessionId])

  // Send prompt to companion. `sessionId` on the state is the Claude Code
  // session ID (used for --resume); `bornastarSessionId` is the Bornastar
  // chat ID used to isolate bridges and resolve the worktree path.
  const sendPrompt = useCallback(async (
    projectId: string,
    prompt: string,
    mode?: 'plan' | 'edit' | 'auto' | 'agent',
    bornastarSessionId?: string,
    opts?: { model?: string; thinking?: 'off' | 'low' | 'medium' | 'high' },
  ) => {
    setIsRunning(true)
    const userMsgId = nextId()
    setMessages((prev) => [...prev, {
      id: userMsgId,
      role: 'user',
      content: prompt,
      timestamp: Date.now(),
    }])
    // Persist the user prompt immediately. The mode/permission snapshot
    // + model choice go on this row so we can slice training data later.
    persistEvents([{
      id: userMsgId,
      role: 'user',
      content: prompt,
      permissionMode: mode ?? 'auto',
      ...(opts?.model && { model: opts.model }),
    }])

    // Fire the command. If the companion daemon is flapping (dev-server
    // hot reload killed its SSE, reconnect not finished) the server
    // returns 503 immediately — reset the running flag so the spinner
    // doesn't hang forever and surface a readable error in the chat
    // instead of a silent stuck state.
    try {
      const res = await fetch('/api/companion/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'prompt',
          projectId,
          prompt,
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
        setMessages((prev) => [...prev, {
          id: nextId(),
          role: 'system',
          content: `Error: ${msg}`,
          timestamp: Date.now(),
        }])
      }
    } catch {
      setIsRunning(false)
      setMessages((prev) => [...prev, {
        id: nextId(),
        role: 'system',
        content: 'Error: Network failed reaching the companion. Try again.',
        timestamp: Date.now(),
      }])
    }
  }, [sessionId])

  // Interrupt running agent for a specific chat (matches the bridge key).
  const interrupt = useCallback(async (projectId: string, bornastarSessionId?: string) => {
    await fetch('/api/companion/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'interrupt', projectId, bornastarSessionId }),
    })
  }, [])

  const clearMessages = useCallback(() => {
    setMessages([])
    setCostUsd(0)
    setSessionId(null)
    setIsRunning(false)
  }, [])

  // Prepend older pages fetched by the ChatPanel when the user scrolls
  // up. Guarded against duplicates by id so a slow older-page fetch that
  // lands after another doesn't double-insert.
  const prependMessages = useCallback((msgs: ChatMessage[]) => {
    if (msgs.length === 0) return
    setMessages((prev) => {
      const seen = new Set(prev.map((m) => m.id))
      const fresh = msgs.filter((m) => !seen.has(m.id))
      if (fresh.length === 0) return prev
      return [...fresh, ...prev]
    })
  }, [])

  // Late hydrate — the DB fetch can land AFTER the hook mounted (parent
  // had an empty cache). Replace state once, only if we haven't received
  // any streaming events yet, so we never clobber in-flight user/Claude
  // turns. Also picks up the Claude --resume session id.
  const hydratedRef = useRef(false)
  const hydrate = useCallback((msgs: ChatMessage[], claudeSessionId?: string | null) => {
    if (hydratedRef.current) return
    hydratedRef.current = true
    setMessages((prev) => {
      if (prev.length > 0) {
        // Stream already produced content — merge by id, preferring
        // existing in-memory entries (they're the freshest).
        const existing = new Set(prev.map((m) => m.id))
        const older = msgs.filter((m) => !existing.has(m.id))
        return [...older, ...prev]
      }
      return msgs
    })
    if (claudeSessionId) setSessionId(claudeSessionId)
  }, [])

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
  }
}
