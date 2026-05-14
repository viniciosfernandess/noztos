'use client'

import { useEffect, useRef, useState } from 'react'
import { useWorkflowSnapshot, type WorkflowRunUIState } from '@/lib/hooks/useWorkflowSnapshot'
import { companionStore } from '@/lib/companion-store'

// Card vivo no chat com progresso do Builder Workflow.
//
// Lives off `useWorkflowSnapshot` which mirrors the chat-message pattern:
// SSE deltas flow into the store instantly, DB cold-load fills the gap
// on mount/reconnect, low-freq backup poll catches missed frames. On
// terminal status the snapshot stays in the store — card keeps rendering
// the final state until the user dismisses it. Não mostra cost/tokens
// (user paga via OAuth).


interface TranscriptChunk {
  ts: number
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking'
  text?: string
  toolName?: string
  toolInput?: Record<string, unknown>
  toolUseId?: string
  toolResult?: string
  toolError?: boolean
}

interface RunSnapshotProgress {
  // Worktree absolute path the agents run in. Used to render tool
  // paths (Read /lib/foo.ts vs Read /Users/.../wt-.../lib/foo.ts) —
  // we strip this prefix at display time so logs match the chat normal
  // convention (project-relative).
  projectPath?: string
  blocks?: Array<{
    index: number
    name: string
    objective: string
    status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
    rejectCount?: number
    steps?: Array<{
      role: 'planner' | 'architect' | 'builder' | 'reviewer' | 'detective' | 'consolidator'
      attempt: number
      status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
      durationMs?: number
      output?: string
      decision?: 'APPROVED' | 'REJECT' | 'FORCED_APPROVAL'
      errorReason?: string
    }>
  }>
  currentBlockIndex?: number
  currentStep?: {
    role: string
    blockIndex: number
    attempt: number
    startedAt: number
    transcript?: TranscriptChunk[]
  } | null
  // /debug only — populated while phase === 'investigating'. N detectives
  // run in parallel; each slot is one detective's StepState. UI renders
  // them in a grid below the planner row.
  parallelSteps?: Array<{
    role: 'detective'
    attempt: number
    status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
    startedAt?: number
    finishedAt?: number
    durationMs?: number
    transcript?: TranscriptChunk[]
    output?: string
    errorReason?: string
  }>
  // High-level phase. Drives parallel/sequential rendering swap.
  phase?: 'planner' | 'investigating' | 'consolidating' | 'fixing' | 'done'
  // For /debug — Planner output is DebugPlannerOutput, not the BlockState
  // shape. We render the detective names from here when phase is set.
  plan?: {
    blocks?: Array<{ name?: string; logicalArea?: string; paths?: string[] }>
  }
}

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled'])

export function WorkflowRunCard({ sessionId, runId }: { sessionId: string; runId: string }) {
  const snapshot = useWorkflowSnapshot(runId)

  if (!snapshot) {
    return (
      <div className="my-3 rounded-md border border-white/10 bg-white/[0.02] px-3 py-2 text-[11px] text-zinc-500">
        Workflow — starting…
      </div>
    )
  }

  const isTerminal = TERMINAL_STATUSES.has(snapshot.status)

  return (
    <div className="my-3 rounded-md border border-white/10 bg-white/[0.02]">
      <Header snapshot={snapshot} />
      <CardScrollBody>
        <Body snapshot={snapshot} />
      </CardScrollBody>
      {snapshot.errorReason && (
        <div className="border-t border-white/10 px-3 py-1.5 text-[10px] text-rose-400">
          {snapshot.errorReason}
        </div>
      )}
      {isTerminal && (
        <div className="flex justify-end border-t border-white/10 px-3 py-1.5">
          <button
            type="button"
            onClick={() => companionStore.dismissWorkflowRun(runId, sessionId)}
            className="rounded px-2 py-1 text-[10px] text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-300"
          >
            Dispensar
          </button>
        </div>
      )}
    </div>
  )
}

