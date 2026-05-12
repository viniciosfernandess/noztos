// Runner — state machine do Debug Workflow.
//
// Phase 0: Planner — decomposes the codebase into detective regions
// Phase 1: Detectives in parallel (Promise.all + sync barrier)
// Phase 2: Consolidator — unifies findings into one diagnostic
// Phase 3: Fix loop — Architect → Builder → Reviewer (max 2 rejects + forced)
// Phase 4: Posts final response to chat
//
// Cache pipeline + DB persistence mirror /build exactly. The only shape
// difference is the parallel detective phase: each detective owns a slot
// in snapshot.parallelSteps[i] and pushes deltas tagged with its index.

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { prisma } from '@/lib/db'
import { getChannel, dropFramesByPredicate } from '@/lib/companion-relay'
import { loadSessionContext, persistRows, type PersistRow } from '@/lib/chat-persist'
import { buildBridgeInContext } from '../shared/bridge-in'
import {
  cleanupHandoff,
  readDetectiveNotes,
  readConsolidatedFindings,
} from '../shared/artifacts'
import { buildRepoSnapshot } from '../builder/planner'
import { runDebugPlannerStep } from './planner'
import { runDetectiveStep } from './detective'
import { runConsolidatorStep } from './consolidator'
import { runDebugArchitectStep } from './architect'
import { runDebugBuilderStep } from './builder'
import { runDebugReviewerStep, type ReviewerDecision } from './reviewer'
import type {
  DetectiveBlock,
  RunSnapshot,
  StepState,
  TranscriptChunk,
  WorkflowMode,
  WorkflowType,
} from '../shared/types'

const MAX_REJECTS = 2

export interface StartDebugWorkflowInput {
  sessionId: string
  userId: string
  projectId: string
  workflowType: WorkflowType            // always 'debug' but kept for parity
  userMessage: string
  mode: WorkflowMode
  projectPath: string
  userMsgId?: string
}

export interface StartDebugWorkflowResult {
  runId: string
}

export async function startDebugWorkflow(input: StartDebugWorkflowInput): Promise<StartDebugWorkflowResult> {
  try {
    const stat = await fs.stat(input.projectPath)
    if (!stat.isDirectory()) throw new Error(`projectPath is not a directory: ${input.projectPath}`)
  } catch (err) {
    throw new Error(`projectPath does not exist or unreachable: ${input.projectPath} — ${(err as Error).message}`)
  }

  const initialSnapshot: RunSnapshot = {
    workflowType: input.workflowType,
    userMessage: input.userMessage,
    mode: input.mode,
    projectPath: input.projectPath,
    blocks: [],
    phase: 'planner',
    currentStep: null,
  }

  const run = await prisma.workflowRun.create({
    data: {
      sessionId: input.sessionId,
      projectId: input.projectId,
      userId: input.userId,
      workflowType: input.workflowType,
      userMessage: input.userMessage,
      status: 'pending',
      progress: initialSnapshot as unknown as object,
    },
    select: { id: true },
  })

  console.log(`[wf-runner] start run=${run.id.slice(0, 8)} session=${input.sessionId.slice(0, 8)} workflow=${input.workflowType} mode=${input.mode}`)

  void executeDebugRun(run.id, input).catch(async (err) => {
    console.error(`[wf-runner] debug run ${run.id} crashed:`, err)
    await prisma.workflowRun.updateMany({
      where: { id: run.id, status: { not: 'cancelled' } },
      data: {
        status: 'failed',
        errorReason: (err as Error).message,
        completedAt: new Date(),
      },
    }).catch(() => {})
  })

  return { runId: run.id }
}

// ── Cancel checkpoint helper ───────────────────────────────────────

async function isCancelled(runId: string): Promise<boolean> {
  const row = await prisma.workflowRun.findUnique({
    where: { id: runId },
    select: { status: true },
  })
  return row?.status === 'cancelled'
}

// ── Persist progress ───────────────────────────────────────────────

async function persistProgress(runId: string, snapshot: RunSnapshot): Promise<void> {
  await prisma.workflowRun.update({
    where: { id: runId },
    data: { progress: snapshot as unknown as object },
  })
}

async function markStatus(runId: string, status: string): Promise<void> {
  await prisma.workflowRun.updateMany({
    where: { id: runId, status: { not: 'cancelled' } },
    data: { status },
  })
}

