// Reviewer step — audita Architect plan + Builder report + estado do
// código. Decide APPROVED ou REJECT (max 2 rejects → FORCED_APPROVAL na 3ª).
//
// Output em XML estruturado: <review_decision> + <review_payload>.
// Orquestrador parseia, escreve summary.md ou rejection-list-N.md
// conforme decisão.
//
// Caso especial — último block: prompt instrui Reviewer a escrever
// resposta final pro user (em vez de summary técnico). Recebe excecionalmente
// summaries dos blocks anteriores.

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { callClaude } from '../shared/claude-cli'
import {
  readPreviousSummaries,
  writeFinalResponse,
  writeRejectionList,
  writeSummary,
} from '../shared/artifacts'
import type {
  AgentStepResult,
  PlannerBlock,
  TranscriptChunk,
} from '../shared/types'

async function loadReviewerSkill(): Promise<string> {
  const path = join(process.cwd(), 'lib/workflows/builder/prompts/reviewer.md')
  return await fs.readFile(path, 'utf-8')
}

interface ReviewerInput {
  userMessage: string
  block: PlannerBlock
  blockIndex: number
  totalBlocks: number
  projectPath: string
  architectPlan: string             // verbatim
  builderReport: string             // verbatim
  attempt: number                   // 1 = first review, 2 = after 1 reject, 3 = forced
  isFinalBlock: boolean             // se true, escreve final response
  runId?: string
  // Histórico de rejection lists nesta sessão de review (pra attempt=3)
  previousRejections?: Array<{ attempt: number; content: string }>
  onChunk?: (chunk: TranscriptChunk) => void
}

export type ReviewerDecision = 'APPROVED' | 'REJECT' | 'FORCED_APPROVAL'

export interface ReviewerStepResult {
  rawResult: AgentStepResult
  decision: ReviewerDecision | null
  payload: string                   // o conteúdo entre <review_payload>...</review_payload>
  parseError?: string
  outputPath?: string               // path do summary.md OU rejection-list-N.md OU final-response.md
  systemPrompt: string
  userText: string
}

function parseReviewerOutput(raw: string): { decision: ReviewerDecision | null; payload: string; error?: string } {
  // Look for <review_decision>...</review_decision>
  const decisionMatch = raw.match(/<review_decision>\s*(APPROVED|REJECT|FORCED_APPROVAL)\s*<\/review_decision>/i)
  if (!decisionMatch) return { decision: null, payload: raw, error: 'no <review_decision> tag found' }
  const decision = decisionMatch[1].toUpperCase() as ReviewerDecision
  // Payload (everything between <review_payload>...</review_payload>)
  const payloadMatch = raw.match(/<review_payload>([\s\S]*?)<\/review_payload>/i)
  const payload = payloadMatch ? payloadMatch[1].trim() : ''
  if (!payload) return { decision, payload: '', error: 'no <review_payload> tag found' }
  return { decision, payload }
}

