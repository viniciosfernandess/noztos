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
  // Confirmation modal for delete — replaces the browser confirm()
  // so the visual stays consistent with the rest of the app and the
  // user can't accidentally dismiss with a stray Enter press.
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  // Sync local state when the task prop changes (different task opened)
  // or when the modal flips from closed to open. Schedule defaults to
  // the task's saved value when present, or "now + 15 min" in the
  // user's local timezone — so the datetime input always opens with a
  // sane near-future timestamp instead of asking the user to type it
  // from scratch. `datetime-local` interprets YYYY-MM-DDTHH:mm as the
  // user's local TZ (no UTC surprises), and `new Date(value).toISOString()`
  // on submit converts back to UTC for storage.
  useEffect(() => {
    if (!task) return
    setName(task.name)
    setInstruction(task.instruction ?? '')
    setExecutorKind((task.executorKind as ExecutorKind) ?? '')
    setExecutorId(task.executorId ?? '')
    setChatMode((task.chatMode as ChatMode) ?? '')
    setScheduleAt(task.scheduledAt ? toLocalDatetime(task.scheduledAt) : defaultScheduleAt())
    setShowSchedule(false)
    setShowDeleteConfirm(false)
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

  // Two-step delete: button opens the confirm modal; confirm modal
  // calls confirmDelete which actually hits the API. Replaces the
  // native browser confirm() so the visual is consistent and an
  // accidental Enter press can't fire the destructive action.
  function handleDelete() {
    setError(null)
    setShowDeleteConfirm(true)
  }

  async function confirmDelete() {
    setBusy('delete')
    const res = await fetch(`/api/projects/${projectId}/tasks/${currentTask.id}`, { method: 'DELETE' })
    setBusy(null)
    setShowDeleteConfirm(false)
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
                  <SchedulePicker value={scheduleAt} onChange={setScheduleAt} />
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
                New task <span className="opacity-70">(cumulative context)</span>
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
                // Entry button is always clickable when not running —
                // opens the date picker so the user can choose a time
                // in any order, even before filling instruction /
                // executor / chat mode. The actual "Save schedule"
                // action below still requires configComplete so an
                // incomplete task can never be persisted in the
                // scheduled column.
                <ActionButton variant="secondary" onClick={() => setShowSchedule(true)}>
                  {isScheduled ? 'Reschedule' : 'Schedule'}
                </ActionButton>
              )}
              {showSchedule && (
                // Always clickable when not running. handleSchedule
                // shows a clear inline error if config is incomplete
                // or the datetime is empty — better than a silently
                // greyed button the user has to guess at.
                <ActionButton variant="secondary" onClick={handleSchedule} busy={busy === 'schedule'}>
                  Save schedule
                </ActionButton>
              )}

              <ActionButton variant="primary" onClick={handleRunNow} busy={busy === 'run'} disabled={!configComplete}>
                Run now
              </ActionButton>
            </>
          )}
        </div>
      </div>

      {/* Delete confirmation overlay — rendered as a sibling of the
          main modal so its z-index sits above and clicks on its
          backdrop don't propagate to the parent (which would close
          both). Stays mounted only while showDeleteConfirm is true. */}
      {showDeleteConfirm && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 px-4"
          onClick={(e) => { e.stopPropagation(); setShowDeleteConfirm(false) }}
        >
          <div
            className="w-full max-w-sm rounded-2xl border border-white/10 shadow-2xl"
            style={{ backgroundColor: '#1F1F1F' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="border-b border-white/10 px-5 py-3">
              <p className="text-base font-medium text-zinc-100">Delete this task?</p>
              <p className="mt-1 text-xs text-zinc-400">
                &quot;{currentTask.name}&quot; will be permanently removed along with all its iterations. This can&apos;t be undone.
              </p>
            </div>
            <div className="flex justify-end gap-2 px-5 py-3">
              <ActionButton variant="ghost" onClick={() => setShowDeleteConfirm(false)}>Cancel</ActionButton>
              <ActionButton variant="danger" onClick={confirmDelete} busy={busy === 'delete'}>Delete task</ActionButton>
            </div>
          </div>
        </div>
      )}
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
  return toLocalInputValue(d)
}

// Default schedule timestamp = now + 1 hour in the user's local TZ.
// Pre-fills the datetime-local input on first open so the picker
// always shows a near-future moment instead of an empty field.
function defaultScheduleAt(): string {
  return toLocalInputValue(new Date(Date.now() + 60 * 60 * 1000))
}

// Format a Date as YYYY-MM-DDTHH:mm in local time — the shape
// `datetime-local` inputs accept (no TZ suffix, no seconds). Used as
// both the input value and the `min` attribute so the browser blocks
// past dates natively.
function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// Round a Date down to the nearest 5-minute mark — keeps preset
// timestamps "clean" (e.g. 9:00 instead of 9:03) and aligns with the
// input's step=300 granularity.
function floorTo5Min(d: Date): Date {
  const copy = new Date(d)
  copy.setSeconds(0, 0)
  copy.setMinutes(Math.floor(copy.getMinutes() / 5) * 5)
  return copy
}

