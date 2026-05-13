// Runner — state machine do Builder Workflow.
//
// Phase 0: Bridge IN + repo snapshot + Planner
// Phase 1..N: pra cada block, Architect → Builder → Reviewer (com reject loop max 2)
// Phase final: posta resposta final do último Reviewer como ChatMessage no chat
//
// Persiste estado em WorkflowRun.progress a cada step pro UI poller
// renderizar progresso vivo.

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { prisma } from '@/lib/db'
import { getChannel, dropFramesByPredicate } from '@/lib/companion-relay'
import { loadSessionContext, persistRows, type PersistRow } from '@/lib/chat-persist'
import { buildBridgeInContext } from '../shared/bridge-in'
import { cleanupHandoff, readArchitectPlan, readBuilderReport, readRejectionList } from '../shared/artifacts'
import { runPlannerStep, buildRepoSnapshot } from './planner'
import { runArchitectStep } from './architect'
import { runBuilderStep } from './builder'
import { runReviewerStep, type ReviewerDecision } from './reviewer'
import type {
  BlockState,
  PlannerOutput,
  RunSnapshot,
  StepState,
  TranscriptChunk,
  WorkflowMode,
  WorkflowType,
} from '../shared/types'

const MAX_REJECTS_PER_BLOCK = 2

export interface StartWorkflowInput {
  sessionId: string
  userId: string
  projectId: string
  workflowType: WorkflowType
  userMessage: string
  mode: WorkflowMode
  projectPath: string
  // Stable id minted by the browser for its optimistic insert. Reused
  // here so the runner's persist + relay push lands as an upsert (no
  // duplicate row on the client). When omitted (e.g. server-driven
  // run with no UI), the runner falls back to `wf-<runId>-user`.
  userMsgId?: string
}

export interface StartWorkflowResult {
  runId: string
}

