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
  type: 'prompt' | 'interrupt' | 'resume' | 'status' | 'clone' | 'create_project'
  sessionId?: string
  projectId?: string
  prompt?: string
  // clone/create
  repoUrl?: string
  projectName?: string
  targetPath?: string
  template?: string
}

// Messages sent FROM companion TO the server
export interface CompanionMessage {
  type: 'auth_status' | 'project_list' | 'claude_event' | 'status' | 'error' | 'project_added'
  payload: unknown
}
