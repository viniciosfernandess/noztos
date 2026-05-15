// Tasks tab — the in-project view at /tasks.
//
// Layout:
//   ┌────────────┬────────────┬────────────┬─────────────────┐
//   │  Pending   │ Scheduled  │   Done     │  Running        │
//   │            │            │            │ (side area —    │
//   │  cards…    │  cards…    │  cards…    │  collapsible    │
//   │            │            │            │  cards w/ live  │
//   │            │            │            │  transcript)    │
//   └────────────┴────────────┴────────────┴─────────────────┘
//
// Cards are click-through into the shared TaskManageModal which
// handles every action (save / run / schedule / cancel / delete). The
// side area uses TaskRunningCard with its own expand-to-transcript
// behavior. Failed tasks land in Done with rose accent.
//
// Data flow:
//   - Initial fetch on mount + on `refreshKey` bump (manage modal
//     reports changes via onChanged → refreshKey++ → list reloads).
//   - Light poll (every 8s) so running tasks update without manual
//     refresh. The poll is paused when the modal is open so the user
//     isn't fighting a re-render while editing.

'use client'

import { useEffect, useState, useCallback } from 'react'
import { TaskManageModal } from './tasks/TaskManageModal'
import { TaskCard } from './tasks/TaskCard'
import { TaskRunningCard } from './tasks/TaskRunningCard'
import type { TaskListItem, TaskDetail } from './tasks/types'

interface TasksPanelProps {
  projectId: string
  // Optional: when set, filter the listing to a single worktree
  // (used by the in-chat tasks panel that mirrors /tasks but scoped
  // to the active worktree). When omitted, behaves as the standalone
  // /tasks page and shows every task in the project.
  worktreeId?: string | null
}

const POLL_MS = 8_000