// Caps the live workflow content at a sensible height with internal
// scroll + sticky-bottom — so the card stays a fixed visual footprint
// no matter how many blocks/steps/tool-calls land. Without this, the
// card grows unbounded as new blocks complete and steps stream in,
// shoving the chat out of position. Same sticky-bottom behavior the
// LiveTranscript itself uses — auto-scrolls to follow new content
// unless the user scrolled up to read something older.
function CardScrollBody({ children }: { children: React.ReactNode }) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const stickToBottomRef = useRef(true)

  function handleScroll() {
    const el = scrollRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    stickToBottomRef.current = distanceFromBottom < 30
  }

  // ResizeObserver fires when the inner content grows (new step rows,
  // new block rows, transcript chunks). We re-pin to the bottom only if
  // the user was already there — preserves their reading position when
  // they scrolled up.
  useEffect(() => {
    const el = scrollRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (!stickToBottomRef.current) return
      el.scrollTop = el.scrollHeight
    })
    ro.observe(el)
    // Also observe the inner child so changes inside it (most common
    // source of growth) trigger the auto-scroll.
    const inner = el.firstElementChild
    if (inner) ro.observe(inner)
    return () => ro.disconnect()
  }, [])

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="max-h-[480px] overflow-y-auto"
    >
      {children}
    </div>
  )
}

// Header label per workflow type. Easy to extend when /review, /test,
// etc land — just add a case.
function workflowLabel(workflowType: string | undefined): { icon: string; name: string } {
  switch (workflowType) {
    case 'debug':
      return { icon: '🔍', name: 'Debug Team' }
    case 'builder':
    default:
      return { icon: '🛠️', name: 'Builder Team' }
  }
}

function Header({ snapshot }: { snapshot: WorkflowRunUIState }) {
  const status = snapshot.status
  const elapsed = ((snapshot.completedAt ? new Date(snapshot.completedAt).getTime() : Date.now()) - new Date(snapshot.createdAt).getTime()) / 1000
  const { icon, name } = workflowLabel(snapshot.workflowType)

  return (
    <div className="flex items-center gap-2 border-b border-white/10 px-3 py-1.5 text-[11px]">
      <StatusDot status={status} />
      <span className="font-medium text-zinc-300">{icon} {name}</span>
      <span className="text-zinc-500">{status === 'running' ? 'running' : status}</span>
      <span className="ml-auto text-zinc-500">{elapsed.toFixed(0)}s</span>
    </div>
  )
}

function StatusDot({ status }: { status: string }) {
  // 'cancelled' is user-initiated pause — neutral zinc (the user chose
  // to stop, nothing went wrong). 'failed' is a system error — rose.
  // Visually separating the two so the chat doesn't look catastrophic
  // when the user just clicked pause.
  const cls = status === 'running' || status === 'pending'
    ? 'bg-amber-400 animate-pulse'
    : status === 'completed'
    ? 'bg-emerald-400'
    : status === 'cancelled'
    ? 'bg-zinc-400'
    : status === 'failed'
    ? 'bg-rose-400'
    : 'bg-zinc-500'
  return <span className={`inline-block h-1.5 w-1.5 rounded-full ${cls}`} />
}