export async function startBuilderWorkflow(input: StartWorkflowInput): Promise<StartWorkflowResult> {
  // Validate projectPath exists
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

  // Fire-and-forget. Erros caem no catch e marcam status='failed'.
  void executeRun(run.id, input).catch(async (err) => {
    console.error(`[wf-runner] run ${run.id} crashed:`, err)
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

// Live transcript onChunk factory.
//
// Each parsed stream-json chunk has two destinations:
//
//   1. Cache (relay ring + browser SSE) — instant. `channel.pushEvent` of a
//      `workflow_progress` frame buffers in the per-session ring and emits
//      to the browser. UI applies the delta to its store and re-renders.
//      In-process push is microseconds; the `claude -p` child is unaffected.
//
//   2. DB (durability backstop) — throttled ~500ms. Mobile reconnect,
//      F5, ring eviction past the cap all read from `WorkflowRun.progress`.
//
// Plus the in-memory snapshot mutation so the runner itself keeps an
// accurate view for its own decisions (Reviewer needs transcript, etc).
//
// Fire-and-forget on persist (no await) so the agent's parse loop is
// never backpressured; persistProgress is a single Prisma update.
function makeLiveOnChunk(
  runId: string,
  snapshot: RunSnapshot,
  ctx: { userId: string; sessionId: string; seqRef: { value: number } },
): (chunk: TranscriptChunk) => void {
  const THROTTLE_MS = 500
  const LOG_EVERY_N = 25      // throughput milestone log cadence
  let scheduled: ReturnType<typeof setTimeout> | null = null
  let lastFlushAt = 0
  let pushedSinceLastLog = 0
  let lastLoggedStepKey: string | null = null

  function flush() {
    scheduled = null
    lastFlushAt = Date.now()
    void persistProgress(runId, snapshot).catch((err) => {
      console.warn(`[wf-runner] live transcript persist failed: ${(err as Error).message}`)
    })
  }

  return (chunk: TranscriptChunk) => {
    if (!snapshot.currentStep) {
      console.log(`[wf-cache] drop chunk runId=${runId.slice(0, 8)} reason=no_currentStep`)
      return
    }
    if (!snapshot.currentStep.transcript) snapshot.currentStep.transcript = []
    snapshot.currentStep.transcript.push(chunk)

    // Push delta to relay (cache + SSE). Best-effort: relay failures must
    // never break the agent's parse loop. Seq is monotonic per run so the
    // browser store can dedupe replays on reconnect. Stamped on the
    // snapshot so the throttled persist captures the latest cursor; the
    // browser reads it on cold-load to seed its dedupe state.
    const seq = ++ctx.seqRef.value
    snapshot.chunkSeq = seq
    const stepKey = `${snapshot.currentStep.role}@b${snapshot.currentStep.blockIndex}/a${snapshot.currentStep.attempt}`
    try {
      const channel = getChannel(ctx.userId)
      channel.pushEvent({
        type: 'workflow_progress',
        payload: {
          bornastarSessionId: ctx.sessionId,
          runId,
          seq,
          role: snapshot.currentStep.role,
          blockIndex: snapshot.currentStep.blockIndex,
          attempt: snapshot.currentStep.attempt,
          chunk,
        },
      }, ctx.userId)
      // First chunk per step gets a dedicated log so the test trace shows
      // the cache pipeline boot for each agent (planner → architect → …).
      if (stepKey !== lastLoggedStepKey) {
        console.log(`[wf-cache] first chunk pushed runId=${runId.slice(0, 8)} step=${stepKey} seq=${seq}`)
        lastLoggedStepKey = stepKey
        pushedSinceLastLog = 0
      }
      pushedSinceLastLog++
      if (pushedSinceLastLog % LOG_EVERY_N === 0) {
        console.log(`[wf-cache] throughput runId=${runId.slice(0, 8)} step=${stepKey} chunksSinceLog=${pushedSinceLastLog} totalSeq=${seq}`)
      }
    } catch (err) {
      console.warn(`[wf-cache] relay push failed runId=${runId.slice(0, 8)} step=${stepKey} err=${(err as Error).message}`)
    }

    if (scheduled) return  // already a flush queued
    const elapsed = Date.now() - lastFlushAt
    if (elapsed >= THROTTLE_MS) {
      flush()
    } else {
      scheduled = setTimeout(flush, THROTTLE_MS - elapsed)
    }
  }
}

// Type guard for the relay drop predicates below — narrows `unknown` to
// the workflow_progress envelope so we can read runId/blockIndex without
// casting at every call site.
interface WorkflowProgressEnvelope {
  type: 'workflow_progress'
  payload: {
    bornastarSessionId: string
    runId: string
    blockIndex: number
    [k: string]: unknown
  }
}
function isWorkflowProgressFrame(ev: unknown): ev is WorkflowProgressEnvelope {
  const e = ev as { type?: string; payload?: { runId?: string } }
  return !!e && e.type === 'workflow_progress' && typeof e.payload?.runId === 'string'
}

// Free the cache footprint of a single completed block. The full snapshot
// stays in DB; the WorkflowRunCard reads it from there if the user scrolls
// back to inspect the block. Keeping the cache lean keeps the working tip
// hot and protects neighboring chat sessions from LRU pressure.
function evictBlockFromCache(sessionId: string, runId: string, blockIndex: number): void {
  const dropped = dropFramesByPredicate(sessionId, (ev) =>
    isWorkflowProgressFrame(ev)
    && ev.payload.runId === runId
    && ev.payload.blockIndex === blockIndex,
  )
  if (dropped > 0) {
    console.log(`[wf-runner] evicted block from cache runId=${runId.slice(0, 8)} blockIndex=${blockIndex} frames=${dropped}`)
  }
}

// Free every frame belonging to this run when the workflow ends (any
// terminal status). DB has the final snapshot; UI can hydrate from there
// if a future view of this run is requested.
function evictRunFromCache(sessionId: string, runId: string): void {
  const dropped = dropFramesByPredicate(sessionId, (ev) =>
    isWorkflowProgressFrame(ev) && ev.payload.runId === runId,
  )
  if (dropped > 0) {
    console.log(`[wf-runner] evicted run from cache runId=${runId.slice(0, 8)} frames=${dropped}`)
  }
}

// ── Main executor ──────────────────────────────────────────────────

async function executeRun(runId: string, input: StartWorkflowInput): Promise<void> {
  await markStatus(runId, 'running')

  const snapshot: RunSnapshot = {
    workflowType: input.workflowType,
    userMessage: input.userMessage,
    mode: input.mode,
    projectPath: input.projectPath,
    blocks: [],
    currentStep: null,
  }

  // Persist the user's prompt before any agent runs. Same trio shape
  // we use for the final response (relay pushEvent + DB persistRows),
  // minus the JSONL append — the (user, assistant) pair lands in the
  // CLI transcript together when the run completes. Without this, F5
  // wipes the optimistic browser-only insert and the chat looks like
  // it was started by the assistant out of nowhere.
  await persistUserMessage(runId, input)

  // Monotonic counter shared across every step's onChunk so the browser
  // store can dedupe deltas on SSE reconnect. The ref shape keeps it
  // mutable across the closures without globals.
  const seqRef = { value: 0 }
  const chunkCtx = { userId: input.userId, sessionId: input.sessionId, seqRef }

  // ── Phase 0: Bridge IN + repo snapshot + Planner ─────────────────

  // Persisted StepState slot for the Planner — same transcript array
  // as currentStep so chunks land in both, and the slot survives when
  // currentStep gets reassigned by the first block's architect.
  const plannerStep: StepState = {
    role: 'planner',
    attempt: 1,
    status: 'running',
    startedAt: Date.now(),
    transcript: [],
  }
  snapshot.plannerStep = plannerStep
  snapshot.currentStep = {
    role: 'planner',
    blockIndex: -1,
    attempt: 1,
    startedAt: plannerStep.startedAt!,
    transcript: plannerStep.transcript,
  }
  await persistProgress(runId, snapshot)

  const chatContextXml = await buildBridgeInContext(input.sessionId, input.userId)
  console.log(`[wf-runner] run=${runId.slice(0, 8)} bridge_in chatBytes=${chatContextXml.length} hasContext=${chatContextXml.length > 0}`)

  const repoSnapshot = await buildRepoSnapshot(input.projectPath)
  console.log(`[wf-runner] run=${runId.slice(0, 8)} repo_snapshot bytes=${repoSnapshot.length} cwd=${input.projectPath}`)

  if (await isCancelled(runId)) {
    console.log(`[wf-runner] run=${runId.slice(0, 8)} cancelled before planner`)
    evictRunFromCache(input.sessionId, runId)
    return
  }
  console.log(`[wf-runner] run=${runId.slice(0, 8)} ▶ planner starting userMsgBytes=${input.userMessage.length}`)

  const plannerResult = await runPlannerStep({
    userMessage: input.userMessage,
    chatContextXml,
    repoSnapshot,
    mode: input.mode,
    projectPath: input.projectPath,
    runId,
    onChunk: makeLiveOnChunk(runId, snapshot, chunkCtx),
  })

  plannerStep.finishedAt = Date.now()
  plannerStep.durationMs = plannerStep.finishedAt - plannerStep.startedAt!
  if (!plannerResult.plan) {
    plannerStep.status = 'failed'
    plannerStep.errorReason = plannerResult.parseError ?? plannerResult.rawResult.error ?? 'unknown'
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

  plannerStep.status = 'completed'
  plannerStep.output = plannerResult.rawResult.output
  snapshot.plan = plannerResult.plan
  snapshot.blocks = plannerResult.plan.blocks.map((b, i) => ({
    index: i,
    name: b.name,
    objective: b.objective,
    estimatedFiles: b.estimatedFiles,
    status: 'pending' as const,
    steps: [],
    rejectCount: 0,
  }))
  snapshot.currentStep = null
  await prisma.workflowRun.update({
    where: { id: runId },
    data: { plan: plannerResult.plan as unknown as object, progress: snapshot as unknown as object },
  })

  const totalObjBytes = plannerResult.plan.blocks.reduce((acc, b) => acc + b.objective.length, 0)
  const blockNames = plannerResult.plan.blocks.map((b) => `"${b.name}"`).join(', ')
  console.log(`[wf-runner] run=${runId.slice(0, 8)} ✓ planner done blocks=${plannerResult.plan.blocks.length} totalObjBytes=${totalObjBytes} names=[${blockNames}]`)

  // Planner phase is done — its chunks are history now. Evict so cache
  // holds only the working tip (which will be the current block from
  // here on). DB still has the planner transcript via the snapshot above.
  evictBlockFromCache(input.sessionId, runId, -1)

  // ── Phase 1..N: blocks ────────────────────────────────────────────

  for (let i = 0; i < snapshot.blocks.length; i++) {
    if (await isCancelled(runId)) {
      console.log(`[wf-runner] run=${runId.slice(0, 8)} cancelled before block=${i + 1}`)
      evictRunFromCache(input.sessionId, runId)
      return
    }

    const block = snapshot.blocks[i]
    const isFinalBlock = i === snapshot.blocks.length - 1
    block.status = 'running'
    block.startedAt = Date.now()
    snapshot.currentBlockIndex = i
    await persistProgress(runId, snapshot)

    console.log(`[wf-runner] run=${runId.slice(0, 8)} block=${i + 1}/${snapshot.blocks.length} START name="${block.name}"`)

    const ok = await runBlock(runId, snapshot, i, isFinalBlock, plannerResult.plan, input, chunkCtx)
    if (!ok) {
      block.status = 'failed'
      block.finishedAt = Date.now()
      await persistProgress(runId, snapshot)
      await prisma.workflowRun.updateMany({
        where: { id: runId, status: { not: 'cancelled' } },
        data: {
          status: 'failed',
          errorReason: `Block ${i + 1} failed`,
          completedAt: new Date(),
        },
      })
      evictRunFromCache(input.sessionId, runId)
      return
    }

    block.status = 'completed'
    block.finishedAt = Date.now()
    await persistProgress(runId, snapshot)
    console.log(`[wf-runner] run=${runId.slice(0, 8)} block=${i + 1} DONE`)

    // Free the chunks of this completed block from the relay ring. DB
    // still holds the full transcript so the card can still scroll back
    // to inspect it (cold-load via /api/workflow/[runId]). The cache
    // keeps only the working tip: the block currently running.
    evictBlockFromCache(input.sessionId, runId, i)
  }

  // ── Phase final: post final response as chat message ─────────────

  if (snapshot.finalResponse) {
    await postFinalResponseToChat(runId, input, snapshot.finalResponse)
  }

  // Cleanup handoff folder (artifacts foram preservados na DB via snapshot)
  try {
    await cleanupHandoff(input.projectPath)
  } catch (err) {
    console.warn(`[wf-runner] cleanup failed: ${(err as Error).message}`)
  }

  // Final cache eviction: drop any remaining workflow_progress frames for
  // this run (e.g. planner-phase chunks where blockIndex = -1, which the
  // per-block eviction above doesn't catch).
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

  console.log(`[wf-runner] run=${runId.slice(0, 8)} COMPLETED blocks=${snapshot.blocks.length}`)
}

// ── Single block execution (with reject loop) ─────────────────────

async function runBlock(
  runId: string,
  snapshot: RunSnapshot,
  blockIndex: number,
  isFinalBlock: boolean,
  plan: PlannerOutput,
  input: StartWorkflowInput,
  chunkCtx: { userId: string; sessionId: string; seqRef: { value: number } },
): Promise<boolean> {
  const block = snapshot.blocks[blockIndex]
  const totalBlocks = snapshot.blocks.length

  let attempt = 1
  let architectIsRetry = false
  let previousArchitectPlan: string | undefined
  let previousRejectionList: string | undefined
  const allRejections: Array<{ attempt: number; content: string }> = []

  while (true) {
    if (await isCancelled(runId)) return false

    // ── Architect ───────────────────────────────────────────────────
    const archStep: StepState = {
      role: 'architect',
      attempt,
      status: 'running',
      startedAt: Date.now(),
      transcript: [],
    }
    block.steps.push(archStep)
    snapshot.currentStep = { role: 'architect', blockIndex, attempt, startedAt: archStep.startedAt!, transcript: archStep.transcript }
    await persistProgress(runId, snapshot)
    console.log(`[wf-runner] run=${runId.slice(0, 8)} block=${blockIndex + 1} ▶ architect attempt=${attempt}${attempt > 1 ? ' (retry)' : ''}`)

    const archResult = await runArchitectStep({
      userMessage: input.userMessage,
      plan,
      block: { name: block.name, objective: block.objective, estimatedFiles: block.estimatedFiles },
      blockIndex,
      totalBlocks,
      projectPath: input.projectPath,
      runId,
      isRetry: architectIsRetry,
      previousPlan: previousArchitectPlan,
      rejectionList: previousRejectionList,
      onChunk: makeLiveOnChunk(runId, snapshot, chunkCtx),
    })

    archStep.finishedAt = Date.now()
    archStep.durationMs = archStep.finishedAt - archStep.startedAt!
    if (archResult.rawResult.error || !archResult.outputPath) {
      archStep.status = 'failed'
      archStep.errorReason = archResult.rawResult.error ?? 'architect produced no output'
      await persistProgress(runId, snapshot)
      console.error(`[wf-runner] block=${blockIndex + 1} architect failed: ${archStep.errorReason}`)
      return false
    }
    archStep.status = 'completed'
    archStep.outputPath = archResult.outputPath
    archStep.output = archResult.rawResult.output
    await persistProgress(runId, snapshot)
    console.log(`[wf-runner] run=${runId.slice(0, 8)} block=${blockIndex + 1} ✓ architect done elapsed=${archStep.durationMs}ms planBytes=${archResult.rawResult.output.length} toolCalls=${archResult.rawResult.toolCalls.length} artifact=${archResult.outputPath?.split('/').slice(-2).join('/') ?? '?'}`)

    const architectPlan = archResult.rawResult.output

    // ── Builder ────────────────────────────────────────────────────
    if (await isCancelled(runId)) return false
    const buildStep: StepState = {
      role: 'builder',
      attempt,
      status: 'running',
      startedAt: Date.now(),
      transcript: [],
    }
    block.steps.push(buildStep)
    snapshot.currentStep = { role: 'builder', blockIndex, attempt, startedAt: buildStep.startedAt!, transcript: buildStep.transcript }
    await persistProgress(runId, snapshot)
    console.log(`[wf-runner] run=${runId.slice(0, 8)} block=${blockIndex + 1} ▶ builder attempt=${attempt}${attempt > 1 ? ' (retry)' : ''} architectPlanBytes=${architectPlan.length}`)

    const buildResult = await runBuilderStep({
      userMessage: input.userMessage,
      block: { name: block.name, objective: block.objective, estimatedFiles: block.estimatedFiles },
      blockIndex,
      totalBlocks,
      projectPath: input.projectPath,
      architectPlan,
      mode: input.mode,
      runId,
      isRetry: attempt > 1,
      onChunk: makeLiveOnChunk(runId, snapshot, chunkCtx),
    })

    buildStep.finishedAt = Date.now()
    buildStep.durationMs = buildStep.finishedAt - buildStep.startedAt!
    if (buildResult.rawResult.error || !buildResult.outputPath) {
      buildStep.status = 'failed'
      buildStep.errorReason = buildResult.rawResult.error ?? 'builder produced no output'
      await persistProgress(runId, snapshot)
      console.error(`[wf-runner] block=${blockIndex + 1} builder failed: ${buildStep.errorReason}`)
      return false
    }
    buildStep.status = 'completed'
    buildStep.outputPath = buildResult.outputPath
    buildStep.output = buildResult.rawResult.output
    await persistProgress(runId, snapshot)
    const editTools = buildResult.rawResult.toolCalls.filter((t) => ['Edit', 'Write', 'NotebookEdit', 'MultiEdit'].includes(t.name)).length
    const bashCalls = buildResult.rawResult.toolCalls.filter((t) => t.name === 'Bash').length
    console.log(`[wf-runner] run=${runId.slice(0, 8)} block=${blockIndex + 1} ✓ builder done elapsed=${buildStep.durationMs}ms reportBytes=${buildResult.rawResult.output.length} edits=${editTools} bashRuns=${bashCalls} totalTools=${buildResult.rawResult.toolCalls.length} artifact=${buildResult.outputPath?.split('/').slice(-2).join('/') ?? '?'}`)

    const builderReport = buildResult.rawResult.output

    // ── Reviewer ───────────────────────────────────────────────────
    if (await isCancelled(runId)) return false
    const revStep: StepState = {
      role: 'reviewer',
      attempt,
      status: 'running',
      startedAt: Date.now(),
      transcript: [],
    }
    block.steps.push(revStep)
    snapshot.currentStep = { role: 'reviewer', blockIndex, attempt, startedAt: revStep.startedAt!, transcript: revStep.transcript }
    await persistProgress(runId, snapshot)
    console.log(`[wf-runner] run=${runId.slice(0, 8)} block=${blockIndex + 1} ▶ reviewer attempt=${attempt}${isFinalBlock ? ' (FINAL BLOCK)' : ''} builderReportBytes=${builderReport.length}`)

    const revResult = await runReviewerStep({
      userMessage: input.userMessage,
      block: { name: block.name, objective: block.objective, estimatedFiles: block.estimatedFiles },
      blockIndex,
      totalBlocks,
      projectPath: input.projectPath,
      architectPlan,
      builderReport,
      attempt,
      isFinalBlock,
      runId,
      previousRejections: allRejections,
      onChunk: makeLiveOnChunk(runId, snapshot, chunkCtx),
    })

    revStep.finishedAt = Date.now()
    revStep.durationMs = revStep.finishedAt - revStep.startedAt!
    if (revResult.rawResult.error || !revResult.decision) {
      revStep.status = 'failed'
      revStep.errorReason = revResult.rawResult.error ?? revResult.parseError ?? 'reviewer parse failed'
      await persistProgress(runId, snapshot)
      console.error(`[wf-runner] block=${blockIndex + 1} reviewer failed: ${revStep.errorReason}`)
      return false
    }
    revStep.status = 'completed'
    revStep.outputPath = revResult.outputPath
    revStep.output = revResult.rawResult.output
    revStep.decision = revResult.decision as ReviewerDecision
    await persistProgress(runId, snapshot)
    const decisionEmoji = revResult.decision === 'APPROVED' ? '✓' : revResult.decision === 'FORCED_APPROVAL' ? '⚠' : '✗'
    console.log(`[wf-runner] run=${runId.slice(0, 8)} block=${blockIndex + 1} ${decisionEmoji} reviewer done elapsed=${revStep.durationMs}ms decision=${revResult.decision} payloadBytes=${revResult.payload.length} artifact=${revResult.outputPath?.split('/').slice(-2).join('/') ?? '?'}`)

    // ── Decisão ────────────────────────────────────────────────────
    if (revResult.decision === 'APPROVED' || revResult.decision === 'FORCED_APPROVAL') {
      block.summaryPath = revResult.outputPath
      block.summary = revResult.payload
      // Final block → store final response in snapshot for chat post
      if (isFinalBlock) {
        snapshot.finalResponse = revResult.payload
      }
      snapshot.currentStep = null
      await persistProgress(runId, snapshot)
      return true
    }

    // REJECT → bump rejectCount, prepare retry
    block.rejectCount = (block.rejectCount ?? 0) + 1
    allRejections.push({ attempt, content: revResult.payload })
    previousRejectionList = revResult.payload
    previousArchitectPlan = architectPlan

    if (block.rejectCount > MAX_REJECTS_PER_BLOCK) {
      // Should not happen — Reviewer should auto-FORCED_APPROVAL on attempt 3+
      console.warn(`[wf-runner] block=${blockIndex + 1} reject cap exceeded (Reviewer didn't force) — failing block`)
      return false
    }

    architectIsRetry = true
    attempt++
    console.log(`[wf-runner] block=${blockIndex + 1} REJECT #${block.rejectCount} → architect retry attempt=${attempt}`)
  }
}

// ── Persist the user prompt at workflow start ─────────────────────
//
// Lands in the same two zones as a normal chat user turn:
//   1. Relay pushEvent → ring + browser SSE (upserts the optimistic
//      row the browser already inserted with the same id, so there's
//      no duplicate or flicker)
//   2. persistRows → DB chat_messages (survives F5)
//
// JSONL append happens later in postFinalResponseToChat — both sides
// of the (user, assistant) pair go in together so `claude --resume`
// reads a coherent turn. Splitting the two writes here would mean
// appending a hanging user line with no assistant response yet.
async function persistUserMessage(runId: string, input: StartWorkflowInput): Promise<void> {
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
    console.log(`[wf-runner] ✓ pushed user frame to relay sid=${input.sessionId.slice(0, 8)} rowId=${rowId}`)
  } catch (err) {
    console.warn(`[wf-runner] user relay push failed: ${(err as Error).message}`)
  }

  try {
    const ctx = await loadSessionContext(input.sessionId, input.userId)
    if (!ctx) {
      console.warn(`[wf-runner] loadSessionContext null on user persist sid=${input.sessionId.slice(0, 8)}`)
      return
    }
    await persistRows([row], ctx)
    console.log(`[wf-runner] ✓ persisted user msg to DB sid=${input.sessionId.slice(0, 8)} rowId=${rowId}`)
  } catch (err) {
    console.warn(`[wf-runner] user DB persist failed: ${(err as Error).message}`)
  }
}

// ── Post final response to chat ────────────────────────────────────
//
// Three landing zones, all using the same canonical assistant row id
// (`wf-<runId>-final`) so anything that surfaces it later is upserted,
// never duplicated:
//
//   1. Ring buffer + browser SSE  — pushEvent on the user's relay
//      channel. Same code path the daemon uses for normal chat: the
//      browser receives a `claude_event` envelope and the in-memory
//      ring updates so bridge_in (next workflow run) sees the turn.
//
//   2. DB write-through           — persistRows upsert into chat_messages.
//      Idempotent by id; mobile/F5/replay all read from here.
//
//   3. Claude CLI JSONL           — companion-side append of a coherent
//      (user, assistant) pair into the `--resume` file, so the next
//      regular chat / skill turn doesn't see a hole where /build was.
//      Best-effort: silently no-ops if the chat never spoke to claude
//      yet (no JSONL exists).
async function postFinalResponseToChat(
  runId: string,
  input: StartWorkflowInput,
  content: string,
): Promise<void> {
  console.log(`[wf-runner] ▶ posting final response to chat session=${input.sessionId.slice(0, 8)} contentBytes=${content.length}`)

  // Stable id ties together SSE event, ring entry, and DB row.
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
    const frame = {
      type: 'claude_event',
      payload: {
        bornastarSessionId: input.sessionId,
        // persistRows path is the daemon-stamped shape bridge_in/companion-store
        // both already understand — wrap our single row the same way.
        persistRows: [{
          id: finalRowId,
          role: 'assistant',
          content,
          createdAt,
        }],
      },
    }
    channel.pushEvent(frame, input.userId)
    console.log(`[wf-runner] ✓ pushed assistant frame to relay (ring + SSE) sid=${input.sessionId.slice(0, 8)} rowId=${finalRowId}`)
  } catch (err) {
    console.warn(`[wf-runner] relay push failed: ${(err as Error).message}`)
  }

  // ── 2. DB write-through ────────────────────────────────────────────
  let claudeSessionId: string | null = null
  try {
    const ctx = await loadSessionContext(input.sessionId, input.userId)
    if (!ctx) {
      console.warn(`[wf-runner] loadSessionContext returned null sid=${input.sessionId.slice(0, 8)} — skipping DB write`)
    } else {
      await persistRows([persistRow], ctx)
      console.log(`[wf-runner] ✓ persisted to DB sid=${input.sessionId.slice(0, 8)} rowId=${finalRowId}`)
    }
    // Need the CLI session id for the JSONL append regardless of DB outcome.
    const session = await prisma.chatSession.findUnique({
      where: { id: input.sessionId },
      select: { claudeSessionId: true },
    })
    claudeSessionId = session?.claudeSessionId ?? null
  } catch (err) {
    console.warn(`[wf-runner] DB persist failed: ${(err as Error).message}`)
  }

  // ── 3. Claude CLI JSONL append (via companion) ─────────────────────
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
    console.warn(`[wf-runner] companion command enqueue failed: ${(err as Error).message}`)
  }
}
