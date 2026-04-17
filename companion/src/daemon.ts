import WebSocket from 'ws'
import { EventEmitter } from 'node:events'
import { loadConfig } from './config.js'
import { detectClaudeAuth, getClaudeVersion } from './auth-detect.js'
import { ClaudeBridge } from './claude-bridge.js'
import { listProjects } from './project-manager.js'
import type { CompanionCommand, CompanionMessage, ClaudeStreamEvent } from './types.js'

// The daemon is the long-running background process that:
//   1. Connects to the Bornastar server via WebSocket (outbound)
//   2. Receives commands from the web UI (prompts, interrupts, etc.)
//   3. Spawns Claude Code CLI sessions per project
//   4. Relays stream-json events back to the server → browser
//
// The connection is OUTBOUND (daemon → server), so no port-forwarding
// or firewall issues. Server matches the companion's auth token to the
// user's browser session and relays messages bidirectionally.

const RECONNECT_DELAY_MS = 5_000
const HEARTBEAT_INTERVAL_MS = 30_000

export class Daemon extends EventEmitter {
  private ws: WebSocket | null = null
  private serverUrl: string
  private authToken: string
  private bridges: Map<string, ClaudeBridge> = new Map()
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private shouldReconnect = true

  constructor(serverUrl: string, authToken: string) {
    super()
    this.serverUrl = serverUrl
    this.authToken = authToken
  }

  async start(): Promise<void> {
    this.shouldReconnect = true
    this.connect()
  }

  stop(): void {
    this.shouldReconnect = false
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    // Kill all active Claude sessions
    for (const [, bridge] of this.bridges) {
      bridge.kill()
    }
    this.bridges.clear()
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }

  private connect(): void {
    const url = `${this.serverUrl.replace(/^http/, 'ws')}/api/companion/ws?token=${this.authToken}`
    this.ws = new WebSocket(url)

    this.ws.on('open', () => {
      this.emit('connected')
      this.startHeartbeat()
      // Send initial state: auth info + project list
      this.sendAuthStatus()
      this.sendProjectList()
    })

    this.ws.on('message', (data) => {
      try {
        const cmd = JSON.parse(data.toString()) as CompanionCommand
        this.handleCommand(cmd)
      } catch {
        // Ignore malformed messages
      }
    })

    this.ws.on('close', () => {
      this.emit('disconnected')
      this.stopHeartbeat()
      if (this.shouldReconnect) {
        this.reconnectTimer = setTimeout(() => this.connect(), RECONNECT_DELAY_MS)
      }
    })

    this.ws.on('error', (err) => {
      this.emit('error', err)
    })
  }

  private send(msg: CompanionMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }

  private sendAuthStatus(): void {
    const auth = detectClaudeAuth()
    const version = getClaudeVersion()
    this.send({
      type: 'auth_status',
      payload: { ...auth, version },
    })
  }

  private sendProjectList(): void {
    this.send({
      type: 'project_list',
      payload: listProjects(),
    })
  }

  private handleCommand(cmd: CompanionCommand): void {
    switch (cmd.type) {
      case 'prompt':
        this.handlePrompt(cmd)
        break
      case 'interrupt':
        this.handleInterrupt(cmd)
        break
      case 'status':
        this.sendAuthStatus()
        this.sendProjectList()
        break
      case 'clone':
        this.handleClone(cmd)
        break
      case 'create_project':
        this.handleCreateProject(cmd)
        break
    }
  }

  private async handlePrompt(cmd: CompanionCommand): Promise<void> {
    if (!cmd.projectId || !cmd.prompt) return

    const config = loadConfig()
    const project = config.projects.find((p) => p.id === cmd.projectId)
    if (!project) {
      this.send({
        type: 'error',
        payload: { message: `Project ${cmd.projectId} not found` },
      })
      return
    }

    // Reuse existing bridge for this project or create new
    let bridge = this.bridges.get(project.id)
    if (bridge?.isRunning()) {
      this.send({
        type: 'error',
        payload: { message: 'Agent is already running for this project. Interrupt first.' },
      })
      return
    }

    bridge = new ClaudeBridge(project.path, cmd.sessionId ?? undefined)
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
      this.send({
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
      this.send({ type: 'project_added', payload: project })
      this.sendProjectList()
    } catch (err) {
      this.send({
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
      this.send({ type: 'project_added', payload: project })
      this.sendProjectList()
    } catch (err) {
      this.send({
        type: 'error',
        payload: { message: `Create failed: ${(err as Error).message}` },
      })
    }
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping()
      }
    }, HEARTBEAT_INTERVAL_MS)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }
}
