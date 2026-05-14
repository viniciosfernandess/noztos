// Workflow → markdown summary builder.
//
// Produces a chronological recap of the agent hand-offs in a workflow
// run. Plants between (user, prompt) and (assistant, finalResponse) in
// chat_messages, and folds into the Claude `--resume` JSONL assistant
// turn, so any downstream reader (next workflow, next task, next chat
// turn with Claude) sees what each role wrote and passed on — not just
// the user-facing final summary.
//
// Design rules:
//   - **Full role outputs**, not fragments or headlines. The point is
//     to expose what was actually handed off agent → agent, in order.
//   - **No live logs**, no per-tool-call narration — only the
//     persistent artifact each role produced (`step.output` for
//     architect/builder, `block.summary` for reviewer, structured
//     plan for the planner).
//   - **Skip the final block's reviewer payload** — it's identical
//     to `snapshot.finalResponse`, which is already the next chat
//     row right after this summary. Re-emitting would duplicate.
//   - Workflow runner internals don't change — we only read from the
//     snapshot the runner already maintains in memory at finalize
//     time, and from WorkflowRun.progress if needed.

import type {
  RunSnapshot,
  PlannerOutput,
  DebugPlannerOutput,
  DetectiveBlock,
  PlannerBlock,
  StepState,
} from './types'

function isDebugPlan(plan: PlannerOutput | DebugPlannerOutput | undefined): plan is DebugPlannerOutput {
  if (!plan) return false
  const blocks = (plan as DebugPlannerOutput).blocks
  return Array.isArray(blocks) && blocks.length > 0 && 'mission' in blocks[0]
}

// Trim trailing/leading whitespace and ensure we don't emit empty
// sections. Returns null when the agent produced nothing meaningful
// so the caller can skip the heading.
function clean(text: string | undefined): string | null {
  const trimmed = (text ?? '').trim()
  return trimmed.length > 0 ? trimmed : null
}

function findStep(steps: StepState[] | undefined, role: string, status: 'completed' | 'failed' | 'running' = 'completed'): StepState | undefined {
  if (!steps) return undefined
  // Last matching step — covers retry loops where architect/builder/reviewer
  // may appear multiple times; we want the final attempt that landed.
  return [...steps].reverse().find((s) => s.role === role && s.status === status)
}

// ── /build summary ──────────────────────────────────────────────────

function buildBuilderSummary(snapshot: RunSnapshot): string {
  const parts: string[] = []
  parts.push(`### Builder workflow — ${snapshot.blocks.length} block${snapshot.blocks.length === 1 ? '' : 's'}`, '')

  // Planner block list — what the user message decomposed into.
  const plan = snapshot.plan as PlannerOutput | undefined
  if (plan?.blocks?.length) {
    parts.push('#### Planner — blocks identified', '')
    for (let i = 0; i < plan.blocks.length; i++) {
      const b = plan.blocks[i] as PlannerBlock
      parts.push(`**Block ${i + 1}: ${b.name}**`, b.objective)
      if (b.estimatedFiles?.length) parts.push(`_Estimated files: ${b.estimatedFiles.join(', ')}_`)
      parts.push('')
    }
  }

  // Per-block trail: architect plan → builder report → reviewer payload
  // (last attempt of each role). Final block's reviewer payload is
  // omitted because it equals `snapshot.finalResponse` (next chat row).
  for (let i = 0; i < snapshot.blocks.length; i++) {
    const block = snapshot.blocks[i]
    const isFinal = i === snapshot.blocks.length - 1
    const archOut = clean(findStep(block.steps, 'architect')?.output)
    const buildOut = clean(findStep(block.steps, 'builder')?.output)
    const reviewer = findStep(block.steps, 'reviewer')
    const decision = reviewer?.decision ?? block.status
    const rejects = block.rejectCount ?? 0

    parts.push(
      `---`,
      ``,
      `### Block ${i + 1}: ${block.name} (${decision}${rejects > 0 ? `, after ${rejects} reject${rejects === 1 ? '' : 's'}` : ''})`,
      ``,
    )
    if (archOut) {
      parts.push('#### Architect — plan', '', archOut, '')
    }
    if (buildOut) {
      parts.push('#### Builder — report', '', buildOut, '')
    }
    // Reviewer: include the per-block summary payload only for
    // intermediate blocks. Final block's summary == finalResponse,
    // which is the assistant chat row right after this one.
    if (!isFinal) {
      const reviewerPayload = clean(block.summary) ?? clean(reviewer?.output)
      if (reviewerPayload) {
        parts.push('#### Reviewer — block summary handed to next block', '', reviewerPayload, '')
      }
    } else {
      parts.push('_(Reviewer payload for the final block is the assistant message that follows.)_', '')
    }
  }

  return parts.join('\n').trim()
}

