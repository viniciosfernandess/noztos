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

// Maps Bornastar UI mode names to Claude Code CLI --permission-mode values.
//
// Three modes match the documented `--permission-mode` values the CLI
// accepts. The names here are stable identifiers — the user-facing labels
// in the UI are `Plan` / `Auto` / `Bypass`, but the IDs stay short and
// stay aligned with what already lives in persisted drafts and event
// payloads, so renaming the labels never requires a migration.
//
// We intentionally don't expose the SDK-only `auto` mode (model classifier,
// research preview at time of writing) — passing that to the CLI silently
// falls back to `default` and the user sees a permission prompt for every
// edit, which is the bug we're fixing here.
export type BornastarMode = 'plan' | 'edit' | 'agent'
const MODE_MAP: Record<BornastarMode, string> = {
  plan: 'plan',
  edit: 'acceptEdits',
  agent: 'bypassPermissions',
}

export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high'
// Official Anthropic extended-thinking keywords. The CLI has no
// --thinking flag — the budget is triggered by wording in the prompt
// itself, so we prepend the right phrase when the user selects a level.
const THINKING_KEYWORD: Record<ThinkingLevel, string> = {
  off: '',
  low: 'think.',
  medium: 'think hard.',
  high: 'ultrathink.',
}

export interface BridgeOptions {
  model?: string       // CLI alias ('haiku'|'sonnet'|'opus') or full id
  thinking?: ThinkingLevel
}

export class ClaudeBridge extends EventEmitter {
  private cwd: string
  private process: ChildProcess | null = null
  private sessionId: string | null = null
  private buffer = ''
  private mode: BornastarMode = 'edit'
  private model?: string
  private thinking: ThinkingLevel = 'off'

  constructor(cwd: string, sessionId?: string, mode?: BornastarMode, options?: BridgeOptions) {
    super()
    this.cwd = cwd
    this.sessionId = sessionId ?? null
    this.mode = mode ?? 'edit'
    this.model = options?.model
    this.thinking = options?.thinking ?? 'off'
  }

  setMode(mode: BornastarMode): void {
    this.mode = mode
  }

  async prompt(text: string): Promise<void> {
    if (this.process) {
      throw new Error('A prompt is already running. Interrupt first or wait for completion.')
    }

    // Fallback to `acceptEdits` (the documented "Auto" CLI value) on the
    // off chance an unknown id slips in via persisted state — never to
    // the SDK-only `auto` literal, which the CLI silently downgrades to
    // `default` and reintroduces the permission prompts on every edit.
    const permissionMode = MODE_MAP[this.mode] ?? 'acceptEdits'
    // Prepend the thinking-budget keyword when the user asked for
    // extended thinking. Haiku ignores the keyword (no extended-thinking
    // support) — harmless leading sentence rather than a hard error.
    const keyword = THINKING_KEYWORD[this.thinking]
    const finalPrompt = keyword ? `${keyword} ${text}` : text

    const args = [
      '-p', finalPrompt,
      '--output-format', 'stream-json',
      '--permission-mode', permissionMode,
      '--verbose',
    ]
    if (this.model) {
      args.push('--model', this.model)
    }

    // Resume existing session if we have one
    if (this.sessionId) {
      args.push('--resume', this.sessionId)
    }

    console.log(`[isolation] claude spawn cwd=${this.cwd} mode=${permissionMode} model=${this.model ?? 'default'} thinking=${this.thinking} resume=${this.sessionId?.slice(0, 8) ?? 'new'}`)
    this.process = spawn('claude', args, {
      cwd: this.cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    // Close stdin right away. We pass the full prompt via -p, so the CLI
    // has nothing to read from stdin — and without this, it waits 3s for
    // possible piped input (e.g. `cat file | claude -p "..."`) before
    // proceeding and emits a stderr warning that leaks into the chat UI.
    this.process.stdin?.end()

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