function Body({ snapshot }: { snapshot: WorkflowRunUIState }) {
  const progress = (snapshot.progress ?? {}) as RunSnapshotProgress
  const blocks = progress.blocks ?? []

  // /debug branch — phase-driven layout. Planner row first, then either
  // parallel detective grid (investigating) or the standard single-step
  // live tip (consolidating / fixing / done). Builder workflow has no
  // `phase`, so it falls through to the existing blocks-based layout below.
  if (progress.phase) {
    return <DebugBody progress={progress} />
  }

  // Pre-blocks state: planner is the active step. The other agents
  // (architect/builder/reviewer) only run AFTER blocks exist, so they
  // already get their transcript inside BlockRow.expanded below.
  // Rendering the planner's transcript here closes the gap — without
  // it, the user sees "Planner thinking… 2m" with zero activity until
  // either the JSON parses (blocks appear) or the run fails.
  if (blocks.length === 0) {
    const plannerStep = progress.currentStep?.role === 'planner' ? progress.currentStep : null
    return (
      <div className="px-3 py-2 text-[11px]">
        {plannerStep ? (
          <>
            <ThinkingLine label="Planner" startedAt={plannerStep.startedAt} />
            <LiveTranscript chunks={plannerStep.transcript} projectPath={progress.projectPath} />
          </>
        ) : (
          <span className="italic text-zinc-500">Planner — decomposing…</span>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col">
      {blocks.map((b) => (
        <BlockRow key={b.index} block={b} totalBlocks={blocks.length} liveStep={progress.currentStep ?? null} projectPath={progress.projectPath} />
      ))}
    </div>
  )
}

// Debug workflow render. Phase-aware: shows the planner banner, then a
// grid of detective tiles when investigating, and finally the live tip
// (consolidator → architect → builder → reviewer) for the remaining
// phases. Each agent's transcript surfaces via the same LiveTranscript
// component the chat normal already renders, so the visual language
// stays consistent.
function DebugBody({ progress }: { progress: RunSnapshotProgress }) {
  const { phase, currentStep, parallelSteps, plan, projectPath } = progress
  const detectiveBlocks = plan?.blocks ?? []

  const phaseLabel = (() => {
    switch (phase) {
      case 'planner': return 'Planner — decomposing the bug'
      case 'investigating': return `Detectives investigating (${parallelSteps?.length ?? 0})`
      case 'consolidating': return 'Consolidator — unifying findings'
      case 'fixing': return 'Fix pipeline — Architect → Builder → Reviewer'
      case 'done': return 'Run complete'
      default: return phase ?? ''
    }
  })()

  return (
    <div className="flex flex-col gap-2 px-3 py-2 text-[11px]">
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">{phaseLabel}</div>

      {phase === 'planner' && currentStep?.role === 'planner' && (
        <div>
          <ThinkingLine label="Planner" startedAt={currentStep.startedAt} />
          <LiveTranscript chunks={currentStep.transcript} projectPath={projectPath} />
        </div>
      )}

      {phase === 'investigating' && parallelSteps && parallelSteps.length > 0 && (
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          {parallelSteps.map((step, i) => (
            <DetectiveTile
              key={i}
              index={i}
              name={detectiveBlocks[i]?.name ?? `Detective ${i + 1}`}
              step={step}
              projectPath={projectPath}
            />
          ))}
        </div>
      )}

      {(phase === 'consolidating' || phase === 'fixing') && currentStep && (
        <div>
          <ThinkingLine label={currentStep.role} startedAt={currentStep.startedAt} attempt={currentStep.attempt} />
          <LiveTranscript chunks={currentStep.transcript} projectPath={projectPath} />
        </div>
      )}
    </div>
  )
}

function DetectiveTile({
  index,
  name,
  step,
  projectPath,
}: {
  index: number
  name: string
  step: NonNullable<RunSnapshotProgress['parallelSteps']>[number]
  projectPath?: string
}) {
  const marker = step.status === 'completed' ? '✓'
    : step.status === 'failed' ? '✗'
    : step.status === 'cancelled' ? '⏸'
    : step.status === 'running' ? '▶'
    : '◌'
  const markerCls = step.status === 'completed' ? 'text-emerald-400'
    : step.status === 'failed' ? 'text-rose-400'
    : step.status === 'cancelled' ? 'text-zinc-400'
    : step.status === 'running' ? 'text-amber-400'
    : 'text-zinc-600'

  return (
    <div className="rounded-md border border-white/5 bg-black/10">
      <div className="flex items-center gap-2 border-b border-white/5 px-2 py-1">
        <span className={`shrink-0 font-mono ${markerCls}`}>{marker}</span>
        <span className="text-[10px] text-zinc-500">#{index + 1}</span>
        <span className="truncate text-zinc-300">{name}</span>
      </div>
      <div className="max-h-[160px] overflow-y-auto px-2 py-1">
        <LiveTranscript chunks={step.transcript} projectPath={projectPath} />
        {step.status === 'failed' && step.errorReason && (
          <p className="mt-1 text-[10px] text-rose-400">{step.errorReason}</p>
        )}
      </div>
    </div>
  )
}

function BlockRow({
  block,
  totalBlocks,
  liveStep,
  projectPath,
}: {
  block: NonNullable<RunSnapshotProgress['blocks']>[number]
  totalBlocks: number
  liveStep: RunSnapshotProgress['currentStep']
  projectPath?: string
}) {
  const isActive = block.status === 'running'
  const [expanded, setExpanded] = useState(isActive || block.status === 'failed')

  useEffect(() => {
    if (block.status === 'running') setExpanded(true)
  }, [block.status])

  const marker = block.status === 'completed' ? '✓'
    : block.status === 'failed' ? '✗'
    : block.status === 'cancelled' ? '⏸'
    : isActive ? '▶'
    : '◌'
  const markerCls = block.status === 'completed' ? 'text-emerald-400'
    : block.status === 'failed' ? 'text-rose-400'
    : block.status === 'cancelled' ? 'text-zinc-400'
    : isActive ? 'text-amber-400'
    : 'text-zinc-600'

  return (
    <div className="border-b border-white/5 last:border-b-0">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] transition-colors hover:bg-white/[0.02]"
      >
        <span className={`shrink-0 font-mono ${markerCls}`}>{marker}</span>
        <span className="text-[10px] text-zinc-500">{block.index + 1}/{totalBlocks}</span>
        <span className="truncate text-zinc-300">{block.name}</span>
        {(block.rejectCount ?? 0) > 0 && (
          <span className="ml-auto shrink-0 rounded border border-amber-500/30 bg-amber-500/10 px-1 text-[9px] text-amber-400">
            {block.rejectCount} reject{block.rejectCount === 1 ? '' : 's'}
          </span>
        )}
      </button>

      {expanded && (
        <div className="border-t border-white/5 bg-black/10 px-3 py-2">
          <div className="mb-2 text-[10px] text-zinc-500">
            <span className="text-zinc-600">Objective: </span>{block.objective}
          </div>

          {(block.steps ?? []).map((step, i) => (
            <StepRow key={i} step={step} />
          ))}

          {liveStep && liveStep.blockIndex === block.index && (
            <>
              <ThinkingLine label={liveStep.role} startedAt={liveStep.startedAt} attempt={liveStep.attempt} />
              <LiveTranscript chunks={liveStep.transcript} projectPath={projectPath} />
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ── Live transcript ───────────────────────────────────────────────
//
// Renders the in-flight agent's stream-json output (text + tool_use +
// tool_result) inline below the thinking line. Same visual language
// the chat normal uses for tools — Read / Grep / Bash / Edit / etc —
// just compact since we live inside a workflow card row.
//
// Each tool_use chunk is paired with its matching tool_result via
// toolUseId so the result renders directly under the call. Latest
// chunks at the bottom; auto-scroll target lives on the last item.
function LiveTranscript({ chunks, projectPath }: { chunks?: TranscriptChunk[]; projectPath?: string }) {
  // Cap height + internal scroll so the card stays a fixed visual
  // footprint even as the agent emits hundreds of chunks. Without this,
  // the workflow card would grow unbounded and shove the chat history
  // off-screen on every poll. Auto-scroll-to-bottom is sticky: as long
  // as the user is already at the bottom (or within ~30px of it),
  // new chunks pull the scroll along; if the user scrolls up to read
  // an earlier chunk, we stop following so they're not yanked back.
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const stickToBottomRef = useRef(true)

  function handleScroll() {
    const el = scrollRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    stickToBottomRef.current = distanceFromBottom < 30
  }

  useEffect(() => {
    if (!stickToBottomRef.current) return
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [chunks])

  if (!chunks || chunks.length === 0) return null

  // Pair tool_use with its tool_result so we render one combined card
  // per tool invocation (matches the chat normal layout).
  const resultByUseId = new Map<string, TranscriptChunk>()
  for (const c of chunks) {
    if (c.type === 'tool_result' && c.toolUseId) resultByUseId.set(c.toolUseId, c)
  }

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="mt-2 max-h-72 space-y-1.5 overflow-y-auto border-l border-amber-500/20 pl-2.5"
    >
      {chunks.map((chunk, i) => {
        if (chunk.type === 'text') {
          return (
            <div key={i} className="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-zinc-300">
              {chunk.text}
            </div>
          )
        }
        if (chunk.type === 'tool_use') {
          const result = chunk.toolUseId ? resultByUseId.get(chunk.toolUseId) : undefined
          return <ToolChunk key={i} use={chunk} result={result} projectPath={projectPath} />
        }
        // tool_result rendered by its tool_use pair (skip standalone)
        return null
      })}
    </div>
  )
}

function ToolChunk({ use, result, projectPath }: { use: TranscriptChunk; result?: TranscriptChunk; projectPath?: string }) {
  const [open, setOpen] = useState(false)
  const summary = describeTool(use, projectPath)
  const hasResult = result?.toolResult && result.toolResult.length > 0
  const isError = result?.toolError === true

  // Errors during exploration (Read of a path that doesn't exist, Grep
  // with zero matches, etc) are normal — the model probes the
  // codebase. Use amber (neutral "didn't succeed") instead of rose
  // ("something broke") so the card doesn't look catastrophic when it's
  // just the agent learning the project shape.
  return (
    <div className={`rounded border ${isError ? 'border-amber-500/20 bg-amber-500/[0.03]' : 'border-white/5 bg-white/[0.02]'}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-[10px]"
      >
        <span className={`font-mono ${isError ? 'text-amber-400/80' : 'text-amber-400'}`}>{isError ? '✗' : hasResult ? '✓' : '▶'}</span>
        <span className="font-medium text-zinc-300">{use.toolName}</span>
        <span className="truncate text-zinc-500">{summary}</span>
        {hasResult && (
          <span className="ml-auto shrink-0 text-[9px] text-zinc-600">{open ? 'hide' : 'show'}</span>
        )}
      </button>
      {open && hasResult && (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words border-t border-white/5 px-2 py-1 font-mono text-[10px] text-zinc-400">
          {result?.toolResult}
        </pre>
      )}
    </div>
  )
}

// Strip the worktree prefix from any path so logs show the
// project-relative form ("lib/foo.ts" instead of
// "/Users/<user>/.bornastar/worktrees/<hash>/wt-.../lib/foo.ts"),
// matching what the chat normal renders. Tolerates trailing slash
// differences and absolute paths that happen to live outside the
// worktree (returns them unchanged).
function relPath(absPath: string, projectPath?: string): string {
  if (!projectPath) return absPath
  const root = projectPath.endsWith('/') ? projectPath.slice(0, -1) : projectPath
  if (absPath === root) return '/'
  if (absPath.startsWith(root + '/')) return absPath.slice(root.length + 1)
  return absPath
}

// One-line summary of a tool call — file path for Read/Edit/Write,
// command for Bash, pattern for Grep, etc. Falls back to JSON of input
// for unknown tools. Paths are stripped of the worktree prefix.
function describeTool(chunk: TranscriptChunk, projectPath?: string): string {
  const input = chunk.toolInput ?? {}
  const name = chunk.toolName ?? ''
  if (name === 'Bash' && typeof input.command === 'string') {
    // Bash commands often contain absolute paths inline (e.g. `cat /Users/.../foo.ts`).
    // String-replace the worktree root globally so those embedded paths shrink too.
    let cmd = input.command
    if (projectPath) {
      const root = projectPath.endsWith('/') ? projectPath.slice(0, -1) : projectPath
      cmd = cmd.split(root + '/').join('')
      cmd = cmd.split(root).join('.')
    }
    return cmd.slice(0, 120)
  }
  if ((name === 'Read' || name === 'Write' || name === 'Edit' || name === 'MultiEdit') && typeof input.file_path === 'string') {
    return relPath(input.file_path, projectPath)
  }
  if (name === 'NotebookEdit' && typeof input.notebook_path === 'string') {
    return relPath(input.notebook_path, projectPath)
  }
  if (name === 'Grep' && typeof input.pattern === 'string') {
    const path = typeof input.path === 'string' ? ` in ${relPath(input.path, projectPath)}` : ''
    return `"${input.pattern}"${path}`
  }
  if (name === 'Glob' && typeof input.pattern === 'string') {
    const path = typeof input.path === 'string' ? ` in ${relPath(input.path, projectPath)}` : ''
    return `${input.pattern}${path}`
  }
  if (name === 'WebFetch' && typeof input.url === 'string') return input.url
  if (name === 'TodoWrite' && Array.isArray(input.todos)) return `${input.todos.length} todos`
  // Fallback: short JSON
  try {
    const s = JSON.stringify(input)
    return s.length > 100 ? s.slice(0, 100) + '…' : s
  } catch {
    return ''
  }
}

function StepRow({ step }: { step: NonNullable<NonNullable<RunSnapshotProgress['blocks']>[number]['steps']>[number] }) {
  const icon = step.status === 'completed' && step.decision === 'REJECT' ? '✗'
    : step.status === 'completed' && step.decision === 'FORCED_APPROVAL' ? '⚠'
    : step.status === 'completed' ? '✓'
    : step.status === 'failed' ? '✗'
    : step.status === 'cancelled' ? '⏸'
    : step.status === 'running' ? '▶'
    : '◌'
  const cls = step.status === 'completed' && step.decision === 'REJECT' ? 'text-rose-400'
    : step.status === 'completed' && step.decision === 'FORCED_APPROVAL' ? 'text-amber-400'
    : step.status === 'completed' ? 'text-emerald-400'
    : step.status === 'failed' ? 'text-rose-400'
    : step.status === 'cancelled' ? 'text-zinc-400'
    : step.status === 'running' ? 'text-amber-400 animate-pulse'
    : 'text-zinc-600'
  return (
    <div className="flex items-center gap-1.5 py-0.5 text-[11px]">
      <span className={`font-mono ${cls}`}>{icon}</span>
      <span className="font-medium text-zinc-200">{capitalize(step.role)}</span>
      {step.attempt > 1 && <span className="text-[9px] text-amber-400/80">retry {step.attempt}</span>}
      {step.durationMs !== undefined && (
        <span className="ml-auto text-[10px] text-zinc-500">{(step.durationMs / 1000).toFixed(1)}s</span>
      )}
    </div>
  )
}

function ThinkingLine({ label, startedAt, attempt }: { label: string; startedAt: number; attempt?: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const elapsed = Math.max(0, now - startedAt)
  const sec = elapsed >= 60_000
    ? `${Math.floor(elapsed / 60_000)}m${Math.floor((elapsed % 60_000) / 1000)}s`
    : `${Math.floor(elapsed / 1000)}s`
  return (
    <div className="mt-1 flex items-center gap-1.5 rounded px-1.5 py-1 text-[11px] text-amber-400">
      <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
      <span className="font-medium">{capitalize(label)}</span>
      {attempt !== undefined && attempt > 1 && <span>retry {attempt}</span>}
      <span className="text-amber-500/80">thinking… {sec}</span>
    </div>
  )
}

function capitalize(s: string): string {
  if (!s) return s
  return s.charAt(0).toUpperCase() + s.slice(1)
}
