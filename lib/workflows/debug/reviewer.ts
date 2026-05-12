// Reviewer step — Phase 3 (third stage of fix loop) do Debug Workflow.
//
// Audits the Builder's work against the Architect plan AND the Consolidator's
// findings (was the actual bug killed?). Same APPROVED/REJECT/FORCED_APPROVAL
// contract as Builder workflow — max 2 rejects, 3rd is forced approval.
//
// On APPROVED: writes the final response that lands in the chat. The
// Debug workflow always has a single fix loop, so its reviewer is always
// "final" — no intermediate summaries.

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { callClaude } from '../shared/claude-cli'
import { writeDebugFinalResponse, writeDebugRejectionList } from '../shared/artifacts'
import type { AgentStepResult, TranscriptChunk } from '../shared/types'

async function loadDebugReviewerSkill(): Promise<string> {
  const path = join(process.cwd(), 'lib/workflows/debug/prompts/reviewer.md')
  return await fs.readFile(path, 'utf-8')
}

interface DebugReviewerInput {
  userMessage: string
  consolidatedFindings: string
  architectPlan: string
  builderReport: string
  attempt: number
  projectPath: string
  runId?: string
  previousRejections?: Array<{ attempt: number; content: string }>
  onChunk?: (chunk: TranscriptChunk) => void
}

export type ReviewerDecision = 'APPROVED' | 'REJECT' | 'FORCED_APPROVAL'

export interface DebugReviewerStepResult {
  rawResult: AgentStepResult
  decision: ReviewerDecision | null
  payload: string
  parseError?: string
  outputPath?: string
  systemPrompt: string
  userText: string
}

function parseReviewerOutput(raw: string): { decision: ReviewerDecision | null; payload: string; error?: string } {
  const decisionMatch = raw.match(/<review_decision>\s*(APPROVED|REJECT|FORCED_APPROVAL)\s*<\/review_decision>/i)
  if (!decisionMatch) return { decision: null, payload: raw, error: 'no <review_decision> tag found' }
  const decision = decisionMatch[1].toUpperCase() as ReviewerDecision
  const payloadMatch = raw.match(/<review_payload>([\s\S]*?)<\/review_payload>/i)
  const payload = payloadMatch ? payloadMatch[1].trim() : ''
  if (!payload) return { decision, payload: '', error: 'no <review_payload> tag found' }
  return { decision, payload }
}

function buildSystemPrompt(skill: string, input: DebugReviewerInput): { system: string; userText: string } {
  const sections: string[] = [
    skill,
    '',
    '---',
    '',
    '## User bug',
    input.userMessage,
    '',
    '## Consolidated findings (what was diagnosed)',
    input.consolidatedFindings,
    '',
    '## Architect fix plan',
    input.architectPlan,
    '',
    '## Builder report',
    input.builderReport,
    '',
  ]
  if (input.attempt >= 3) {
    sections.push(
      '<review_context attempt="3" forced="true">',
      '',
      'This is the 3rd review for this fix. Architect + Builder already',
      'iterated twice. APPROVE with FORCED_APPROVAL. List unresolved',
      'issues in the payload so the user can address them manually.',
      '',
    )
    if (input.previousRejections?.length) {
      sections.push('### Reject history:', '')
      for (const r of input.previousRejections) {
        sections.push(`#### Reject #${r.attempt}`, r.content, '')
      }
    }
    sections.push('</review_context>')
  } else if (input.attempt > 1) {
    sections.push(
      `<review_context attempt="${input.attempt}">`,
      `${input.attempt}th review. You may approve or reject once more.`,
      'Next reject (3rd) forces approval.',
      '</review_context>',
      '',
    )
    if (input.previousRejections?.length) {
      sections.push('### Reject history:', '')
      for (const r of input.previousRejections) {
        sections.push(`#### Reject #${r.attempt}`, r.content, '')
      }
    }
  }

  const userText = 'Audit the fix. Output XML starting with <review_decision>.'
  return { system: sections.join('\n'), userText }
}

export async function runDebugReviewerStep(input: DebugReviewerInput): Promise<DebugReviewerStepResult> {
  const skill = await loadDebugReviewerSkill()
  const { system, userText } = buildSystemPrompt(skill, input)

  const rawResult = await callClaude({
    role: 'reviewer',
    systemPrompt: system,
    userText,
    cwd: input.projectPath,
    model: 'sonnet',
    runId: input.runId,
    disallowedTools: ['Edit', 'Write', 'NotebookEdit', 'MultiEdit'],
    permissionMode: 'bypassPermissions',
    onChunk: input.onChunk,
  })

  const { decision, payload, error } = parseReviewerOutput(rawResult.output)

  let effectiveDecision: ReviewerDecision | null = decision
  if (input.attempt >= 3 && decision !== 'FORCED_APPROVAL') {
    if (decision === 'APPROVED' || decision === 'REJECT') {
      console.warn(`[debug-reviewer] attempt=3 returned ${decision}, forcing FORCED_APPROVAL`)
      effectiveDecision = 'FORCED_APPROVAL'
    }
  }

  let outputPath: string | undefined
  if (effectiveDecision && payload) {
    try {
      if (effectiveDecision === 'REJECT') {
        outputPath = await writeDebugRejectionList(input.projectPath, input.attempt, payload)
      } else {
        // Approved or forced approval — always final response for /debug
        outputPath = await writeDebugFinalResponse(input.projectPath, payload)
      }
    } catch (err) {
      console.warn(`[debug-reviewer] failed to write artifact: ${(err as Error).message}`)
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
