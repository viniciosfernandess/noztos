// Architect step — desenha plano de implementação pro Builder.
//
// Único agent com cross-block awareness: lê summaries dos blocks
// anteriores. Output é capturado pelo orquestrador, salvo como
// architect-plan.md no .team-handoff/ e injetado no prompt do Builder.

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { callClaude } from '../shared/claude-cli'
import { readPreviousSummaries, writeArchitectPlan } from '../shared/artifacts'
import type {
  AgentStepResult,
  PlannerBlock,
  PlannerOutput,
  TranscriptChunk,
} from '../shared/types'

async function loadArchitectSkill(): Promise<string> {
  const path = join(process.cwd(), 'lib/workflows/builder/prompts/architect.md')
  return await fs.readFile(path, 'utf-8')
}

interface ArchitectInput {
  userMessage: string
  plan: PlannerOutput
  block: PlannerBlock
  blockIndex: number
  totalBlocks: number
  projectPath: string
  runId?: string
  // Quando isRetry: previous plan + rejection list
  isRetry?: boolean
  previousPlan?: string          // architect-plan.md anterior verbatim
  rejectionList?: string         // rejection-list-N.md verbatim
  onChunk?: (chunk: TranscriptChunk) => void
}

export interface ArchitectStepResult {
  rawResult: AgentStepResult
  outputPath?: string
  systemPrompt: string
  userText: string
}

function buildPlanContext(plan: PlannerOutput, currentIndex: number, totalBlocks: number): string {
  const lines: string[] = ['## Workflow plan (all blocks)', '']
  plan.blocks.forEach((b, i) => {
    const marker = i < currentIndex ? '✓' : i === currentIndex ? '▶' : '◌'
    lines.push(`${marker} **Block ${i + 1}/${totalBlocks}: ${b.name}**`)
    lines.push(`   ${b.objective}`)
  })
  return lines.join('\n')
}

async function buildPreviousSummariesSection(projectPath: string, currentIndex: number): Promise<string> {
  if (currentIndex === 0) return ''
  const summaries = await readPreviousSummaries(projectPath, currentIndex)
  if (summaries.length === 0) return ''
  const lines: string[] = ['## Summaries dos blocks anteriores', '']
  for (const s of summaries) {
    lines.push(`### Block ${s.blockIndex + 1}`, s.content, '')
  }
  return lines.join('\n')
}

function buildRetryContext(input: ArchitectInput): string {
  if (!input.isRetry) return ''
  return `## RETRY CONTEXT — Você está sendo invocado de novo

Reviewer rejeitou seu plano anterior + a execução do Builder. Estado do
código já reflete o que Builder tentou (use Read pra ver). Sua tarefa:
gere um AJUSTE — não recomeça do zero, foca no que falhou.

### Plano que você produziu antes

${input.previousPlan ?? '(não disponível)'}

### Razões do reject (lista do Reviewer)

${input.rejectionList ?? '(não disponível)'}

### Instruction
Itere sobre o plano acima. Foque em corrigir os pontos apontados.
Builder vai ler seu novo plano e aplicar os ajustes em cima do código
que já está lá (não vai desfazer tudo).
`
}

async function buildArchitectSystemPrompt(skill: string, input: ArchitectInput): Promise<{ system: string; userText: string }> {
  const summaries = await buildPreviousSummariesSection(input.projectPath, input.blockIndex)
  const retry = buildRetryContext(input)

  // Architect works in strict isolation: skill (its role) + the Block
  // the Planner assigned + summaries from previous-block Reviewers (so
  // sequential blocks know what was already done). No user message, no
  // full plan context — those have been digested upstream by the Planner.
  const sections: string[] = [
    skill,
    '',
    '---',
    '',
  ]
  if (summaries) sections.push(summaries)
  sections.push(`## Block atual (sua vez)`, '', `**Block ${input.blockIndex + 1}: ${input.block.name}**`, '', `**Objective:** ${input.block.objective}`, '')
  if (input.block.estimatedFiles?.length) {
    sections.push(`**Estimated files:** ${input.block.estimatedFiles.join(', ')}`, '')
  }
  if (retry) sections.push(retry)

  const userText = input.isRetry
    ? `Produza o plano AJUSTADO em markdown agora, focado em corrigir os pontos do reject.`
    : `Investigue o código relevante (Read/Grep/Glob) e produza o plano detalhado em markdown.`

  return { system: sections.join('\n'), userText }
}

export async function runArchitectStep(input: ArchitectInput): Promise<ArchitectStepResult> {
  const skill = await loadArchitectSkill()
  const { system, userText } = await buildArchitectSystemPrompt(skill, input)

  const rawResult = await callClaude({
    role: 'architect',
    systemPrompt: system,
    userText,
    cwd: input.projectPath,
    model: 'sonnet',
    runId: input.runId,
    // Architect investiga livremente — Bash liberado pra enumeração
    // ergonômica (ls, find, cat, grep, head). Sem ele o modelo cai no
    // viés de Read seletivo e inventa "convenções novas" pra preencher
    // gaps do mapa mental. Edit/Write bloqueados garantem que ele não
    // pode modificar arquivos.
    disallowedTools: ['Edit', 'Write', 'NotebookEdit', 'MultiEdit'],
    permissionMode: 'bypassPermissions',
    onChunk: input.onChunk,
  })

  let outputPath: string | undefined
  if (rawResult.output && !rawResult.error) {
    try {
      outputPath = await writeArchitectPlan(input.projectPath, input.blockIndex, rawResult.output)
    } catch (err) {
      console.warn(`[architect] failed to write architect-plan.md: ${(err as Error).message}`)
    }
  }

  return {
    rawResult,
    ...(outputPath && { outputPath }),
    systemPrompt: system,
    userText,
  }
}
