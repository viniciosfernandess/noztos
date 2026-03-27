'use client'

import { useState, useEffect, useRef } from 'react'

// ── Types ──────────────────────────────────────────────────────────────────

interface RunningTask {
  id: string
  name: string
  instruction: string | null
  executorType: string
  executorId: string | null
  accumulatedContext: {
    model?: string
    intent?: string
  }
  pausedAtEmployee: string | null
  scheduledAt: string | null
}

interface SkillLog {
  id: string
  collaboratorName: string
  thoughts: string | null
  conclusion: string | null
  approved: boolean | null
  rejectionReason: string | null
  startedAt: string
  finishedAt: string | null
}

interface BuildLog {
  id: string
  filesTouched: { path: string; action: string }[]
  createdAt: string
}

const EMPLOYEES: Record<string, { color: string }> = {
  CEO: { color: 'from-violet-500 to-purple-600' },
  Architect: { color: 'from-blue-500 to-cyan-600' },
  Designer: { color: 'from-pink-500 to-rose-600' },
  Security: { color: 'from-red-500 to-orange-600' },
  Builder: { color: 'from-red-600 to-red-700' },
  Claude: { color: 'from-zinc-500 to-zinc-600' },
}

const INTENT_LABELS: Record<string, { label: string; color: string }> = {
  build: { label: 'Build', color: 'text-emerald-400' },
  analyze_fix: { label: 'Analyze & Fix', color: 'text-amber-400' },
  conversation: { label: 'Review & Discuss', color: 'text-sky-400' },
}

// ── Main Component ─────────────────────────────────────────────────────────

