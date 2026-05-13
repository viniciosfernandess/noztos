'use client'

// Thin hook around GET /api/projects/[id]/git/status. Used by the ChecksPanel
// (15s polling) and the worktree header badge (30s polling). Kept in its
// own module so components can share the same endpoint without talking to
// each other.

import { useEffect, useRef, useState } from 'react'
import { MOCK_GIT_STATUS } from '@/lib/mocks/checks-demo'
import { getCachedGitStatus, setCachedGitStatus, subscribeCachedGitStatus, clearWorktreeCache } from '@/lib/worktree-cache'

// Module-level dedupe — multiple useGitStatus consumers can mount for the
// same worktree (ChecksPanel + WorkPanel header). Without this, both would
// race to POST /advance-base on a merge transition. First detector wins,
// the rest skip while the request is in flight.
const advanceInFlight = new Set<string>()

// Idempotent post-merge baseline advance. Returns true on success (DB
// updated, or already aligned and the no-op was confirmed) so the caller
// can stop firing for this worktree. Returns false on transient failure
// (network, 5xx) so the caller retries on the next poll.
async function advanceBaseAndRefresh(projectId: string, worktreeId: string): Promise<boolean> {
  if (advanceInFlight.has(worktreeId)) return false
  advanceInFlight.add(worktreeId)
  try {
    const res = await fetch(`/api/projects/${projectId}/worktrees/${worktreeId}/advance-base`, { method: 'POST' })
    if (!res.ok) return false
    const data = await res.json() as { advanced?: boolean; baseCommit?: string }
    if (data.advanced) {
      // Stale: filesCache (yellow flags), hunksCache (per-file diffs vs base),
      // gitStatusCache, worktreeMetaCache. Subscribers refetch on next render.
      clearWorktreeCache(worktreeId)
      // Wake the global fs-change refresher so the file tree / changes panel
      // refetch in the current frame. paths=[wt/.] is a sentinel that
      // satisfies parseAffectedCacheKeys → routes the refresh to this worktree.
      window.dispatchEvent(new CustomEvent('bornastar-fs-change', {
        detail: { source: 'worktrees', paths: [`${worktreeId}/.`] },
      }))
      console.log(`[isolation] base advanced wt=${worktreeId.slice(0, 8)} → ${data.baseCommit?.slice(0, 8) ?? '?'}`)
    }
    // Either advanced (great) or no-op (origin/main already matched the
    // baseCommit — another tab beat us, or the merge hadn't actually moved
    // the tip). Both count as success: nothing else for this caller to do.
    return true
  } catch {
    return false
  } finally {
    advanceInFlight.delete(worktreeId)
  }
}

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
  // Tracks whether we've successfully completed a post-merge advance for
  // this worktree's PR. Stays false until the round trip confirms — a
  // failed attempt (network blip, 5xx) keeps it false so the next poll
  // retries. Reset to false when the worktree id changes (new mount).
  const advancedRef = useRef<boolean>(false)

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
        //
        // Read `prev` from the cache, not from React state via a setStatus
        // updater. The cache is the shared source-of-truth (subscribers
        // re-sync from it on notify); reading from there matches the same
        // last-writer-wins semantics React would give us, and — critically
        // — avoids calling setCachedGitStatus inside a setStatus updater.
        // That older pattern fired `notify` during the render commit, and
        // subscribed components calling setState mid-render triggered the
        // "Cannot update a component while rendering another" warning + a
        // cascade of stale state (Explorer marked every file dirty, Checks
        // panel showed phantom uncommitted, Changes panel saw nothing —
        // because nothing actually was).
        const local = data as LocalGitStatus
        const prev = getCachedGitStatus<GitStatus>(cacheKey) ?? null
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
        setStatus(merged)
      } else {
        const full = data as GitStatus
        setStatus(full)
        setCachedGitStatus(cacheKey, full)
        // Merge transition detector — fires whenever the PR is merged AND
        // we haven't yet confirmed an advance for this worktree. Idempotent
        // server-side and dedup'd module-side, so multiple consumers
        // (ChecksPanel + header) racing on the same worktree resolve to
        // exactly one POST. Conductor-style: branch state stays intact,
        // only the diff baseline moves so merged files drop out of the
        // changes view automatically.
        if (full.pr?.merged && !advancedRef.current && worktreeId) {
          advanceBaseAndRefresh(projectId, worktreeId).then((ok) => {
            if (ok && mounted.current) advancedRef.current = true
          })
        }
      }
    } catch {}
  }

  // Adaptive poll cadence — when the PR is approved/clean (about to merge),
  // we drop to 5s so the merge detection fires within seconds of the
  // GitHub button being clicked, instead of waiting up to 30s. Default
  // cadence resumes once the PR settles (merged, closed, or no PR).
  // Only the local interval changes; the caller-provided `pollMs` still
  // sets the default for non-imminent states.
  function effectivePollMs(): number {
    const pr = status?.pr
    if (!pr || pr.merged || pr.state === 'closed') return pollMs
    if (pr.derivedStatus === 'approved') return 5000
    if (pr.derivedStatus === 'open' && pr.mergeable_state === 'clean') return 5000
    return pollMs
  }

  useEffect(() => {
    // Each new worktree starts with the advance-arming reset — the prior
    // worktree's success doesn't carry over.
    advancedRef.current = false
  }, [worktreeId])

  // Cache parity with `subscribeCachedFiles` (Changes panel pattern):
  //   - On worktree/session switch, snap immediately to whatever the cache
  //     has for the new key — instant correct render of the Commit/Push
  //     and Create-PR buttons (they previously showed the prior worktree's
  //     state until the next fetch resolved, ~200-1500ms of glitch).
  //   - Subscribe so any other consumer's update (header polling vs
  //     ChecksPanel polling vs an explicit `clearWorktreeCache`) flows
  //     into this hook's state too. Single source of truth = one cache
  //     slice per key, every consumer subscribed.
  useEffect(() => {
    const key = gitStatusCacheKey(sessionId, worktreeId)
    setStatus(getCachedGitStatus<GitStatus>(key) ?? null)
    return subscribeCachedGitStatus(key, () => {
      const next = getCachedGitStatus<GitStatus>(key)
      // `next` is undefined after a `clearWorktreeCache` — surface as null
      // so dependent UI (buttons, badges) drops to the "no data" branch
      // until the imminent refetch fills it back in.
      setStatus(next ?? null)
    })
  }, [sessionId, worktreeId])

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
    pollRef.current = setInterval(() => fetchOnce('full'), effectivePollMs())
    return () => {
      mounted.current = false
      if (pollRef.current) clearInterval(pollRef.current)
    }
    // Re-runs when the effective interval changes — see status.pr.derivedStatus
    // dependency below. Without that, an "approved" PR would keep polling at
    // the original pollMs because the interval was set at mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, sessionId, worktreeId, pollMs, enabled, status?.pr?.derivedStatus, status?.pr?.mergeable_state])

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
