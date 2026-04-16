'use client'

// Shared split-button for the "Create PR" action. Main area creates a
// regular PR; the chevron opens a small menu with "Create as draft".
// Used by both the worktree top bar and the Checks panel row so the
// affordance is identical everywhere the action is offered.

import { useEffect, useRef, useState } from 'react'

export interface SplitCreatePRButtonProps {
  onCreate: (asDraft: boolean) => void
  disabled?: boolean
  // Visual variant — the top bar wants the emerald filled look, the
  // Checks row wants the neutral outline look. Everything else shared.
  variant?: 'emerald' | 'outline'
}

export function SplitCreatePRButton({ onCreate, disabled, variant = 'outline' }: SplitCreatePRButtonProps) {
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

  const base = variant === 'emerald'
    ? 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:border-emerald-500/60 hover:bg-emerald-500/20'
    : 'border border-[#2B2B2B] text-zinc-300 hover:border-[#3A3A3A] hover:bg-white/[0.03]'

  return (
    <div ref={wrapperRef} className="relative inline-flex">
      {/* Main action: regular Create PR */}
      <button
        onClick={() => onCreate(false)}
        disabled={disabled}
        className={`flex items-center gap-1.5 rounded-l-md ${base} px-2.5 py-1 text-[11px] font-semibold disabled:opacity-40`}
      >
        {variant === 'emerald' && (
          <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={2.2} stroke="currentColor">
            <circle cx="6" cy="6" r="2" />
            <circle cx="6" cy="18" r="2" />
            <circle cx="18" cy="18" r="2" />
            <path d="M6 8v8M8 6h6a4 4 0 014 4v8" strokeLinecap="round" />
          </svg>
        )}
        Create PR
      </button>
      {/* Chevron section — opens the dropdown */}
      <button
        onClick={() => setMenuOpen((v) => !v)}
        disabled={disabled}
        title="More PR options"
        className={`rounded-r-md border-l-0 ${base} px-1.5 py-1 text-[11px] font-semibold disabled:opacity-40`}
      >
        <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={2.2} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
        </svg>
      </button>

      {menuOpen && (
        <div
          className="absolute right-0 top-full z-30 mt-1 w-[220px] rounded-md border border-[#2B2B2B] py-1 text-[11px] shadow-xl"
          style={{ backgroundColor: '#252526' }}
        >
          <button
            onClick={() => { setMenuOpen(false); onCreate(true) }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-zinc-200 hover:bg-white/5"
          >
            <svg className="h-3 w-3 text-zinc-400" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div className="flex-1">
              <div className="font-medium">Create as draft</div>
              <div className="text-[10px] text-zinc-500">Don&apos;t notify reviewers yet</div>
            </div>
          </button>
        </div>
      )}
    </div>
  )
}
