'use client'

// Thin hook around GET /api/projects/[id]/git/status. Used by the ChecksPanel
// (15s polling) and the worktree header badge (30s polling). Kept in its
// own module so components can share the same endpoint without talking to
// each other.

import { useEffect, useRef, useState } from 'react'

export interface GitStatus {
  branch: string
  uncommitted: number
  commitsAhead: number
  commitsBehind: number
  mainProtected: boolean
  mainProtectionChecked: number
  pr: {
    number: number
    title: string
    body: string | null
    state: 'open' | 'closed'
    draft: boolean
    merged: boolean
    html_url: string
    head: { ref: string }
    base: { ref: string }
    derivedStatus: 'draft' | 'open' | 'changes_requested' | 'approved' | 'merged' | 'closed' | 'conflicts'
    mergeable_state: string | null
  } | null
  githubConnected: boolean
}

export function useGitStatus(projectId: string, sessionId: string | null, worktreeId: string | null, pollMs: number = 30000): {
  status: GitStatus | null
  refresh: () => void
} {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const mounted = useRef(true)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchOnce = async () => {
    try {
      const p = new URLSearchParams()
      if (worktreeId) p.set('worktree', worktreeId)
      else if (sessionId) p.set('session', sessionId)
      const url = `/api/projects/${projectId}/git/status${p.toString() ? `?${p.toString()}` : ''}`
      const res = await fetch(url)
      if (!res.ok) return
      const data = (await res.json()) as GitStatus
      if (mounted.current) setStatus(data)
    } catch {}
  }

  useEffect(() => {
    mounted.current = true
    fetchOnce()
    pollRef.current = setInterval(fetchOnce, pollMs)
    return () => {
      mounted.current = false
      if (pollRef.current) clearInterval(pollRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, sessionId, worktreeId, pollMs])

  return { status, refresh: fetchOnce }
}

// Color + short label for a quick-read status badge.
export function deriveBadge(status: GitStatus | null): { color: string; label: string } | null {
  if (!status) return null
  const pr = status.pr
  if (pr?.merged) return { color: 'bg-purple-500', label: 'Merged' }
  if (pr && pr.state === 'closed') return { color: 'bg-red-600', label: 'Closed' }
  if (pr?.derivedStatus === 'approved') return { color: 'bg-emerald-500', label: 'Approved' }
  if (pr?.derivedStatus === 'changes_requested') return { color: 'bg-amber-500', label: 'Changes requested' }
  if (pr?.derivedStatus === 'conflicts') return { color: 'bg-amber-600', label: 'Conflicts' }
  if (pr?.derivedStatus === 'draft') return { color: 'bg-zinc-500', label: 'Draft' }
  if (pr && pr.state === 'open') return { color: 'bg-blue-500', label: 'PR open' }
  if (status.commitsBehind > 0) return { color: 'bg-amber-500', label: 'Behind main' }
  if (status.uncommitted > 0) return { color: 'bg-amber-500', label: `${status.uncommitted} uncommitted` }
  if (status.commitsAhead > 0) return { color: 'bg-blue-500', label: `${status.commitsAhead} unpushed` }
  return null
}
