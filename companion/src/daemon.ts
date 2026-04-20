import { EventEmitter } from 'node:events'
import { hostname } from 'node:os'
import { spawn } from 'node:child_process'
import { loadConfig } from './config.js'
import { detectClaudeAuth, detectClaudeInstallation, getClaudeVersion } from './auth-detect.js'
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
      machineName: hostname(),
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
      case 'setup_claude':
        this.handleSetupClaude()
        break
      case 'claude_status':
        this.sendClaudeStatus()
        break
      case 'scan_repos':
        this.handleScanRepos()
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

  // ── Scan local repos ───────────────────────────────────────────────

  private async handleScanRepos(): Promise<void> {
    const { homedir } = await import('node:os')
    const { existsSync, readdirSync, statSync } = await import('node:fs')
    const { join } = await import('node:path')

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
      })
    }, HEARTBEAT_INTERVAL_MS)
  }
}
