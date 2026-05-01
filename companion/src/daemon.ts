import { EventEmitter } from 'node:events'
import { hostname, homedir } from 'node:os'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from './config.js'
import { detectClaudeAuth, detectClaudeInstallation, getClaudeVersion } from './auth-detect.js'
import { ClaudeBridge, getActiveConfig } from './claude-bridge.js'
import { refreshPromptConfig, startPromptConfigPolling } from './prompt-config.js'
import { ProjectWatcher, type FsChangeBatch } from './fs-watcher.js'
import { SyncQueue, type QueuedEvent } from './sync-queue.js'
import { SyncWorker } from './sync-worker.js'
import { listProjects, relabelProjectId, unregisterProject, cleanupProjectWorktreesDir } from './project-manager.js'
import { PtyManager } from './pty-manager.js'
import type { CompanionCommand, CompanionMessage, ClaudeStreamEvent } from './types.js'

// A ChatMessage-shaped row ready to persist. Every row carries a
// stable `id` AND a `createdAt` (unix ms, producer timestamp); the
// same tuple flows through the local sync queue, the relay payload
// (for server-side write-through), and the ring buffer replay — all
// three paths upsert on id and honour the producer timestamp.
interface PersistRow {
  id: string
  createdAt: number
  role: 'user' | 'assistant' | 'thinking' | 'tool' | 'system'
  content: string
  toolName?: string
  toolInput?: Record<string, unknown>
  toolResult?: string
  toolUseId?: string
  toolError?: boolean
  model?: string
  permissionMode?: string
  claudeSessionId?: string
  // Per-turn metrics (only set on the system row that closes a turn)
  costUsd?: number
  durationMs?: number
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreateTokens?: number
}

// The daemon is the long-running background process that:
//   1. Registers with the Bornastar server (POST /api/companion/register)
//   2. Listens for commands via SSE (GET /api/companion/events)
//   3. Spawns Claude Code CLI sessions per project
//   4. Relays stream-json events back via POST /api/companion/response
//
// All connections are OUTBOUND (daemon → server) over standard HTTPS,
// so no port-forwarding, firewall, or WebSocket upgrade needed.
// Works with stock Next.js API routes.

const RECONNECT_DELAY_MS = 1_000
const HEARTBEAT_INTERVAL_MS = 10_000

export class Daemon extends EventEmitter {
  private serverUrl: string
  private authToken: string
  private bridges: Map<string, ClaudeBridge> = new Map()
  // Bornastar session IDs whose Claude CLI is currently running. Broadcast
  // to the browser so a ChatPanel remounting mid-prompt can restore its
  // "Claude is working" indicator without waiting for the next event.
  private runningSessions: Set<string> = new Set()
  // One filesystem watcher per registered project — replaces the
  // Explorer / Changes / stats polling on the browser. Keyed by abs path.
  private watchers: Map<string, ProjectWatcher> = new Map()
  // One persistent shell PTY per terminal context (worktreeId).
  // Lifecycle in pty-manager.ts: spawn on first attach, survive
  // browser disconnects within the activity TTL (1h) or post-detach
  // TTL (10 min) with child-process extension, kill on shutdown.
  private ptyManager: PtyManager = new PtyManager()
  // Persistent sync queue that mirrors every chat event to Supabase in
  // the background. Browser only renders — durability lives here.
  private syncQueue: SyncQueue = new SyncQueue()
  private syncWorker: SyncWorker = new SyncWorker({
    queue: this.syncQueue,
    send: (events) => this.sendSyncBatch(events),
  })
  private eventSource: EventSource | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private shouldReconnect = true
  private abortController: AbortController | null = null

  constructor(serverUrl: string, authToken: string) {
    super()
    this.serverUrl = serverUrl
    this.authToken = authToken
    // Wire PTY events through the existing SSE pipeline. Every byte
    // the shell emits → pty_data → server → browser xterm.write().
    // Exit tells the browser to drop its "PTY active" flag so the
    // worktree's cache slices can age normally.
    this.ptyManager.on('data', (contextKey: string, data: string) => {
      void this.send({
        type: 'pty_data',
        payload: { contextKey, data },
      })
    })
    this.ptyManager.on('exit', (contextKey: string, exitCode: number) => {
      void this.send({
        type: 'pty_exit',
        payload: { contextKey, exitCode },
      })
    })
  }

  async start(): Promise<void> {
    this.shouldReconnect = true
    await this.register()
    this.connectEvents()
    this.startHeartbeat()
    this.syncWatchers()
    this.syncWorker.start()
    // Pull the live prompt config from the server. Fire-and-forget so
    // a slow / failed fetch doesn't delay daemon readiness — the
    // bundled defaults already in claude-bridge keep every spawn fully
    // functional until this resolves. On success the active config
    // gets replaced atomically; spawns after that point use the new
    // values. Backup polling runs every 5 minutes in case SSE drops.
    void refreshPromptConfig('startup')
    startPromptConfigPolling(() => getActiveConfig().version)
  }

