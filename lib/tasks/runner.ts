// Task runner — executes a TaskIteration on the task's worktree.
//
// Each iteration corresponds to one user-instigated run (Run now, or a
// scheduled fire). The runner:
//   1. Creates the TaskIteration row (status=running, iterationNumber +1)
//   2. Flips Task.status to running
//   3. Builds a per-iteration system prompt = skill md + frozen
//      contextSnapshot + accumulated prior iterations + current
//      instruction
//   4. Spawns Claude (skill kind) or starts a workflow run (workflow
//      kind) with that prompt + the right tool restrictions for chat
//      mode
//   5. Streams chunks through the existing companion-relay so the
//      running side area in TasksPanel renders the live transcript
//   6. On completion, persists iteration output/files/duration and
//      moves Task back to a terminal state (done | failed)
//
// Workflow kind: the workflow starters (startBuilderWorkflow /
// startDebugWorkflow) historically built their own chat context via
// Bridge IN. For a task-bound run there is no chat — only the frozen
// snapshot — so we pass `overrideChatContext` and the workflow runner
// skips Bridge IN entirely. The workflow's own audit trail (its own
// WorkflowRun row) is linked back into the TaskIteration so the user
// can drill into the per-role transcripts from the task view.

import { prisma } from '@/lib/db'
import { getChannel } from '@/lib/companion-relay'
import { callClaude } from '@/lib/workflows/shared/claude-cli'
import { startBuilderWorkflow } from '@/lib/workflows/builder/runner'
import { startDebugWorkflow } from '@/lib/workflows/debug/runner'
import type { TranscriptChunk, WorkflowType } from '@/lib/workflows/shared/types'

interface TriggerInput {
  taskId: string
  instruction: string
  executorKind: 'workflow' | 'skill'
  executorId: string
  chatMode: 'agent' | 'plan' | 'ask'
}

/**
 * Schedule an iteration to execute. Validates inputs, creates the row,
 * fires the actual run as a background promise, and returns once the
 * iteration is registered (not when it finishes). The caller (the /run
 * API) returns its 202 immediately after this resolves.
 */
export async function triggerTaskIteration(input: TriggerInput): Promise<{ iterationId: string; iterationNumber: number }> {
  if (input.executorKind === 'workflow' && input.chatMode !== 'agent') {
    throw new Error('Workflow tasks must run in agent mode')
  }

  const task = await prisma.task.findUnique({
    where: { id: input.taskId },
    select: {
      id: true,
      projectId: true,
      worktreeId: true,
      userId: true,
      name: true,
      status: true,
      contextSnapshot: true,
      iterations: {
        orderBy: { iterationNumber: 'desc' },
        take: 1,
        select: { iterationNumber: true },
      },
    },
  })
  if (!task) throw new Error('Task not found')
  if (task.status === 'running') {
    throw new Error('Task is already running')
  }

  const nextNumber = (task.iterations[0]?.iterationNumber ?? 0) + 1
  console.log(`[task-runner] trigger taskId=${task.id.slice(0, 8)} iter#${nextNumber} kind=${input.executorKind}/${input.executorId} mode=${input.chatMode} worktree=${task.worktreeId.slice(0, 8)}`)

  const iteration = await prisma.taskIteration.create({
    data: {
      taskId: input.taskId,
      iterationNumber: nextNumber,
      instruction: input.instruction,
      executorKind: input.executorKind,
      executorId: input.executorId,
      chatMode: input.chatMode,
      status: 'running',
      startedAt: new Date(),
    },
    select: { id: true, iterationNumber: true },
  })

  await prisma.task.update({
    where: { id: input.taskId },
    data: {
      status: 'running',
      // Reset the done-review marker. The card flips back to amber when
      // this iteration completes, signaling the user has new output to
      // look at — they can't lose track of a re-run's outcome.
      reviewedAt: null,
    },
  })
  console.log(`[task-runner] ▶ iteration row created id=${iteration.id.slice(0, 8)} task→running`)

  // Kick off execution in the background. The /run API doesn't await
  // this — the iteration just appears in the running side area and
  // the user follows it live via the relay-driven transcript.
  void runIteration(task, iteration.id, input).catch(async (err) => {
    console.error(`[task-runner] iteration ${iteration.id} crashed:`, err)
    await failIteration(input.taskId, iteration.id, (err as Error).message).catch(() => {})
  })

  return { iterationId: iteration.id, iterationNumber: iteration.iterationNumber }
}

