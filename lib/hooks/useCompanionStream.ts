'use client'

import { useState, useEffect, useCallback, useRef } from 'react'

// ── Stream-JSON event types from Claude Code CLI ──────────────────────

export interface ClaudeContentBlock {
  type: 'text' | 'tool_use' | 'tool_result'
  // text
  text?: string
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
  type: 'system' | 'assistant' | 'user' | 'result' | 'error' | 'companion_status' | 'claude_event'
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
  // claude_event wrapper (from relay)
  payload?: { projectId?: string; event?: ClaudeEvent; message?: string }
}

// Parsed message for rendering — flattened from stream events
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
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
  companionInfo: {
    email?: string
    plan?: string
    version?: string
    projects?: Array<{ id: string; path: string; name: string }>
  } | null
  sessionId: string | null
  costUsd: number
  sendPrompt: (projectId: string, prompt: string, mode?: 'plan' | 'edit' | 'auto' | 'agent') => Promise<void>
  interrupt: (projectId: string) => Promise<void>
  clearMessages: () => void
}

export function useCompanionStream(): UseCompanionStreamReturn {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [status, setStatus] = useState<CompanionStatus>('disconnected')
  const [companionInfo, setCompanionInfo] = useState<UseCompanionStreamReturn['companionInfo']>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [costUsd, setCostUsd] = useState(0)
  const eventSourceRef = useRef<AbortController | null>(null)
  const messageIdCounter = useRef(0)

  const nextId = () => `msg-${Date.now()}-${++messageIdCounter.current}`

  // Parse a Claude stream event into ChatMessage(s)
  const parseEvent = useCallback((event: ClaudeEvent): ChatMessage[] => {
    const parsed: ChatMessage[] = []

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
        if (actual.subtype === 'init') {
          parsed.push({
            id: nextId(),
            role: 'system',
            content: `Session started · Model: ${actual.model ?? 'claude'} · Mode: ${actual.permissionMode ?? 'default'}`,
            timestamp: Date.now(),
          })
        }
        break

      case 'assistant':
        if (actual.message?.content) {
          for (const block of actual.message.content) {
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
                  return {
                    ...m,
                    toolResult: resultText,
                    toolError: block.is_error ?? false,
                    bashOutput: m.toolName === 'Bash' ? resultText : m.bashOutput,
                  }
                }
                return m
              }))
            }
          }
        }
        break

      case 'result':
        if (actual.total_cost_usd) setCostUsd((prev) => prev + actual.total_cost_usd!)
        parsed.push({
          id: nextId(),
          role: 'system',
          content: actual.is_error
            ? `Error: ${actual.error ?? actual.result ?? 'Unknown error'}`
            : actual.result ?? 'Done',
          timestamp: Date.now(),
          costUsd: actual.total_cost_usd,
          durationMs: actual.duration_ms,
          numTurns: actual.num_turns,
        })
        break

      case 'error':
        parsed.push({
          id: nextId(),
          role: 'system',
          content: `Error: ${actual.error ?? (actual.payload as { message?: string })?.message ?? 'Unknown'}`,
          timestamp: Date.now(),
        })
        break
    }

    return parsed
  }, [])

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

  // Send prompt to companion
  const sendPrompt = useCallback(async (projectId: string, prompt: string, mode?: 'plan' | 'edit' | 'auto' | 'agent') => {
    setMessages((prev) => [...prev, {
      id: nextId(),
      role: 'user',
      content: prompt,
      timestamp: Date.now(),
    }])

    await fetch('/api/companion/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'prompt',
        projectId,
        prompt,
        sessionId,
        mode: mode ?? 'auto',
      }),
    })
  }, [sessionId])

  // Interrupt running agent
  const interrupt = useCallback(async (projectId: string) => {
    await fetch('/api/companion/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'interrupt', projectId }),
    })
  }, [])

  const clearMessages = useCallback(() => {
    setMessages([])
    setCostUsd(0)
    setSessionId(null)
  }, [])

  return {
    messages,
    status,
    companionInfo,
    sessionId,
    costUsd,
    sendPrompt,
    interrupt,
    clearMessages,
  }
}
