// Architect step — Phase 3 (first stage of fix loop) do Debug Workflow.
//
// Receives the Consolidator's unified findings. Designs the minimum
// viable fix: which files change, what each change is, and why. Does NOT
// scope-creep into refactors. Output is a markdown plan that Builder
// applies verbatim.

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { callClaude } from '../shared/claude-cli'
import { writeDebugArchitectPlan } from '../shared/artifacts'
import type { AgentStepResult, TranscriptChunk } from '../shared/types'

async function loadDebugArchitectSkill(): Promise<string> {
  const path = join(process.cwd(), 'lib/workflows/debug/prompts/architect.md')
  return await fs.readFile(path, 'utf-8')
}

interface DebugArchitectInput {
  userMessage: string
  consolidatedFindings: string
  projectPath: string
  runId?: string
  // Quando isRetry: previous plan + rejection list
  isRetry?: boolean
  previousPlan?: string
  rejectionList?: string
  onChunk?: (chunk: TranscriptChunk) => void
}

export interface DebugArchitectStepResult {
  rawResult: AgentStepResult
  outputPath?: string
  systemPrompt: string
  userText: string
}

function buildSystemPrompt(skill: string, input: DebugArchitectInput): { system: string; userText: string } {
  // Architect works in isolation: skill (its role) + the consolidated
  // findings produced upstream. No user message, no chat context — the
  // findings document carries the bugs, locations, evidence, and
  // severity Architect needs to design the fix.
  const sections: string[] = [
    skill,
    '',
    '---',
    '',
    '## Consolidated findings (root cause + evidence)',
    input.consolidatedFindings,
    '',
  ]
  if (input.isRetry) {
    sections.push(
      '## RETRY CONTEXT',
      '',
      'Reviewer rejected your previous plan + the Builder execution.',
      'Iterate on the plan below — focus on what failed, do not restart.',
      '',
      '### Your previous plan',
      input.previousPlan ?? '(unavailable)',
      '',
      '### Rejection list from Reviewer',
      input.rejectionList ?? '(unavailable)',
      '',
    )
  }
  const userText = input.isRetry
    ? 'Emit the ADJUSTED markdown fix plan now, focused on the rejection points.'
    : 'Investigate any code references you need (Read/Grep/Glob) and emit the markdown fix plan.'
  return { system: sections.join('\n'), userText }
}

export async function runDebugArchitectStep(input: DebugArchitectInput): Promise<DebugArchitectStepResult> {
  const skill = await loadDebugArchitectSkill()
  const { system, userText } = buildSystemPrompt(skill, input)

  const rawResult = await callClaude({
    role: 'architect',
    systemPrompt: system,
    userText,
    cwd: input.projectPath,
    model: 'sonnet',
    runId: input.runId,
    disallowedTools: ['Edit', 'Write', 'NotebookEdit', 'MultiEdit'],
    permissionMode: 'bypassPermissions',
    onChunk: input.onChunk,
  })

  let outputPath: string | undefined
  if (rawResult.output && !rawResult.error) {
    try {
      outputPath = await writeDebugArchitectPlan(input.projectPath, rawResult.output)
    } catch (err) {
      console.warn(`[debug-architect] failed to write plan: ${(err as Error).message}`)
    }
  }

  return {
    rawResult,
    ...(outputPath && { outputPath }),
    systemPrompt: system,
    userText,
  }
}
