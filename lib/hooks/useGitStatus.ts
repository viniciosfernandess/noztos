'use client'

// Thin hook around GET /api/projects/[id]/git/status. Used by the ChecksPanel
// (15s polling) and the worktree header badge (30s polling). Kept in its
// own module so components can share the same endpoint without talking to
// each other.

import { useEffect, useRef, useState } from 'react'
import { MOCK_GIT_STATUS } from '@/lib/mocks/checks-demo'

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
  // Optional CI aggregate — backend can expose this later via the
  // GitHub check-runs endpoint. Used to flag "CI failing" as an
  // Unsupported case without needing in-app resolution.
  ciStatus?: 'passing' | 'pending' | 'failing' | null
}

// Returns a short label when the current status is "something the user
// needs to resolve on GitHub" (CI failure, future binary/submodule/etc).
// Returns null when nothing needs external attention.
export function deriveUnsupportedLabel(status: GitStatus | null): string | null {
  if (!status?.pr) return null
  const pr = status.pr
  // Only applies while the PR is genuinely open.
  if (pr.merged || pr.state === 'closed') return null
  if (status.ciStatus === 'failing') return 'CI failing'
  // Room to add more reasons here as we wire them up (binary conflict
  // detection, submodule conflicts, "branch deleted on remote", etc).
  return null
}

export function useGitStatus(projectId: string, sessionId: string | null, worktreeId: string | null, pollMs: number = 30000): {
  status: GitStatus | null
  refresh: () => void
} {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const mounted = useRef(true)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchOnce = async () => {
    if (MOCK_GIT_STATUS) {
      if (mounted.current) setStatus(MOCK_GIT_STATUS as GitStatus)
      return
    }
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

  // Optimistic override — after a commit+push on a changes-requested
  // PR, immediately flip the local state to "awaiting review" so the
  // bar reacts without waiting for the next 30s poll. The real poll
  // later corrects it to whatever GitHub actually says (clean → Ready,
  // still blocked → Awaiting, etc).
  useEffect(() => {
    const toAwaiting = () => {
      if (!mounted.current) return
      setStatus((prev) => {
        if (!prev?.pr) return prev
        if (prev.pr.derivedStatus !== 'changes_requested') return prev
        return {
          ...prev,
          pr: { ...prev.pr, derivedStatus: 'open', mergeable_state: 'blocked' },
        }
      })
    }
    // Mark-ready optimistic flip — draft becomes a regular open PR,
    // goes through the normal Awaiting/Ready pipeline on next poll.
    const toReady = () => {
      if (!mounted.current) return
      setStatus((prev) => {
        if (!prev?.pr || prev.pr.derivedStatus !== 'draft') return prev
        return {
          ...prev,
          pr: { ...prev.pr, draft: false, derivedStatus: 'open', mergeable_state: 'clean' },
        }
      })
    }
    window.addEventListener('bornastar-optimistic-awaiting', toAwaiting)
    window.addEventListener('bornastar-optimistic-ready', toReady)
    return () => {
      window.removeEventListener('bornastar-optimistic-awaiting', toAwaiting)
      window.removeEventListener('bornastar-optimistic-ready', toReady)
    }
  }, [])

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