export function TasksPanel({ projectId, worktreeId }: TasksPanelProps) {
  const [tasks, setTasks] = useState<TaskListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedTask, setSelectedTask] = useState<TaskDetail | TaskListItem | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  const loadTasks = useCallback(async () => {
    try {
      const url = worktreeId
        ? `/api/projects/${projectId}/tasks?worktreeId=${encodeURIComponent(worktreeId)}`
        : `/api/projects/${projectId}/tasks`
      const res = await fetch(url)
      if (!res.ok) {
        const j = await res.json().catch(() => null)
        setError(j?.error ?? `Failed to load tasks (${res.status})`)
        return
      }
      const data = await res.json() as { tasks: TaskListItem[] }
      setTasks(data.tasks)
      setError(null)
    } finally {
      setLoading(false)
    }
  }, [projectId, worktreeId])

  useEffect(() => {
    void loadTasks()
  }, [loadTasks, refreshKey])

  // Light poll so the running side area reflects state changes (status
  // flips from running → done / failed) without the user refreshing.
  // Skipped while the modal is open to avoid clobbering inputs.
  useEffect(() => {
    if (selectedTask) return
    const t = setInterval(() => { void loadTasks() }, POLL_MS)
    return () => clearInterval(t)
  }, [selectedTask, loadTasks])

  async function openTask(task: TaskListItem) {
    // Optimistic review flip: when the user clicks a done/failed card
    // that's still amber (reviewedAt=null), assume the GET below will
    // stamp it server-side and update the local list right now so the
    // card flips emerald immediately. The server is still source of
    // truth — the .then() below reconciles whatever it returns. If
    // the GET fails, the next 8s poll re-fetches and corrects.
    const willStamp = (task.status === 'done' || task.status === 'failed') && !task.reviewedAt
    if (willStamp) {
      const nowIso = new Date().toISOString()
      setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, reviewedAt: nowIso } : t)))
    }

    // Fetch the full TaskDetail (including iterations) for the modal.
    try {
      const res = await fetch(`/api/projects/${projectId}/tasks/${task.id}`)
      if (res.ok) {
        const detail = await res.json() as TaskDetail
        setSelectedTask(detail)
        // Reconcile the list with whatever the server returned. The
        // iterations subarray belongs to TaskDetail only — we strip
        // it before merging so the list-level shape (TaskListItem)
        // stays clean. Cast to never because TS can't infer that the
        // destructured rest matches TaskListItem exactly.
        const { iterations: _iterations, ...listFields } = detail
        void _iterations
        setTasks((prev) => prev.map((t) => (t.id === detail.id ? { ...t, ...(listFields as unknown as TaskListItem) } : t)))
        return
      }
    } catch { /* fall through to list-level data */ }
    setSelectedTask(task)
  }

  const pending = tasks.filter((t) => t.status === 'pending')
  const scheduled = tasks.filter((t) => t.status === 'scheduled')
  const done = tasks.filter((t) => t.status === 'done' || t.status === 'failed')
  const running = tasks.filter((t) => t.status === 'running')

  return (
    // overflow-x-auto + min-w on the inner blocks: when the chat area
    // is narrowed by sidebars/filters, the running area no longer gets
    // clipped — instead the whole panel scrolls horizontally. Themed
    // scrollbar (chat-scroll) keeps it from showing the chunky native
    // macOS overlay. overflow-y-hidden on the outer leaves the column
    // bodies + running area to manage their own vertical scroll.
    <div className="chat-scroll flex flex-1 overflow-x-auto overflow-y-hidden" style={{ backgroundColor: '#1F1F1F' }}>
      {/* Main: 3 columns — min-w guarantees each column stays at least
          ~160 px wide; below that the parent scrolls instead of squishing. */}
      <div className="flex min-h-0 min-w-[480px] flex-1 flex-col">
        <div className="flex shrink-0 border-b border-white/10 text-[11px] uppercase tracking-wide text-zinc-500">
          <ColumnHeader label="Pending" count={pending.length} color="amber" />
          <ColumnHeader label="Scheduled" count={scheduled.length} color="blue" />
          <ColumnHeader label="Done" count={done.length} color="emerald" />
        </div>
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <Column>
            {loading && <EmptyState label="Loading…" />}
            {!loading && pending.length === 0 && <EmptyState label="No pending tasks" />}
            {pending.map((t) => (
              <TaskCard key={t.id} task={t} onOpen={() => openTask(t)} />
            ))}
          </Column>
          <Column>
            {loading && <EmptyState label="Loading…" />}
            {!loading && scheduled.length === 0 && <EmptyState label="No scheduled tasks" />}
            {scheduled.map((t) => (
              <TaskCard key={t.id} task={t} onOpen={() => openTask(t)} />
            ))}
          </Column>
          <Column last>
            {loading && <EmptyState label="Loading…" />}
            {!loading && done.length === 0 && <EmptyState label="No completed tasks" />}
            {done.map((t) => (
              <TaskCard key={t.id} task={t} onOpen={() => openTask(t)} />
            ))}
          </Column>
        </div>
      </div>

      {/* Side area: running */}
      <div className="flex w-72 shrink-0 flex-col border-l border-white/10" style={{ backgroundColor: '#1A1A1A' }}>
        <div className="flex shrink-0 items-center gap-2 border-b border-white/10 px-3 py-2 text-[11px] uppercase tracking-wide text-zinc-500">
          <span className="h-1.5 w-1.5 rounded-full bg-violet-400" />
          Running
          <span className="rounded bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-medium text-violet-300">{running.length}</span>
        </div>
        <div className="chat-scroll flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
          {running.length === 0 ? (
            <EmptyState label="No running tasks" />
          ) : (
            running.map((t) => (
              <TaskRunningCard
                key={t.id}
                task={t}
                onOpen={() => openTask(t)}
              />
            ))
          )}
        </div>
      </div>

      {error && (
        <div className="absolute right-3 top-3 z-10 rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
          {error}
        </div>
      )}

      <TaskManageModal
        projectId={projectId}
        open={selectedTask !== null}
        task={selectedTask}
        onClose={() => setSelectedTask(null)}
        onChanged={() => setRefreshKey((k) => k + 1)}
        // Chained task: fetch the fresh task and swap modal contents so
        // the user immediately configures the next link in the chain.
        onOpenChainedTask={async (taskId) => {
          try {
            const res = await fetch(`/api/projects/${projectId}/tasks/${taskId}`)
            if (res.ok) setSelectedTask(await res.json() as TaskDetail)
          } catch { /* keep modal as-is on failure */ }
        }}
      />
    </div>
  )
}

function Column({ children, last }: { children: React.ReactNode; last?: boolean }) {
  return (
    <div className={`chat-scroll flex min-h-0 min-w-[160px] flex-1 flex-col gap-2 overflow-y-auto p-3 ${last ? '' : 'border-r border-white/10'}`}>
      {children}
    </div>
  )
}

function ColumnHeader({ label, count, color }: { label: string; count: number; color: 'amber' | 'blue' | 'emerald' }) {
  const dot = {
    amber: 'bg-amber-400',
    blue: 'bg-blue-400',
    emerald: 'bg-emerald-400',
  }[color]
  const pill = {
    amber: 'bg-amber-500/15 text-amber-300',
    blue: 'bg-blue-500/15 text-blue-300',
    emerald: 'bg-emerald-500/15 text-emerald-300',
  }[color]
  return (
    <div className="flex flex-1 items-center gap-2 border-r border-white/10 px-3 py-2 last:border-r-0">
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      <span className="font-medium tracking-wide">{label}</span>
      <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${pill}`}>{count}</span>
    </div>
  )
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="flex flex-1 items-center justify-center text-[11px] italic text-zinc-600">
      {label}
    </div>
  )
}
