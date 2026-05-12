// Consolidator step — Phase 2 do Debug Workflow.
//
// Reads every detective's notes (passed verbatim in the prompt), merges
// overlapping findings, deduplicates, ranks evidence, and emits a single
// unified diagnostic document. That doc is what Architect uses to design
// the fix — Architect does NOT re-read detective notes.

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { callClaude } from '../shared/claude-cli'
import { writeConsolidatedFindings } from '../shared/artifacts'
import type { AgentStepResult, TranscriptChunk } from '../shared/types'

async function loadConsolidatorSkill(): Promise<string> {
  const path = join(process.cwd(), 'lib/workflows/debug/prompts/consolidator.md')
  return await fs.readFile(path, 'utf-8')
}

interface ConsolidatorInput {
  userMessage: string
  detectiveReports: Array<{ index: number; name: string; notes: string }>
  projectPath: string
  runId?: string
  onChunk?: (chunk: TranscriptChunk) => void
}

export interface ConsolidatorStepResult {
  rawResult: AgentStepResult
  outputPath?: string
  systemPrompt: string
  userText: string
}

function buildSystemPrompt(skill: string, input: ConsolidatorInput): { system: string; userText: string } {
  const sections: string[] = [
    skill,
    '',
    '---',
    '',
    '## Mission (bug)',
    input.userMessage,
    '',
    `## Detective reports (${input.detectiveReports.length})`,
    '',
  ]
  for (const r of input.detectiveReports) {
    sections.push(`### Detective ${r.index + 1}: ${r.name}`, '', r.notes, '')
  }
  const userText = 'Consolidate. Emit the unified findings markdown.'
  return { system: sections.join('\n'), userText }
}

export async function runConsolidatorStep(input: ConsolidatorInput): Promise<ConsolidatorStepResult> {
  const skill = await loadConsolidatorSkill()
  const { system, userText } = buildSystemPrompt(skill, input)

  const rawResult = await callClaude({
    role: 'consolidator',
    systemPrompt: system,
    userText,
    cwd: input.projectPath,
    model: 'sonnet',
    runId: input.runId,
    // Consolidator may re-read files to validate claims, never edits.
    disallowedTools: ['Edit', 'Write', 'NotebookEdit', 'MultiEdit'],
    permissionMode: 'bypassPermissions',
    onChunk: input.onChunk,
  })

  let outputPath: string | undefined
  if (rawResult.output && !rawResult.error) {
    try {
      outputPath = await writeConsolidatedFindings(input.projectPath, rawResult.output)
    } catch (err) {
      console.warn(`[consolidator] failed to write findings: ${(err as Error).message}`)
    }
  }

  return {
    rawResult,
    ...(outputPath && { outputPath }),
    systemPrompt: system,
    userText,
  }
}
