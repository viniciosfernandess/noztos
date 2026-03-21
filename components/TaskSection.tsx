'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

interface TaskItem {
  id: string
  name: string
  instruction: string | null
  status: string
  executorType: string
  executorId: string | null
  pausedAtEmployee: string | null
}

interface Team {
  id: string
  name: string
}

interface TaskSectionProps {
  projectId: string
  tasks: TaskItem[]
  teams: Team[]
}

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-zinc-300',
  queue: 'bg-blue-400',
  progress: 'bg-amber-400',
  completed: 'bg-emerald-500',
  done: 'bg-emerald-600',
}

export function TaskSection({ projectId, tasks, teams }: TaskSectionProps) {
  const router = useRouter()
  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [instruction, setInstruction] = useState('')
  const [teamId, setTeamId] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [running, setRunning] = useState<string | null>(null)

  async function createTask(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setSubmitting(true)
    try {
      const res = await fetch(`/api/projects/${projectId}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          instruction: instruction.trim() || undefined,
          teamId: teamId || undefined,
        }),
      })
      if (res.ok) {
        setShowForm(false)
        setName('')
        setInstruction('')
        setTeamId('')
        router.refresh()
      }
    } finally {
      setSubmitting(false)
    }
  }

  async function runTask(taskId: string) {
    setRunning(taskId)
    try {
      await fetch(`/api/projects/${projectId}/tasks/${taskId}/run`, {
        method: 'POST',
      })
      router.refresh()
    } finally {
      setRunning(null)
    }
  }

  function teamName(executorId: string | null) {
    if (!executorId) return null
    return teams.find((t) => t.id === executorId)?.name ?? null
  }

  return (
    <section className="rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">
          Tasks
        </h2>
        {!showForm && (
          <button
            onClick={() => setShowForm(true)}
            className="text-xs font-medium text-zinc-500 transition-colors hover:text-zinc-900 dark:hover:text-zinc-50"
          >
            + New Task
          </button>
        )}
      </div>

      {tasks.length === 0 && !showForm && (
        <p className="mt-2 text-sm text-zinc-400">
          No tasks yet. Create a task and assign it to a team.
        </p>
      )}

      {tasks.length > 0 && (
        <div className="mt-3 flex flex-col gap-2">
          {tasks.map((task) => (
            <div
              key={task.id}
              className="flex items-center justify-between rounded-lg border border-zinc-100 px-4 py-3 dark:border-zinc-800"
            >
              <div className="flex items-center gap-3">
                <span
                  className={`inline-block h-2 w-2 rounded-full ${STATUS_COLORS[task.status] ?? 'bg-zinc-300'}`}
                  title={task.status}
                />
                <div>
                  <span className="text-sm font-medium text-zinc-900 dark:text-zinc-50">
                    {task.name}
                  </span>
                  {teamName(task.executorId) && (
                    <span className="ml-2 text-xs text-zinc-400">
                      → {teamName(task.executorId)}
                    </span>
                  )}
                  {task.instruction && (
                    <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate max-w-md">
                      {task.instruction}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-zinc-400">{task.status}</span>
                {task.status === 'pending' && task.executorType === 'team' && (
                  <button
                    onClick={() => runTask(task.id)}
                    disabled={running === task.id}
                    className="rounded-full bg-zinc-900 px-3 py-1 text-xs font-medium text-white disabled:opacity-50 dark:bg-white dark:text-zinc-900"
                  >
                    {running === task.id ? 'Running...' : 'Run'}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {showForm && (
        <form onSubmit={createTask} className="mt-4 flex flex-col gap-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-700">
          <input
            type="text"
            placeholder="Task name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-9 rounded-lg border border-zinc-300 bg-white px-3 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
          />
          <textarea
            placeholder="Instructions (optional)"
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            rows={3}
            className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
          />
          <select
            value={teamId}
            onChange={(e) => setTeamId(e.target.value)}
            className="h-9 rounded-lg border border-zinc-300 bg-white px-3 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
          >
            <option value="">No team (manual)</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={submitting || !name.trim()}
              className="flex h-8 items-center justify-center rounded-full bg-zinc-900 px-4 text-xs font-medium text-white disabled:opacity-50 dark:bg-white dark:text-zinc-900"
            >
              {submitting ? 'Creating...' : 'Create Task'}
            </button>
            <button
              type="button"
              onClick={() => { setShowForm(false); setName(''); setInstruction(''); setTeamId('') }}
              className="text-xs text-zinc-400 hover:text-zinc-600"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  )
}
