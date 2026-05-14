// Aggregate file paths edited across every step of a workflow run.
// Walks the live snapshot's transcript chunks, picks out tool_use
// frames for the file-mutating tools (Edit/Write/MultiEdit/etc.) and
// returns a deduped path list. Used by the task-bound finalization
// hook to write iteration.filesTouched and drive the "T" badge in
// the Changes list.
//
// We intentionally keep the source of truth as the transcript (not a
// separate accumulator on each step) because:
//   - the transcript already persists in WorkflowRun.progress, so a
//     restart-then-finalize would still find the data;
//   - we'd otherwise need to plumb a new field through every step's
//     return shape just for this lookup.

import type { RunSnapshot, StepState } from './types'

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit'])

export function extractFilesTouched(snapshot: RunSnapshot): string[] {
  const out = new Set<string>()
  const visit = (steps?: StepState[]) => {
    if (!steps) return
    for (const step of steps) {
      for (const chunk of step.transcript ?? []) {
        if (chunk.type !== 'tool_use' || !chunk.toolName) continue
        if (!EDIT_TOOLS.has(chunk.toolName)) continue
        const input = chunk.toolInput ?? {}
        // file_path covers Edit/Write/MultiEdit; notebook_path covers
        // NotebookEdit. Anything else and the tool didn't actually
        // target a file (or it's an unknown tool we shouldn't claim).
        const raw = (input as Record<string, unknown>).file_path
          ?? (input as Record<string, unknown>).notebook_path
        if (typeof raw === 'string' && raw.length > 0) out.add(raw)
      }
    }
  }
  if (snapshot.plannerStep) visit([snapshot.plannerStep])
  if (snapshot.surveyorStep) visit([snapshot.surveyorStep])
  if (snapshot.consolidatorStep) visit([snapshot.consolidatorStep])
  if (snapshot.parallelSteps) visit(snapshot.parallelSteps)
  if (snapshot.fixAttempts) visit(snapshot.fixAttempts)
  for (const block of snapshot.blocks ?? []) visit(block.steps)
  return [...out]
}