  stop(): void {
    this.shouldReconnect = false
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.abortController) this.abortController.abort()
    for (const [, bridge] of this.bridges) {
      bridge.kill()
    }
    this.bridges.clear()
    for (const [, watcher] of this.watchers) {
      watcher.stop()
    }
    this.watchers.clear()
    // Hard-kill every live PTY. SIGHUP propagates to children (build,
    // test, vim, etc.), so a daemon shutdown cleanly stops anything
    // the user had running. The browser will see `pty_exit` events
    // (if SSE still alive) and let cacheProtector age normally.
    this.ptyManager.killAll()
    // Give the sync worker one last chance to flush whatever it was
    // holding — fire-and-forget, stop() can't be async.
    this.syncWorker.flushNow().catch(() => {})
    this.syncWorker.stop()
    this.syncQueue.close()
    this.unregister().catch(() => {})
  }

  // ── Server communication (SSE + POST) ─────────────────────────────

  private async post(path: string, body: unknown): Promise<Response | null> {
    try {
      return await fetch(`${this.serverUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.authToken}`,
        },
        body: JSON.stringify(body),
      })
    } catch (err) {
      this.emit('error', err)
      return null
    }
  }

  private async register(): Promise<void> {
    const auth = detectClaudeAuth()
    const version = getClaudeVersion()
    const projects = listProjects()
    const res = await this.post('/api/companion/register', {
      authInfo: { ...auth, version },
      projects,
      machineName: hostname(),
      // The web side stores this and uses it to compute the worktrees
      // directory (`<homeDir>/.bornastar/worktrees/<projectId>/`) when
      // provisioning. Web never assumes its own `os.homedir()` matches
      // the daemon's — important for the day web runs cloud-side.
      homeDir: homedir(),
    })
    if (res?.ok) {
      this.emit('registered')
    } else {
      this.emit('error', new Error(`Registration failed: ${res?.status ?? 'network error'}`))
    }
  }

  private async unregister(): Promise<void> {
    try {
      await fetch(`${this.serverUrl}/api/companion/register`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${this.authToken}` },
      })
    } catch {}
  }

  private async send(msg: CompanionMessage): Promise<void> {
    await this.post('/api/companion/response', msg)
  }

  // ── SSE listener (receives commands from browser) ─────────────────

  private connectEvents(): void {
    this.abortController = new AbortController()
    const url = `${this.serverUrl}/api/companion/events`

    // Use fetch-based SSE (Node.js doesn't have native EventSource).
    // We read the stream line by line and parse SSE `data:` frames.
    const connect = async () => {
      try {
        const res = await fetch(url, {
          headers: { 'Authorization': `Bearer ${this.authToken}` },
          signal: this.abortController!.signal,
        })

        if (!res.ok || !res.body) {
          throw new Error(`SSE connect failed: ${res.status}`)
        }

        this.emit('connected')
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
              const data = line.slice(6)
              try {
                const cmd = JSON.parse(data) as CompanionCommand
                this.handleCommand(cmd)
              } catch {
                // Non-JSON data line (heartbeat comment, etc.)
              }
            }
            // SSE comments (`: heartbeat`) are silently ignored
          }
        }
      } catch (err) {
        if ((err as Error).name === 'AbortError') return
        this.emit('error', err)
      }

      // Stream ended or errored — reconnect if we should
      this.emit('disconnected')
      if (this.shouldReconnect) {
        this.reconnectTimer = setTimeout(() => {
          this.register().then(() => this.connectEvents()).catch(() => {})
        }, RECONNECT_DELAY_MS)
      }
    }

    connect()
  }

  // ── Command handlers ──────────────────────────────────────────────

  private handleCommand(cmd: CompanionCommand): void {
    switch (cmd.type) {
      case 'prompt':
        this.handlePrompt(cmd)
        break
      case 'interrupt':
        this.handleInterrupt(cmd)
        break
      case 'resume':
        this.handlePrompt(cmd)
        break
      case 'status':
        this.sendStatus()
        break
      case 'clone':
        this.handleClone(cmd)
        break
      case 'config_updated':
        // Backend pushed a new CompanionConfig version. Pull the
        // fresh payload and replace the in-memory active config —
        // next claude spawn picks up the new prompts. This is the
        // primary update channel; the 5-min poll in prompt-config.ts
        // is just a safety net in case SSE silently dropped.
        console.log('[isolation] received SSE config_updated push — refreshing prompts')
        void refreshPromptConfig('sse-push')
        break
      case 'create_project':
        this.handleCreateProject(cmd)
        break
      case 'init_project':
        this.handleInitProject(cmd)
        break
      case 'setup_claude':
        this.handleSetupClaude()
        break
      case 'claude_status':
        this.sendClaudeStatus()
        break
      case 'scan_repos':
        this.handleScanRepos()
        break
      case 'query_running':
        this.broadcastRunning()
        break
      case 'pty_attach':
        this.handlePtyAttach(cmd)
        break
      case 'pty_input':
        this.handlePtyInput(cmd)
        break
      case 'pty_resize':
        this.handlePtyResize(cmd)
        break
      case 'pty_detach':
        this.handlePtyDetach(cmd)
        break
      case 'relabel_project':
        this.handleRelabelProject(cmd)
        break
      case 'unregister_project':
        this.handleUnregisterProject(cmd)
        break
      case 'cleanup_project':
        this.handleCleanupProject(cmd)
        break
    }
  }

  // ── Project lifecycle commands (server-driven) ──────────────────────
  //
  // The server enqueues these to keep the daemon's local config and disk
  // converged with the DB after lifecycle events:
  //   • relabel_project    — register-time reconciliation found a daemon
  //                          project whose id is the legacy hex; rewrite
  //                          it to the DB cuid so future fs-watcher paths
  //                          and provisionWorktree paths line up.
  //   • unregister_project — DB project was deleted; drop the local row
  //                          (the watcher tear-down happens via
  //                          syncWatchers on the next config tick).
  //   • cleanup_project    — DB project was deleted; rm -rf the worktrees
  //                          dir on disk. Best-effort, non-fatal on error.

  private handleRelabelProject(cmd: CompanionCommand): void {
    if (!cmd.oldProjectId || !cmd.newProjectId) {
      console.warn('[project] relabel missing oldProjectId/newProjectId', cmd)
      return
    }
    const ok = relabelProjectId(cmd.oldProjectId, cmd.newProjectId)
    console.log(`[project] relabel ${cmd.oldProjectId.slice(0, 8)} → ${cmd.newProjectId.slice(0, 8)} ${ok ? 'OK' : 'no-op (project not found)'}`)
    if (ok) {
      // Force watchers to re-evaluate so the worktrees-path watcher
      // moves from the old hex dir to the new cuid dir on next tick.
      this.syncWatchers()
    }
  }

  private handleUnregisterProject(cmd: CompanionCommand): void {
    if (!cmd.targetPath) {
      console.warn('[project] unregister missing targetPath', cmd)
      return
    }
    unregisterProject(cmd.targetPath)
    console.log(`[project] unregistered path=${cmd.targetPath}`)
    // Tear down the project's watchers right away.
    this.syncWatchers()
  }

  private handleCleanupProject(cmd: CompanionCommand): void {
    if (!cmd.worktreesPath) {
      console.warn('[project] cleanup missing worktreesPath', cmd)
      return
    }
    cleanupProjectWorktreesDir(cmd.worktreesPath)
    console.log(`[project] cleanup ${cmd.worktreesPath}`)
  }

  // ── PTY command handlers ──────────────────────────────────────────
  //
  // Each PTY command carries a `contextKey` (worktreeId) matching the
  // browser-side cache key. PtyManager owns lifecycle; we relay events
  // back via `send` so the existing SSE pipeline carries them to the
  // browser. Reattach also synthesises a one-shot `pty_data` with the
  // ring buffer + `reattached: true` so the browser knows to wipe its
  // cached snapshot before painting.

  private handlePtyAttach(cmd: CompanionCommand): void {
    if (!cmd.contextKey || !cmd.cwd || cmd.cols == null || cmd.rows == null) {
      console.warn('[pty] attach missing fields', cmd)
      return
    }
    const { snapshot, reattached } = this.ptyManager.attach(cmd.contextKey, {
      cwd: cmd.cwd,
      cols: cmd.cols,
      rows: cmd.rows,
      displayName: cmd.displayName,
    })
    // If we reattached an existing PTY, the snapshot is non-empty and
    // we ship it to the browser so it can repaint scrollback before
    // any new live data arrives. Cold spawn: snapshot is '' — browser
    // sees the prompt come through the regular `data` event.
    if (snapshot) {
      void this.send({
        type: 'pty_data',
        payload: { contextKey: cmd.contextKey, data: snapshot, reattached },
      })
    }
  }

  private handlePtyInput(cmd: CompanionCommand): void {
    if (!cmd.contextKey || cmd.data == null) return
    this.ptyManager.input(cmd.contextKey, cmd.data)
  }

  private handlePtyResize(cmd: CompanionCommand): void {
    if (!cmd.contextKey || cmd.cols == null || cmd.rows == null) return
    this.ptyManager.resize(cmd.contextKey, cmd.cols, cmd.rows)
  }

  private handlePtyDetach(cmd: CompanionCommand): void {
    if (!cmd.contextKey) return
    this.ptyManager.detach(cmd.contextKey)
  }

  private async sendStatus(): Promise<void> {
    const auth = detectClaudeAuth()
    const version = getClaudeVersion()
    await this.send({
      type: 'auth_status',
      payload: { ...auth, version },
    })
    await this.send({
      type: 'project_list',
      payload: listProjects(),
    })
    await this.broadcastRunning()
  }

  // ── Persistent queue plumbing ─────────────────────────────────────
  //
  // Every ChatMessage-shaped row (user prompt, assistant text, thinking
  // block, tool_use, tool_result update, final result) gets persisted
  // three ways, each reached from the same pre-built PersistRow with
  // a stable id:
  //
  //   1. Local SQLite queue → /sync-messages (durable, retried, daemon-
  //      owned path; survives a dead server).
  //   2. Attached to the relay `claude_event` payload as `persistRows`
  //      so the server can write-through to Supabase without re-parsing
  //      and — crucially — uses the same id.
  //   3. The ring buffer inside companion-relay.ts captures the whole
  //      claude_event frame for instant chat hydration.
  //
  // Upserts by id are idempotent across all three, so duplicates are
  // harmless and we never lose rows if one lane fails.

  private generateEventId(): string {
    return `evt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  }

  private enqueueRow(row: PersistRow, ctx: { sessionId: string; projectId: string }): void {
    this.syncQueue.enqueue({
      id: row.id,
      sessionId: ctx.sessionId,
      projectId: ctx.projectId,
      userId: '',  // server resolves from the bearer token
      payload: row as unknown as Record<string, unknown>,
      createdAt: Date.now(),
    })
    this.syncWorker.wake()
  }

  // Translate a raw Claude CLI stream event into ChatMessage-shaped rows
  // with stable ids. IDs are the contract between daemon (queue) and
  // server (write-through): same row → same id → idempotent upsert.
  private buildPersistRows(
    event: ClaudeStreamEvent,
    ctx: { mode?: string; model?: string },
  ): PersistRow[] {
    const out: PersistRow[] = []
    // Single timestamp per event — all rows born here share it, which
    // matches how the browser would render them (one moment in time).
    const now = Date.now()

    // Assistant: text + thinking + tool_use blocks.
    if (event.type === 'assistant') {
      const content = (event as unknown as { message?: { content?: Array<{ type: string; text?: string; thinking?: string; id?: string; name?: string; input?: Record<string, unknown> }> } }).message?.content
      if (!Array.isArray(content)) return out
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          out.push({
            id: this.generateEventId(),
            createdAt: now,
            role: 'assistant',
            content: block.text,
            model: ctx.model,
            permissionMode: ctx.mode,
          })
        } else if (block.type === 'thinking' && block.thinking) {
          out.push({
            id: this.generateEventId(),
            createdAt: now,
            role: 'thinking',
            content: block.thinking,
            model: ctx.model,
            permissionMode: ctx.mode,
          })
        } else if (block.type === 'tool_use' && block.id && block.name) {
          out.push({
            id: block.id,                     // reuse Claude's id so tool_result merges
            createdAt: now,
            role: 'tool',
            content: `Using ${block.name}`,
            toolName: block.name,
            toolInput: block.input ?? {},
            toolUseId: block.id,
            toolError: false,
            model: ctx.model,
            permissionMode: ctx.mode,
          })
        }
      }
      return out
    }

    // Result: the per-turn summary with cost, tokens, duration. This
    // is the row that feeds the session rollup increments (see
    // chat-persist.ts) and keeps numTurns accurate. Persisted hidden
    // (no content) so the chat UI stays clean.
    if (event.type === 'result') {
      const e = event as unknown as {
        session_id?: string
        total_cost_usd?: number
        duration_ms?: number
        num_turns?: number
        usage?: {
          input_tokens?: number
          output_tokens?: number
          cache_read_input_tokens?: number
          cache_creation_input_tokens?: number
        }
        is_error?: boolean
        error?: string
        result?: string
      }
      out.push({
        id: this.generateEventId(),
        createdAt: now,
        role: 'system',
        content: e.is_error ? `Error: ${e.error ?? e.result ?? 'Unknown'}` : '',
        costUsd: e.total_cost_usd,
        durationMs: e.duration_ms,
        inputTokens: e.usage?.input_tokens,
        outputTokens: e.usage?.output_tokens,
        cacheReadTokens: e.usage?.cache_read_input_tokens,
        cacheCreateTokens: e.usage?.cache_creation_input_tokens,
        claudeSessionId: e.session_id,
        model: ctx.model,
      })
      return out
    }

    // User event from the CLI: only tool_result blocks (user prompts
    // come from us, not from the CLI).
    if (event.type === 'user') {
      const content = (event as unknown as { message?: { content?: Array<{ type: string; tool_use_id?: string; is_error?: boolean; content?: string | Array<{ text?: string }> }> } }).message?.content
      if (!Array.isArray(content)) return out
      for (const block of content) {
        if (block.type !== 'tool_result' || !block.tool_use_id) continue
        const resultText = typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content)
            ? block.content.map((c) => c.text ?? '').join('\n')
            : ''
        out.push({
          id: block.tool_use_id,              // same id as the tool_use row → upsert merges
          createdAt: now,
          role: 'tool',
          content: '',
          toolResult: resultText,
          toolError: !!block.is_error,
          toolUseId: block.tool_use_id,
        })
      }
      return out
    }

    return out
  }

  // POSTed by the SyncWorker. Sends a batch to the server and reports
  // whether every row landed. Only fully-successful batches get ack'd.
  private async sendSyncBatch(events: QueuedEvent[]): Promise<{ ok: boolean }> {
    const res = await this.post('/api/companion/sync-messages', {
      events: events.map((e) => ({
        id: e.id,
        sessionId: e.sessionId,
        projectId: e.projectId,
        createdAt: e.createdAt,
        ...e.payload,
      })),
    }).catch(() => null)
    if (!res) return { ok: false }
    return { ok: res.ok }
  }

  // Fire-and-forget broadcast of which chats are currently running. Called
  // whenever the set changes (prompt started, bridge finished, interrupted)
  // and on explicit client queries.
  private async broadcastRunning(): Promise<void> {
    const ids = Array.from(this.runningSessions)
    console.log(`[isolation] running_sessions broadcast count=${ids.length} ids=[${ids.map(i => i.slice(0, 8)).join(',')}]`)
    await this.send({
      type: 'running_sessions',
      payload: { sessionIds: ids },
    })
  }

  private async handlePrompt(cmd: CompanionCommand): Promise<void> {
    if (!cmd.projectId || !cmd.prompt) return

    const config = loadConfig()
    const project = config.projects.find((p) => p.id === cmd.projectId)
    if (!project) {
      await this.send({
        type: 'error',
        payload: { message: `Project ${cmd.projectId} not found` },
      })
      return
    }

    // Resolve the working directory: a specific worktree path (when the chat
    // belongs to a worktree) or the project root (main chats).
    const cwd = cmd.worktreePath ?? project.path

    // Bridge key: one per Bornastar chat session so conversations stay
    // independent and multiple chats can run concurrently across worktrees.
    // Fallback to projectId for backward compatibility.
    const bridgeKey = cmd.bornastarSessionId ?? project.id

    const scope = cmd.worktreePath ? 'worktree' : 'main'
    console.log(`[isolation] prompt project=${project.name} scope=${scope} cwd=${cwd} bridgeKey=${bridgeKey.slice(0, 8)} mode=${cmd.mode ?? 'agent'}`)

    let bridge = this.bridges.get(bridgeKey)
    if (bridge?.isRunning()) {
      await this.send({
        type: 'error',
        payload: { message: 'Agent is already running. Interrupt first.' },
      })
      return
    }

    bridge = new ClaudeBridge(cwd, cmd.sessionId ?? undefined, cmd.mode ?? 'agent', {
      model: cmd.model,
      thinking: cmd.thinking,
    })
    this.bridges.set(bridgeKey, bridge)

    // Tag every outgoing event with the Bornastar chat session so the
    // browser can filter and never show chat1's stream inside chat2.
    const bornastarSessionId = cmd.bornastarSessionId

    // Enqueue the user prompt as the first row of this turn and also
    // relay it so the ring buffer and server write-through see it —
    // otherwise a mobile catching up mid-stream would miss the question
    // the Mac asked. The id is stable across all three persistence lanes.
    const persistCtx = bornastarSessionId && project.id
      ? { sessionId: bornastarSessionId, projectId: project.id, mode: cmd.mode, model: cmd.model }
      : null
    if (persistCtx) {
      const userRow: PersistRow = {
        // Prefer the id the browser minted for its optimistic render.
        // Keeping one id across browser / queue / ring buffer / DB means
        // hydrate after a remount recognises this row as already shown.
        id: cmd.userMsgId ?? this.generateEventId(),
        createdAt: Date.now(),
        role: 'user',
        content: cmd.prompt,
        permissionMode: cmd.mode ?? 'agent',
        ...(cmd.model && { model: cmd.model }),
      }
      const idSource = cmd.userMsgId ? 'browser' : 'generated'
      console.log(`[bridge] user-row sessionId=${bornastarSessionId?.slice(0, 8) ?? '-'} userRowId=${userRow.id.slice(0, 16)} (from=${idSource})`)
      this.enqueueRow(userRow, persistCtx)
      this.send({
        type: 'claude_event',
        payload: { projectId: project.id, bornastarSessionId, persistRows: [userRow] },
      }).catch(() => {})
    }

    // Track this chat as running so a late-joining ChatPanel can restore
    // its "Claude is working" indicator by querying the current set.
    if (bornastarSessionId) {
      this.runningSessions.add(bornastarSessionId)
      this.broadcastRunning()
    }
    // Capture bridge reference so cleanup only removes THIS bridge from the
    // map. If a later prompt replaced the entry (same bridgeKey), we leave
    // the newer bridge alone.
    const startedBridge = bridge
    const markFinished = () => {
      if (bornastarSessionId && this.runningSessions.delete(bornastarSessionId)) {
        this.broadcastRunning()
      }
      if (this.bridges.get(bridgeKey) === startedBridge) {
        this.bridges.delete(bridgeKey)
        console.log(`[isolation] bridge cleanup bridgeKey=${bridgeKey.slice(0, 8)} (map size now ${this.bridges.size})`)
      }
    }

    bridge.on('event', (event: ClaudeStreamEvent) => {
      // Build persistable rows once — same ids flow through the queue,
      // the relay (for server write-through) and the ring buffer.
      const rows = persistCtx ? this.buildPersistRows(event, persistCtx) : []
      console.log(`[bridge] event type=${event.type} session=${bornastarSessionId?.slice(0, 8) ?? '(none)'} persistCtx=${!!persistCtx} rows=${rows.length}`)
      // Durability before broadcast: enqueue to the local SQLite WAL
      // first, THEN relay to the server. If the daemon crashes between
      // the two calls, the row survives in the queue and sync-worker
      // eventually pushes it to Supabase — no data loss.
      if (persistCtx) for (const row of rows) this.enqueueRow(row, persistCtx)
      this.send({
        type: 'claude_event',
        payload: {
          projectId: project.id,
          bornastarSessionId,
          event,
          ...(rows.length > 0 && { persistRows: rows }),
        },
      })
    })

    bridge.on('done', (summary: { code: number; sessionId: string | null }) => {
      // Stamp the turn's `system/result` row with the Claude session id
      // so the browser picks it up on its next --resume. Single stable
      // id across queue + relay so the server write-through upserts the
      // same row.
      const systemRow: PersistRow | null = persistCtx && summary.sessionId
        ? {
            id: this.generateEventId(),
            createdAt: Date.now(),
            role: 'system',
            content: '',
            claudeSessionId: summary.sessionId,
          }
        : null
      // Durability before broadcast — same rule as the 'event' handler
      // above. The system/result row carries claudeSessionId, which the
      // browser needs to resume the chat; losing it costs the user their
      // --resume path, so we enqueue first.
      if (persistCtx && systemRow) this.enqueueRow(systemRow, persistCtx)
      this.send({
        type: 'claude_event',
        payload: {
          projectId: project.id,
          bornastarSessionId,
          event: {
            type: 'result',
            session_id: summary.sessionId,
            content: `Session ended (exit ${summary.code})`,
          },
          ...(systemRow && { persistRows: [systemRow] }),
        },
      })
      // Flush now — user just saw the response settle; push Supabase
      // to catch up immediately.
      this.syncWorker.flushNow().catch(() => {})
      markFinished()
    })

    bridge.on('error', (err: Error) => {
      this.send({
        type: 'error',
        payload: { projectId: project.id, bornastarSessionId, message: err.message },
      })
      markFinished()
    })

    try {
      await bridge.prompt(cmd.prompt)
    } catch (err) {
      await this.send({
        type: 'error',
        payload: { projectId: project.id, bornastarSessionId, message: (err as Error).message },
      })
      markFinished()
    }
  }

  private handleInterrupt(cmd: CompanionCommand): void {
    if (!cmd.projectId) return
    const bridgeKey = cmd.bornastarSessionId ?? cmd.projectId
    const bridge = this.bridges.get(bridgeKey)
    if (bridge?.isRunning()) {
      bridge.interrupt()
    }
  }

  private async handleClone(cmd: CompanionCommand): Promise<void> {
    if (!cmd.repoUrl || !cmd.targetPath) return
    try {
      const { cloneRepo } = await import('./project-manager.js')
      const project = cloneRepo(cmd.repoUrl, cmd.targetPath)
      await this.send({ type: 'project_added', payload: project })
      await this.sendStatus()
    } catch (err) {
      await this.send({
        type: 'error',
        payload: { message: `Clone failed: ${(err as Error).message}` },
      })
    }
  }

  private async handleCreateProject(cmd: CompanionCommand): Promise<void> {
    if (!cmd.targetPath) return
    try {
      const { createProject } = await import('./project-manager.js')
      // `cmd.projectId` (the DB cuid) flows into createProject so the
      // scaffolded project is registered with that id from the start —
      // same alignment guarantee as init_project.
      const project = createProject(cmd.targetPath, { template: cmd.template, providedId: cmd.projectId })
      console.log(`[isolation] project scaffolded path=${project.path} id=${project.id.slice(0, 8)} template=${cmd.template ?? '(none)'}${cmd.projectId ? ' (from DB cuid)' : ' (hex, awaiting reconcile)'}`)
      await this.send({ type: 'project_added', payload: project })
      await this.sendStatus()
      this.syncWatchers()
    } catch (err) {
      console.warn(`[isolation] project scaffold FAILED path=${cmd.targetPath}: ${(err as Error).message}`)
      await this.send({
        type: 'error',
        payload: { message: `Create failed: ${(err as Error).message}` },
      })
    }
  }

  // Register an existing local directory as a project (used by the web
  // "Open local project" flow). Idempotent — addProject deduplicates by
  // path, so repeated calls just refresh the config entry.
  //
  // When `cmd.projectId` is provided (the DB cuid, sent by the picker
  // after creating the DB row first), it becomes the daemon-side id —
  // keeps fs-watcher path, worktrees dir and provisionWorktree all in
  // sync with the DB from the start. Without it, a legacy hex id is
  // minted and reconciliation fixes it on the next register tick.
  private async handleInitProject(cmd: CompanionCommand): Promise<void> {
    if (!cmd.targetPath) return
    try {
      const { initProject } = await import('./project-manager.js')
      const project = initProject(cmd.targetPath, cmd.projectId)
      console.log(`[isolation] project registered path=${project.path} id=${project.id.slice(0, 8)}${cmd.projectId ? ' (from DB cuid)' : ' (hex, awaiting reconcile)'}`)
      await this.send({ type: 'project_added', payload: project })
      await this.sendStatus()
      // A freshly-registered project needs its own filesystem watcher
      // so the browser stops having to poll. syncWatchers() is cheap
      // (idempotent — won't re-create the watcher if it already exists).
      this.syncWatchers()
    } catch (err) {
      await this.send({
        type: 'error',
        payload: { message: `Init failed: ${(err as Error).message}` },
      })
    }
  }

  // ── Filesystem watchers (push instead of browser polling) ─────────────
  //
  // One watcher per registered project. On every debounced batch of
  // changes we push an SSE event the browser listens to — Explorer,
  // Changes panel and stats rows refetch only when something actually
  // moved on disk, instead of hammering the server every 5 s.
  private syncWatchers(): void {
    const projects = loadConfig().projects
    const activePaths = new Set(projects.map((p) => p.path))

    // Spin up watchers for any project that doesn't have one yet. Each
    // project gets ONE chokidar instance watching two roots:
    //   • the project repo itself (main view)
    //   • `~/.bornastar/worktrees/<projectId>/` — where every worktree
    //     of that project lives (outside the repo, so the project tree
    //     stays clean). mkdir -p before start so the watcher always has
    //     something to attach to even before the first worktree exists.
    for (const project of projects) {
      if (this.watchers.has(project.path)) continue
      const worktreesPath = join(homedir(), '.bornastar', 'worktrees', project.id)
      try { mkdirSync(worktreesPath, { recursive: true }) } catch {}
      const watcher = new ProjectWatcher(project.path, worktreesPath)
      watcher.on('change', (batch: FsChangeBatch) => {
        console.log(`[isolation] fs_change project=${batch.projectPath} source=${batch.source} paths=${batch.paths.length}`)
        this.send({ type: 'fs_change', payload: batch }).catch(() => {})
      })
      watcher.on('error', (err) => {
        console.warn(`[isolation] fs watcher error (${project.path}):`, err)
      })
      watcher.start()
      this.watchers.set(project.path, watcher)
      console.log(`[isolation] watcher SPAWN project=${project.path} id=${project.id.slice(0, 8)} worktreesPath=${worktreesPath}`)
    }

    // Tear down watchers for projects that were removed from config.
    for (const [path, watcher] of this.watchers) {
      if (!activePaths.has(path)) {
        watcher.stop()
        this.watchers.delete(path)
        console.log(`[isolation] watcher TEARDOWN project=${path}`)
      }
    }
  }

  // ── Scan local repos ───────────────────────────────────────────────

  private async handleScanRepos(): Promise<void> {
    const { existsSync, readdirSync, statSync } = await import('node:fs')

    const home = homedir()
    const searchDirs = [
      join(home, 'projects'),
      join(home, 'Desktop', 'projects'),
      join(home, 'dev'),
      join(home, 'code'),
      join(home, 'repos'),
      join(home, 'Documents', 'projects'),
      join(home, 'Desktop'),
    ]

    const repos: Array<{ name: string; path: string; parentDir: string }> = []

    for (const dir of searchDirs) {
      if (!existsSync(dir)) continue
      try {
        const entries = readdirSync(dir)
        for (const entry of entries) {
          const fullPath = join(dir, entry)
          try {
            if (!statSync(fullPath).isDirectory()) continue
            if (existsSync(join(fullPath, '.git'))) {
              repos.push({
                name: entry,
                path: fullPath,
                parentDir: dir.replace(home, '~'),
              })
            }
          } catch {}
        }
      } catch {}
    }

    await this.send({
      type: 'claude_event',
      payload: {
        event: {
          type: 'system' as const,
          subtype: 'scan_repos_result',
          content: JSON.stringify(repos),
        },
      },
    })
  }

  // ── Claude Code setup (install + login) ────────────────────────────

  private async sendClaudeStatus(): Promise<void> {
    const auth = detectClaudeAuth()
    const version = getClaudeVersion()
    await this.send({
      type: 'claude_event',
      payload: {
        event: {
          type: 'system' as const,
          subtype: 'claude_status',
          content: JSON.stringify({ ...auth, version }),
        },
      },
    })
  }

  private async handleSetupClaude(): Promise<void> {
    const installed = detectClaudeInstallation()

    // Step 1: Install if needed
    if (!installed) {
      await this.send({
        type: 'claude_event',
        payload: { event: { type: 'system' as const, subtype: 'setup_progress', content: 'installing' } },
      })

      try {
        await new Promise<void>((resolve, reject) => {
          const proc = spawn('bash', ['-c', 'curl -fsSL https://claude.ai/install.sh | bash'], {
            stdio: ['pipe', 'pipe', 'pipe'],
          })
          let output = ''
          proc.stdout?.on('data', (d: Buffer) => { output += d.toString() })
          proc.stderr?.on('data', (d: Buffer) => { output += d.toString() })
          proc.on('close', (code) => {
            if (code === 0) resolve()
            else reject(new Error(`Install failed (exit ${code}): ${output.slice(-200)}`))
          })
          proc.on('error', reject)
        })

        await this.send({
          type: 'claude_event',
          payload: { event: { type: 'system' as const, subtype: 'setup_progress', content: 'installed' } },
        })
      } catch (err) {
        await this.send({
          type: 'error',
          payload: { message: `Claude install failed: ${(err as Error).message}` },
        })
        return
      }
    } else {
      await this.send({
        type: 'claude_event',
        payload: { event: { type: 'system' as const, subtype: 'setup_progress', content: 'already_installed' } },
      })
    }

    // Step 2: Check if already authenticated
    const auth = detectClaudeAuth()
    if (auth.authenticated) {
      await this.send({
        type: 'claude_event',
        payload: {
          event: {
            type: 'system' as const,
            subtype: 'setup_progress',
            content: 'authenticated',
          },
        },
      })
      await this.send({
        type: 'claude_event',
        payload: {
          event: {
            type: 'system' as const,
            subtype: 'setup_complete',
            content: JSON.stringify({ email: auth.email, plan: auth.plan, version: getClaudeVersion() }),
          },
        },
      })
      return
    }

    // Step 3: Run `claude login` and capture URL + code
    await this.send({
      type: 'claude_event',
      payload: { event: { type: 'system' as const, subtype: 'setup_progress', content: 'login_starting' } },
    })

    const loginProc = spawn('claude', ['login'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    })

    // Kill login process after 10 minutes if user never authorizes
    const loginTimeout = setTimeout(() => {
      loginProc.kill('SIGTERM')
      this.send({
        type: 'error',
        payload: { message: 'Login timed out after 10 minutes. Try again.' },
      })
    }, 10 * 60 * 1000)

    let fullOutput = ''

    const processOutput = (chunk: Buffer) => {
      const text = chunk.toString()
      fullOutput += text

      // Look for URL pattern (claude.ai auth URL)
      const urlMatch = fullOutput.match(/(https:\/\/[^\s]+claude[^\s]+)/i)
        ?? fullOutput.match(/(https:\/\/[^\s]+)/i)
      // Look for code pattern
      const codeMatch = fullOutput.match(/code[:\s]+([A-Z0-9-]{4,})/i)
        ?? fullOutput.match(/([A-Z0-9]{4}-[A-Z0-9]{4})/i)

      if (urlMatch || codeMatch) {
        this.send({
          type: 'claude_event',
          payload: {
            event: {
              type: 'system' as const,
              subtype: 'login_url',
              content: JSON.stringify({
                url: urlMatch?.[1] ?? null,
                code: codeMatch?.[1] ?? null,
                raw: text.trim(),
              }),
            },
          },
        })
      }
    }

    loginProc.stdout?.on('data', processOutput)
    loginProc.stderr?.on('data', processOutput)

    loginProc.on('close', async (code) => {
      clearTimeout(loginTimeout)
      if (code === 0) {
        // Re-check auth status
        const finalAuth = detectClaudeAuth()
        await this.send({
          type: 'claude_event',
          payload: {
            event: {
              type: 'system' as const,
              subtype: 'setup_complete',
              content: JSON.stringify({
                email: finalAuth.email,
                plan: finalAuth.plan,
                version: getClaudeVersion(),
              }),
            },
          },
        })
      } else {
        await this.send({
          type: 'error',
          payload: { message: `Claude login failed (exit ${code})` },
        })
      }
    })
  }

  // ── Heartbeat (keeps server-side companion status alive) ──────────

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(async () => {
      await this.post('/api/companion/register', {
        authInfo: { ...detectClaudeAuth(), version: getClaudeVersion() },
        projects: listProjects(),
        homeDir: homedir(),
      })
    }, HEARTBEAT_INTERVAL_MS)
  }
}
