'use client'

// Card variant for the Running side area. Collapsed: shows the task
// name + spinner + the last action snippet streamed by the runner.
// Click → expands inline to show the live transcript (similar to the
// WorkflowRunCard transcript view in chat). Click again → collapses.
//
// Multiple cards can be expanded simultaneously — no exclusivity. When
// the task finishes, the parent unmounts this card and re-renders the
// finished task in the Done column.

import { useState } from 'react'
import type { TaskListItem } from './types'

interface Props {
  task: TaskListItem
  /** Last text chunk streamed by the runner — used as the snippet. */
  lastSnippet?: string | null
  /** Optional live transcript lines (text only, tool calls collapsed). */
  transcript?: string[]
  onOpen: () => void
}

export function TaskRunningCard({ task, lastSnippet, transcript = [], onOpen }: Props) {
  const [expanded, setExpanded] = useState(false)
  const branchName = task.branchName

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
            {branchName && lastSnippet && <span className="text-zinc-700">·</span>}
            {lastSnippet && <span className="truncate">{lastSnippet}</span>}
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
        <div className="border-t border-violet-500/20 bg-black/20 px-3 py-2">
          {transcript.length === 0 ? (
            <p className="text-[11px] italic text-zinc-500">No output yet…</p>
          ) : (
            <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] text-zinc-400">
              {transcript.join('\n')}
            </pre>
          )}
          <div className="mt-2 flex justify-end">
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
