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
// Three Bornastar-flavored modes (Plan/Ask/Agent) sitting on top of the
// CLI primitives. Naming chosen for product clarity, not for parity with
// the CLI's internal labels:
//
//   • Plan  — uses the CLI's plan mode as-is. Anthropic ships a tuned
//             system prompt for it (structured plan output, ExitPlanMode
//             tool); we don't fight that.
//   • Ask   — bypassPermissions at the CLI level + a tools blacklist
//             that hides Edit/Write/MultiEdit/NotebookEdit. Bash works
//             so the user can ask `git status` / `npm test` style
//             questions; the system prompt covers the "no destructive
//             bash" rule the CLI can't enforce by itself.
//   • Agent — bypassPermissions, no restrictions. Default mode.
export type BornastarMode = 'plan' | 'ask' | 'agent'
const MODE_MAP: Record<BornastarMode, string> = {
  plan: 'plan',
  ask: 'bypassPermissions',
  agent: 'bypassPermissions',
}

// Tools blocked at the CLI level for each mode. Plan handles its own
// enforcement via the CLI's built-in plan-mode behavior, so the list
// is empty there. Ask blocks every file-write tool — Claude literally
// cannot call Edit/Write because the CLI rejects the call before it
// reaches the model. Agent has no restrictions.
const DISALLOWED_TOOLS_BY_MODE: Record<BornastarMode, string[]> = {
  plan: [],
  ask: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'],
  agent: [],
}

// Mode-specific instruction we hand the model on top of whatever the
// CLI injects. Plan ships with Anthropic's tuned plan prompt already,
// so we leave its body empty and only the wrapper-naming rule below
// gets appended. Ask gets the full "show, don't apply" guidance with
// concrete verb lists; Agent gets the autonomy framing.
const MODE_PROMPT: Record<BornastarMode, string> = {
  plan: `UI note for this wrapper: when you call ExitPlanMode, the plan
markdown you pass to that tool renders as a dedicated review card
below your conversational reply, with Approve / Keep-refining buttons.
The user reads the plan content in that card.

So you don't need to repeat the plan body in your text — the user will
already see it right below. Write your reply naturally; just don't
duplicate the same content twice.`,
  ask: `You are in Ask mode.

You CAN read code, search, and run safe Bash commands like \`git status\`,
\`ls\`, \`npm test\`, \`cat\`, \`grep\`, \`find\`, etc. Use them freely to
answer the user's questions.

You CANNOT modify, create, or delete files. Edit, Write, MultiEdit and
NotebookEdit are disabled at the CLI level. You also MUST NOT use Bash
to write or change anything — no \`mkdir\`, \`rm\`, \`touch\`, \`mv\`, \`cp\`,
\`git commit\`, \`git push\`, \`git checkout\`, \`npm install\`, shell
redirects (\`>\`, \`>>\`, \`tee\`), or any other side-effecting command.

When the user asks you to "write", "draft", "compose", "show", "sketch",
or "propose" content (a README, a function, a config, an SQL migration,
an email, anything textual) — produce that content INLINE in your chat
response. The user wants to read and review it. Don't refuse. This is
exactly what Ask is for.

Only when the user asks you to APPLY, SAVE, EXECUTE, IMPLEMENT, COMMIT,
RUN, INSTALL or CREATE the change in the project itself — that's the
write side that Ask doesn't cover. Respond:
"I can show you what I'd do here in chat, but to actually apply it I
need Agent mode. Want me to draft it inline first, or are you ready to
switch?"`,
  agent: `You are in Agent mode.

You have full autonomy — read, edit, write, create, delete, run any
command. Execute the user's request without asking for permission
unless an action is clearly destructive and irreversible (e.g. \`rm -rf\`
outside the project, force-pushing main, dropping production data).`,
}

// Wrapper-naming rule appended to every mode. Claude knows the CLI
// modes by their internal names (plan / acceptEdits / bypassPermissions);
// here we tell it to use OUR names when nudging the user to switch, so
// the chat copy lines up with the picker labels.
const NAMING_RULE = `
This wrapper exposes three modes to the user:
- "Plan"  — read-only with structured plan output
- "Ask"   — read-only conversational (no edits, no destructive bash)
- "Agent" — full autonomy

When you suggest the user switch modes, ALWAYS use these wrapper names
(Plan / Ask / Agent). NEVER reference the underlying CLI names
(plan / acceptEdits / bypassPermissions / default) in your replies.`

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
  private mode: BornastarMode = 'agent'
  private model?: string
  private thinking: ThinkingLevel = 'off'

  constructor(cwd: string, sessionId?: string, mode?: BornastarMode, options?: BridgeOptions) {
    super()
    this.cwd = cwd
    this.sessionId = sessionId ?? null
    this.mode = mode ?? 'agent'
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

    // Fallback to `bypassPermissions` (Agent's CLI value) on the off
    // chance an unknown id slips in via persisted state from before the
    // mode rename — matches the new default. Old persisted 'edit' values
    // hit this fallback and behave like Agent, which is the closest
    // semantic match for "auto-accept everything" and avoids leaving
    // the user stuck in a broken-mode chat.
    const permissionMode = MODE_MAP[this.mode] ?? 'bypassPermissions'
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

    // Tool blacklist (Ask mode mainly — blocks Edit/Write at the CLI
    // before they reach the model). Empty list = flag omitted entirely.
    const disallowed = DISALLOWED_TOOLS_BY_MODE[this.mode] ?? []
    if (disallowed.length > 0) {
      args.push('--disallowedTools', disallowed.join(','))
    }

    // Append our mode-specific instruction + the wrapper-naming rule.
    // Plan ships with an empty body so we don't override Anthropic's
    // tuned plan prompt — only the naming rule goes there.
    const appendPrompt = (MODE_PROMPT[this.mode] + NAMING_RULE).trim()
    if (appendPrompt) {
      args.push('--append-system-prompt', appendPrompt)
    }

    if (this.model) {
      args.push('--model', this.model)
    }

    // Resume existing session if we have one
    if (this.sessionId) {
      args.push('--resume', this.sessionId)
    }

    console.log(`[isolation] claude spawn cwd=${this.cwd} bornastarMode=${this.mode} cliMode=${permissionMode} disallowed=${disallowed.length} prompt=${appendPrompt.length}b model=${this.model ?? 'default'} thinking=${this.thinking} resume=${this.sessionId?.slice(0, 8) ?? 'new'}`)
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
