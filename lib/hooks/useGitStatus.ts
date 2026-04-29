'use client'

// Thin hook around GET /api/projects/[id]/git/status. Used by the ChecksPanel
// (15s polling) and the worktree header badge (30s polling). Kept in its
// own module so components can share the same endpoint without talking to
// each other.

import { useEffect, useRef, useState } from 'react'
import { MOCK_GIT_STATUS } from '@/lib/mocks/checks-demo'
import { getCachedGitStatus, setCachedGitStatus } from '@/lib/worktree-cache'

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
  // True when the project has no GitHub remote (filesystem-only).
  // Drives "publish to GitHub" CTAs and skips the GitHub-side fetches
  // when there's no repo to talk to.
  isLocalProject?: boolean
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

// Single key for both ChecksPanel and the WorkPanel header so both
// useGitStatus consumers seed/write into the same cache slice.
function gitStatusCacheKey(sessionId: string | null, worktreeId: string | null): string {
  return worktreeId ?? sessionId ?? 'main'
}

export function useGitStatus(projectId: string, sessionId: string | null, worktreeId: string | null, pollMs: number = 30000, enabled: boolean = true): {
  status: GitStatus | null
  refresh: () => void
} {
  // Seed from the shared cache so a remount (e.g. ChecksPanel opening
  // after the WorkPanel header already polled) renders the badge +
  // "Commit and push" / "Create PR" buttons in the current frame
  // instead of waiting for this hook's own initial fetch.
  const [status, setStatus] = useState<GitStatus | null>(() =>
    getCachedGitStatus<GitStatus>(gitStatusCacheKey(sessionId, worktreeId)) ?? null,
  )
  const mounted = useRef(true)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Fields the local-only probe returns. Used to type-narrow the merge
  // path so we never accidentally clobber GitHub-side state with `undefined`.
  type LocalGitStatus = Pick<GitStatus, 'branch' | 'uncommitted' | 'commitsAhead' | 'commitsBehind'>

  const fetchOnce = async (mode: 'full' | 'localOnly' = 'full') => {
    if (MOCK_GIT_STATUS) {
      if (mounted.current) setStatus(MOCK_GIT_STATUS as GitStatus)
      return
    }
    try {
      const p = new URLSearchParams()
      if (worktreeId) p.set('worktree', worktreeId)
      else if (sessionId) p.set('session', sessionId)
      if (mode === 'localOnly') p.set('localOnly', 'true')
      const url = `/api/projects/${projectId}/git/status${p.toString() ? `?${p.toString()}` : ''}`
      const res = await fetch(url)
      if (!res.ok) return
      const data = await res.json()
      if (!mounted.current) return
      const cacheKey = gitStatusCacheKey(sessionId, worktreeId)
      if (mode === 'localOnly') {
        // Merge local fields into the existing snapshot — keeps the last-
        // known PR / CI / mainProtected state intact between polls. First
        // call after mount runs as 'full' so `prev` always has a base.
        const local = data as LocalGitStatus
        setStatus((prev) => {
          const merged: GitStatus = prev
            ? { ...prev, ...local }
            // No prior state yet (first event landed before the initial
            // poll resolved): synthesise a partial. The next poll lands
            // ~30s later and fills in the GitHub-side fields.
            : {
                ...local,
                mainProtected: false,
                mainProtectionChecked: 0,
                pr: null,
                githubConnected: false,
              }
          setCachedGitStatus(cacheKey, merged)
          return merged
        })
      } else {
        const full = data as GitStatus
        setStatus(full)
        setCachedGitStatus(cacheKey, full)
      }
    } catch {}
  }

  useEffect(() => {
    mounted.current = true
    // Optimistic-window gate: while the worktree is still provisioning on
    // the server (worktreePath='_pending_'), the /git/status endpoint
    // returns 400 because the on-disk worktree doesn't exist yet. Skipping
    // the fetch+interval keeps the console clean and saves a useless
    // round-trip per poll. The caller flips `enabled` true once the
    // worktree is real, and this effect re-runs to start polling.
    if (!enabled) return
    fetchOnce('full')
    pollRef.current = setInterval(() => fetchOnce('full'), pollMs)
    return () => {
      mounted.current = false
      if (pollRef.current) clearInterval(pollRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, sessionId, worktreeId, pollMs, enabled])

  // fs-change driven local refresh. Same `bornastar-fs-change` event the
  // worktree-cache listens to — when files mutate on disk the daemon
  // emits a batch and we kick a localOnly fetch so uncommitted /
  // commitsAhead update in ~150ms (vs. waiting up to pollMs for the next
  // full cycle). Debounced 200ms to coalesce save-format-lint bursts;
  // git status itself is fast enough that we don't need a longer window.
  useEffect(() => {
    if (!enabled) return
    let timer: ReturnType<typeof setTimeout> | null = null
    function onFsChange() {
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        if (mounted.current) fetchOnce('localOnly')
      }, 200)
    }
    window.addEventListener('bornastar-fs-change', onFsChange)
    return () => {
      window.removeEventListener('bornastar-fs-change', onFsChange)
      if (timer) clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, sessionId, worktreeId, enabled])

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
