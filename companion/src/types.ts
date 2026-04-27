// ── Shared types for the Bornastar companion ──────────────────────────

export interface ProjectConfig {
  id: string
  path: string
  name: string
  registeredAt: string
  gitRemote?: string
}

export interface CompanionConfig {
  version: string
  serverUrl: string
  authToken: string | null
  projects: ProjectConfig[]
}

export interface ClaudeAuthInfo {
  installed: boolean
  authenticated: boolean
  email?: string
  plan?: string // 'pro' | 'max-5x' | 'max-20x' | 'team' | 'enterprise'
  error?: string
}

// Stream-json event types from Claude Code CLI
export type ClaudeEventType =
  | 'system'
  | 'assistant'
  | 'user'
  | 'tool_use'
  | 'tool_result'
  | 'result'
  | 'error'

export interface ClaudeStreamEvent {
  type: ClaudeEventType
  subtype?: string
  // assistant message
  content?: string
  // tool_use
  tool_name?: string
  tool_input?: Record<string, unknown>
  tool_use_id?: string
  // tool_result
  output?: string
  is_error?: boolean
  // result (final)
  session_id?: string
  cost_usd?: number
  duration_ms?: number
  // error
  error?: string
}

// Commands sent FROM the web to the companion
export interface CompanionCommand {
  type: 'prompt' | 'interrupt' | 'resume' | 'status' | 'clone' | 'create_project' | 'init_project' | 'setup_claude' | 'claude_status' | 'scan_repos' | 'query_running'
  sessionId?: string
  projectId?: string
  prompt?: string
  // Claude Code permission mode. See claude-bridge.ts MODE_MAP for the
  // mapping to documented `--permission-mode` values.
  mode?: 'plan' | 'edit' | 'agent'
  // Worktree isolation — when set, the Claude Code CLI is spawned in this
  // absolute path instead of project.path. Lets each chat in its own branch
  // operate on its own files.
  worktreePath?: string
  // Bornastar chat session ID (DB id). Used as the bridge key so each chat
  // has its own Claude Code conversation and multiple chats can run
  // concurrently across worktrees without the "Agent already running" clash.
  bornastarSessionId?: string
  // Claude model selector — short alias ('haiku' / 'sonnet' / 'opus') or a
  // fully-qualified id ('claude-sonnet-4-6'). Omitted = CLI default.
  model?: string
  // Extended-thinking budget — translates to a "think …" keyword injected
  // at the start of the prompt. 'off' = no injection. Haiku ignores this
  // (model has no extended-thinking support).
  thinking?: 'off' | 'low' | 'medium' | 'high'
  // Stable id the browser already used for its optimistic render of the
  // user's prompt. When present we use it as the userRow persistRow id
  // so the same id flows browser → daemon queue → ring buffer → DB —
  // hydrate after remount recognises the row as already on screen.
  userMsgId?: string
  // clone/create
  repoUrl?: string
  projectName?: string
  targetPath?: string
  template?: string
}

// Messages sent FROM companion TO the server
export interface CompanionMessage {
  type: 'auth_status' | 'project_list' | 'claude_event' | 'status' | 'error' | 'project_added' | 'running_sessions' | 'fs_change'
  payload: unknown
}
