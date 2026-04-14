'use client'

// Checks panel — lives inside the bottom-right overlay alongside Terminal.
// Shows git + PR state for the active chat's context (main or a worktree)
// and lets the user drive the whole commit → push → PR → merge flow via
// buttons, so nothing needs to be typed into a terminal.
//
// State is fetched from GET /api/projects/[id]/git/status and refreshed
// every 15s while mounted. Actions call the dedicated POST endpoints and
// trigger an immediate refresh on success.

import { useCallback, useEffect, useRef, useState } from 'react'

interface GitStatus {
  branch: string
  uncommitted: number
  commitsAhead: number
  commitsBehind: number
  mainProtected: boolean
  mainProtectionChecked: number
  pr: PullRequest | null
  githubConnected: boolean
}

interface PullRequest {
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
}

export interface ChecksPanelProps {
  projectId: string
  sessionId: string | null
  worktreeId: string | null
  // Called when the user clicks the back/close of the Merged banner so the
  // parent can decide what to show (typically: keep the worktree open with
  // normal buttons).
  onArchive?: () => void
}

export function ChecksPanel({ projectId, sessionId, worktreeId, onArchive }: ChecksPanelProps) {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null) // id of the in-flight action
  const [error, setError] = useState<string | null>(null)

  // PR draft fields — only shown when there's no open PR yet. Kept in state
  // so the user can type a title/body before clicking Create.
  const [prTitle, setPrTitle] = useState('')
  const [prBody, setPrBody] = useState('')
  const [prDraft, setPrDraft] = useState(false)

  // Commit message modal
  const [showCommitModal, setShowCommitModal] = useState(false)
  const [commitMessage, setCommitMessage] = useState('')

  // Move-main-to-branch modal (shown when main is protected + user has work)
  const [showMoveToBranchModal, setShowMoveToBranchModal] = useState(false)
  const [newBranchName, setNewBranchName] = useState('')

  // Resolve the right query string for every endpoint. Preferring worktreeId
  // when present keeps the behaviour explicit and avoids an extra DB lookup.
  const qs = useCallback(() => {
    const p = new URLSearchParams()
    if (worktreeId) p.set('worktree', worktreeId)
    else if (sessionId) p.set('session', sessionId)
    return p.toString() ? `?${p.toString()}` : ''
  }, [worktreeId, sessionId])

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/git/status${qs()}`)
      if (!res.ok) {
        setError(`Status unavailable (HTTP ${res.status})`)
        setLoading(false)
        return
      }
      const data = (await res.json()) as GitStatus
      setStatus(data)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error')
    } finally {
      setLoading(false)
    }
  }, [projectId, qs])

  // Poll loop — tight while there's an open PR (user is waiting for review
  // / merge feedback), looser once the state is stable (no PR or merged).
  useEffect(() => {
    refresh()
    const interval = setInterval(refresh, 15000)
    return () => clearInterval(interval)
  }, [refresh])

  // ── Actions ──────────────────────────────────────────────────────────────

  const openCommitModal = () => {
    if (!status) return
    // Simple placeholder — future: let the agent generate a draft message.
    setCommitMessage(`chore: ${status.uncommitted} file${status.uncommitted === 1 ? '' : 's'} updated`)
    setShowCommitModal(true)
  }

  async function commitAndPush() {
    if (!commitMessage.trim()) return
    setBusy('commit')
    setShowCommitModal(false)
    try {
      const body = JSON.stringify({ message: commitMessage.trim(), worktreeId, sessionId })
      const commit = await fetch(`/api/projects/${projectId}/git/commit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
      if (!commit.ok) {
        const t = await commit.json().catch(() => ({}))
        throw new Error(t.error || `commit failed (${commit.status})`)
      }
      const push = await fetch(`/api/projects/${projectId}/git/push`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
      if (!push.ok) {
        const t = await push.json().catch(() => ({}))
        // 'protected' surfaces to the UI as a specific banner; other errors
        // just reset the busy state with a message.
        if (t.code === 'protected') throw new Error('Main is protected. Move these changes to a branch before pushing.')
        if (t.code === 'no_auth') throw new Error('GitHub not connected.')
        throw new Error(t.error || `push failed (${push.status})`)
      }
      setError(null)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed')
    } finally {
      setBusy(null)
    }
  }

  async function createPR() {
    if (!status) return
    setBusy('pr')
    try {
      const res = await fetch(`/api/projects/${projectId}/worktrees/${worktreeId}/pr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: prTitle.trim() || `Changes from ${status.branch}`, body: prBody, draft: prDraft }),
      })
      if (!res.ok) {
        const t = await res.json().catch(() => ({}))
        throw new Error(t.error || `create PR failed (${res.status})`)
      }
      setPrTitle(''); setPrBody(''); setPrDraft(false)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Create PR failed')
    } finally {
      setBusy(null)
    }
  }

  async function mergePR() {
    setBusy('merge')
    try {
      const res = await fetch(`/api/projects/${projectId}/worktrees/${worktreeId}/pr/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'merge' }),
      })
      if (!res.ok) {
        const t = await res.json().catch(() => ({}))
        throw new Error(t.error || `merge failed (${res.status})`)
      }
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Merge failed')
    } finally {
      setBusy(null)
    }
  }

  async function moveToBranch() {
    if (!sessionId) { setError('No active chat'); return }
    setBusy('move')
    setShowMoveToBranchModal(false)
    try {
      const res = await fetch(`/api/projects/${projectId}/git/move-main-to-branch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, newBranchName: newBranchName.trim() || undefined }),
      })
      if (!res.ok) {
        const t = await res.json().catch(() => ({}))
        throw new Error(t.error || `move failed (${res.status})`)
      }
      setNewBranchName('')
      await refresh()
      // Let the parent know so it can refresh the sidebar and activate the
      // new worktree — dispatched as a window event to avoid extra props.
      window.dispatchEvent(new CustomEvent('bornastar-refresh-worktrees'))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Move failed')
    } finally {
      setBusy(null)
    }
  }

  async function updateBranch() {
    setBusy('update')
    try {
      const res = await fetch(`/api/projects/${projectId}/git/update-branch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ worktreeId, sessionId }),
      })
      if (!res.ok) {
        const t = await res.json().catch(() => ({}))
        if (t.conflict) throw new Error('Conflicts detected. Resolve in terminal.')
        throw new Error(t.error || `update failed (${res.status})`)
      }
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update branch failed')
    } finally {
      setBusy(null)
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────

  if (loading) {
    return <div className="flex h-full items-center justify-center text-[11px] text-zinc-500">Loading git status…</div>
  }
  if (!status) {
    return <div className="flex h-full items-center justify-center text-[11px] text-zinc-500">{error ?? 'No status available.'}</div>
  }

  const pr = status.pr
  const isMain = !worktreeId
  // Core state flags that drive which rows appear.
  const hasUncommitted = status.uncommitted > 0
  const hasUnpushed = status.commitsAhead > 0
  const isBehind = status.commitsBehind > 0
  const hasOpenPr = pr && pr.state === 'open'
  const isMerged = pr && pr.merged

  return (
    <div className="flex h-full flex-col overflow-y-auto px-3 py-3 text-[12px]">
      {/* Merged banner — top priority, overrides normal rows */}
      {isMerged && (
        <div className="mb-3 rounded-md border border-purple-500/40 p-3" style={{ backgroundColor: 'rgba(168, 85, 247, 0.12)' }}>
          <div className="mb-1.5 flex items-center gap-2">
            <span className="rounded bg-purple-600 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">Merged</span>
            <a href={pr?.html_url} target="_blank" rel="noreferrer" className="text-[11px] text-purple-200 hover:text-purple-100">#{pr?.number} — view on GitHub ↗</a>
          </div>
          <div className="mb-2 text-[11px] text-zinc-400">
            Your changes are now in <span className="font-mono text-zinc-300">main</span>. Continue working on this branch or archive it.
          </div>
          <div className="flex gap-2">
            <button
              onClick={onArchive}
              className="rounded border border-[#3C3C3C] px-2.5 py-1 text-[11px] text-zinc-200 hover:bg-white/5"
            >
              Archive
            </button>
          </div>
        </div>
      )}

      {/* PR title / description — only editable when no PR exists yet */}
      {!hasOpenPr && !isMerged && !isMain && (
        <>
          <label className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">PR title</label>
          <input
            value={prTitle}
            onChange={(e) => setPrTitle(e.target.value)}
            placeholder={`e.g. ${status.branch}`}
            className="mb-2 w-full rounded border border-[#2B2B2B] bg-[#1F1F1F] px-2 py-1.5 text-[12px] text-zinc-200 placeholder-zinc-600 outline-none focus:border-zinc-500"
          />
          <label className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">PR description</label>
          <textarea
            value={prBody}
            onChange={(e) => setPrBody(e.target.value)}
            rows={3}
            placeholder="What does this change?"
            className="mb-3 w-full resize-none rounded border border-[#2B2B2B] bg-[#1F1F1F] px-2 py-1.5 text-[12px] text-zinc-200 placeholder-zinc-600 outline-none focus:border-zinc-500"
          />
        </>
      )}

      {/* Git status heading */}
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Git status</div>

      {/* Row: GitHub connection */}
      {!status.githubConnected && (
        <Row
          indicator="red"
          label="GitHub not connected"
          action={<a href="/api/auth/github/start" className="rounded border border-[#3C3C3C] px-2 py-1 text-[11px] text-zinc-200 hover:bg-white/5">Connect</a>}
        />
      )}

      {/* Row: uncommitted changes */}
      {hasUncommitted && (
        <Row
          indicator="amber"
          label={`${status.uncommitted} uncommitted change${status.uncommitted === 1 ? '' : 's'}`}
          action={
            status.githubConnected && !(isMain && status.mainProtected) ? (
              <button
                onClick={openCommitModal}
                disabled={busy !== null}
                className="rounded border border-[#3C3C3C] px-2 py-1 text-[11px] text-zinc-200 hover:bg-white/5 disabled:opacity-40"
              >
                Commit and push
              </button>
            ) : null
          }
        />
      )}

      {/* Row: branch behind main */}
      {!isMain && isBehind && (
        <Row
          indicator="amber"
          label={`${status.commitsBehind} commit${status.commitsBehind === 1 ? '' : 's'} behind main`}
          action={
            <button
              onClick={updateBranch}
              disabled={busy !== null}
              className="rounded border border-[#3C3C3C] px-2 py-1 text-[11px] text-zinc-200 hover:bg-white/5 disabled:opacity-40"
            >
              Update branch
            </button>
          }
        />
      )}

      {/* Row: unpushed commits (and no PR yet) */}
      {hasUnpushed && !hasOpenPr && !isMerged && !hasUncommitted && (
        <Row
          indicator="blue"
          label={`${status.commitsAhead} commit${status.commitsAhead === 1 ? '' : 's'} not pushed`}
          action={
            <button
              onClick={openCommitModal}
              disabled={busy !== null}
              className="rounded border border-[#3C3C3C] px-2 py-1 text-[11px] text-zinc-200 hover:bg-white/5 disabled:opacity-40"
            >
              Push
            </button>
          }
        />
      )}

      {/* Row: PR status */}
      {hasOpenPr && pr && (
        <>
          <Row
            indicator={prIndicator(pr.derivedStatus)}
            label={prLabel(pr)}
            action={
              <div className="flex gap-1">
                <a href={pr.html_url} target="_blank" rel="noreferrer" className="rounded border border-[#3C3C3C] px-2 py-1 text-[11px] text-zinc-200 hover:bg-white/5">View PR #{pr.number}</a>
                {(pr.derivedStatus === 'approved' || (pr.derivedStatus === 'open' && pr.mergeable_state === 'clean')) && (
                  <button
                    onClick={mergePR}
                    disabled={busy !== null}
                    className="rounded bg-emerald-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-emerald-500 disabled:opacity-40"
                  >
                    Merge
                  </button>
                )}
              </div>
            }
          />
        </>
      )}

      {/* Row: no PR open (only when we're in a branch context) */}
      {!hasOpenPr && !isMerged && !isMain && (
        <Row
          indicator="gray"
          label="No PR open"
          action={
            status.githubConnected && status.commitsAhead > 0 ? (
              <div className="flex items-center gap-1">
                <label className="flex items-center gap-1 text-[10px] text-zinc-400">
                  <input type="checkbox" checked={prDraft} onChange={(e) => setPrDraft(e.target.checked)} className="h-3 w-3" />
                  Draft
                </label>
                <button
                  onClick={createPR}
                  disabled={busy !== null}
                  className="rounded border border-[#3C3C3C] px-2 py-1 text-[11px] text-zinc-200 hover:bg-white/5 disabled:opacity-40"
                >
                  Create PR
                </button>
              </div>
            ) : (
              <span className="text-[11px] text-zinc-600">Push commits first</span>
            )
          }
        />
      )}

      {/* Row: main-protected warning for main chats */}
      {isMain && status.mainProtected && (hasUncommitted || hasUnpushed) && (
        <Row
          indicator="red"
          label="Main is protected — push blocked"
          action={
            <button
              onClick={() => setShowMoveToBranchModal(true)}
              disabled={busy !== null}
              className="rounded border border-[#3C3C3C] px-2 py-1 text-[11px] text-zinc-200 hover:bg-white/5 disabled:opacity-40"
            >
              Move to a branch
            </button>
          }
        />
      )}

      {/* Move-to-branch modal */}
      {showMoveToBranchModal && (
        <div className="absolute inset-0 z-20 flex items-center justify-center" style={{ backgroundColor: 'rgba(0,0,0,0.55)' }}>
          <div className="w-[400px] rounded-md border border-[#2B2B2B] p-4 shadow-xl" style={{ backgroundColor: '#252526' }}>
            <div className="mb-1 text-[12px] font-medium text-zinc-200">Move changes to a new branch</div>
            <div className="mb-3 text-[11px] text-zinc-400">This chat + its uncommitted changes move onto a new branch. Main resets back to the remote state.</div>
            <input
              autoFocus
              value={newBranchName}
              onChange={(e) => setNewBranchName(e.target.value)}
              placeholder="branch-name (leave empty for auto)"
              className="mb-3 w-full rounded border border-[#3A3A3A] bg-[#1F1F1F] px-2 py-1.5 text-[12px] text-zinc-200 outline-none focus:border-zinc-500"
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowMoveToBranchModal(false)}
                className="rounded border border-[#3A3A3A] px-3 py-1 text-[11px] text-zinc-300 hover:bg-white/5"
              >
                Cancel
              </button>
              <button
                onClick={moveToBranch}
                disabled={busy !== null}
                className="rounded bg-emerald-600 px-3 py-1 text-[11px] font-medium text-white hover:bg-emerald-500 disabled:opacity-40"
              >
                Move
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Error inline — last resort, non-blocking */}
      {error && (
        <div className="mt-3 rounded border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-[11px] text-red-300">
          {error}
        </div>
      )}

      {/* Commit message modal */}
      {showCommitModal && (
        <div className="absolute inset-0 z-20 flex items-center justify-center" style={{ backgroundColor: 'rgba(0,0,0,0.55)' }}>
          <div className="w-[380px] rounded-md border border-[#2B2B2B] p-4 shadow-xl" style={{ backgroundColor: '#252526' }}>
            <div className="mb-2 text-[12px] font-medium text-zinc-200">Commit message</div>
            <textarea
              autoFocus
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              rows={3}
              className="mb-3 w-full resize-none rounded border border-[#3A3A3A] bg-[#1F1F1F] px-2 py-1.5 text-[12px] text-zinc-200 outline-none focus:border-zinc-500"
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowCommitModal(false)}
                className="rounded border border-[#3A3A3A] px-3 py-1 text-[11px] text-zinc-300 hover:bg-white/5"
              >
                Cancel
              </button>
              <button
                onClick={commitAndPush}
                disabled={!commitMessage.trim()}
                className="rounded bg-emerald-600 px-3 py-1 text-[11px] font-medium text-white hover:bg-emerald-500 disabled:opacity-40"
              >
                Commit and push
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// Utility row — checkbox-style dot on the left, label, right-aligned action.
function Row({ indicator, label, action }: { indicator: 'red' | 'amber' | 'blue' | 'gray' | 'green' | 'purple'; label: string; action?: React.ReactNode }) {
  const dot = {
    red: 'bg-red-500',
    amber: 'bg-amber-500',
    blue: 'bg-blue-500',
    gray: 'bg-zinc-600',
    green: 'bg-emerald-500',
    purple: 'bg-purple-500',
  }[indicator]
  return (
    <div className="flex items-center gap-2 border-b border-[#2B2B2B] py-2 last:border-b-0">
      <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
      <span className="flex-1 text-[12px] text-zinc-300">{label}</span>
      {action}
    </div>
  )
}

function prIndicator(status: PullRequest['derivedStatus']): 'blue' | 'amber' | 'green' | 'red' | 'purple' | 'gray' {
  switch (status) {
    case 'draft': return 'gray'
    case 'open': return 'blue'
    case 'changes_requested': return 'amber'
    case 'approved': return 'green'
    case 'merged': return 'purple'
    case 'closed': return 'red'
    case 'conflicts': return 'amber'
  }
}

function prLabel(pr: PullRequest): string {
  const prefix = `PR #${pr.number}`
  switch (pr.derivedStatus) {
    case 'draft': return `${prefix} · Draft`
    case 'open': return `${prefix} · Open`
    case 'changes_requested': return `${prefix} · Changes requested`
    case 'approved': return `${prefix} · Approved`
    case 'merged': return `${prefix} · Merged`
    case 'closed': return `${prefix} · Closed`
    case 'conflicts': return `${prefix} · Conflicts`
  }
}
