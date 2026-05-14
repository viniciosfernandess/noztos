'use client'

// Shared task management modal. Opens from two entry points:
//   1. Right after a task is created from chat — via the "Manage now"
//      button on TaskCreatedConfirmModal.
//   2. From the /tasks tab — clicking any card.
//
// The same component handles every status (pending / scheduled /
// running / done / failed). It mutates the task via PATCH for config
// edits and dedicated POSTs for run / schedule / cancel.
//
// Actions per state:
//   Pending   → Save (PATCH) · Run now (POST /run) · Schedule (POST /schedule) · Delete (DELETE)
//   Scheduled → Save (PATCH) · Run now (clears schedule + runs) · Reschedule · Cancel schedule (DELETE /schedule) · Delete
//   Running   → Cancel (POST /cancel)
//   Done      → Re-run (POST /run with current config) · Edit + re-run · Delete
//
// The modal closes on its own when the parent says so (via `open` going
// false) or when the user clicks outside / X / Esc.

import { useEffect, useState } from 'react'
import { CHAT_MODE_NOTE, ExecutorKind, ChatMode, SKILL_OPTIONS, WORKFLOW_OPTIONS, TaskDetail, TaskListItem } from './types'

interface Props {
  projectId: string
  open: boolean
  task: TaskListItem | TaskDetail | null
  onClose: () => void
  onChanged?: () => void
  /** Hand off to a freshly-forked task. The parent typically re-fetches
   *  /tasks/[id] and sets it as the new selectedTask so the modal swaps
   *  contents without closing. */
  onOpenChainedTask?: (taskId: string) => void
}

const CHAT_MODES: { id: ChatMode; label: string; hint: string }[] = [
  { id: 'agent', label: 'Agent', hint: 'Can edit code on the worktree' },
  { id: 'plan', label: 'Plan', hint: 'Read-only — produces a plan, no edits' },
  { id: 'ask', label: 'Ask', hint: 'Read-only — answers without editing' },
]

