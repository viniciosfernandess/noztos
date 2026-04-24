// ── Companion stream types ────────────────────────────────────────
//
// Shared vocabulary between the SSE-parsing layer in CompanionProvider,
// the module-level companionStore (lib/companion-store.ts), and the
// components that render chat state via the store hooks (lib/hooks/
// useCompanionStore.ts). No runtime code lives here any more — the
// old `useCompanionStream` hook was replaced by the store-based
// architecture. File kept under this name so existing `import type`
// paths keep working.

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
  // before relay. Live-stream render uses those stable ids so hydrate
  // after remount is a no-op — same row on the wire, same id in state.
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
