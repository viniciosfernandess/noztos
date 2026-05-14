'use client'

// Small confirmation modal that appears right after a task is created
// from a chat message. The task is already persisted by the time this
// renders — this modal is informational, not a form. Auto-dismisses
// after 10s. "Manage now" hands off to TaskManageModal so the user can
// configure the executor/instruction/mode in the same flow without
// having to navigate to the tasks tab.

import { useEffect, useState } from 'react'

interface Props {
  open: boolean
  taskName: string
  onClose: () => void
  onManage: () => void
  /** Auto-dismiss after this many ms. Default 10000. */
  autoDismissMs?: number
}

export function TaskCreatedConfirmModal({ open, taskName, onClose, onManage, autoDismissMs = 10_000 }: Props) {
  const [remaining, setRemaining] = useState(autoDismissMs)

  useEffect(() => {
    if (!open) return
    setRemaining(autoDismissMs)
    const start = Date.now()
    const tick = setInterval(() => {
      const left = autoDismissMs - (Date.now() - start)
      if (left <= 0) {
        clearInterval(tick)
        onClose()
        return
      }
      setRemaining(left)
    }, 200)
    return () => clearInterval(tick)
  }, [open, autoDismissMs, onClose])

  if (!open) return null

  const seconds = Math.ceil(remaining / 1000)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
      onClick={onClose}
    >
      <div
        className="flex w-full max-w-sm flex-col rounded-2xl border border-white/10 shadow-2xl"
        style={{ backgroundColor: '#1F1F1F' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-3">
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-500/15">
              <svg className="h-3.5 w-3.5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </span>
            <h3 className="text-sm font-medium text-zinc-100">Task created</h3>
          </div>
          <button onClick={onClose} className="rounded p-1 text-zinc-400 hover:bg-white/5 hover:text-zinc-200">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-5 py-4">
          <p className="text-sm text-zinc-300">
            <span className="font-medium text-zinc-100">{taskName}</span>
          </p>
          <p className="mt-1 text-xs text-zinc-500">
            The context up to this message is attached. It&apos;s isolated from this chat now — find it in the Tasks tab.
          </p>
        </div>

        <div className="flex items-center justify-between border-t border-white/10 bg-white/[0.02] px-5 py-3">
          <span className="text-[11px] text-zinc-500">Dismissing in {seconds}s…</span>
          <button
            onClick={onManage}
            className="rounded-md bg-violet-600 px-3 py-1.5 text-sm text-white hover:bg-violet-500"
          >
            Manage now
          </button>
        </div>
      </div>
    </div>
  )
}
