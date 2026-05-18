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
  // Lifecycle commands:
  //   • init_project       — register a local path as a daemon project. When
  //                          `projectId` is provided (the DB cuid), it becomes
  //                          the daemon-side id too — keeps both sides aligned
  //                          (fs-watcher path, worktrees dir, etc).
  //   • relabel_project    — server tells daemon "the project at <oldId> is
  //                          actually known as <newId> in the DB". Used by the
  //                          register-time reconciliation loop to migrate
  //                          legacy hex ids to DB cuids.
  //   • unregister_project — drop a project from the daemon's local config.
  //                          Server enqueues this when a project is deleted.
  //   • cleanup_project    — best-effort `rm -rf` on the project's worktrees
  //                          dir. Enqueued by DELETE /api/projects when the
  //                          daemon was offline at delete time.
  type: 'prompt' | 'interrupt' | 'resume' | 'status' | 'clone' | 'create_project' | 'init_project' | 'setup_claude' | 'claude_status' | 'scan_repos' | 'query_running' | 'config_updated' | 'skills_updated' | 'pty_attach' | 'pty_input' | 'pty_resize' | 'pty_detach' | 'relabel_project' | 'unregister_project' | 'cleanup_project' | 'append_claude_turn' | 'update_companion'
  sessionId?: string
  projectId?: string
  // For relabel_project: id the daemon currently uses for this project (the
  // legacy hex), and the new DB cuid it should adopt.
  oldProjectId?: string
  newProjectId?: string
  // For unregister_project / cleanup_project — the path on disk to act on.
  worktreesPath?: string
  prompt?: string
  // PTY commands — see pty-manager.ts for lifecycle. `contextKey` is
  // the worktreeId (terminal exists only inside worktrees); matches
  // the cache key in worktree-cache.ts so the browser snapshot, the
  // daemon ring buffer, and every protector check converge on the
  // same identifier.
  contextKey?: string
  cwd?: string
  cols?: number
  rows?: number
  // Raw bytes (UTF-8) for keystrokes / paste. PTY data is binary in
  // theory but every modern terminal app emits valid UTF-8; encoding
  // gymnastics aren't worth the bytes.
  data?: string
  // Friendly name for the prompt's PS1 — we use the worktree's
  // `branchName` (e.g. "belgrade-v1"), NOT the worktree's display
  // name. Branch name is stable across the auto-rename feature that
  // updates the display name when the user sends a chat message.
  displayName?: string
  // Bornastar UI mode. See claude-bridge.ts MODE_MAP, BUNDLED_DISALLOWED_TOOLS_BY_MODE
  // and BUNDLED_MODE_PROMPT for the full mapping to CLI primitives. The
  // bundled values are overridden at runtime by setActiveConfig() once
  // the daemon fetches the live config from the server.
  mode?: 'plan' | 'ask' | 'agent'
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
  // Active skill (case-insensitive name like 'ceo', 'tester'). When set,
  // the daemon prepends that agent's skillMd to --append-system-prompt
  // alongside the mode prompt. Pulled from the skill cache populated by
  // skill-config.ts (mirrors how config_updated drives modePrompts).
  // null/undefined = regular chat without an agent persona.
  skillId?: string | null
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
  // ── append_claude_turn ──────────────────────────────────────────────
  // After a workflow run finishes, the orchestrator (server) writes the
  // final assistant turn into our DB and broadcasts it via the relay.
  // But the Claude CLI's own JSONL transcript (read by `claude --resume`)
  // never saw that turn — so the next regular chat prompt would resume
  // a session that has a hole where the workflow happened.
  // This command tells the daemon to append a coherent (user, assistant)
  // pair to that JSONL, so the next `--resume` reads a continuous history.
  // claudeSessionId: the CLI session id (stored on chat_sessions.claudeSessionId).
  // worktreePath: the cwd of the chat (used to derive the project dir name).
  // userText / assistantText: the pair to append.
  claudeSessionId?: string
  userText?: string
  assistantText?: string
}

// Messages sent FROM companion TO the server
export interface CompanionMessage {
  type: 'auth_status' | 'project_list' | 'claude_event' | 'status' | 'error' | 'project_added' | 'running_sessions' | 'fs_change' | 'pty_data' | 'pty_exit'
  payload: unknown
}
