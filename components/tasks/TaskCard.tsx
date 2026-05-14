'use client'

// Card variant for non-running task states. Renders inside the Pending,
// Scheduled, and Done columns of the TasksPanel. Running tasks use
// TaskRunningCard instead (different shape — live transcript inline).
//
// Click anywhere on the card → opens the manage modal. The card itself
// is read-only chrome; mutations all flow through the modal.

import type { TaskListItem } from './types'

interface Props {
  task: TaskListItem
  onOpen: () => void
}

export function TaskCard({ task, onOpen }: Props) {
  // Done/failed without a `reviewedAt` stamp = the user hasn't opened
  // the result yet. We keep the card amber to nag — flips to emerald
  // (done) or rose (failed) only after the manage modal pulls the
  // single-task GET (which auto-stamps reviewedAt server-side).
  const needsReview = (task.status === 'done' || task.status === 'failed') && !task.reviewedAt
  const accentKey: string = needsReview ? 'needs-review' : task.status
  const accent = ACCENTS[accentKey] ?? ACCENTS.pending
  const branchLabel = task.branchName ?? null

  return (
    <button
      onClick={onOpen}
      className={`group flex w-full flex-col gap-1 rounded-lg border bg-white/[0.02] px-3 py-2 text-left transition-colors hover:bg-white/[0.05] ${accent.border}`}
    >
      <div className="flex items-start gap-2">
        <span className={`mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full ${accent.dot}`} />
        <span className="flex-1 min-w-0 truncate text-sm text-zinc-100">{task.name}</span>
        {needsReview && (
          <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
            Review
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 pl-3.5 text-[11px] text-zinc-500">
        {branchLabel && (
          <span className="truncate font-mono text-zinc-400" title={branchLabel}>{branchLabel}</span>
        )}
        {branchLabel && <span className="text-zinc-700">·</span>}
        <span>{formatRelative(task.scheduledAt && task.status === 'scheduled' ? task.scheduledAt : task.createdAt)}</span>
        {task.status === 'scheduled' && task.scheduledAt && (
          <>
            <span className="text-zinc-700">·</span>
            <span className="text-blue-300">{formatScheduled(task.scheduledAt)}</span>
          </>
        )}
      </div>
    </button>
  )
}

const ACCENTS: Record<string, { border: string; dot: string }> = {
  pending: { border: 'border-amber-500/20 hover:border-amber-500/40', dot: 'bg-amber-400' },
  scheduled: { border: 'border-blue-500/20 hover:border-blue-500/40', dot: 'bg-blue-400' },
  done: { border: 'border-emerald-500/20 hover:border-emerald-500/40', dot: 'bg-emerald-400' },
  failed: { border: 'border-rose-500/20 hover:border-rose-500/40', dot: 'bg-rose-400' },
  // "Needs review" — done/failed but the user hasn't opened the modal
  // yet. Amber pulls the eye; one click resolves it to the real status.
  'needs-review': { border: 'border-amber-500/30 hover:border-amber-500/50', dot: 'bg-amber-400' },
}

function formatRelative(iso: string): string {
  const date = new Date(iso)
  const diff = Date.now() - date.getTime()
  const seconds = Math.round(diff / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days}d ago`
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function formatScheduled(iso: string): string {
  const date = new Date(iso)
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  if (sameDay) {
    return `today ${date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
  }
  return date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}