export function TaskRunnerViewer({ projectId }: { projectId: string }) {
  const [task, setTask] = useState<RunningTask | null>(null)
  const [logs, setLogs] = useState<SkillLog[]>([])
  const [buildLogs, setBuildLogs] = useState<BuildLog[]>([])
  const [pausing, setPausing] = useState(false)
  const [showPauseModal, setShowPauseModal] = useState(false)
  const [lastCompleted, setLastCompleted] = useState<{ name: string; completedAt: string; intent?: string } | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Poll for running task every 3s
  useEffect(() => {
    // Fetch last completed task
    fetch(`/api/projects/${projectId}/tasks?status=completed&limit=1`)
      .then((r) => r.json())
      .then((data) => {
        const tasks = data.tasks ?? data ?? []
        if (tasks.length > 0) {
          const t = tasks[0]
          setLastCompleted({
            name: t.name,
            completedAt: t.updatedAt ?? t.createdAt,
            intent: t.accumulatedContext?.intent,
          })
        }
      })
      .catch(() => {})
  }, [projectId])

  useEffect(() => {
    function poll() {
      fetch(`/api/projects/${projectId}/tasks/running`)
        .then((r) => r.json())
        .then((data) => {
          setTask(data.task ?? null)
          setLogs(data.logs ?? [])
          setBuildLogs(data.buildLogs ?? [])
        })
        .catch(() => {})
    }

    poll()
    pollRef.current = setInterval(poll, 3000)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [projectId])

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [logs.length])

  async function handlePauseAction(mode: 'continue' | 'restart' | 'delete') {
    if (!task || pausing) return
    setPausing(true)
    try {
      await fetch(`/api/projects/${projectId}/tasks/${task.id}/pause`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      })
      setTask(null)
      setLogs([])
      setBuildLogs([])
      setShowPauseModal(false)
    } catch {}
    setPausing(false)
  }

  // No running task
  if (!task) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 px-6">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white/5">
          <svg className="h-5 w-5 text-zinc-600" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.348a1.125 1.125 0 010 1.971l-11.54 6.347a1.125 1.125 0 01-1.667-.985V5.653z" />
          </svg>
        </div>
        <div className="text-center">
          <p className="text-xs text-zinc-500">No task running</p>
          <p className="text-[10px] text-zinc-600 mt-0.5">Start a task from the queue or wait for auto-start</p>
        </div>

        {/* Last completed task */}
        {lastCompleted && (
          <div className="w-full rounded-lg border border-white/10 bg-white/[0.03] p-3">
            <p className="text-[9px] font-semibold uppercase tracking-wider text-zinc-600 mb-1.5">Last Completed</p>
            <p className="text-[11px] font-medium text-zinc-300 line-clamp-2">{lastCompleted.name}</p>
            <div className="mt-1.5 flex items-center gap-2">
              <svg className="h-3 w-3 text-emerald-500" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
              </svg>
              <span className="text-[10px] text-zinc-500">{getTimeAgoFn(lastCompleted.completedAt)}</span>
              {lastCompleted.intent && (
                <span className={`text-[9px] font-medium ${
                  lastCompleted.intent === 'build' ? 'text-emerald-400' :
                  lastCompleted.intent === 'analyze_fix' ? 'text-amber-400' : 'text-sky-400'
                }`}>
                  {lastCompleted.intent === 'build' ? 'Build' : lastCompleted.intent === 'analyze_fix' ? 'Analyze' : 'Review'}
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    )
  }

  const intent = INTENT_LABELS[task.accumulatedContext?.intent ?? '']
  const model = task.accumulatedContext?.model ?? 'sonnet'
  const allFiles = buildLogs.flatMap((b) => b.filesTouched)
  const activeEmployee = task.pausedAtEmployee
  const isTeam = task.executorType === 'team'

  return (
    <div className="flex h-full flex-col">
      {/* Task info bar */}
      <div className="shrink-0 border-b border-white/10 px-4 py-3" style={{ backgroundColor: '#15151c' }}>
        <div className="flex items-center justify-between">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-zinc-200 truncate">{task.name}</p>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {intent && <span className={`text-[9px] font-medium ${intent.color}`}>{intent.label}</span>}
              <span className="text-[9px] text-zinc-600">·</span>
              <span className="text-[9px] text-zinc-500">{model}</span>
              {task.scheduledAt && (
                <>
                  <span className="text-[9px] text-zinc-600">·</span>
                  <span className="text-[9px] text-amber-400">
                    {new Date(task.scheduledAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                  </span>
                </>
              )}
            </div>
          </div>
          {/* Pause button */}
          <button
            onClick={() => setShowPauseModal(true)}
            className="flex h-7 items-center gap-1.5 rounded-lg bg-red-500/10 px-2.5 text-[10px] font-medium text-red-400 transition-colors hover:bg-red-500/20"
          >
            <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 24 24">
              <rect x="6" y="4" width="4" height="16" rx="1" />
              <rect x="14" y="4" width="4" height="16" rx="1" />
            </svg>
            Pause
          </button>
        </div>

        {/* Progress indicator */}
        <div className="mt-2 flex items-center gap-2">
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/5">
            <div className="h-full animate-pulse rounded-full bg-gradient-to-r from-violet-500 to-indigo-500" style={{ width: '100%' }} />
          </div>
          <span className="text-[9px] text-zinc-500">{logs.length} step{logs.length !== 1 ? 's' : ''}</span>
        </div>
      </div>

      {/* Live output */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
        {logs.length === 0 && (
          <div className="flex items-center gap-2 py-4">
            <div className="h-2 w-2 animate-pulse rounded-full bg-violet-500" />
            <span className="text-[11px] text-zinc-500">Starting task...</span>
          </div>
        )}

        {logs.map((log, i) => {
          const empColor = EMPLOYEES[log.collaboratorName]?.color ?? 'from-zinc-500 to-zinc-600'
          const isActive = !log.finishedAt
          const isDone = !!log.finishedAt

          return (
            <div key={log.id} className={`rounded-lg border p-3 transition-all ${
              isActive
                ? 'border-violet-500/30 bg-violet-500/[0.06]'
                : 'border-white/10 bg-white/[0.02]'
            }`}>
              {/* Employee header */}
              <div className="flex items-center gap-2 mb-1.5">
                <span className={`rounded bg-gradient-to-br ${empColor} px-1.5 py-0.5 text-[9px] font-bold text-white`}>
                  {log.collaboratorName}
                </span>
                {isActive && (
                  <div className="flex items-center gap-1">
                    <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-violet-500" />
                    <span className="text-[9px] text-violet-400">working...</span>
                  </div>
                )}
                {isDone && log.approved === true && (
                  <span className="rounded bg-emerald-500/20 px-1 py-0.5 text-[8px] font-medium text-emerald-400">APPROVED</span>
                )}
                {isDone && log.approved === false && (
                  <span className="rounded bg-red-500/20 px-1 py-0.5 text-[8px] font-medium text-red-400">REJECTED</span>
                )}
                {isDone && log.approved === null && (
                  <svg className="h-3 w-3 text-emerald-500" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                )}
              </div>

              {/* Output */}
              {log.conclusion ? (
                <p className="text-[11px] leading-relaxed text-zinc-400 whitespace-pre-wrap line-clamp-6">
                  {log.conclusion}
                </p>
              ) : log.thoughts ? (
                <p className="text-[11px] leading-relaxed text-zinc-500 whitespace-pre-wrap line-clamp-4">
                  {log.thoughts}
                </p>
              ) : isActive ? (
                <div className="flex gap-1 py-1">
                  <div className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-600" style={{ animationDelay: '0ms' }} />
                  <div className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-600" style={{ animationDelay: '150ms' }} />
                  <div className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-600" style={{ animationDelay: '300ms' }} />
                </div>
              ) : null}

              {/* Rejection reason */}
              {log.rejectionReason && (
                <div className="mt-1.5 rounded border border-red-500/20 bg-red-500/5 px-2 py-1">
                  <p className="text-[10px] text-red-400">{log.rejectionReason}</p>
                </div>
              )}
            </div>
          )
        })}

        {/* Files touched */}
        {allFiles.length > 0 && (
          <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
            <p className="mb-1.5 text-[9px] font-semibold uppercase tracking-wider text-zinc-600">Files Touched</p>
            <div className="space-y-0.5">
              {allFiles.map((f, i) => (
                <div key={i} className="flex items-center gap-1.5 text-[10px]">
                  <span className={`font-mono ${f.action === 'delete' ? 'text-red-400' : 'text-emerald-400'}`}>
                    {f.action === 'delete' ? 'D' : 'M'}
                  </span>
                  <span className="text-zinc-400 truncate">{f.path}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Active employee indicator at bottom */}
        {activeEmployee && logs.length > 0 && logs[logs.length - 1]?.finishedAt && (
          <div className="flex items-center gap-2 py-2">
            <div className="h-2 w-2 animate-pulse rounded-full bg-violet-500" />
            <span className="text-[10px] text-zinc-500">Moving to next step...</span>
          </div>
        )}
      </div>

      {/* Pause modal */}
      {showPauseModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowPauseModal(false)}>
          <div
            className="w-full max-w-sm overflow-hidden rounded-2xl border border-white/10 shadow-2xl"
            style={{ backgroundColor: '#1a1a22' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="border-b border-white/10 px-6 py-4" style={{ backgroundColor: '#15151c' }}>
              <h2 className="text-sm font-semibold text-zinc-100">Pause Task</h2>
              <p className="text-[11px] text-zinc-500 mt-0.5">{task.name}</p>
            </div>

            <div className="p-5 space-y-2">
              {/* Option 1: Continue where stopped */}
              <button
                onClick={() => handlePauseAction('continue')}
                disabled={pausing}
                className="flex w-full items-start gap-3 rounded-lg border border-white/10 p-3 text-left transition-all hover:border-violet-500/30 hover:bg-violet-500/[0.04] disabled:opacity-50"
              >
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-violet-500/15 mt-0.5">
                  <svg className="h-3.5 w-3.5 text-violet-400" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25v13.5m-7.5-13.5v13.5" />
                  </svg>
                </div>
                <div>
                  <p className="text-xs font-medium text-zinc-200">Pause & Continue Later</p>
                  <p className="mt-0.5 text-[10px] text-zinc-500">Changes to files will be kept. Task will continue from where it stopped. If files were modified externally, it will restart automatically.</p>
                </div>
              </button>

              {/* Option 2: Restart from zero */}
              <button
                onClick={() => handlePauseAction('restart')}
                disabled={pausing}
                className="flex w-full items-start gap-3 rounded-lg border border-white/10 p-3 text-left transition-all hover:border-amber-500/30 hover:bg-amber-500/[0.04] disabled:opacity-50"
              >
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-amber-500/15 mt-0.5">
                  <svg className="h-3.5 w-3.5 text-amber-400" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182" />
                  </svg>
                </div>
                <div>
                  <p className="text-xs font-medium text-zinc-200">Restart from Zero</p>
                  <p className="mt-0.5 text-[10px] text-zinc-500">All progress will be lost. File changes will be reverted. Task keeps its configuration and goes back to the queue to run fresh.</p>
                </div>
              </button>

              {/* Option 3: Delete */}
              <button
                onClick={() => handlePauseAction('delete')}
                disabled={pausing}
                className="flex w-full items-start gap-3 rounded-lg border border-white/10 p-3 text-left transition-all hover:border-red-500/30 hover:bg-red-500/[0.04] disabled:opacity-50"
              >
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-red-500/15 mt-0.5">
                  <svg className="h-3.5 w-3.5 text-red-400" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                  </svg>
                </div>
                <div>
                  <p className="text-xs font-medium text-zinc-200">Delete Task</p>
                  <p className="mt-0.5 text-[10px] text-zinc-500">Task will be permanently deleted. File changes will be reverted.</p>
                </div>
              </button>

              {/* Cancel */}
              <button
                onClick={() => setShowPauseModal(false)}
                className="w-full pt-1 text-center text-xs text-zinc-500 hover:text-zinc-300"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function getTimeAgoFn(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}