async function runIteration(
  task: { id: string; projectId: string; worktreeId: string; userId: string; name: string; contextSnapshot: string },
  iterationId: string,
  input: TriggerInput,
): Promise<void> {
  console.log(`[task-runner] dispatch taskId=${task.id.slice(0, 8)} iter=${iterationId.slice(0, 8)} → ${input.executorKind}`)
  if (input.executorKind === 'skill') {
    await runSkillIteration(task, iterationId, input)
    return
  }
  if (input.executorKind === 'workflow') {
    await runWorkflowIteration(task, iterationId, input)
    return
  }
  throw new Error(`Unknown executorKind: ${input.executorKind}`)
}

// ── Skill path ───────────────────────────────────────────────────────

async function runSkillIteration(
  task: { id: string; projectId: string; worktreeId: string; userId: string; name: string; contextSnapshot: string },
  iterationId: string,
  input: TriggerInput,
): Promise<void> {
  const tag = `[task-runner/skill] task=${task.id.slice(0, 8)} iter=${iterationId.slice(0, 8)}`
  const skillMd = await loadSkillMd(input.executorId)
  if (!skillMd) {
    console.warn(`${tag} ✗ skill not found id="${input.executorId}"`)
    await failIteration(task.id, iterationId, `Skill not found: ${input.executorId}`)
    return
  }
  console.log(`${tag} skill loaded id="${input.executorId}" mdBytes=${skillMd.length}`)

  const worktreePath = await resolveWorktreePath(task.worktreeId)
  if (!worktreePath) {
    console.warn(`${tag} ✗ worktree path unresolved worktreeId=${task.worktreeId.slice(0, 8)}`)
    await failIteration(task.id, iterationId, 'Worktree path could not be resolved')
    return
  }
  console.log(`${tag} worktree resolved path=${worktreePath}`)

  const priorIterations = await prisma.taskIteration.findMany({
    where: { taskId: task.id, id: { not: iterationId } },
    orderBy: { iterationNumber: 'asc' },
    select: {
      iterationNumber: true,
      instruction: true,
      executorKind: true,
      executorId: true,
      chatMode: true,
      outputSummary: true,
      filesTouched: true,
      status: true,
    },
  })

  const systemPrompt = buildTaskSystemPrompt(skillMd, task, priorIterations)
  console.log(`${tag} system prompt built bytes=${systemPrompt.length} priorIterations=${priorIterations.length} contextBytes=${task.contextSnapshot.length}`)
  const channel = getChannel(task.userId)
  const transcript: TranscriptChunk[] = []
  const onChunk = (chunk: TranscriptChunk) => {
    transcript.push(chunk)
    try {
      channel.pushEvent({
        type: 'task_iteration_chunk',
        payload: {
          bornastarSessionId: task.id,   // tasks reuse user channels keyed by taskId for now
          taskId: task.id,
          iterationId,
          chunk,
        },
      } as Parameters<typeof channel.pushEvent>[0], task.userId)
    } catch {/* relay failures never block the agent */}
  }

  const disallowed = chatModeDisallowedTools(input.chatMode)
  const startedAt = Date.now()
  console.log(`${tag} ▶ callClaude starting mode=${input.chatMode} disallowed=${disallowed.length}`)
  const result = await callClaude({
    role: 'builder', // semantic placeholder; the role label isn't load-bearing for skills
    systemPrompt,
    userText: input.instruction,
    cwd: worktreePath,
    model: 'sonnet',
    disallowedTools: disallowed,
    permissionMode: 'bypassPermissions',
    onChunk,
  })
  const elapsedMs = Date.now() - startedAt
  console.log(`${tag} ◀ callClaude returned elapsed=${elapsedMs}ms outputBytes=${result.output?.length ?? 0} toolCalls=${result.toolCalls.length} error=${result.error ?? 'none'}`)

  if (result.error) {
    await failIteration(task.id, iterationId, result.error)
    return
  }

  const filesTouched = extractEditedFiles(result.toolCalls)
  await prisma.taskIteration.update({
    where: { id: iterationId },
    data: {
      status: 'completed',
      finishedAt: new Date(),
      outputSummary: summarizeOutput(result.output),
      fullOutput: result.output,
      filesTouched,
    },
  })
  // Track every file the task wrote to so the Changes list can mark
  // them with the "T" badge until the user commits. The commit
  // endpoint clears this back to [].
  await markWorktreeTouched(task.worktreeId, filesTouched)
  await prisma.task.update({
    where: { id: task.id },
    data: { status: 'done' },
  })
  console.log(`${tag} ✓ COMPLETED filesTouched=${filesTouched.length}${filesTouched.length ? ' paths=[' + filesTouched.join(', ') + ']' : ''} task→done`)
}