export function TaskManageModal({ projectId, open, task, onClose, onChanged, onOpenChainedTask }: Props) {
  const [name, setName] = useState('')
  const [instruction, setInstruction] = useState('')
  const [executorKind, setExecutorKind] = useState<ExecutorKind | ''>('')
  const [executorId, setExecutorId] = useState('')
  const [chatMode, setChatMode] = useState<ChatMode | ''>('')
  const [scheduleAt, setScheduleAt] = useState('')
  const [showSchedule, setShowSchedule] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Sync local state when the task prop changes (different task opened)
  // or when the modal flips from closed to open.
  useEffect(() => {
    if (!task) return
    setName(task.name)
    setInstruction(task.instruction ?? '')
    setExecutorKind((task.executorKind as ExecutorKind) ?? '')
    setExecutorId(task.executorId ?? '')
    setChatMode((task.chatMode as ChatMode) ?? '')
    setScheduleAt(task.scheduledAt ? toLocalDatetime(task.scheduledAt) : '')
    setShowSchedule(false)
    setError(null)
  }, [task])

  if (!open || !task) return null

  // After the guard above task is non-null; bind to a const so closures
  // that fire later in the file don't re-trigger the null check.
  const currentTask = task
  const isRunning = currentTask.status === 'running'
  const isScheduled = currentTask.status === 'scheduled'
  const isDone = currentTask.status === 'done' || currentTask.status === 'failed'

  const canConfigure = !isRunning
  const configComplete =
    instruction.trim().length > 0 &&
    executorKind !== '' &&
    executorId !== '' &&
    chatMode !== '' &&
    !(executorKind === 'workflow' && chatMode !== 'agent')

  function pickExecutorKind(kind: ExecutorKind) {
    setExecutorKind(kind)
    setExecutorId('')
    if (kind === 'workflow') setChatMode('agent')
  }

  async function patchConfig(): Promise<TaskListItem | null> {
    const res = await fetch(`/api/projects/${projectId}/tasks/${currentTask.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name.trim() || undefined,
        instruction: instruction.trim() ? instruction.trim() : null,
        executorKind: executorKind || null,
        executorId: executorId || null,
        chatMode: chatMode || null,
      }),
    })
    if (!res.ok) {
      const j = await res.json().catch(() => null)
      setError(j?.error ?? `PATCH failed (${res.status})`)
      return null
    }
    return res.json()
  }

  async function handleSave() {
    setBusy('save')
    setError(null)
    const ok = await patchConfig()
    setBusy(null)
    if (ok) {
      onChanged?.()
      onClose()
    }
  }

  async function handleRunNow() {
    if (!configComplete) {
      setError('Fill instruction, executor, and chat mode before running.')
      return
    }
    setBusy('run')
    setError(null)
    const patched = await patchConfig()
    if (!patched) { setBusy(null); return }
    const res = await fetch(`/api/projects/${projectId}/tasks/${currentTask.id}/run`, { method: 'POST' })
    setBusy(null)
    if (!res.ok) {
      const j = await res.json().catch(() => null)
      setError(j?.error ?? `Run failed (${res.status})`)
      return
    }
    onChanged?.()
    onClose()
  }

  async function handleSchedule() {
    if (!configComplete) {
      setError('Fill instruction, executor, and chat mode before scheduling.')
      return
    }
    if (!scheduleAt) {
      setError('Pick a date and time.')
      return
    }
    setBusy('schedule')
    setError(null)
    const patched = await patchConfig()
    if (!patched) { setBusy(null); return }
    const res = await fetch(`/api/projects/${projectId}/tasks/${currentTask.id}/schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scheduledAt: new Date(scheduleAt).toISOString() }),
    })
    setBusy(null)
    if (!res.ok) {
      const j = await res.json().catch(() => null)
      setError(j?.error ?? `Schedule failed (${res.status})`)
      return
    }
    onChanged?.()
    onClose()
  }

  async function handleCancelSchedule() {
    setBusy('cancel-schedule')
    const res = await fetch(`/api/projects/${projectId}/tasks/${currentTask.id}/schedule`, { method: 'DELETE' })
    setBusy(null)
    if (!res.ok) {
      const j = await res.json().catch(() => null)
      setError(j?.error ?? `Cancel schedule failed (${res.status})`)
      return
    }
    onChanged?.()
    onClose()
  }

  async function handleCancelRun() {
    setBusy('cancel')
    const res = await fetch(`/api/projects/${projectId}/tasks/${currentTask.id}/cancel`, { method: 'POST' })
    setBusy(null)
    if (!res.ok) {
      const j = await res.json().catch(() => null)
      setError(j?.error ?? `Cancel failed (${res.status})`)
      return
    }
    onChanged?.()
    onClose()
  }

  async function handleCreateChained() {
    setBusy('chain')
    setError(null)
    const res = await fetch(`/api/projects/${projectId}/tasks/from-task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceTaskId: currentTask.id }),
    })
    setBusy(null)
    if (!res.ok) {
      const j = await res.json().catch(() => null)
      setError(j?.error ?? `Chain failed (${res.status})`)
      return
    }
    const created = await res.json() as { id: string }
    onChanged?.()
    // Hand the fresh task back to the parent so the same modal swaps
    // to the new task (ready to configure). If no handler wired, close.
    if (onOpenChainedTask) {
      onOpenChainedTask(created.id)
    } else {
      onClose()
    }
  }

  async function handleDelete() {
    if (!confirm(`Delete task "${currentTask.name}"? This can't be undone.`)) return
    setBusy('delete')
    const res = await fetch(`/api/projects/${projectId}/tasks/${currentTask.id}`, { method: 'DELETE' })
    setBusy(null)
    if (!res.ok) {
      const j = await res.json().catch(() => null)
      setError(j?.error ?? `Delete failed (${res.status})`)
      return
    }
    onChanged?.()
    onClose()
  }

  const executorOptions = executorKind === 'workflow' ? WORKFLOW_OPTIONS : executorKind === 'skill' ? SKILL_OPTIONS : []
  const contextLabel = currentTask.contextSource?.chatId
    ? `Context from chat ${currentTask.contextSource.chatId.slice(0, 8)} — ${currentTask.contextSource.rowCount ?? '?'} messages`
    : 'Context attached'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[88vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-white/10 shadow-2xl"
        style={{ backgroundColor: '#1F1F1F' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-3">
          <div className="flex-1 min-w-0">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={!canConfigure}
              className="w-full bg-transparent text-base font-medium text-zinc-100 outline-none placeholder:text-zinc-500"
              placeholder="Task name"
            />
            <StatusPill status={task.status} />
          </div>
          <button onClick={onClose} className="ml-3 rounded p-1.5 text-zinc-400 hover:bg-white/5 hover:text-zinc-200">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Branch + chain hint — always visible so the user knows which
              worktree this task will edit and whether it inherits context
              from a previous task. */}
          <div className="flex items-center gap-2 text-[11px] text-zinc-500">
            {currentTask.branchName && (
              <span className="rounded bg-white/[0.04] px-1.5 py-0.5 font-mono text-zinc-300">
                {currentTask.branchName}
              </span>
            )}
            {currentTask.sourceTaskId && (
              <span className="rounded bg-violet-500/10 px-1.5 py-0.5 text-violet-300">
                Chained — context inherited from previous task
              </span>
            )}
          </div>

          {isDone ? (
            <DoneView
              task={currentTask}
              iteration={'iterations' in currentTask && currentTask.iterations.length > 0
                ? currentTask.iterations[currentTask.iterations.length - 1]
                : null}
            />
          ) : (
            <>
              <Field label="Attached context">
                <div className="flex items-center gap-2 rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-zinc-400">
                  <svg className="h-4 w-4 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 17.25l-3-3 3-3M8.25 6.75l3 3-3 3" />
                  </svg>
                  <span className="truncate">{contextLabel}</span>
                </div>
              </Field>

              <Field label="Instruction">
                <textarea
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  disabled={!canConfigure}
                  rows={4}
                  placeholder="What should be done with the attached context?"
                  className="w-full resize-y rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-violet-500/40"
                />
              </Field>

              <Field label="Executor">
                <div className="grid grid-cols-2 gap-2">
                  <button
                    disabled={!canConfigure}
                    onClick={() => pickExecutorKind('workflow')}
                    className={`rounded-md border px-3 py-2 text-left text-sm ${executorKind === 'workflow' ? 'border-violet-500/60 bg-violet-500/10 text-violet-200' : 'border-white/10 bg-white/[0.02] text-zinc-300 hover:bg-white/[0.05]'} disabled:opacity-50`}
                  >
                    Workflow
                    <div className="mt-0.5 text-[11px] text-zinc-500">Multi-agent (build / debug)</div>
                  </button>
                  <button
                    disabled={!canConfigure}
                    onClick={() => pickExecutorKind('skill')}
                    className={`rounded-md border px-3 py-2 text-left text-sm ${executorKind === 'skill' ? 'border-violet-500/60 bg-violet-500/10 text-violet-200' : 'border-white/10 bg-white/[0.02] text-zinc-300 hover:bg-white/[0.05]'} disabled:opacity-50`}
                  >
                    Skill
                    <div className="mt-0.5 text-[11px] text-zinc-500">Single agent (CEO, Architect, …)</div>
                  </button>
                </div>
                {executorKind && (
                  <select
                    disabled={!canConfigure}
                    value={executorId}
                    onChange={(e) => setExecutorId(e.target.value)}
                    className="mt-2 w-full rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-zinc-100 outline-none focus:border-violet-500/40"
                  >
                    <option value="">Pick one…</option>
                    {executorOptions.map((opt) => (
                      <option key={opt.id} value={opt.id}>{opt.label}</option>
                    ))}
                  </select>
                )}
              </Field>

              <Field label="Chat mode">
                <div className="grid grid-cols-3 gap-2">
                  {CHAT_MODES.map((mode) => {
                    const disabled = !canConfigure || (executorKind === 'workflow' && mode.id !== 'agent')
                    return (
                      <button
                        key={mode.id}
                        disabled={disabled}
                        onClick={() => setChatMode(mode.id)}
                        className={`rounded-md border px-3 py-2 text-left text-sm ${chatMode === mode.id ? 'border-violet-500/60 bg-violet-500/10 text-violet-200' : 'border-white/10 bg-white/[0.02] text-zinc-300 hover:bg-white/[0.05]'} disabled:opacity-40`}
                        title={mode.hint}
                      >
                        {mode.label}
                        <div className="mt-0.5 text-[11px] text-zinc-500">{mode.hint}</div>
                      </button>
                    )
                  })}
                </div>
                {executorKind === 'workflow' && (
                  <p className="mt-1 text-[11px] text-zinc-500">{CHAT_MODE_NOTE}</p>
                )}
              </Field>

              {showSchedule && (
                <Field label="Run at">
                  <input
                    type="datetime-local"
                    value={scheduleAt}
                    onChange={(e) => setScheduleAt(e.target.value)}
                    className="w-full rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-zinc-100 outline-none focus:border-violet-500/40"
                  />
                </Field>
              )}
            </>
          )}

          {error && (
            <div className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
              {error}
            </div>
          )}
        </div>

        {/* Footer — actions per state */}
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-white/10 bg-white/[0.02] px-5 py-3">
          {isRunning && (
            <ActionButton variant="danger" onClick={handleCancelRun} busy={busy === 'cancel'}>Cancel run</ActionButton>
          )}

          {isDone && (
            <>
              <ActionButton variant="ghost" onClick={handleDelete} busy={busy === 'delete'}>Delete</ActionButton>
              <ActionButton variant="primary" onClick={handleCreateChained} busy={busy === 'chain'}>
                Create chained task
              </ActionButton>
            </>
          )}

          {!isRunning && !isDone && (
            <>
              <ActionButton variant="ghost" onClick={handleDelete} busy={busy === 'delete'}>Delete</ActionButton>

              {isScheduled && (
                <ActionButton variant="ghost" onClick={handleCancelSchedule} busy={busy === 'cancel-schedule'}>
                  Cancel schedule
                </ActionButton>
              )}

              {!showSchedule && (
                <ActionButton variant="secondary" onClick={() => setShowSchedule(true)} disabled={!configComplete}>
                  {isScheduled ? 'Reschedule' : 'Schedule'}
                </ActionButton>
              )}
              {showSchedule && (
                <ActionButton variant="secondary" onClick={handleSchedule} busy={busy === 'schedule'} disabled={!configComplete || !scheduleAt}>
                  Save schedule
                </ActionButton>
              )}

              <ActionButton variant="primary" onClick={handleRunNow} busy={busy === 'run'} disabled={!configComplete}>
                Run now
              </ActionButton>

              <ActionButton variant="ghost" onClick={handleSave} busy={busy === 'save'}>Save</ActionButton>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-[11px] uppercase tracking-wide text-zinc-500">{label}</div>
      {children}
    </div>
  )
}

function StatusPill({ status }: { status: string }) {
  const styles: Record<string, string> = {
    pending: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
    scheduled: 'border-blue-500/30 bg-blue-500/10 text-blue-300',
    running: 'border-violet-500/30 bg-violet-500/10 text-violet-300',
    done: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
    failed: 'border-rose-500/30 bg-rose-500/10 text-rose-300',
  }
  return (
    <span className={`mt-1 inline-block rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${styles[status] ?? styles.pending}`}>
      {status}
    </span>
  )
}

function ActionButton({
  variant,
  onClick,
  busy,
  disabled,
  children,
}: {
  variant: 'primary' | 'secondary' | 'ghost' | 'danger'
  onClick: () => void
  busy?: boolean
  disabled?: boolean
  children: React.ReactNode
}) {
  const variants: Record<typeof variant, string> = {
    primary: 'bg-violet-600 text-white hover:bg-violet-500 disabled:bg-violet-600/40',
    secondary: 'border border-white/10 bg-white/[0.04] text-zinc-200 hover:bg-white/[0.08] disabled:opacity-40',
    ghost: 'text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-200',
    danger: 'bg-rose-600 text-white hover:bg-rose-500',
  }
  return (
    <button
      onClick={onClick}
      disabled={disabled || busy}
      className={`rounded-md px-3 py-1.5 text-sm transition-colors disabled:cursor-not-allowed ${variants[variant]}`}
    >
      {busy ? '…' : children}
    </button>
  )
}

// Done view: replaces every form field with a clean recap — what ran,
// what was asked, what the model answered. The user said the frozen
// chat context shouldn't re-render here (the work is done; what matters
// is the result and the link forward via "Create chained task").
function DoneView({
  task,
  iteration,
}: {
  task: TaskListItem | TaskDetail
  iteration: {
    status: string
    instruction: string
    executorKind: string
    executorId: string
    chatMode: string
    finishedAt: string | null
    outputSummary: string | null
    fullOutput: string | null
    errorReason: string | null
    filesTouched: string[] | null
    workflowRunId: string | null
  } | null
}) {
  if (!iteration) {
    return (
      <div className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-3 text-xs italic text-zinc-500">
        No iteration recorded yet.
      </div>
    )
  }
  // fullOutput is the chat-style answer; outputSummary is the short
  // form. Prefer fullOutput so the user sees the whole reasoning
  // (matches what would land in a chat thread).
  const response = iteration.fullOutput ?? iteration.outputSummary ?? ''
  const isFailure = iteration.status === 'failed' || task.status === 'failed'

  return (
    <div className="space-y-4">
      <Field label="Run configuration">
        <div className="grid grid-cols-2 gap-2 rounded-md border border-white/10 bg-white/[0.03] px-3 py-2.5 text-[11px] text-zinc-400 sm:grid-cols-3">
          <ConfigItem label="Executor" value={`${iteration.executorKind} / ${iteration.executorId}`} />
          <ConfigItem label="Mode" value={iteration.chatMode} />
          <ConfigItem
            label="Finished"
            value={iteration.finishedAt ? new Date(iteration.finishedAt).toLocaleString('en-US') : '—'}
          />
        </div>
      </Field>

      <Field label="Instruction">
        <div className="whitespace-pre-wrap rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-zinc-200">
          {iteration.instruction}
        </div>
      </Field>

      <Field label={isFailure ? 'Error' : 'Response'}>
        <div
          className={`whitespace-pre-wrap rounded-md border px-3 py-2 text-sm ${
            isFailure
              ? 'border-rose-500/30 bg-rose-500/5 text-rose-200'
              : 'border-emerald-500/20 bg-emerald-500/5 text-zinc-100'
          }`}
        >
          {isFailure ? (iteration.errorReason ?? 'Run failed (no reason recorded).') : (response || 'No response captured.')}
        </div>
      </Field>

      {iteration.filesTouched && iteration.filesTouched.length > 0 && (
        <Field label="Files touched">
          <ul className="space-y-0.5 rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-[11px] font-mono text-zinc-300">
            {iteration.filesTouched.map((f) => (
              <li key={f} className="truncate">{f}</li>
            ))}
          </ul>
        </Field>
      )}
    </div>
  )
}

function ConfigItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="truncate font-mono text-xs text-zinc-200" title={value}>{value}</div>
    </div>
  )
}

// `datetime-local` inputs need YYYY-MM-DDTHH:mm in local time; trim the
// seconds and timezone off an ISO string so the picker pre-fills it.
function toLocalDatetime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
