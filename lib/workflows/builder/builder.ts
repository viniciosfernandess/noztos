// Builder step — executa o plano do Architect editando código de verdade.
//
// Único agent com Edit/Write/Bash. bypassPermissions ativo —
// o Builder age sem prompts interativos. Output captura o "report"
// markdown que o Builder escreve descrevendo o que fez.

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { callClaude } from '../shared/claude-cli'
import { writeBuilderReport } from '../shared/artifacts'
import type {
  AgentStepResult,
  PlannerBlock,
  TranscriptChunk,
  WorkflowMode,
} from '../shared/types'

async function loadBuilderSkill(): Promise<string> {
  const path = join(process.cwd(), 'lib/workflows/builder/prompts/builder.md')
  return await fs.readFile(path, 'utf-8')
}

interface BuilderInput {
  userMessage: string
  block: PlannerBlock
  blockIndex: number
  totalBlocks: number
  projectPath: string
  architectPlan: string          // verbatim do architect-plan.md (pra injetar no prompt)
  mode: WorkflowMode
  runId?: string
  isRetry?: boolean              // após reject — Architect já ajustou plano
  onChunk?: (chunk: TranscriptChunk) => void
}

export interface BuilderStepResult {
  rawResult: AgentStepResult
  outputPath?: string
  systemPrompt: string
  userText: string
}

function buildBuilderSystemPrompt(skill: string, input: BuilderInput): { system: string; userText: string } {
  // Builder works in strict isolation: skill (its role) + the Architect
  // plan it must execute. Nothing else. No user message, no block info —
  // the Architect already digested everything into the plan.
  const sections: string[] = [
    skill,
    '',
    '---',
    '',
    '## Plano do Architect (siga exato)',
    '',
    input.architectPlan,
    '',
  ]
  if (input.isRetry) {
    sections.push(
      '## RETRY',
      '',
      'Esta é uma execução pós-reject. O plano acima é a versão AJUSTADA',
      'do Architect. Estado do código reflete o que você fez na passagem',
      'anterior. Itere em cima do que existe — não desfaça tudo.',
      '',
    )
  }

  const userText = input.mode === 'ask'
    ? `Em modo ASK: NÃO escreva código. Em vez disso, explique em prosa como você implementaria conforme o plano. Output: report markdown descrevendo a abordagem proposta.`
    : `Execute o plano agora. Edite/crie arquivos via Edit/Write. Rode tests via Bash quando aplicável. Output: report markdown descrevendo o que você fez.`

  return { system: sections.join('\n'), userText }
}

export async function runBuilderStep(input: BuilderInput): Promise<BuilderStepResult> {
  const skill = await loadBuilderSkill()
  const { system, userText } = buildBuilderSystemPrompt(skill, input)

  // Em ask mode, Builder não pode editar.
  const editingTools = ['Edit', 'Write', 'NotebookEdit', 'MultiEdit', 'Bash']
  const disallowedTools = input.mode === 'ask' ? editingTools : []

  const rawResult = await callClaude({
    role: 'builder',
    systemPrompt: system,
    userText,
    cwd: input.projectPath,
    model: 'sonnet',
    runId: input.runId,
    ...(disallowedTools.length > 0 && { disallowedTools }),
    permissionMode: 'bypassPermissions',
    onChunk: input.onChunk,
  })

  let outputPath: string | undefined
  if (rawResult.output && !rawResult.error) {
    try {
      outputPath = await writeBuilderReport(input.projectPath, input.blockIndex, rawResult.output)
    } catch (err) {
      console.warn(`[builder] failed to write builder-report.md: ${(err as Error).message}`)
    }
  }

  return {
    rawResult,
    ...(outputPath && { outputPath }),
    systemPrompt: system,
    userText,
  }
}