// ── Workflow path ────────────────────────────────────────────────────
//
// Workflows historically build their own chat context via Bridge IN.
// For a task-bound run we hand them the task's frozen snapshot via
// `overrideChatContext` and tag the run with `taskContext` so the final
// response lands on the TaskIteration row instead of being posted back
// to a chat thread. The workflow's own WorkflowRun row is linked into
// the iteration (workflowRunId) so the manage modal can drill into the
// per-role transcripts.
//
// The workflow runner only writes back to the iteration on success.
// To cover failure / cancel paths cleanly, this function polls the
// WorkflowRun status until terminal — on failure we propagate the
// errorReason into the iteration, on success the workflow has already
// updated everything.

const WORKFLOW_TYPE_BY_EXECUTOR: Record<string, WorkflowType> = {
  build: 'builder',
  debug: 'debug',
}

async function runWorkflowIteration(
  task: { id: string; projectId: string; worktreeId: string; userId: string; name: string; contextSnapshot: string },
  iterationId: string,
  input: TriggerInput,
): Promise<void> {
  const tag = `[task-runner/workflow] task=${task.id.slice(0, 8)} iter=${iterationId.slice(0, 8)}`
  const workflowType = WORKFLOW_TYPE_BY_EXECUTOR[input.executorId]
  if (!workflowType) {
    console.warn(`${tag} ✗ unknown workflow id="${input.executorId}"`)
    await failIteration(task.id, iterationId, `Unknown workflow: ${input.executorId}`)
    return
  }

  const worktreePath = await resolveWorktreePath(task.worktreeId)
  if (!worktreePath) {
    console.warn(`${tag} ✗ worktree path unresolved worktreeId=${task.worktreeId.slice(0, 8)}`)
    await failIteration(task.id, iterationId, 'Worktree path could not be resolved')
    return
  }
  console.log(`${tag} ▶ starting workflow=${workflowType} cwd=${worktreePath} contextBytes=${task.contextSnapshot.length}`)

  const starter = workflowType === 'debug' ? startDebugWorkflow : startBuilderWorkflow
  const { runId } = await starter({
    sessionId: task.id,
    userId: task.userId,
    projectId: task.projectId,
    workflowType,
    userMessage: input.instruction,
    mode: 'agent',
    projectPath: worktreePath,
    overrideChatContext: task.contextSnapshot,
    taskContext: { taskId: task.id, iterationId },
  })
  console.log(`${tag} workflow started runId=${runId.slice(0, 8)} — polling for terminal`)

  await prisma.taskIteration.update({
    where: { id: iterationId },
    data: { workflowRunId: runId },
  })

  await waitForWorkflowTerminal(runId, task.id, iterationId, task.worktreeId)
}

const WORKFLOW_POLL_MS = 3_000

