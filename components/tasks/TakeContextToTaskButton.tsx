'use client'

// Discrete button rendered under the latest assistant chat message.
// On hover: tooltip "Take context to task".
// On click: POSTs /tasks/from-chat with the anchored message id, then
// hands the new task off to the parent (which opens the confirmation
// modal). The button itself stays light — no spinner overlay — but
// disables briefly while the request is in flight so a double-click
// can't create two tasks.

import { useState } from 'react'
import type { TaskListItem } from './types'

interface Props {
  projectId: string
  sessionId: string
  messageId: string
  /** Called once the task is created. Receives the new task id. */
  onCreated: (task: TaskListItem) => void
  /** Called if the request fails — caller surfaces the error in toast. */
  onError?: (message: string) => void
}

export function TakeContextToTaskButton({ projectId, sessionId, messageId, onCreated, onError }: Props) {
  const [busy, setBusy] = useState(false)

  async function handleClick() {
    if (busy) return
    setBusy(true)
    try {
      const res = await fetch(`/api/projects/${projectId}/tasks/from-chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, cutoffMessageId: messageId }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        onError?.(body?.error ?? `Failed to create task (${res.status})`)
        return
      }
      const task = (await res.json()) as TaskListItem
      onCreated(task)
    } catch (err) {
      onError?.((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="group relative mt-1 flex">
      <button
        onClick={handleClick}
        disabled={busy}
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-zinc-500 transition-colors hover:bg-white/[0.04] hover:text-zinc-300 disabled:opacity-50"
      >
        <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
        </svg>
        Take context to task
      </button>
    </div>
  )
}
