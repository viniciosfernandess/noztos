'use client'

// Two-option button for the "Conflicts" state on the worktree top bar.
// Main click = open the manual resolver overlay (picks-each-conflict UI).
// Chevron = delegate to the active chat agent, who runs the merge +
// resolves the conflicts + pushes. User watches the chat and can course-
// correct inline. Mirrors Conductor's pattern but keeps the manual path
// as the default so the user never commits an AI decision unreviewed.

import { useEffect, useRef, useState } from 'react'

export interface ResolveConflictsSplitButtonProps {
  onManual: () => void
  onAgent: () => void
}

export function ResolveConflictsSplitButton({ onManual, onAgent }: ResolveConflictsSplitButtonProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!menuOpen) return
    const close = (e: MouseEvent) => {
      if (!wrapperRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [menuOpen])

  return (
    <div ref={wrapperRef} className="relative inline-flex">
      <button
        onClick={onManual}
        className="rounded-l-md bg-amber-500 px-3 py-1 text-[11px] font-semibold text-white shadow-sm hover:bg-amber-400"
      >
        Resolve conflicts
      </button>
      <button
        onClick={() => setMenuOpen((v) => !v)}
        title="More options"
        className="rounded-r-md border-l border-amber-600 bg-amber-500 px-1.5 py-1 text-[11px] font-semibold text-white hover:bg-amber-400"
      >
        <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={2.2} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
        </svg>
      </button>

      {menuOpen && (
        <div
          className="absolute right-0 top-full z-30 mt-1 w-[260px] rounded-md border border-[#2B2B2B] py-1 text-[11px] shadow-xl"
          style={{ backgroundColor: '#252526' }}
        >
          <button
            onClick={() => { setMenuOpen(false); onManual() }}
            className="flex w-full items-start gap-2 px-3 py-1.5 text-left text-zinc-200 hover:bg-white/5"
          >
            <svg className="mt-0.5 h-3 w-3 text-zinc-400" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div className="flex-1">
              <div className="font-medium">Resolve manually</div>
              <div className="text-[10px] text-zinc-500">Pick each conflict yourself in the editor</div>
            </div>
          </button>
          <button
            onClick={() => { setMenuOpen(false); onAgent() }}
            className="flex w-full items-start gap-2 px-3 py-1.5 text-left text-zinc-200 hover:bg-white/5"
          >
            <svg className="mt-0.5 h-3 w-3 text-zinc-400" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.59 14.37a6 6 0 01-5.84 7.38v-4.8m5.84-2.58a14.98 14.98 0 006.16-12.12A14.98 14.98 0 009.63 7.5m5.96 6.87L15.59 14.37l-6-6m0 0l-3.75 1.44a6 6 0 00-4.12 4.12L9.63 7.5m0 0l6 6v-6h-6z" />
            </svg>
            <div className="flex-1">
              <div className="font-medium">Resolve with agent</div>
              <div className="text-[10px] text-zinc-500">Ask the chat to merge and push — review the decisions</div>
            </div>
          </button>
        </div>
      )}
    </div>
  )
}
