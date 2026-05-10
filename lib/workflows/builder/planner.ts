// Planner step — Phase 0 do Builder Workflow.
//
// Responsabilidade: chamar claude com a skill do Planner + contexto
// (user task, chat context vindo do Bridge IN, repo snapshot, mode),
// capturar o output JSON, validar e retornar PlannerOutput tipado.
//
// Quando isso retorna, runner.ts pode iniciar os blocks.

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { callClaude } from '../shared/claude-cli'
import { writePlan, writePlannerRawOutput } from '../shared/artifacts'
import type {
  AgentStepResult,
  PlannerOutput,
  TranscriptChunk,
  WorkflowMode,
} from '../shared/types'

// Carrega skill md do disco. Em produção, podemos cachear no startup;
// V1 lê do FS a cada run pra simplicidade.
async function loadPlannerSkill(): Promise<string> {
  const path = join(process.cwd(), 'lib/workflows/builder/prompts/planner.md')
  return await fs.readFile(path, 'utf-8')
}

interface PlannerInput {
  userMessage: string
  chatContextXml: string         // output do Bridge IN ('' se vazio)
  repoSnapshot: string
  mode: WorkflowMode
  projectPath: string
  onChunk?: (chunk: TranscriptChunk) => void
}

export interface PlannerStepResult {
  rawResult: AgentStepResult
  plan: PlannerOutput | null
  parseError?: string
  systemPrompt: string
  userText: string
}

// Repo snapshot — only what's bias-free.
//
// We deliberately DO NOT include a directory tree here. Earlier versions
// listed top-level entries + key dirs one level deep; that gave the
// Planner a false sense of "I already know the structure" and it stopped
// investigating before discovering route groups, dynamic paths, etc.
// Now the snapshot only carries package.json (stack/scripts/deps) and
// the README excerpt — both describe WHAT the project is without
// claiming WHERE things live. The Planner is forced to use Read/Grep/
// Glob to learn structure, which prevents asserting absences that
// aren't real.
export async function buildRepoSnapshot(projectPath: string): Promise<string> {
  const lines: string[] = [`Project root: ${projectPath}`]
  try {
    const pkgRaw = await fs.readFile(join(projectPath, 'package.json'), 'utf-8')
    const pkg = JSON.parse(pkgRaw) as {
      name?: string
      scripts?: Record<string, string>
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    lines.push('', `package.json: name="${pkg.name ?? 'unknown'}"`)
    if (pkg.scripts) lines.push(`  scripts: ${Object.keys(pkg.scripts).join(', ')}`)
    const deps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) })
    if (deps.length > 0) {
      lines.push(`  deps: ${deps.slice(0, 15).join(', ')}${deps.length > 15 ? ` (+${deps.length - 15} more)` : ''}`)
    }
  } catch {}
  try {
    const readme = await fs.readFile(join(projectPath, 'README.md'), 'utf-8')
    lines.push('', 'README.md excerpt:', readme.slice(0, 500))
  } catch {}
  return lines.join('\n')
}

function buildPlannerSystemPrompt(skill: string, input: PlannerInput): string {
  const sections: string[] = [
    skill,
    '',
    '---',
    '',
    '## User task',
    input.userMessage,
    '',
  ]
  if (input.chatContextXml.length > 0) {
    sections.push('## Chat context preceding the workflow', input.chatContextXml, '')
  }
  sections.push('## Repo snapshot', input.repoSnapshot, '')
  sections.push(`## Mode\n${input.mode}`, '')
  return sections.join('\n')
}

// XML tag extraction. Non-greedy so the FIRST closing tag wins —
// the model can put `<` for generics, backticks, quotes, real newlines,
// markdown code blocks, anything inside a tag without breaking us. The
// only forbidden literal is the closing tag itself, which the prompt
// flags for the model.
function extractTag(source: string, tag: string): string | null {
  // Built dynamically so we can pass the tag name; flags `i`/`s`-style
  // via [\s\S] to handle multiline content.
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i')
  const m = source.match(re)
  return m ? m[1] : null
}

// Find every <block>...</block> in document order. Same non-greedy
// rule per match.
function extractAllBlocks(source: string): string[] {
  const re = /<block\b[^>]*>([\s\S]*?)<\/block>/gi
  const blocks: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(source)) !== null) {
    blocks.push(m[1])
  }
  return blocks
}

