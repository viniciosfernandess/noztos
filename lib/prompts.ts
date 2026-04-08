import { readFileSync } from 'fs'
import { join } from 'path'

// ── Prompt Loader ─────────────────────────────────────────────────────────
//
// Loads prompts from /prompts/*.md files.
// All behavior rules are centralized there — not in code.

const PROMPTS_DIR = join(process.cwd(), 'prompts')
const SKILLS_DIR = join(PROMPTS_DIR, 'skills')

// Cache prompts in memory (they don't change at runtime)
const cache = new Map<string, string>()

// ── Session Prompt Cache ──────────────────────────────────────────────────
// Memoizes the built prompt parts per (modeFile, isExecution) combo so we
// don't re-join the same strings on every request. Keyed by a string like
// "when-debugging.md:false". Cleared only on process restart.
const builtPromptCache = new Map<string, string[]>()

function load(filePath: string): string {
  if (cache.has(filePath)) return cache.get(filePath)!
  const content = readFileSync(filePath, 'utf-8')
  cache.set(filePath, content)
  return content
}

// ── Base Prompts ──────────────────────────────────────────────────────────

export function getBasePrompt(): string {
  return load(join(PROMPTS_DIR, 'base.md'))
}

export function getBuildRules(): string {
  return load(join(PROMPTS_DIR, 'build-rules.md'))
}

export function getTaskRules(): string {
  return load(join(PROMPTS_DIR, 'task-rules.md'))
}

export function getTeamRules(): string {
  return load(join(PROMPTS_DIR, 'team-rules.md'))
}

export function getSuggestionsRules(): string {
  return load(join(PROMPTS_DIR, 'suggestions-rules.md'))
}

// ── Skill Prompts ─────────────────────────────────────────────────────────

export function getSkillPrompt(skillId: string): string {
  return load(join(SKILLS_DIR, `${skillId}.md`))
}

export function getBuilderPrompt(): string {
  return load(join(SKILLS_DIR, 'builder.md'))
}

// ── Specialty Prompts ─────────────────────────────────────────────────────

export function getSecurityScanPrompt(mode: 'full' | 'targeted'): string {
  return load(join(PROMPTS_DIR, `security-scan-${mode}.md`))
}

export function getCodeHealthPrompt(mode: 'full' | 'targeted'): string {
  return load(join(PROMPTS_DIR, `codehealth-${mode}.md`))
}

// ── When Prompts ─────────────────────────────────────────────────────────

const WHEN_FILES = [
  'when-explaining-what.md',
  'when-explaining-how.md',
  'when-comparing.md',
  'when-discussing-code.md',
  'when-planning.md',
  'when-improving-code.md',
  'when-refactoring.md',
  'when-debugging.md',
  'when-testing.md',
  'when-devops.md',
  'when-documentation.md',
  'when-after-execution.md',
]

const MODES_DIR = join(PROMPTS_DIR, 'modes')

export function getAllWhens(): string {
  return WHEN_FILES.map(f => load(join(MODES_DIR, f))).join('\n\n')
}

/** Load a single mode file by filename (e.g. 'when-planning.md') */
export function getModePrompt(fileName: string): string {
  return load(join(MODES_DIR, fileName))
}

// ── Composed Prompts ──────────────────────────────────────────────────────

/** System prompt for direct chat (no skill selected) — repo always present */
export function buildChatPrompt(): string {
  return [getBasePrompt(), getAllWhens(), getBuildRules(), getTaskRules()].join('\n\n---\n\n')
}

/** System prompt for skill chat (/ceo, /architect, etc.) — repo always present */
export function buildSkillChatPrompt(skillId: string): string {
  return [getBasePrompt(), getSkillPrompt(skillId), getAllWhens(), getBuildRules(), getTaskRules()].join('\n\n---\n\n')
}

/** System prompt for team chat pipeline — repo always present */
export function buildTeamChatPrompt(): string {
  return [getBasePrompt(), getTeamRules(), getAllWhens(), getBuildRules(), getTaskRules()].join('\n\n---\n\n')
}

/** System prompt for a specific employee within a team pipeline */
export function buildTeamMemberPrompt(skillId: string): string {
  return [getBasePrompt(), getSkillPrompt(skillId)].join('\n\n---\n\n')
}

/** System prompt for the builder within a team pipeline */
export function buildTeamBuilderPrompt(): string {
  return [getBasePrompt(), getBuilderPrompt()].join('\n\n---\n\n')
}

// ── Task Prompts ──────────────────────────────────────────────────────────

/** System prompt for task execution (skill mode) */
export function buildTaskSkillPrompt(skillId: string): string {
  const parts = [getBasePrompt(), getSkillPrompt(skillId), getSuggestionsRules()]
  return parts.join('\n\n---\n\n')
}