// Live transcript callback factory — targets a specific step slot.
// `target` returns the StepState to append chunks into. Lets a single
// makeOnChunk implementation feed either snapshot.currentStep (sequential
// phases) or snapshot.parallelSteps[i] (detective phase).
function makeOnChunk(
  runId: string,
  snapshot: RunSnapshot,
  ctx: {
    userId: string
    sessionId: string
    seqRef: { value: number }
    target: () => StepState | undefined
    roleLabel: string
    blockIndex: number
    attempt: number
  },
): (chunk: TranscriptChunk) => void {
  const THROTTLE_MS = 500
  const LOG_EVERY_N = 25
  let scheduled: ReturnType<typeof setTimeout> | null = null
  let lastFlushAt = 0
  let pushedSinceLastLog = 0
  let loggedFirst = false

  function flush() {
    scheduled = null
    lastFlushAt = Date.now()
    void persistProgress(runId, snapshot).catch((err) => {
      console.warn(`[wf-runner] live transcript persist failed: ${(err as Error).message}`)
    })
  }

  return (chunk: TranscriptChunk) => {
    const step = ctx.target()
    if (!step) {
      console.log(`[wf-cache] drop chunk runId=${runId.slice(0, 8)} role=${ctx.roleLabel} reason=no_step_target`)
      return
    }
    if (!step.transcript) step.transcript = []
    step.transcript.push(chunk)

    const seq = ++ctx.seqRef.value
    snapshot.chunkSeq = seq
    const stepKey = `${ctx.roleLabel}@b${ctx.blockIndex}/a${ctx.attempt}`
    try {
      const channel = getChannel(ctx.userId)
      channel.pushEvent({
        type: 'workflow_progress',
        payload: {
          bornastarSessionId: ctx.sessionId,
          runId,
          seq,
          role: step.role,
          blockIndex: ctx.blockIndex,
          attempt: ctx.attempt,
          chunk,
        },
      }, ctx.userId)
      if (!loggedFirst) {
        console.log(`[wf-cache] first chunk pushed runId=${runId.slice(0, 8)} step=${stepKey} seq=${seq}`)
        loggedFirst = true
        pushedSinceLastLog = 0
      }
      pushedSinceLastLog++
      if (pushedSinceLastLog % LOG_EVERY_N === 0) {
        console.log(`[wf-cache] throughput runId=${runId.slice(0, 8)} step=${stepKey} chunksSinceLog=${pushedSinceLastLog} totalSeq=${seq}`)
      }
    } catch (err) {
      console.warn(`[wf-cache] relay push failed runId=${runId.slice(0, 8)} step=${stepKey} err=${(err as Error).message}`)
    }

    if (scheduled) return
    const elapsed = Date.now() - lastFlushAt
    if (elapsed >= THROTTLE_MS) flush()
    else scheduled = setTimeout(flush, THROTTLE_MS - elapsed)
  }
}

// Type guard for the eviction predicates below.
interface WorkflowProgressEnvelope {
  type: 'workflow_progress'
  payload: { bornastarSessionId: string; runId: string; blockIndex: number; role?: string; [k: string]: unknown }
}
function isWorkflowProgressFrame(ev: unknown): ev is WorkflowProgressEnvelope {
  const e = ev as { type?: string; payload?: { runId?: string } }
  return !!e && e.type === 'workflow_progress' && typeof e.payload?.runId === 'string'
}

function evictRoleFromCache(sessionId: string, runId: string, role: string): void {
  const dropped = dropFramesByPredicate(sessionId, (ev) =>
    isWorkflowProgressFrame(ev) && ev.payload.runId === runId && ev.payload.role === role,
  )
  if (dropped > 0) {
    console.log(`[wf-runner] evicted role from cache runId=${runId.slice(0, 8)} role=${role} frames=${dropped}`)
  }
}

function evictRunFromCache(sessionId: string, runId: string): void {
  const dropped = dropFramesByPredicate(sessionId, (ev) =>
    isWorkflowProgressFrame(ev) && ev.payload.runId === runId,
  )
  if (dropped > 0) {
    console.log(`[wf-runner] evicted run from cache runId=${runId.slice(0, 8)} frames=${dropped}`)
  }
}

// ── Main executor ──────────────────────────────────────────────────

