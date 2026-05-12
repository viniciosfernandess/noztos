// Builder step — Phase 3 (second stage of fix loop) do Debug Workflow.
//
// Applies the Architect's fix plan to the worktree. Edit/Write/Bash are
// open. Adds a regression test when the plan specifies. Output is a
// markdown report the Reviewer audits.

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { callClaude } from '../shared/claude-cli'
import { writeDebugBuilderReport } from '../shared/artifacts'
import type { AgentStepResult, TranscriptChunk, WorkflowMode } from '../shared/types'

async function loadDebugBuilderSkill(): Promise<string> {
  const path = join(process.cwd(), 'lib/workflows/debug/prompts/builder.md')
  return await fs.readFile(path, 'utf-8')
}

interface DebugBuilderInput {
  userMessage: string
  architectPlan: string
  consolidatedFindings: string
  projectPath: string
  mode: WorkflowMode
  runId?: string
  isRetry?: boolean
  onChunk?: (chunk: TranscriptChunk) => void
}

export interface DebugBuilderStepResult {
  rawResult: AgentStepResult
  outputPath?: string
  systemPrompt: string
  userText: string
}

function buildSystemPrompt(skill: string, input: DebugBuilderInput): { system: string; userText: string } {
  const sections: string[] = [
    skill,
    '',
    '---',
    '',
    '## User bug',
    input.userMessage,
    '',
    '## Consolidated findings (background)',
    input.consolidatedFindings,
    '',
    '## Architect fix plan (apply exactly)',
    input.architectPlan,
    '',
  ]
  if (input.isRetry) {
    sections.push(
      '## RETRY',
      '',
      'Post-reject execution. The plan above is the ADJUSTED version.',
      'Code state already reflects your prior edits — iterate on top.',
      '',
    )
  }
  const userText = input.mode === 'ask'
    ? 'In ASK mode: do NOT write code. Describe in prose how you would apply the fix. Output: markdown report.'
    : 'Apply the fix plan now via Edit/Write. Run tests via Bash when applicable. Output: markdown report.'
  return { system: sections.join('\n'), userText }
}

export async function runDebugBuilderStep(input: DebugBuilderInput): Promise<DebugBuilderStepResult> {
  const skill = await loadDebugBuilderSkill()
  const { system, userText } = buildSystemPrompt(skill, input)

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
      outputPath = await writeDebugBuilderReport(input.projectPath, rawResult.output)
    } catch (err) {
      console.warn(`[debug-builder] failed to write report: ${(err as Error).message}`)
    }
  }

  return {
    rawResult,
    ...(outputPath && { outputPath }),
    systemPrompt: system,
    userText,
  }
}