function parsePlannerOutput(raw: string): { plan: PlannerOutput | null; error?: string } {
  // Strip optional markdown fence the model may wrap the XML in. Same
  // anchored-to-end pattern as before — internal backticks stay intact.
  const cleaned = raw
    .replace(/^[\s\S]*?```(?:xml)?\s*\n/, '')
    .replace(/\n```\s*$/, '')
    .trim()

  // Top-level <plan> wrapper is optional — the model may emit just
  // <block>...</block> directly. Either works; we extract from whichever
  // scope contains the blocks.
  const planInner = extractTag(cleaned, 'plan') ?? cleaned

  const blockSources = extractAllBlocks(planInner)
  if (blockSources.length === 0) {
    return { plan: null, error: 'planner output has no <block> tags' }
  }

  const rationale = (extractTag(planInner, 'rationale') ?? '').trim()

  const blocks: PlannerOutput['blocks'] = []
  for (let i = 0; i < blockSources.length; i++) {
    const src = blockSources[i]
    const name = (extractTag(src, 'name') ?? '').trim()
    const objective = (extractTag(src, 'objective') ?? '').trim()
    if (!name || !objective) {
      return { plan: null, error: `block ${i + 1} missing <name> or <objective>` }
    }
    const filesRaw = extractTag(src, 'estimated_files')?.trim()
    const estimatedFiles = filesRaw
      ? filesRaw.split(/[,\n]/).map((s) => s.trim()).filter(Boolean)
      : undefined
    blocks.push({ name, objective, ...(estimatedFiles && estimatedFiles.length > 0 && { estimatedFiles }) })
  }

  return {
    plan: {
      ...(rationale && { rationale }),
      blocks,
    },
  }
}

function planToMarkdown(plan: PlannerOutput, userMessage: string): string {
  const lines: string[] = [`# Plan`, '', `## Task`, userMessage, '']
  if (plan.rationale) lines.push(`## Rationale`, plan.rationale, '')
  lines.push(`## Blocks`, '')
  plan.blocks.forEach((b, i) => {
    lines.push(`### Block ${i + 1}: ${b.name}`)
    lines.push('', `**Objective:** ${b.objective}`)
    if (b.estimatedFiles?.length) {
      lines.push('', `**Estimated files:** ${b.estimatedFiles.join(', ')}`)
    }
    lines.push('')
  })
  return lines.join('\n')
}

export async function runPlannerStep(input: PlannerInput): Promise<PlannerStepResult> {
  const skill = await loadPlannerSkill()
  const systemPrompt = buildPlannerSystemPrompt(skill, input)
  const userText = 'Produce the final JSON plan now.'

  const rawResult = await callClaude({
    role: 'planner',
    systemPrompt,
    userText,
    cwd: input.projectPath,
    model: 'sonnet',
    // Planner não escreve código, mas precisa explorar livremente.
    // Bash fica permitido (read-only por convenção: ls, find, cat, head,
    // tree) — sem ele o modelo não consegue enumerar diretórios de
    // forma ergonômica e acaba "advinhando" estrutura. Edit/Write
    // bloqueados garantem que ele não pode modificar arquivos.
    disallowedTools: ['Edit', 'Write', 'NotebookEdit', 'MultiEdit'],
    permissionMode: 'bypassPermissions',
    onChunk: input.onChunk,
  })

  const { plan, error } = parsePlannerOutput(rawResult.output)

  // Materializa plan.md em .team-handoff/ (audit trail) se o parse foi bem
  if (plan) {
    try {
      await writePlan(input.projectPath, planToMarkdown(plan, input.userMessage))
    } catch (err) {
      console.warn(`[planner] failed to write plan.md: ${(err as Error).message}`)
    }
  } else {
    // Parse failed — observability dump so we can see WHAT the model returned.
    // Pure logging: no behaviour change, run is still marked failed by the runner.
    const raw = rawResult.output ?? ''
    const head = raw.slice(0, 500)
    const tail = raw.length > 1000 ? raw.slice(-500) : ''
    console.warn(`[planner] PARSE FAILED error="${error}" rawBytes=${raw.length}`)
    console.warn(`[planner] raw HEAD (≤500B): ${head}`)
    if (tail) console.warn(`[planner] raw TAIL (≤500B): ${tail}`)
    try {
      const path = await writePlannerRawOutput(input.projectPath, raw)
      console.warn(`[planner] raw output dumped to: ${path}`)
    } catch (err) {
      console.warn(`[planner] failed to dump raw output: ${(err as Error).message}`)
    }
  }

  return {
    rawResult,
    plan,
    ...(error && { parseError: error }),
    systemPrompt,
    userText,
  }
}