/** System prompt for task execution (team member) */
export function buildTaskTeamMemberPrompt(skillId: string): string {
  return [getBasePrompt(), getSkillPrompt(skillId), getSuggestionsRules()].join('\n\n---\n\n')
}

/** System prompt for task execution (builder) */
export function buildTaskBuilderPrompt(): string {
  return [getBasePrompt(), getBuilderPrompt(), getSuggestionsRules()].join('\n\n---\n\n')
}

// ── Environment Block ─────────────────────────────────────────────────────

// ── Permission Mode ───────────────────────────────────────────────────────

export type PermissionMode = 'leitura' | 'planejamento' | 'edicao'

const MODE_DESCRIPTIONS: Record<PermissionMode, string> = {
  leitura: 'Leitura — você pode ler e analisar código livremente. Edições e execução de comandos requerem aprovação do usuário.',
  planejamento: 'Planejamento — você pode ler e analisar código livremente. Produza um plano detalhado das ações que executaria, mas não execute nenhuma escrita ou comando.',
  edicao: 'Edição — acesso total. Você pode ler, editar arquivos e executar comandos sem restrições.',
}

/**
 * Build a dynamic # Environment block injected as its own system prompt block.
 * Tells Claude which model it's running on, current date, and active permission mode.
 * Goes AFTER the static blocks so it never busts the static cache.
 */
export function buildEnvironmentBlock(modelKey?: string, permissionMode?: PermissionMode, projectName?: string, repoName?: string): string {
  const modelNames: Record<string, string> = {
    haiku: 'Claude Haiku 4.5 (claude-haiku-4-5-20251001)',
    sonnet: 'Claude Sonnet 4 (claude-sonnet-4-20250514)',
    opus: 'Claude Opus 4 (claude-opus-4-20250514)',
  }
  const modelName = (modelKey && modelNames[modelKey]) ?? 'Claude Sonnet 4 (claude-sonnet-4-20250514)'
  const today = new Date().toISOString().slice(0, 10)
  const mode = permissionMode ?? 'leitura'
  const modeDesc = MODE_DESCRIPTIONS[mode]

  const permissionInstructions = mode === 'leitura'
    ? `\n\nIf the user asks you to create, edit, or delete files — or run commands — you MUST NOT do it. Instead, respond normally explaining what you would do, then end your message with:\n[REQUEST_EDIT_PERMISSION: one sentence explaining what change you need to make]`
    : mode === 'planejamento'
    ? `\n\nYou may read and analyze files freely. When asked to implement something, produce a detailed step-by-step plan of exactly what you would do — files, changes, commands — but do NOT execute any writes or commands. Do not use [REQUEST_EDIT_PERMISSION].`
    : ''

  const projectLine = projectName ? `\n- Project: ${projectName}${repoName ? ` (${repoName})` : ''}` : ''

  return `# Environment

- Model: ${modelName}
- Date: ${today}
- Latest Claude models — Opus 4.6: claude-opus-4-6, Sonnet 4.6: claude-sonnet-4-6, Haiku 4.5: claude-haiku-4-5-20251001${projectLine}

# Permission Mode

${modeDesc}${permissionInstructions}`
}

// ── Classified Prompt Builder ─────────────────────────────────────────────

/**
 * Build system prompt parts based on classifier result.
 * Returns an array of parts to be sent as separate cached blocks:
 *   [0] base.md — identical across ALL requests → max cache hits
 *   [1] mode-specific behavior — stable per mode
 *   [2] build rules + task rules — stable, same for all
 *
 * The (modeFileName, isExecution) combo is memoized so repeated requests
 * with the same mode don't re-join the same strings.
 * Splitting into blocks lets Anthropic cache base.md independently of the
 * mode file, so a mode change still gets a cache hit on block 0.
 */
export function buildClassifiedPrompt(modeFileName: string | null, isExecution: boolean): string[] {
  const cacheKey = `${modeFileName ?? 'null'}:${isExecution}`
  const cached = builtPromptCache.get(cacheKey)
  if (cached) return cached

  // Block 0: base — most stable, shared by every single request
  const base = getBasePrompt()

  // Block 1: mode-specific (stable per mode)
  const modeParts: string[] = []
  if (modeFileName) modeParts.push(load(join(MODES_DIR, modeFileName)))
  if (isExecution) modeParts.push(load(join(MODES_DIR, 'when-after-execution.md')))

  // Block 2: rules — same for all non-skill requests
  const rules = [getBuildRules(), getTaskRules()].join('\n\n---\n\n')

  const parts: string[] = [base]
  if (modeParts.length > 0) parts.push(modeParts.join('\n\n---\n\n'))
  parts.push(rules)

  builtPromptCache.set(cacheKey, parts)
  return parts
}

// ── Skill Name Map ────────────────────────────────────────────────────────

export const SKILL_NAMES: Record<string, string> = {
  ceo: 'CEO',
  architect: 'Architect',
  designer: 'Designer',
  security: 'Security',
}
