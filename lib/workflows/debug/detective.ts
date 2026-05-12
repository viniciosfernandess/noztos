// Detective step — Phase 1 do Debug Workflow. Runs N times in parallel.
//
// Each detective owns a single region (logical area + filesystem paths)
// assigned by the Planner, plus the bug description. It investigates
// independently and emits markdown notes — what was found and where —
// that the Consolidator will merge across all detectives.

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { callClaude } from '../shared/claude-cli'
import { writeDetectiveNotes } from '../shared/artifacts'
import type {
  AgentStepResult,
  DetectiveBlock,
  TranscriptChunk,
} from '../shared/types'

async function loadDetectiveSkill(): Promise<string> {
  const path = join(process.cwd(), 'lib/workflows/debug/prompts/detective.md')
  return await fs.readFile(path, 'utf-8')
}

interface DetectiveInput {
  userMessage: string
  block: DetectiveBlock
  detectiveIndex: number
  totalDetectives: number
  projectPath: string
  runId?: string
  onChunk?: (chunk: TranscriptChunk) => void
}

export interface DetectiveStepResult {
  rawResult: AgentStepResult
  outputPath?: string
  systemPrompt: string
  userText: string
}

function buildSystemPrompt(skill: string, input: DetectiveInput): { system: string; userText: string } {
  const { block } = input
  const sections: string[] = [
    skill,
    '',
    '---',
    '',
    '## Mission (bug)',
    block.mission,
    '',
    `## You are Detective ${input.detectiveIndex + 1}/${input.totalDetectives}`,
    '',
    `**Region:** ${block.name}`,
    '',
    `**Logical area:** ${block.logicalArea}`,
    '',
    `**Paths in your scope:**`,
    ...block.paths.map((p) => `- ${p}`),
    '',
  ]
  const userText = 'Investigate your region. Emit a markdown report with hypothesis, evidence (file:line), and confidence.'
  return { system: sections.join('\n'), userText }
}

export async function runDetectiveStep(input: DetectiveInput): Promise<DetectiveStepResult> {
  const skill = await loadDetectiveSkill()
  const { system, userText } = buildSystemPrompt(skill, input)

  const rawResult = await callClaude({
    role: 'detective',
    systemPrompt: system,
    userText,
    cwd: input.projectPath,
    model: 'sonnet',
    runId: input.runId,
    // Investigation only — no code changes. Bash stays open for ergonomic
    // enumeration (grep, find, head, etc).
    disallowedTools: ['Edit', 'Write', 'NotebookEdit', 'MultiEdit'],
    permissionMode: 'bypassPermissions',
    onChunk: input.onChunk,
  })

  let outputPath: string | undefined
  if (rawResult.output && !rawResult.error) {
    try {
      outputPath = await writeDetectiveNotes(input.projectPath, input.detectiveIndex, rawResult.output)
    } catch (err) {
      console.warn(`[detective] failed to write notes: ${(err as Error).message}`)
    }
  }

  return {
    rawResult,
    ...(outputPath && { outputPath }),
    systemPrompt: system,
    userText,
  }
}