async function waitForWorkflowTerminal(
  runId: string,
  taskId: string,
  iterationId: string,
  worktreeId: string,
): Promise<void> {
  const tag = `[task-runner/workflow-poll] task=${taskId.slice(0, 8)} iter=${iterationId.slice(0, 8)} run=${runId.slice(0, 8)}`
  while (true) {
    await new Promise((r) => setTimeout(r, WORKFLOW_POLL_MS))
    const row = await prisma.workflowRun.findUnique({
      where: { id: runId },
      select: { status: true, errorReason: true },
    })
    if (!row) {
      console.warn(`${tag} workflow row vanished — aborting poll`)
      return
    }
    if (row.status !== 'completed' && row.status !== 'failed' && row.status !== 'cancelled') continue
    console.log(`${tag} terminal status=${row.status}${row.errorReason ? ` errorReason="${row.errorReason}"` : ''}`)

    const iter = await prisma.taskIteration.findUnique({
      where: { id: iterationId },
      select: { status: true, filesTouched: true },
    })
    if (!iter) {
      console.warn(`${tag} iteration row vanished after workflow terminal`)
      return
    }
    if (iter.status === 'running') {
      // Workflow ended without writing back to the iteration → propagate failure.
      console.warn(`${tag} workflow ended but iteration still 'running' — failing iteration`)
      await failIteration(taskId, iterationId, row.errorReason ?? `Workflow ${row.status}`)
      return
    }
    if (iter.status === 'completed') {
      // Workflow wrote the iteration's filesTouched; merge into the
      // worktree's task-touched set so the Changes list lights up T.
      const touched = Array.isArray(iter.filesTouched)
        ? (iter.filesTouched as unknown[]).filter((p): p is string => typeof p === 'string')
        : []
      await markWorktreeTouched(worktreeId, touched)
      console.log(`${tag} ✓ COMPLETED filesTouched=${touched.length}${touched.length ? ' paths=[' + touched.join(', ') + ']' : ''}`)
    }
    return
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function chatModeDisallowedTools(mode: 'agent' | 'plan' | 'ask'): string[] {
  if (mode === 'agent') return []
  // Read-only modes mirror what the chat already enforces for plan/ask.
  return ['Edit', 'Write', 'NotebookEdit', 'MultiEdit', 'Bash']
}

function buildTaskSystemPrompt(
  skillMd: string,
  task: { name: string; contextSnapshot: string },
  prior: Array<{
    iterationNumber: number
    instruction: string
    executorKind: string
    executorId: string
    chatMode: string
    outputSummary: string | null
    filesTouched: unknown
    status: string
  }>,
): string {
  const sections: string[] = [
    skillMd,
    '',
    '---',
    '',
    '## Task',
    task.name,
    '',
    '## Frozen chat context (preamble — read-only)',
    task.contextSnapshot,
    '',
  ]
  if (prior.length > 0) {
    sections.push('## Prior iterations of this task', '')
    for (const it of prior) {
      const files = Array.isArray(it.filesTouched) ? (it.filesTouched as string[]).join(', ') : ''
      sections.push(
        `### Iteration ${it.iterationNumber} (${it.executorKind}/${it.executorId} in ${it.chatMode} — ${it.status})`,
        `User asked: ${it.instruction}`,
        ...(it.outputSummary ? [`Result: ${it.outputSummary}`] : []),
        ...(files ? [`Files touched: ${files}`] : []),
        '',
      )
    }
  }
  return sections.join('\n')
}

function summarizeOutput(full: string): string {
  // Keep the first ~500 chars as the summary; the manage modal shows the
  // full output via TaskIteration.fullOutput when needed.
  const trimmed = full.trim()
  if (trimmed.length <= 500) return trimmed
  return `${trimmed.slice(0, 500)}…`
}

function extractEditedFiles(
  toolCalls: Array<{ name: string; input: Record<string, unknown> }>,
): string[] {
  const out = new Set<string>()
  for (const call of toolCalls) {
    if (!['Edit', 'Write', 'NotebookEdit', 'MultiEdit'].includes(call.name)) continue
    const path = call.input.file_path ?? call.input.notebook_path
    if (typeof path === 'string') out.add(path)
  }
  return [...out]
}

async function loadSkillMd(skillId: string): Promise<string | null> {
  // Skill ids match Collaborator.name (case-insensitive) for platform
  // defaults. Project-scoped skills could land here too; not used yet.
  const row = await prisma.collaborator.findFirst({
    where: {
      name: { equals: skillId, mode: 'insensitive' },
      isPlatformDefault: true,
    },
    select: { skillMd: true },
  })
  return row?.skillMd ?? null
}

async function resolveWorktreePath(worktreeId: string): Promise<string | null> {
  const row = await prisma.worktree.findUnique({
    where: { id: worktreeId },
    select: { worktreePath: true },
  })
  return row?.worktreePath ?? null
}

// Merge `paths` into Worktree.taskTouchedPaths (deduped). Drives the
// "T" badge in the Changes list. The commit endpoint clears this array
// so the badge disappears post-commit, matching the U lifecycle.
async function markWorktreeTouched(worktreeId: string, paths: string[]): Promise<void> {
  if (paths.length === 0) {
    console.log(`[task-runner/touched] worktree=${worktreeId.slice(0, 8)} no paths to mark`)
    return
  }
  try {
    const row = await prisma.worktree.findUnique({
      where: { id: worktreeId },
      select: { taskTouchedPaths: true },
    })
    const current = Array.isArray(row?.taskTouchedPaths) ? (row.taskTouchedPaths as unknown[]).filter((p): p is string => typeof p === 'string') : []
    const merged = Array.from(new Set([...current, ...paths]))
    if (merged.length === current.length) {
      console.log(`[task-runner/touched] worktree=${worktreeId.slice(0, 8)} no new paths (current=${current.length})`)
      return
    }
    await prisma.worktree.update({
      where: { id: worktreeId },
      data: { taskTouchedPaths: merged },
    })
    console.log(`[task-runner/touched] worktree=${worktreeId.slice(0, 8)} +${merged.length - current.length} paths (total=${merged.length})`)
  } catch (err) {
    console.warn(`[task-runner/touched] failed worktree=${worktreeId.slice(0, 8)}: ${(err as Error).message}`)
  }
}

async function failIteration(taskId: string, iterationId: string, reason: string): Promise<void> {
  console.warn(`[task-runner] ✗ FAILED task=${taskId.slice(0, 8)} iter=${iterationId.slice(0, 8)} reason="${reason}"`)
  await prisma.taskIteration.update({
    where: { id: iterationId },
    data: {
      status: 'failed',
      finishedAt: new Date(),
      errorReason: reason,
    },
  })
  await prisma.task.update({
    where: { id: taskId },
    data: { status: 'failed' },
  })
}
