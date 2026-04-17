import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type { ClaudeStreamEvent } from './types.js'

// Spawns a `claude` CLI process in stream-json mode and emits parsed
// events. Each ClaudeBridge instance manages one conversation session
// inside a specific project directory.
//
// Usage:
//   const bridge = new ClaudeBridge('/path/to/project')
//   bridge.on('event', (e: ClaudeStreamEvent) => { ... })
//   bridge.on('done', (summary) => { ... })
//   bridge.on('error', (err) => { ... })
//   await bridge.prompt('Add dark mode to the settings page')
//   bridge.interrupt()  // Ctrl-C equivalent

export class ClaudeBridge extends EventEmitter {
  private cwd: string
  private process: ChildProcess | null = null
  private sessionId: string | null = null
  private buffer = ''

  constructor(cwd: string, sessionId?: string) {
    super()
    this.cwd = cwd
    this.sessionId = sessionId ?? null
  }

  async prompt(text: string): Promise<void> {
    if (this.process) {
      throw new Error('A prompt is already running. Interrupt first or wait for completion.')
    }

    const args = [
      '-p', text,
      '--output-format', 'stream-json',
      '--permission-mode', 'bypassPermissions',
      '--verbose',
    ]

    // Resume existing session if we have one
    if (this.sessionId) {
      args.push('--resume', this.sessionId)
    }

    this.process = spawn('claude', args, {
      cwd: this.cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.buffer = ''

    this.process.stdout?.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf-8')
      this.drainBuffer()
    })

    this.process.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8').trim()
      if (text) {
        this.emit('event', {
          type: 'error' as const,
          error: text,
        } satisfies ClaudeStreamEvent)
      }
    })

    this.process.on('close', (code) => {
      // Drain any remaining buffer
      this.drainBuffer()
      this.process = null
      this.emit('done', { code, sessionId: this.sessionId })
    })

    this.process.on('error', (err) => {
      this.process = null
      this.emit('error', err)
    })
  }

  interrupt(): void {
    if (this.process) {
      this.process.kill('SIGINT')
    }
  }

  kill(): void {
    if (this.process) {
      this.process.kill('SIGTERM')
      this.process = null
    }
  }

  isRunning(): boolean {
    return this.process !== null
  }

  getSessionId(): string | null {
    return this.sessionId
  }

  private drainBuffer(): void {
    const lines = this.buffer.split('\n')
    // Keep the last incomplete line in the buffer
    this.buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const event = JSON.parse(trimmed) as ClaudeStreamEvent
        // Capture session_id from result events for resume
        if (event.session_id) {
          this.sessionId = event.session_id
        }
        this.emit('event', event)
      } catch {
        // Non-JSON lines (progress indicators, etc.) — emit as system
        this.emit('event', {
          type: 'system' as const,
          content: trimmed,
        } satisfies ClaudeStreamEvent)
      }
    }
  }
}