async function executeDebugRun(runId: string, input: StartDebugWorkflowInput): Promise<void> {
  await markStatus(runId, 'running')

  const snapshot: RunSnapshot = {
    workflowType: input.workflowType,
    userMessage: input.userMessage,
    mode: input.mode,
    projectPath: input.projectPath,
    blocks: [],
    phase: 'planner',
    currentStep: null,
  }

  await persistUserMessage(runId, input)

  const seqRef = { value: 0 }
  const chunkCtx = { userId: input.userId, sessionId: input.sessionId, seqRef }

  // ── Phase 0: Bridge IN + repo snapshot + Planner ─────────────────

  snapshot.currentStep = {
    role: 'planner',
    blockIndex: -1,
    attempt: 1,
    startedAt: Date.now(),
  }
  await persistProgress(runId, snapshot)

  const chatContextXml = await buildBridgeInContext(input.sessionId, input.userId)
  console.log(`[wf-runner] run=${runId.slice(0, 8)} bridge_in chatBytes=${chatContextXml.length}`)
  const repoSnapshot = await buildRepoSnapshot(input.projectPath)
  console.log(`[wf-runner] run=${runId.slice(0, 8)} repo_snapshot bytes=${repoSnapshot.length}`)

  if (await isCancelled(runId)) {
    console.log(`[wf-runner] run=${runId.slice(0, 8)} cancelled before planner`)
    evictRunFromCache(input.sessionId, runId)
    return
  }

  const plannerResult = await runDebugPlannerStep({
    userMessage: input.userMessage,
    chatContextXml,
    repoSnapshot,
    mode: input.mode,
    projectPath: input.projectPath,
    runId,
    onChunk: makeOnChunk(runId, snapshot, {
      ...chunkCtx,
      target: () => (snapshot.currentStep ? (snapshot.currentStep as unknown as StepState) : undefined),
      roleLabel: 'planner',
      blockIndex: -1,
      attempt: 1,
    }),
  })

  if (!plannerResult.plan) {
    snapshot.currentStep = null
    await persistProgress(runId, snapshot)
    await prisma.workflowRun.updateMany({
      where: { id: runId, status: { not: 'cancelled' } },
      data: {
        status: 'failed',
        errorReason: `Planner failed: ${plannerResult.parseError ?? plannerResult.rawResult.error ?? 'unknown'}`,
        completedAt: new Date(),
      },
    })
    evictRunFromCache(input.sessionId, runId)
    return
  }

  snapshot.plan = plannerResult.plan
  const detectiveBlocks: DetectiveBlock[] = plannerResult.plan.blocks
  console.log(`[wf-runner] run=${runId.slice(0, 8)} ✓ planner done detectives=${detectiveBlocks.length} areas=[${detectiveBlocks.map((b) => `"${b.name}"`).join(', ')}]`)
  snapshot.currentStep = null
  await persistProgress(runId, snapshot)

  evictRoleFromCache(input.sessionId, runId, 'planner')

  // ── Phase 1: Detectives in parallel ──────────────────────────────

  if (await isCancelled(runId)) {
    console.log(`[wf-runner] run=${runId.slice(0, 8)} cancelled before detectives`)
    evictRunFromCache(input.sessionId, runId)
    return
  }

  snapshot.phase = 'investigating'
  snapshot.parallelSteps = detectiveBlocks.map((_, i) => ({
    role: 'detective' as const,
    attempt: 1,
    status: 'running' as const,
    startedAt: Date.now(),
    transcript: [],
    // detective slot index lives implicitly as the array position; we also
    // mirror it in the step for UI legibility.
  }))
  await persistProgress(runId, snapshot)
  console.log(`[wf-runner] run=${runId.slice(0, 8)} ▶ detectives spawning N=${detectiveBlocks.length}`)

  const detectivePromises = detectiveBlocks.map((block, i) =>
    runDetectiveStep({
      userMessage: input.userMessage,
      block,
      detectiveIndex: i,
      totalDetectives: detectiveBlocks.length,
      projectPath: input.projectPath,
      runId,
      onChunk: makeOnChunk(runId, snapshot, {
        ...chunkCtx,
        target: () => snapshot.parallelSteps?.[i],
        roleLabel: `detective#${i}`,
        blockIndex: i,
        attempt: 1,
      }),
    }).then((result) => ({ index: i, block, result })),
  )

  const detectiveResults = await Promise.all(detectivePromises)

  // Mark each detective step as completed/failed; persist transcript stays.
  for (const { index, result } of detectiveResults) {
    const step = snapshot.parallelSteps?.[index]
    if (!step) continue
    step.finishedAt = Date.now()
    step.durationMs = (step.finishedAt ?? 0) - (step.startedAt ?? 0)
    if (result.rawResult.error || !result.outputPath) {
      step.status = 'failed'
      step.errorReason = result.rawResult.error ?? 'detective produced no notes'
    } else {
      step.status = 'completed'
      step.outputPath = result.outputPath
      step.output = result.rawResult.output
    }
  }
  await persistProgress(runId, snapshot)

  const successful = detectiveResults.filter((r) => snapshot.parallelSteps?.[r.index]?.status === 'completed')
  console.log(`[wf-runner] run=${runId.slice(0, 8)} ✓ detectives done ${successful.length}/${detectiveResults.length}`)

  if (successful.length === 0) {
    await prisma.workflowRun.updateMany({
      where: { id: runId, status: { not: 'cancelled' } },
      data: {
        status: 'failed',
        errorReason: 'All detectives failed to produce notes',
        completedAt: new Date(),
      },
    })
    evictRunFromCache(input.sessionId, runId)
    return
  }

  if (await isCancelled(runId)) {
    console.log(`[wf-runner] run=${runId.slice(0, 8)} cancelled after detectives`)
    evictRunFromCache(input.sessionId, runId)
    return
  }

  // ── Phase 2: Consolidator ────────────────────────────────────────

  snapshot.phase = 'consolidating'
  const consolidatorStep: StepState = {
    role: 'consolidator',
    attempt: 1,
    status: 'running',
    startedAt: Date.now(),
  }
  // Surface the consolidator as the live tip — UI flips back to single-step.
  snapshot.currentStep = {
    role: 'consolidator',
    blockIndex: -1,
    attempt: 1,
    startedAt: consolidatorStep.startedAt!,
    transcript: [],
  }
  await persistProgress(runId, snapshot)

  const detectiveReports: Array<{ index: number; name: string; notes: string }> = []
  for (const { index, block } of detectiveResults) {
    const notes = await readDetectiveNotes(input.projectPath, index)
    if (notes) detectiveReports.push({ index, name: block.name, notes })
  }

  console.log(`[wf-runner] run=${runId.slice(0, 8)} ▶ consolidator reports=${detectiveReports.length}`)
  const consolidatorResult = await runConsolidatorStep({
    userMessage: input.userMessage,
    detectiveReports,
    projectPath: input.projectPath,
    runId,
    onChunk: makeOnChunk(runId, snapshot, {
      ...chunkCtx,
      target: () => (snapshot.currentStep ? (snapshot.currentStep as unknown as StepState) : undefined),
      roleLabel: 'consolidator',
      blockIndex: -1,
      attempt: 1,
    }),
  })

  if (consolidatorResult.rawResult.error || !consolidatorResult.outputPath) {
    await prisma.workflowRun.updateMany({
      where: { id: runId, status: { not: 'cancelled' } },
      data: {
        status: 'failed',
        errorReason: `Consolidator failed: ${consolidatorResult.rawResult.error ?? 'no output'}`,
        completedAt: new Date(),
      },
    })
    evictRunFromCache(input.sessionId, runId)
    return
  }

  snapshot.consolidatedFindings = consolidatorResult.rawResult.output
  console.log(`[wf-runner] run=${runId.slice(0, 8)} ✓ consolidator done bytes=${consolidatorResult.rawResult.output.length}`)
  await persistProgress(runId, snapshot)

  // Detective traces have served their purpose — Architect reads only the
  // consolidated findings. Free cache.
  evictRoleFromCache(input.sessionId, runId, 'detective')

  // ── Phase 3: Fix loop (Architect → Builder → Reviewer) ───────────

  if (await isCancelled(runId)) {
    evictRunFromCache(input.sessionId, runId)
    return
  }

  snapshot.phase = 'fixing'
  await persistProgress(runId, snapshot)

  const allRejections: Array<{ attempt: number; content: string }> = []
  let attempt = 1
  let architectIsRetry = false
  let previousArchitectPlan: string | undefined
  let previousRejectionList: string | undefined

  // Persisted audit trail for the fix loop. Each role on each attempt
  // pushes its own StepState here (mirrors /build's block.steps[]). The
  // live `currentStep` keeps driving the streaming card; this array is
  // pure cold-load study material. Initialized lazily on first push.
  if (!snapshot.fixAttempts) snapshot.fixAttempts = []

  fixLoop: while (true) {
    if (await isCancelled(runId)) { evictRunFromCache(input.sessionId, runId); return }

    // Architect
    const archStep: StepState = {
      role: 'architect',
      attempt,
      status: 'running',
      startedAt: Date.now(),
    }
    snapshot.fixAttempts.push(archStep)
    snapshot.currentStep = {
      role: 'architect',
      blockIndex: 0,
      attempt,
      startedAt: archStep.startedAt!,
      transcript: [],
    }
    await persistProgress(runId, snapshot)
    console.log(`[wf-runner] run=${runId.slice(0, 8)} ▶ architect attempt=${attempt}${attempt > 1 ? ' (retry)' : ''}`)

    const archResult = await runDebugArchitectStep({
      userMessage: input.userMessage,
      consolidatedFindings: snapshot.consolidatedFindings,
      projectPath: input.projectPath,
      runId,
      isRetry: architectIsRetry,
      previousPlan: previousArchitectPlan,
      rejectionList: previousRejectionList,
      onChunk: makeOnChunk(runId, snapshot, {
        ...chunkCtx,
        target: () => (snapshot.currentStep ? (snapshot.currentStep as unknown as StepState) : undefined),
        roleLabel: 'architect',
        blockIndex: 0,
        attempt,
      }),
    })

    archStep.finishedAt = Date.now()
    archStep.durationMs = archStep.finishedAt - archStep.startedAt!
    if (archResult.rawResult.error || !archResult.outputPath) {
      archStep.status = 'failed'
      archStep.errorReason = archResult.rawResult.error ?? 'architect produced no output'
      await persistProgress(runId, snapshot)
      await prisma.workflowRun.updateMany({
        where: { id: runId, status: { not: 'cancelled' } },
        data: {
          status: 'failed',
          errorReason: `Architect failed: ${archResult.rawResult.error ?? 'no output'}`,
          completedAt: new Date(),
        },
      })
      evictRunFromCache(input.sessionId, runId)
      return
    }
    archStep.status = 'completed'
    archStep.outputPath = archResult.outputPath
    archStep.output = archResult.rawResult.output
    await persistProgress(runId, snapshot)
    const architectPlan = archResult.rawResult.output

    // Builder
    if (await isCancelled(runId)) { evictRunFromCache(input.sessionId, runId); return }
    const buildStep: StepState = {
      role: 'builder',
      attempt,
      status: 'running',
      startedAt: Date.now(),
    }
    snapshot.fixAttempts.push(buildStep)
    snapshot.currentStep = {
      role: 'builder',
      blockIndex: 0,
      attempt,
      startedAt: buildStep.startedAt!,
      transcript: [],
    }
    await persistProgress(runId, snapshot)
    console.log(`[wf-runner] run=${runId.slice(0, 8)} ▶ builder attempt=${attempt}`)

    const buildResult = await runDebugBuilderStep({
      userMessage: input.userMessage,
      consolidatedFindings: snapshot.consolidatedFindings,
      architectPlan,
      projectPath: input.projectPath,
      mode: input.mode,
      runId,
      isRetry: attempt > 1,
      onChunk: makeOnChunk(runId, snapshot, {
        ...chunkCtx,
        target: () => (snapshot.currentStep ? (snapshot.currentStep as unknown as StepState) : undefined),
        roleLabel: 'builder',
        blockIndex: 0,
        attempt,
      }),
    })

    buildStep.finishedAt = Date.now()
    buildStep.durationMs = buildStep.finishedAt - buildStep.startedAt!
    if (buildResult.rawResult.error || !buildResult.outputPath) {
      buildStep.status = 'failed'
      buildStep.errorReason = buildResult.rawResult.error ?? 'builder produced no output'
      await persistProgress(runId, snapshot)
      await prisma.workflowRun.updateMany({
        where: { id: runId, status: { not: 'cancelled' } },
        data: {
          status: 'failed',
          errorReason: `Builder failed: ${buildResult.rawResult.error ?? 'no output'}`,
          completedAt: new Date(),
        },
      })
      evictRunFromCache(input.sessionId, runId)
      return
    }
    buildStep.status = 'completed'
    buildStep.outputPath = buildResult.outputPath
    buildStep.output = buildResult.rawResult.output
    await persistProgress(runId, snapshot)
    const builderReport = buildResult.rawResult.output

    // Reviewer
    if (await isCancelled(runId)) { evictRunFromCache(input.sessionId, runId); return }
    const revStep: StepState = {
      role: 'reviewer',
      attempt,
      status: 'running',
      startedAt: Date.now(),
    }
    snapshot.fixAttempts.push(revStep)
    snapshot.currentStep = {
      role: 'reviewer',
      blockIndex: 0,
      attempt,
      startedAt: revStep.startedAt!,
      transcript: [],
    }
    await persistProgress(runId, snapshot)
    console.log(`[wf-runner] run=${runId.slice(0, 8)} ▶ reviewer attempt=${attempt}`)

    const revResult = await runDebugReviewerStep({
      userMessage: input.userMessage,
      consolidatedFindings: snapshot.consolidatedFindings,
      architectPlan,
      builderReport,
      attempt,
      projectPath: input.projectPath,
      runId,
      previousRejections: allRejections,
      onChunk: makeOnChunk(runId, snapshot, {
        ...chunkCtx,
        target: () => (snapshot.currentStep ? (snapshot.currentStep as unknown as StepState) : undefined),
        roleLabel: 'reviewer',
        blockIndex: 0,
        attempt,
      }),
    })

    revStep.finishedAt = Date.now()
    revStep.durationMs = revStep.finishedAt - revStep.startedAt!
    if (revResult.rawResult.error || !revResult.decision) {
      revStep.status = 'failed'
      revStep.errorReason = revResult.rawResult.error ?? revResult.parseError ?? 'reviewer parse failed'
      await persistProgress(runId, snapshot)
      await prisma.workflowRun.updateMany({
        where: { id: runId, status: { not: 'cancelled' } },
        data: {
          status: 'failed',
          errorReason: `Reviewer failed: ${revResult.rawResult.error ?? revResult.parseError ?? 'unknown'}`,
          completedAt: new Date(),
        },
      })
      evictRunFromCache(input.sessionId, runId)
      return
    }
    revStep.status = 'completed'
    revStep.outputPath = revResult.outputPath
    revStep.output = revResult.payload
    revStep.decision = revResult.decision as ReviewerDecision
    await persistProgress(runId, snapshot)

    if (revResult.decision === 'APPROVED' || revResult.decision === 'FORCED_APPROVAL') {
      snapshot.finalResponse = revResult.payload
      snapshot.currentStep = null
      snapshot.phase = 'done'
      await persistProgress(runId, snapshot)
      break fixLoop
    }

    // REJECT
    allRejections.push({ attempt, content: revResult.payload })
    console.log(`[wf-runner] run=${runId.slice(0, 8)} REJECT #${allRejections.length}`)
    if (allRejections.length > MAX_REJECTS) {
      console.warn(`[wf-runner] run=${runId.slice(0, 8)} reject cap exceeded without forced — failing`)
      await prisma.workflowRun.updateMany({
        where: { id: runId, status: { not: 'cancelled' } },
        data: {
          status: 'failed',
          errorReason: 'Reject cap exceeded — Reviewer did not force approval',
          completedAt: new Date(),
        },
      })
      evictRunFromCache(input.sessionId, runId)
      return
    }
    architectIsRetry = true
    previousArchitectPlan = architectPlan
    previousRejectionList = revResult.payload
    attempt++
  }

  // ── Phase final: post final response as chat message ─────────────

  if (snapshot.finalResponse) {
    await postFinalResponseToChat(runId, input, snapshot.finalResponse)
  }

  try { await cleanupHandoff(input.projectPath) } catch (err) {
    console.warn(`[wf-runner] cleanup failed: ${(err as Error).message}`)
  }

  evictRunFromCache(input.sessionId, runId)

  await prisma.workflowRun.updateMany({
    where: { id: runId, status: { not: 'cancelled' } },
    data: {
      status: 'completed',
      finalResponse: snapshot.finalResponse,
      progress: snapshot as unknown as object,
      completedAt: new Date(),
    },
  })

  console.log(`[wf-runner] run=${runId.slice(0, 8)} COMPLETED detectives=${detectiveBlocks.length}`)
}