async function buildReviewerSystemPrompt(skill: string, input: ReviewerInput): Promise<{ system: string; userText: string }> {
  // Reviewer works in strict isolation: skill (its role) + the two
  // artifacts under judgment — Architect plan (what should have been
  // done) and Builder report (what was done). No user message, no
  // block info. The exception is the final block, which gets prior
  // summaries to write the user-facing final response.
  const sections: string[] = [
    skill,
    '',
    '---',
    '',
    '## Plano do Architect',
    '',
    input.architectPlan,
    '',
    '## Report do Builder',
    '',
    input.builderReport,
    '',
  ]

  // Final block exception — receives previous summaries
  if (input.isFinalBlock) {
    const prevSummaries = await readPreviousSummaries(input.projectPath, input.blockIndex)
    if (prevSummaries.length > 0) {
      sections.push('## Summaries dos blocks anteriores (somente pra última resposta)', '')
      for (const s of prevSummaries) {
        sections.push(`### Block ${s.blockIndex + 1}`, s.content, '')
      }
    }
    sections.push(
      '<final_block>true</final_block>',
      '',
      'Este é o ÚLTIMO block do workflow. Em vez de summary técnico,',
      'escreva a RESPOSTA FINAL pro user no chat. Use os summaries acima',
      'pra contar a história completa do que foi feito ao longo do workflow.',
      '',
    )
  }

  // 3rd review forced approval
  if (input.attempt >= 3) {
    sections.push(
      '<review_context attempt="3" forced="true">',
      '',
      'Esta é a 3ª revisão deste block. Architect e Builder já tentaram',
      'duas vezes. APROVE este block. Use status FORCED_APPROVAL no',
      '<review_decision>. No payload, liste as issues remanescentes pro',
      'user revisar manualmente.',
      '',
    )
    if (input.previousRejections?.length) {
      sections.push('### Histórico de rejects:', '')
      for (const r of input.previousRejections) {
        sections.push(`#### Reject #${r.attempt}`, r.content, '')
      }
    }
    sections.push('</review_context>')
  } else if (input.attempt > 1) {
    // attempt 2: not forced, still can reject
    sections.push(
      `<review_context attempt="${input.attempt}">`,
      `Esta é a ${input.attempt}ª revisão. Você pode aprovar ou rejeitar uma`,
      'vez mais. Próximo reject (3º) força aprovação.',
      '</review_context>',
      '',
    )
    if (input.previousRejections?.length) {
      sections.push('### Histórico de rejects:', '')
      for (const r of input.previousRejections) {
        sections.push(`#### Reject #${r.attempt}`, r.content, '')
      }
    }
  }

  const userText = `Audite o trabalho. Output em XML estruturado começando com <review_decision>.`

  return { system: sections.join('\n'), userText }
}

export async function runReviewerStep(input: ReviewerInput): Promise<ReviewerStepResult> {
  const skill = await loadReviewerSkill()
  const { system, userText } = await buildReviewerSystemPrompt(skill, input)

  const rawResult = await callClaude({
    role: 'reviewer',
    systemPrompt: system,
    userText,
    cwd: input.projectPath,
    model: 'sonnet',
    runId: input.runId,
    // Reviewer audita livremente — Bash liberado pra enumeração (ls,
    // find, cat, grep, head). Sem ele cai no mesmo viés de Read seletivo
    // que escapa de detalhes do projeto. Edit/Write bloqueados garantem
    // que ele não pode modificar arquivos durante a auditoria.
    disallowedTools: ['Edit', 'Write', 'NotebookEdit', 'MultiEdit'],
    permissionMode: 'bypassPermissions',
    onChunk: input.onChunk,
  })

  const { decision, payload, error } = parseReviewerOutput(rawResult.output)

  // Forced approval safety net: if attempt=3, treat any non-error decision as FORCED_APPROVAL
  let effectiveDecision: ReviewerDecision | null = decision
  if (input.attempt >= 3 && decision !== 'FORCED_APPROVAL') {
    if (decision === 'APPROVED' || decision === 'REJECT') {
      console.warn(`[reviewer] attempt=3 returned ${decision}, forcing FORCED_APPROVAL`)
      effectiveDecision = 'FORCED_APPROVAL'
    }
  }

  // Persist artifact
  let outputPath: string | undefined
  if (effectiveDecision && payload) {
    try {
      if (effectiveDecision === 'REJECT') {
        outputPath = await writeRejectionList(input.projectPath, input.blockIndex, input.attempt, payload)
      } else if (input.isFinalBlock) {
        // APPROVED or FORCED_APPROVAL on last block → final-response
        outputPath = await writeFinalResponse(input.projectPath, input.blockIndex, payload)
      } else {
        // intermediate block approved → summary
        outputPath = await writeSummary(input.projectPath, input.blockIndex, payload)
      }
    } catch (err) {
      console.warn(`[reviewer] failed to write artifact: ${(err as Error).message}`)
    }
  }

  return {
    rawResult,
    decision: effectiveDecision,
    payload,
    ...(error && { parseError: error }),
    ...(outputPath && { outputPath }),
    systemPrompt: system,
    userText,
  }
}
