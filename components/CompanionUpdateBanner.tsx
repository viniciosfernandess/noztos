'use client'

// Companion update banner.
//
// Renders when the daemon's reported package version is older than the
// latest published @noztos/companion on NPM. Drops to nothing when
// up-to-date OR disconnected (no false-positives between heartbeats).
//
// "Update now" button posts an update_companion command via the existing
// relay. The daemon receives it through /api/companion/events, runs
// `npm install -g @noztos/companion@latest`, and tells the user to
// restart with a follow-up companion_status broadcast carrying the
// updateInstalled flag (see CompanionInfo).
//
// Position: callers decide. Currently mounted at the top of the home
// page (above ProjectList) and at the top of the project page (above
// the worktree sidebar). Both hide automatically when there's nothing
// to show, so it's safe to leave mounted everywhere.

import { useState } from 'react'
import { useCompanionInfo } from '@/lib/hooks/useCompanionStore'

export function CompanionUpdateBanner() {
  const info = useCompanionInfo()
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!info?.updateAvailable) return null
  const current = info.daemonVersion ?? '?'
  const latest = info.latestVersion ?? '?'

  async function handleUpdate() {
    if (submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/companion/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'update_companion' }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
        throw new Error(j.error ?? `HTTP ${res.status}`)
      }
      setSubmitted(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/[0.08] px-4 py-2.5 text-[12px]">
      <svg className="h-4 w-4 shrink-0 text-amber-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 16.5V9.75m0 0l3 3m-3-3l-3 3M6.75 19.5a4.5 4.5 0 01-1.41-8.775 5.25 5.25 0 0110.233-2.33 3 3 0 013.758 3.848A3.752 3.752 0 0118 19.5H6.75z" />
      </svg>
      <div className="flex-1 min-w-0">
        <div className="font-medium text-amber-200">
          {submitted ? 'Update started' : 'Companion update available'}
        </div>
        <div className="text-[11px] text-amber-300/80">
          {submitted ? (
            <>The daemon will install <span className="font-mono">v{latest}</span> and restart. Reload this page in a few seconds.</>
          ) : (
            <>You&apos;re on <span className="font-mono">v{current}</span> — <span className="font-mono">v{latest}</span> is out. Your current session keeps working.</>
          )}
        </div>
        {error && <div className="mt-1 text-[11px] text-rose-300">{error}</div>}
      </div>
      {!submitted && (
        <button
          type="button"
          onClick={handleUpdate}
          disabled={submitting}
          className="shrink-0 rounded-md border border-amber-500/40 bg-amber-500/15 px-3 py-1 text-[11px] font-medium text-amber-200 transition-colors hover:bg-amber-500/25 disabled:opacity-60"
        >
          {submitting ? 'Updating…' : 'Update now'}
        </button>
      )}
    </div>
  )
}
