'use client'

// Card variant for the Running side area. Auto-opens when the task is
// rendered (status='running' is the only filter the side area uses,
// so a collapsed card would be visual noise). Live progress streams
// inside, fixed-height with internal scroll so the card doesn't push
// the chat / sibling cards off-screen as the agent emits chunks.
//
// Two render branches by executor kind:
//
//   • workflow — reuses <WorkflowRunCard> directly, subscribing to the
//     existing workflowSnapshots store + workflow_progress SSE pipeline.
//     Zero new code path; the user sees the same rich card they'd see
//     in the chat (planner → blocks → tool transcripts).
//
//   • skill — subscribes to a per-iteration transcript cache fed by
//     task_iteration_chunk SSE frames the runner emits. Text-only
//     stream by default; tool_use entries surface as compact lines.

import { useEffect, useRef, useState } from 'react'
import type { TaskListItem } from './types'
import { useTaskIterationTranscript } from '@/lib/hooks/useCompanionStore'
import type { TaskTranscriptChunk } from '@/lib/companion-store'
import { WorkflowRunCard } from '../WorkflowRunCard'

interface Props {
  task: TaskListItem
  onOpen: () => void
}

export function TaskRunningCard({ task, onOpen }: Props) {
  // Default expanded: the side area only lists running tasks, and the
  // whole point of the card is the live transcript. Collapsing it
  // would force a click before the user can see what their task is
  // doing. Toggle stays as an escape hatch when the user wants to
  // declutter while many tasks run in parallel.
  const [expanded, setExpanded] = useState(true)
  const branchName = task.branchName
  const current = task.currentIteration
  const isWorkflow = current?.executorKind === 'workflow' && current.workflowRunId

  return (
    <div className="rounded-lg border border-violet-500/30 bg-violet-500/5">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-start gap-2 px-3 py-2 text-left"
      >
        <span className="mt-1 inline-flex h-2 w-2 shrink-0 items-center justify-center">
          <span className="absolute h-2 w-2 animate-ping rounded-full bg-violet-500 opacity-60" />
          <span className="relative h-1.5 w-1.5 rounded-full bg-violet-400" />
        </span>
        <div className="flex-1 min-w-0">
          <div className="truncate text-sm text-zinc-100">{task.name}</div>
          <div className="flex items-center gap-2 text-[11px] text-zinc-500">
            {branchName && <span className="truncate font-mono text-zinc-400" title={branchName}>{branchName}</span>}
            {branchName && current && <span className="text-zinc-700">·</span>}
            {current && <span className="truncate">{current.executorKind}</span>}
          </div>
        </div>
        <svg
          className={`mt-1 h-3 w-3 shrink-0 text-zinc-500 transition-transform ${expanded ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {expanded && (
        <div className="border-t border-violet-500/20 bg-black/20">
          {isWorkflow && current?.workflowRunId ? (
            // Reuse the existing chat workflow card — same data
            // pipeline (workflow_progress SSE → workflowSnapshots),
            // same UI affordances. Fixed-height container keeps the
            // card's visual footprint constant: as the agent emits
            // chunks the box DOESN'T grow, the scroll just kicks in.
            // Full inspection lives behind "Open task".
            <div className="chat-scroll h-[240px] overflow-y-auto p-2">
              <WorkflowRunCard runId={current.workflowRunId} />
            </div>
          ) : current?.id ? (
            <SkillTranscript iterationId={current.id} />
          ) : (
            <p className="h-[240px] px-3 py-2 text-[11px] italic text-zinc-500">Waiting for runner…</p>
          )}
          <div className="flex justify-end border-t border-violet-500/20 px-3 py-1.5">
            <button
              onClick={onOpen}
              className="rounded-md border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] text-zinc-300 hover:bg-white/[0.08]"
            >
              Open task
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// Skill-task live transcript. Pulls chunks from the companion store's
// per-iteration cache (fed by the SSE handler in CompanionProvider).
// Renders text inline, tool_use entries as one-line chips. Auto-scrolls
// to the bottom on new chunks unless the user scrolled up to read older
// output — same sticky-bottom pattern WorkflowRunCard's LiveTranscript
// uses, so the visual behavior matches across both kinds of tasks.
function SkillTranscript({ iterationId }: { iterationId: string }) {
  const chunks = useTaskIterationTranscript(iterationId)
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

  if (chunks.length === 0) {
    return <p className="h-[240px] px-3 py-2 text-[11px] italic text-zinc-500">Streaming…</p>
  }

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="chat-scroll h-[240px] space-y-1 overflow-y-auto px-3 py-2 text-[11px]"
    >
      {chunks.map((c, i) => (
        <ChunkLine key={i} chunk={c} />
      ))}
    </div>
  )
}

function ChunkLine({ chunk }: { chunk: TaskTranscriptChunk }) {
  if (chunk.type === 'text' && chunk.text) {
    return (
      <div className="whitespace-pre-wrap break-words font-mono text-zinc-300">
        {chunk.text}
      </div>
    )
  }
  if (chunk.type === 'thinking' && chunk.text) {
    return (
      <div className="whitespace-pre-wrap break-words italic text-zinc-500">
        {chunk.text}
      </div>
    )
  }
  if (chunk.type === 'tool_use' && chunk.toolName) {
    const summary = describeToolInput(chunk.toolInput)
    return (
      <div className="flex items-center gap-1.5 rounded border border-white/5 bg-white/[0.02] px-1.5 py-0.5">
        <span className="font-mono text-amber-400">▶</span>
        <span className="font-medium text-zinc-300">{chunk.toolName}</span>
        {summary && <span className="truncate text-zinc-500">{summary}</span>}
      </div>
    )
  }
  // tool_result chunks are paired with their tool_use; we skip standalone
  // rendering since the user already saw the tool_use line above.
  return null
}

function describeToolInput(input: Record<string, unknown> | undefined): string {
  if (!input) return ''
  if (typeof input.command === 'string') return input.command.slice(0, 80)
  if (typeof input.file_path === 'string') return input.file_path
  if (typeof input.pattern === 'string') return input.pattern
  if (typeof input.url === 'string') return input.url
  return ''
}
