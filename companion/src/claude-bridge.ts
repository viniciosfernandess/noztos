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

// ── Bundled fallback values ─────────────────────────────────────────
//
// These are the prompts/disallow-lists the daemon ships with in its
// dist/ bundle. They cover three cases:
//   1. First boot before the very first server fetch lands
//   2. Backend is unreachable (offline user / our backend down)
//   3. Server returned malformed config (validation rejected it)
//
// In any of those cases the daemon stays 100% functional with these
// values. The active values come from `getActiveConfig()` which mirrors
// whatever the server most recently returned; when no fetch has
// succeeded yet, that mirror is initialised to these bundled defaults.
//
// ⚠️  Edit here AND in scripts/seed-companion-config.ts at the same
//    time so the seeded DB row never drifts from the bundle.
//
// AskUserQuestion is blocked in Plan because the CLI fails it instantly
// with a synthetic "No response requested." reply (upstream issue
// anthropics/claude-code#16712); removing the tool flips Claude into
// asking via plain text instead.
const BUNDLED_DISALLOWED_TOOLS_BY_MODE: Record<BornastarMode, string[]> = {
  plan: ['AskUserQuestion'],
  ask: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'],
  agent: [],
}

const BUNDLED_MODE_PROMPT: Record<BornastarMode, string> = {
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

const BUNDLED_NAMING_RULE = `
This wrapper exposes three modes to the user:
- "Plan"  — read-only with structured plan output
- "Ask"   — read-only conversational (no edits, no destructive bash)
- "Agent" — full autonomy

When you suggest the user switch modes, ALWAYS use these wrapper names
(Plan / Ask / Agent). NEVER reference the underlying CLI names
(plan / acceptEdits / bypassPermissions / default) in your replies.`

// ── Active config (process-wide, mutable) ───────────────────────────
//
// The shape mirrors the singleton row served by /api/companion/config.
// `version` doubles as the source-of-truth tag the daemon compares
// against /config-version to decide whether to re-fetch full payload.
export interface ActiveConfig {
  modePrompts: Record<BornastarMode, string>
  namingRule: string
  disallowedTools: Record<BornastarMode, string[]>
  version: string
}

let activeConfig: ActiveConfig = {
  modePrompts: BUNDLED_MODE_PROMPT,
  namingRule: BUNDLED_NAMING_RULE,
  disallowedTools: BUNDLED_DISALLOWED_TOOLS_BY_MODE,
  version: 'bundled',
}

// Read-only accessor for callers that just want to inspect the current
// config (e.g. logging, status endpoints). Returns a reference — do not
// mutate. Use setActiveConfig to publish changes.
export function getActiveConfig(): Readonly<ActiveConfig> {
  return activeConfig
}

// Replace the active config. Called by the daemon's loader after a
// successful /config fetch. Any in-flight `prompt()` already started
// will keep using the prior values (its args are already built); the
// next spawn picks up the new ones. No restart needed.
export function setActiveConfig(next: ActiveConfig): void {
  activeConfig = next
}

// ── Active skills (process-wide, mutable) ──────────────────────────
//
// Keyed by lowercase agent name ('ceo', 'tester', 'devops'…). Populated
// by skill-config.ts after a successful /skills fetch; empty until then,
// in which case skillId-tagged spawns silently fall back to "no skill
// prompt" (chat behaves like a regular `/agent` chat). Version is the
// SHA-256 returned by the server — used by the version-drift poll.
const activeSkills: Map<string, string> = new Map()
let activeSkillsVersion = 'bundled'

export function setActiveSkills(skills: Array<{ name: string; prompt: string }>, version: string): void {
  activeSkills.clear()
  for (const s of skills) {
    activeSkills.set(s.name.toLowerCase(), s.prompt)
  }
  activeSkillsVersion = version
}

export function getActiveSkillsVersion(): string {
  return activeSkillsVersion
}

function getSkillPromptByName(name: string | null | undefined): string | null {
  if (!name) return null
  return activeSkills.get(name.toLowerCase()) ?? null
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
  skillId?: string | null   // active agent skill; null = regular chat
}

export class ClaudeBridge extends EventEmitter {
  private cwd: string
  private process: ChildProcess | null = null
  private sessionId: string | null = null
  private buffer = ''
  private mode: BornastarMode = 'agent'
  private model?: string
  private thinking: ThinkingLevel = 'off'
  private skillId: string | null = null

  constructor(cwd: string, sessionId?: string, mode?: BornastarMode, options?: BridgeOptions) {
    super()
    this.cwd = cwd
    this.sessionId = sessionId ?? null
    this.mode = mode ?? 'agent'
    this.model = options?.model
    this.thinking = options?.thinking ?? 'off'
    this.skillId = options?.skillId ?? null
  }

  setMode(mode: BornastarMode): void {
    this.mode = mode
  }

  setSkillId(skillId: string | null): void {
    this.skillId = skillId
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

    // Pull live config (prompts + disallowed-tools) from the
    // process-wide active store. Initialised to bundled defaults at
    // module load; replaced by setActiveConfig() after a successful
    // /config fetch. Either way, this is just an object lookup —
    // nanoseconds, identical cost to the previous hard-coded const.
    const cfg = activeConfig

    // Tool blacklist (Ask mode mainly — blocks Edit/Write at the CLI
    // before they reach the model). Empty list = flag omitted entirely.
    const disallowed = cfg.disallowedTools[this.mode] ?? []
    if (disallowed.length > 0) {
      args.push('--disallowedTools', disallowed.join(','))
    }

    // Append our mode-specific instruction + the wrapper-naming rule.
    // Plan ships with an empty body so we don't override Anthropic's
    // tuned plan prompt — only the naming rule goes there.
    //
    // When the user activated a skill (e.g. /ceo), prepend that agent's
    // skillMd. Order matters: skill prompt sets the persona, then mode
    // prompt scopes the operating envelope. If the skillId is unknown
    // to the local cache (offline / pre-fetch / typo), we silently
    // fall back to the bare mode prompt so chat keeps working.
    const skillPrompt = getSkillPromptByName(this.skillId)
    if (this.skillId) {
      console.log(`[isolation] skill lookup id=${this.skillId} hit=${skillPrompt ? 'yes' : 'no'} promptBytes=${skillPrompt?.length ?? 0} cacheVersion=${activeSkillsVersion}`)
    }
    const skillBlock = skillPrompt ? `${skillPrompt}\n\n` : ''
    const appendPrompt = (skillBlock + (cfg.modePrompts[this.mode] ?? '') + cfg.namingRule).trim()
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

    console.log(`[isolation] claude spawn cwd=${this.cwd} bornastarMode=${this.mode} cliMode=${permissionMode} disallowed=${disallowed.length} prompt=${appendPrompt.length}b configVersion=${cfg.version} skill=${this.skillId ?? 'none'}${skillPrompt ? ` skillVersion=${activeSkillsVersion}` : ''} model=${this.model ?? 'default'} thinking=${this.thinking} resume=${this.sessionId?.slice(0, 8) ?? 'new'}`)
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