// Compute each quick-preset's resulting Date. Centralized so the chip
// labels and onClick handlers stay in sync.
//
//   • In N hours — `now + N * 1h`, floored to 5 min
//   • Tonight 9pm — today 21:00 if still future, else tomorrow 21:00
//   • Tomorrow 9am — tomorrow at 09:00
//   • Next Monday 9am — the next Monday after today at 09:00 (skips
//     today if today is Monday — "next" meaning a fresh week)
function schedulePresets(): Array<{ id: string; label: string; at: Date }> {
  const now = new Date()
  const today9pm = new Date(now)
  today9pm.setHours(21, 0, 0, 0)
  const targetTonight = today9pm.getTime() > now.getTime() + 5 * 60 * 1000
    ? today9pm
    : new Date(today9pm.getTime() + 24 * 60 * 60 * 1000)
  const tomorrow9am = new Date(now)
  tomorrow9am.setDate(tomorrow9am.getDate() + 1)
  tomorrow9am.setHours(9, 0, 0, 0)
  const nextMonday9am = new Date(now)
  // 1 = Monday in Date.getDay(). Compute days-until-next-Monday;
  // when today is Monday, jump to the following Monday (7 days).
  const daysUntilMonday = ((1 - now.getDay() + 7) % 7) || 7
  nextMonday9am.setDate(nextMonday9am.getDate() + daysUntilMonday)
  nextMonday9am.setHours(9, 0, 0, 0)
  return [
    { id: '30m',     label: 'In 30 min',     at: floorTo5Min(new Date(now.getTime() + 30 * 60 * 1000)) },
    { id: '1h',      label: 'In 1 hour',     at: floorTo5Min(new Date(now.getTime() + 60 * 60 * 1000)) },
    { id: '3h',      label: 'In 3 hours',    at: floorTo5Min(new Date(now.getTime() + 3 * 60 * 60 * 1000)) },
    { id: 'tonight', label: 'Tonight 9pm',   at: targetTonight },
    { id: 'tom9',    label: 'Tomorrow 9am',  at: tomorrow9am },
    { id: 'mon9',    label: 'Next Mon 9am',  at: nextMonday9am },
  ]
}

// Pretty preview of a chosen schedule moment: "Friday, May 15 at 09:00
// — in 12 hours". Locale en-US to match the rest of the task UI
// (formatRelative in TaskCard etc). Timezone name pulled from
// Intl.DateTimeFormat so the user always knows which clock the time
// is in — critical when scheduling from a laptop while traveling.
function previewSchedule(localValue: string): { pretty: string; relative: string; tz: string; invalid: boolean; isPast: boolean } {
  const d = new Date(localValue)
  if (!localValue || Number.isNaN(d.getTime())) {
    return { pretty: '', relative: '', tz: '', invalid: true, isPast: false }
  }
  const isPast = d.getTime() < Date.now() - 60 * 1000
  const pretty = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d)
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const diffMs = d.getTime() - Date.now()
  const relative = relativeFromMs(diffMs)
  return { pretty, relative, tz, invalid: false, isPast }
}

function relativeFromMs(ms: number): string {
  const abs = Math.abs(ms)
  const minutes = Math.round(abs / 60_000)
  const hours = Math.round(abs / 3_600_000)
  const days = Math.round(abs / 86_400_000)
  const sign = ms < 0 ? 'ago' : 'from now'
  if (minutes < 60) return `${minutes} min ${sign}`
  if (hours < 24)   return `${hours} hour${hours === 1 ? '' : 's'} ${sign}`
  return `${days} day${days === 1 ? '' : 's'} ${sign}`
}

// Composite schedule input — quick presets + native datetime input +
// live preview with local-tz label. Same lifted-state pattern as the
// rest of the form (parent owns scheduleAt). Replaces the bare
// datetime-local that was easy to fill wrong (past time, no feedback
// on which timezone the user just picked).
function SchedulePicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const presets = schedulePresets()
  const minValue = toLocalInputValue(new Date(Date.now() + 60 * 1000)) // 1 min in future
  const preview = previewSchedule(value)
  return (
    <div className="space-y-2.5">
      {/* Quick presets — most schedules fall into one of these patterns
          so a single click sets a sensible moment instead of forcing
          the user to spin a date picker for an absolute time. */}
      <div className="flex flex-wrap gap-1.5">
        {presets.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onChange(toLocalInputValue(p.at))}
            className="rounded-md border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[11px] text-zinc-300 transition-colors hover:border-white/20 hover:bg-white/[0.06]"
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Native datetime-local with min/step guards. `min` blocks past
          dates at the browser level (no need to error after submit);
          `step=300` snaps to 5-minute increments, matching the
          presets and the scheduler's 60s tick granularity. */}
      <input
        type="datetime-local"
        value={value}
        min={minValue}
        step={300}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-zinc-100 outline-none focus:border-violet-500/40"
      />

      {/* Live preview — explicit timezone, friendly day/time, and a
          relative offset. The TZ label is essential when scheduling
          from a laptop that may roam (the daemon fires on UTC; what
          the user types is their local time, and they should see
          which local). */}
      {!preview.invalid && (
        <div className={`flex items-center justify-between gap-2 text-[11px] ${preview.isPast ? 'text-rose-300' : 'text-zinc-400'}`}>
          <span>
            {preview.pretty} <span className="text-zinc-500">· {preview.relative}</span>
          </span>
          <span className="text-zinc-500">{preview.tz}</span>
        </div>
      )}
      {preview.isPast && (
        <p className="text-[11px] text-rose-300">
          That moment has already passed. Pick a future time or use one of the presets above.
        </p>
      )}
    </div>
  )
}