// ── Persist the user prompt at workflow start ─────────────────────

async function persistUserMessage(runId: string, input: StartDebugWorkflowInput): Promise<void> {
  const rowId = input.userMsgId ?? `wf-${runId}-user`
  const createdAt = Date.now()
  const row: PersistRow = {
    id: rowId,
    role: 'user',
    content: input.userMessage,
    createdAt,
  }
  try {
    const channel = getChannel(input.userId)
    channel.pushEvent({
      type: 'claude_event',
      payload: {
        bornastarSessionId: input.sessionId,
        persistRows: [{ id: rowId, role: 'user', content: input.userMessage, createdAt }],
      },
    }, input.userId)
  } catch (err) {
    console.warn(`[wf-runner] user relay push failed: ${(err as Error).message}`)
  }
  try {
    const ctx = await loadSessionContext(input.sessionId, input.userId)
    if (!ctx) return
    await persistRows([row], ctx)
  } catch (err) {
    console.warn(`[wf-runner] user DB persist failed: ${(err as Error).message}`)
  }
}

// ── Post final response to chat ────────────────────────────────────

async function postFinalResponseToChat(
  runId: string,
  input: StartDebugWorkflowInput,
  content: string,
): Promise<void> {
  console.log(`[wf-runner] ▶ posting final response to chat session=${input.sessionId.slice(0, 8)} contentBytes=${content.length}`)
  const finalRowId = `wf-${runId}-final`
  const createdAt = Date.now()
  const persistRow: PersistRow = {
    id: finalRowId,
    role: 'assistant',
    content,
    createdAt,
  }

  // ── 1. Ring buffer + browser SSE ───────────────────────────────────
  try {
    const channel = getChannel(input.userId)
    channel.pushEvent({
      type: 'claude_event',
      payload: {
        bornastarSessionId: input.sessionId,
        persistRows: [{ id: finalRowId, role: 'assistant', content, createdAt }],
      },
    }, input.userId)
    console.log(`[wf-runner] ✓ pushed final to relay sid=${input.sessionId.slice(0, 8)} rowId=${finalRowId}`)
  } catch (err) {
    console.warn(`[wf-runner] final relay push failed: ${(err as Error).message}`)
  }

  // ── 2. DB write-through ────────────────────────────────────────────
  let claudeSessionId: string | null = null
  try {
    const ctx = await loadSessionContext(input.sessionId, input.userId)
    if (!ctx) {
      console.warn(`[wf-runner] loadSessionContext null on final persist sid=${input.sessionId.slice(0, 8)} — skipping DB write`)
    } else {
      await persistRows([persistRow], ctx)
      console.log(`[wf-runner] ✓ persisted final to DB sid=${input.sessionId.slice(0, 8)}`)
    }
    const session = await prisma.chatSession.findUnique({
      where: { id: input.sessionId },
      select: { claudeSessionId: true },
    })
    claudeSessionId = session?.claudeSessionId ?? null
  } catch (err) {
    console.warn(`[wf-runner] final DB persist failed: ${(err as Error).message}`)
  }

  // ── 3. Claude CLI JSONL append (via companion) ─────────────────────
  // Closes the handshake daemon-side: appends the (user, assistant) pair
  // to the local .jsonl so the next chat-normal turn under `claude --resume`
  // sees this workflow run as part of the conversation. Best-effort; no-op
  // when the chat never spoke to claude yet (no claudeSessionId).
  if (!claudeSessionId) {
    console.log(`[wf-runner] no claudeSessionId on chat (first turn?) — skipping JSONL append`)
    return
  }
  try {
    const channel = getChannel(input.userId)
    channel.pushCommand({
      type: 'append_claude_turn',
      claudeSessionId,
      worktreePath: input.projectPath,
      userText: input.userMessage,
      assistantText: content,
    })
    console.log(`[wf-runner] ✓ enqueued append_claude_turn cmd to companion claudeSid=${claudeSessionId.slice(0, 8)}`)
  } catch (err) {
    console.warn(`[wf-runner] JSONL append cmd push failed: ${(err as Error).message}`)
  }
}

// Re-export decision type for the API/dispatcher if needed.
export type { ReviewerDecision }
// readConsolidatedFindings import kept above for completeness — useful for
// future code paths (e.g. re-consolidate on forced approval).
void readConsolidatedFindings
