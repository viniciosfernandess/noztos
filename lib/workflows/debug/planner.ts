// Planner step — Phase 0 do Debug Workflow.
//
// Mesma estrutura geral do Builder planner: lê user task + chat context
// + repo snapshot, devolve XML estruturado. A diferença é o que cada
// <block> carrega: aqui um bloco descreve uma região (logical area +
// filesystem paths) que será atribuída a um Detetive. Todos os
// detetives rodam em paralelo no Phase 1 com a mesma missão (o bug do
// user).

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { callClaude } from '../shared/claude-cli'
import { writePlan, writePlannerRawOutput } from '../shared/artifacts'
import type {
  AgentStepResult,
  DebugPlannerOutput,
  TranscriptChunk,
  WorkflowMode,
} from '../shared/types'

async function loadDebugPlannerSkill(): Promise<string> {
  const path = join(process.cwd(), 'lib/workflows/debug/prompts/planner.md')
  return await fs.readFile(path, 'utf-8')
}

interface DebugPlannerInput {
  userMessage: string
  chatContextXml: string
  repoSnapshot: string
  mode: WorkflowMode
  projectPath: string
  runId?: string
  onChunk?: (chunk: TranscriptChunk) => void
}

export interface DebugPlannerStepResult {
  rawResult: AgentStepResult
  plan: DebugPlannerOutput | null
  parseError?: string
  systemPrompt: string
  userText: string
}

function buildSystemPrompt(skill: string, input: DebugPlannerInput): string {
  const sections: string[] = [
    skill,
    '',
    '---',
    '',
    '## User task (bug description)',
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

function extractTag(source: string, tag: string): string | null {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i')
  const m = source.match(re)
  return m ? m[1] : null
}

function extractAllBlocks(source: string): string[] {
  const re = /<block\b[^>]*>([\s\S]*?)<\/block>/gi
  const blocks: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(source)) !== null) blocks.push(m[1])
  return blocks
}

function parsePlannerOutput(raw: string, _userMessage: string): { plan: DebugPlannerOutput | null; error?: string } {
  const cleaned = raw
    .replace(/^[\s\S]*?```(?:xml)?\s*\n/, '')
    .replace(/\n```\s*$/, '')
    .trim()

  const planInner = extractTag(cleaned, 'plan') ?? cleaned
  const blockSources = extractAllBlocks(planInner)
  if (blockSources.length === 0) {
    return { plan: null, error: 'planner output has no <block> tags' }
  }
  const rationale = (extractTag(planInner, 'rationale') ?? '').trim()
  // The mission is a single planner-crafted hunt brief — shared by every
  // Detective. Required: without it the Detectives have nothing to hunt.
  const mission = (extractTag(planInner, 'mission') ?? '').trim()
  if (!mission) {
    return { plan: null, error: 'planner output missing <mission> tag' }
  }

  const blocks: DebugPlannerOutput['blocks'] = []
  for (let i = 0; i < blockSources.length; i++) {
    const src = blockSources[i]
    const name = (extractTag(src, 'name') ?? '').trim()
    const logicalArea = (extractTag(src, 'logical_area') ?? '').trim()
    const pathsRaw = (extractTag(src, 'paths') ?? '').trim()
    if (!name || !logicalArea || !pathsRaw) {
      return { plan: null, error: `detective ${i + 1} missing <name> / <logical_area> / <paths>` }
    }
    const paths = pathsRaw.split(/[,\n]/).map((s) => s.trim()).filter(Boolean)
    blocks.push({ name, logicalArea, paths, mission })
  }
  return { plan: { ...(rationale && { rationale }), blocks } }
}

function planToMarkdown(plan: DebugPlannerOutput, userMessage: string): string {
  const lines: string[] = [`# Debug Plan`, '', `## Bug`, userMessage, '']
  if (plan.rationale) lines.push(`## Rationale`, plan.rationale, '')
  lines.push(`## Detectives`, '')
  plan.blocks.forEach((b, i) => {
    lines.push(`### Detective ${i + 1}: ${b.name}`)
    lines.push('', `**Logical area:** ${b.logicalArea}`)
    lines.push('', `**Paths:** ${b.paths.join(', ')}`)
    lines.push('')
  })
  return lines.join('\n')
}

export async function runDebugPlannerStep(input: DebugPlannerInput): Promise<DebugPlannerStepResult> {
  const skill = await loadDebugPlannerSkill()
  const systemPrompt = buildSystemPrompt(skill, input)
  const userText = 'Emit the final XML plan now.'

  const rawResult = await callClaude({
    role: 'planner',
    systemPrompt,
    userText,
    cwd: input.projectPath,
    model: 'sonnet',
    runId: input.runId,
    // Planner reads code freely to figure out regions but never mutates.
    disallowedTools: ['Edit', 'Write', 'NotebookEdit', 'MultiEdit'],
    permissionMode: 'bypassPermissions',
    onChunk: input.onChunk,
  })

  const parsed = parsePlannerOutput(rawResult.output, input.userMessage)
  if (parsed.plan) {
    try { await writePlan(input.projectPath, planToMarkdown(parsed.plan, input.userMessage)) } catch { /* swallow */ }
  } else {
    try { await writePlannerRawOutput(input.projectPath, rawResult.output) } catch { /* swallow */ }
  }

  return {
    rawResult,
    plan: parsed.plan,
    ...(parsed.error && { parseError: parsed.error }),
    systemPrompt,
    userText,
  }
}