// ── /debug summary ──────────────────────────────────────────────────

function buildDebugSummary(snapshot: RunSnapshot): string {
  const parts: string[] = []
  parts.push('### Debug workflow', '')

  // Surveyor — explored the repo, wrote a structured study for the planner.
  const surveyor = snapshot.surveyorStep
  const surveyorReport = clean(snapshot.surveyorReport) ?? clean(surveyor?.output)
  if (surveyorReport) {
    parts.push('#### Surveyor — repo study handed to Planner', '', surveyorReport, '', '---', '')
  }

  // Planner — divided into detectives.
  const plan = snapshot.plan as DebugPlannerOutput | undefined
  if (plan?.blocks?.length) {
    parts.push(`#### Planner — ${plan.blocks.length} detective${plan.blocks.length === 1 ? '' : 's'} spawned`, '')
    for (let i = 0; i < plan.blocks.length; i++) {
      const b = plan.blocks[i] as DetectiveBlock
      parts.push(`**Detective ${i + 1}: ${b.name}** (${b.logicalArea})`)
      parts.push(`Paths: ${b.paths.join(', ')}`)
      parts.push(`Mission: ${b.mission}`, '')
    }
    parts.push('---', '')
  }

  // Each detective's investigation report — what they handed to the consolidator.
  if (snapshot.parallelSteps?.length) {
    parts.push(`#### Detective findings (parallel)`, '')
    for (let i = 0; i < snapshot.parallelSteps.length; i++) {
      const det = snapshot.parallelSteps[i]
      const out = clean(det.output)
      if (out) {
        parts.push(`**Detective ${i + 1} report:**`, '', out, '')
      }
    }
    parts.push('---', '')
  }

  // Consolidator — merged findings handed to the fix architect.
  const consolidator = snapshot.consolidatorStep
  const consolidated = clean(snapshot.consolidatedFindings) ?? clean(consolidator?.output)
  if (consolidated) {
    parts.push('#### Consolidator — merged findings handed to Architect', '', consolidated, '', '---', '')
  }

  // Fix loop: architect → builder → reviewer (× attempts). Same rule
  // as /build — final reviewer payload is the assistant chat row
  // that follows, so we don't repeat it here.
  if (snapshot.fixAttempts?.length) {
    parts.push('#### Fix loop', '')
    // Group by attempt. The fixAttempts array has roles interleaved in
    // chronological order; the last entry per role is what landed.
    const arch = findStep(snapshot.fixAttempts, 'architect')
    const build = findStep(snapshot.fixAttempts, 'builder')
    const reviewer = findStep(snapshot.fixAttempts, 'reviewer')
    const decision = reviewer?.decision ?? 'unknown'

    if (arch?.output) parts.push('**Architect — fix plan**', '', clean(arch.output) ?? '', '')
    if (build?.output) parts.push('**Builder — report**', '', clean(build.output) ?? '', '')
    parts.push(`**Reviewer decision: ${decision}**`)
    parts.push('_(Reviewer payload is the assistant message that follows.)_', '')
  }

  return parts.join('\n').trim()
}

// ── Public entry point ──────────────────────────────────────────────

export function buildWorkflowSummary(snapshot: RunSnapshot): string {
  const body = isDebugPlan(snapshot.plan) || snapshot.workflowType === 'debug'
    ? buildDebugSummary(snapshot)
    : buildBuilderSummary(snapshot)
  // Outer envelope — explicit framing so the next consumer (Claude on
  // resume, next workflow's Planner, task's downstream agent) can tell
  // this is a recap of the previous run, not the user's own words.
  return [
    '<workflow_internals>',
    body,
    '</workflow_internals>',
  ].join('\n')
}
