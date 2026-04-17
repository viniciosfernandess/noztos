import { EventEmitter } from 'node:events'
import { loadConfig } from './config.js'
import { detectClaudeAuth, getClaudeVersion } from './auth-detect.js'
import { ClaudeBridge } from './claude-bridge.js'
import { listProjects } from './project-manager.js'
import type { CompanionCommand, CompanionMessage, ClaudeStreamEvent } from './types.js'

// The daemon is the long-running background process that:
//   1. Registers with the Bornastar server (POST /api/companion/register)
//   2. Listens for commands via SSE (GET /api/companion/events)
//   3. Spawns Claude Code CLI sessions per project
//   4. Relays stream-json events back via POST /api/companion/response
//
// All connections are OUTBOUND (daemon → server) over standard HTTPS,
// so no port-forwarding, firewall, or WebSocket upgrade needed.
// Works with stock Next.js API routes.

const RECONNECT_DELAY_MS = 5_000
const HEARTBEAT_INTERVAL_MS = 25_000

export class Daemon extends EventEmitter {
  private serverUrl: string
  private authToken: string
  private bridges: Map<string, ClaudeBridge> = new Map()
  private eventSource: EventSource | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private shouldReconnect = true
  private abortController: AbortController | null = null

  constructor(serverUrl: string, authToken: string) {
    super()
    this.serverUrl = serverUrl
    this.authToken = authToken
  }

  async start(): Promise<void> {
    this.shouldReconnect = true
    await this.register()
    this.connectEvents()
    this.startHeartbeat()
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
      case 'create_project':
        this.handleCreateProject(cmd)
        break
    }
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

    let bridge = this.bridges.get(project.id)
    if (bridge?.isRunning()) {
      await this.send({
        type: 'error',
        payload: { message: 'Agent is already running. Interrupt first.' },
      })
      return
    }

    bridge = new ClaudeBridge(project.path, cmd.sessionId ?? undefined, cmd.mode ?? 'auto')
    this.bridges.set(project.id, bridge)

    bridge.on('event', (event: ClaudeStreamEvent) => {
      this.send({
        type: 'claude_event',
        payload: { projectId: project.id, event },
      })
    })

    bridge.on('done', (summary: { code: number; sessionId: string | null }) => {
      this.send({
        type: 'claude_event',
        payload: {
          projectId: project.id,
          event: {
            type: 'result',
            session_id: summary.sessionId,
            content: `Session ended (exit ${summary.code})`,
          },
        },
      })
    })

    bridge.on('error', (err: Error) => {
      this.send({
        type: 'error',
        payload: { projectId: project.id, message: err.message },
      })
    })

    try {
      await bridge.prompt(cmd.prompt)
    } catch (err) {
      await this.send({
        type: 'error',
        payload: { projectId: project.id, message: (err as Error).message },
      })
    }
  }

  private handleInterrupt(cmd: CompanionCommand): void {
    if (!cmd.projectId) return
    const bridge = this.bridges.get(cmd.projectId)
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
      const project = createProject(cmd.targetPath, { template: cmd.template })
      await this.send({ type: 'project_added', payload: project })
      await this.sendStatus()
    } catch (err) {
      await this.send({
        type: 'error',
        payload: { message: `Create failed: ${(err as Error).message}` },
      })
    }
  }

  // ── Heartbeat (keeps server-side companion status alive) ──────────

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(async () => {
      await this.post('/api/companion/register', {
        authInfo: detectClaudeAuth(),
        projects: listProjects(),
      })
    }, HEARTBEAT_INTERVAL_MS)
  }
}
