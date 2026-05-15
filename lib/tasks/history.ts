// Task history serializer + budget truncator.
//
// Treats a task as its own thread (like a chat session): every
// iteration becomes a "turn" inside <task_history>, in chronological
// order. Workflow iterations carry the full per-role hand-off via
// <workflow_internals> — same shape buildWorkflowSummary produces for
// chat-driven workflows — so a chained task downstream sees not just
// "what came out" but also "how it was built". Skill iterations are
// simpler: prompt + result.
//
// On fork (from-task), the new task's contextSnapshot is:
//
//   parent.contextSnapshot  +  serializeTaskHistory(parent)
//
// Because each parent's contextSnapshot ALREADY contains its own
// ancestors' task_history blocks (recursive append), the chain is
// transitively complete with a single concatenation. The chat_context
// base at the very top stays untouched on every fork.
//
// truncateToBudget enforces a soft cap on the resulting snapshot. The
// chat_context base is always preserved; task_history blocks are
// dropped oldest-first until the total fits. This keeps deep chains
// useful (recent transitions stay) without runaway growth.

import { prisma } from '@/lib/db'
import { buildWorkflowSummary } from '@/lib/workflows/shared/summary'
import type { RunSnapshot } from '@/lib/workflows/shared/types'

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttr(s: string): string {
  return escapeXml(s).replace(/"/g, '&quot;')
}

interface IterationLike {
  iterationNumber: number
  instruction: string
  executorKind: string
  executorId: string
  chatMode: string
  status: string
  fullOutput: string | null
  outputSummary: string | null
  workflowRunId: string | null
  finishedAt: Date | null
}

/**
 * Render a task as a chat-like thread XML. Each completed iteration
 * becomes one <iteration> element. Workflow iterations are enriched
 * with <workflow_internals> pulled from the linked WorkflowRun's
 * progress snapshot (same buildWorkflowSummary the chat workflow
 * pipeline uses, so the format is shape-identical).
 *
 * Pulling iterations is the caller's responsibility — we accept them
 * pre-loaded so the caller can decide ordering / filtering. Typical
 * caller: from-task fork, with `iterations` = all completed in
 * iterationNumber asc order.
 */
export async function serializeTaskHistory(
  task: { id: string; name: string },
  iterations: IterationLike[],
): Promise<string> {
  if (iterations.length === 0) {
    console.log(`[task-history] task=${task.id.slice(0, 8)} no iterations to serialize`)
    return ''
  }
  const completedCount = iterations.filter((it) => it.status === 'completed').length

  // Pre-fetch every workflow run referenced by the iterations in one
  // round-trip so the loop below doesn't N+1 the DB. Skill iterations
  // skip this entirely.
  const workflowRunIds = iterations
    .filter((it) => it.executorKind === 'workflow' && it.workflowRunId)
    .map((it) => it.workflowRunId!)
  const runById = workflowRunIds.length > 0
    ? new Map(
        (await prisma.workflowRun.findMany({
          where: { id: { in: workflowRunIds } },
          select: { id: true, progress: true },
        })).map((r) => [r.id, r.progress]),
      )
    : new Map<string, unknown>()
  console.log(`[task-history] task=${task.id.slice(0, 8)} iters=${iterations.length} completed=${completedCount} workflowRefs=${workflowRunIds.length} runsLoaded=${runById.size}`)

  const lines: string[] = []
  lines.push(`<task_history task_id="${escapeAttr(task.id)}" name="${escapeAttr(task.name)}">`)
  let serializedCount = 0
  let internalsEmbedded = 0
  for (const iter of iterations) {
    if (iter.status !== 'completed') continue   // skip running / failed / cancelled
    serializedCount++
    const attrs = [
      `number="${iter.iterationNumber}"`,
      `executor="${escapeAttr(`${iter.executorKind}/${iter.executorId}`)}"`,
      `mode="${escapeAttr(iter.chatMode)}"`,
      `finishedAt="${escapeAttr(iter.finishedAt?.toISOString() ?? '')}"`,
    ].join(' ')
    lines.push(`  <iteration ${attrs}>`)
    lines.push(`    <prompt>${escapeXml(iter.instruction)}</prompt>`)

    // Workflow iteration → embed the same per-role recap we plant
    // between user prompt and final response in the chat. Lets a
    // downstream task see the planner's blocks, each detective's
    // findings, the consolidator's unification, the fix loop — the
    // texture that the user-facing summary alone strips out.
    if (iter.executorKind === 'workflow' && iter.workflowRunId) {
      const progress = runById.get(iter.workflowRunId)
      if (progress) {
        try {
          const summary = buildWorkflowSummary(progress as RunSnapshot)
          // Indent each line of the summary so the XML stays readable.
          const indented = summary.split('\n').map((l) => `    ${l}`).join('\n')
          lines.push(indented)
          internalsEmbedded++
        } catch (err) {
          // Defensive — a stale or malformed RunSnapshot shouldn't
          // block the fork. Log + fall through with no internals.
          console.warn(`[task-history] buildWorkflowSummary failed for run=${iter.workflowRunId.slice(0, 8)}: ${(err as Error).message}`)
        }
      }
    }

    const result = iter.fullOutput ?? iter.outputSummary ?? ''
    lines.push(`    <result>${escapeXml(result)}</result>`)
    lines.push(`  </iteration>`)
  }
  lines.push(`</task_history>`)
  const result = lines.join('\n')
  console.log(`[task-history] task=${task.id.slice(0, 8)} serialized=${serializedCount} workflowInternalsEmbedded=${internalsEmbedded} bytes=${result.length}`)
  return result
}

const TASK_HISTORY_OPEN = '<task_history'
const TASK_HISTORY_CLOSE = '</task_history>'
const CHAT_CONTEXT_CLOSE = '</chat_context>'

/**
 * Soft cap on contextSnapshot size. Keeps the chat_context base intact
 * (it's the origin everyone needs to reason from); drops oldest
 * task_history blocks until the total fits. Newest history stays —
 * that's the most useful to a chained agent. Returns the original
 * string when already under budget.
 */
export function truncateToBudget(snapshot: string, maxBytes: number): string {
  if (snapshot.length <= maxBytes) {
    console.log(`[task-history/truncate] under budget bytes=${snapshot.length} max=${maxBytes}`)
    return snapshot
  }

  // Anchor on the chat_context closing tag. If the snapshot doesn't
  // contain one (shouldn't happen with current writers, but defensive),
  // fall back to a hard slice.
  const chatEnd = snapshot.indexOf(CHAT_CONTEXT_CLOSE)
  if (chatEnd === -1) {
    console.warn(`[task-history/truncate] no chat_context closer — hard slice fallback`)
    return snapshot.slice(0, maxBytes)
  }
  const baseEnd = chatEnd + CHAT_CONTEXT_CLOSE.length
  const base = snapshot.slice(0, baseEnd)
  const rest = snapshot.slice(baseEnd)

  // Slice out every <task_history>...</task_history> block in order.
  const blocks: string[] = []
  let cursor = 0
  while (cursor < rest.length) {
    const open = rest.indexOf(TASK_HISTORY_OPEN, cursor)
    if (open === -1) break
    const close = rest.indexOf(TASK_HISTORY_CLOSE, open)
    if (close === -1) break
    const blockEnd = close + TASK_HISTORY_CLOSE.length
    blocks.push(rest.slice(open, blockEnd))
    cursor = blockEnd
  }
  const initialBlockCount = blocks.length

  // Drop oldest blocks until under budget — BUT always keep at least
  // the most recent block. Losing the immediate parent's transition
  // defeats the entire purpose of chaining; a snapshot slightly over
  // budget is better than one with zero memory of where it came from.
  // The "deep chain over budget" path is rare (5+ workflow links);
  // when it happens, we accept the overshoot in exchange for the
  // invariant.
  const sep = '\n\n'
  const assemble = () => `${base}${blocks.length > 0 ? sep + blocks.join(sep) : ''}`
  while (blocks.length > 1 && assemble().length > maxBytes) {
    blocks.shift()
  }
  const finalAssembled = assemble()
  const overshoot = finalAssembled.length > maxBytes
  console.log(`[task-history/truncate] over budget bytes=${snapshot.length} max=${maxBytes} blocksBefore=${initialBlockCount} blocksAfter=${blocks.length} finalBytes=${finalAssembled.length}${overshoot ? ' OVERSHOOT (last block preserved)' : ''}`)
  return finalAssembled
}
