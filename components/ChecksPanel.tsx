'use client'

// Checks panel — lives in the right-panel tab row (Explorer / Changes /
// Checks). Shows three stacked sections:
//
//   1. PR title + description — always editable. Acts as a live draft even
//      before the user has done any git work; once a PR exists, becomes
//      the current PR's title/body (in read-only form for now — editing
//      an open PR is a future enhancement).
//
//   2. Git status — conditional. Appears only when there's real git state
//      to act on (uncommitted, unpushed, behind main, open PR, etc).
//      Empty/idle means this section doesn't render at all — the panel
//      becomes a pure "compose + todos" workspace, matching Conductor.
//
//   3. Your todos — always present. Per-worktree checklist (or per-session
//      for main chats) the user/agent maintains alongside git work.
//
// Status polls every 15s while mounted so the section updates without a
// manual refresh.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MOCK_CONFLICTS, MOCK_GIT_STATUS } from '@/lib/mocks/checks-demo'
import { SplitCreatePRButton } from './SplitCreatePRButton'
import { deriveUnsupportedLabel } from '@/lib/hooks/useGitStatus'

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

interface Todo {
  id: string
  content: string
  done: boolean
  position: number
  createdAt: string
}

export interface ChecksPanelProps {
  projectId: string
  sessionId: string | null
  worktreeId: string | null
  onArchive?: () => void
  // True when the user clicked "Continue" on a merged PR banner — the
  // purple Merged row stops rendering and any row-level actions go back
  // to their normal single-button form ("Commit and push" / "Create PR").
  mergedBannerDismissed?: boolean
  // Same idea for a rejected PR — "Start over" dismisses the red row.
  closedBannerDismissed?: boolean
}

export function ChecksPanel({ projectId, sessionId, worktreeId, onArchive, mergedBannerDismissed, closedBannerDismissed }: ChecksPanelProps) {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // PR draft state — worktree level. Null sessionId/worktreeId = no scope
  // yet (happens briefly when the active chat is being set up).
  const [prTitle, setPrTitle] = useState('')
  const [prBody, setPrBody] = useState('')
  const prSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Todos state
  const [todos, setTodos] = useState<Todo[]>([])
  const [newTodoContent, setNewTodoContent] = useState('')
  const [addingTodo, setAddingTodo] = useState(false)
  // Inline "Add" input — only shows when the user clicks + Add. Mirrors
  // Conductor: no persistent input at the bottom.
  const [todoInputOpen, setTodoInputOpen] = useState(false)

  // Commit message modal state.
  const [showCommitModal, setShowCommitModal] = useState(false)
  const [commitMessage, setCommitMessage] = useState('')
  // Archive confirmation — only opens when there's unsaved work at archive
  // time. Otherwise we skip the modal and archive immediately.
  const [showArchiveConfirm, setShowArchiveConfirm] = useState(false)
  const [prDraft, setPrDraft] = useState(false)
  // Live "Current changes" summary — re-fetched alongside git status.
  // Renders below the PR body once a PR exists so the user can see what
  // the branch currently contains (including pushes after the PR opened).
  const [currentChangesSummary, setCurrentChangesSummary] = useState('')

  const qs = useCallback(() => {
    const p = new URLSearchParams()
    if (worktreeId) p.set('worktree', worktreeId)
    else if (sessionId) p.set('session', sessionId)
    return p.toString() ? `?${p.toString()}` : ''
  }, [worktreeId, sessionId])

  // ── Git status polling ────────────────────────────────────────────────
  const refreshStatus = useCallback(async () => {
    if (MOCK_GIT_STATUS) {
      setStatus(MOCK_GIT_STATUS as GitStatus)
      return
    }
    try {
      const res = await fetch(`/api/projects/${projectId}/git/status${qs()}`)
      if (res.ok) setStatus(await res.json())
    } catch {}
  }, [projectId, qs])

  useEffect(() => {
    refreshStatus()
    const t = setInterval(refreshStatus, 15000)
    return () => clearInterval(t)
  }, [refreshStatus])

  // Sibling listeners to the hook's so the Checks panel's own rows
  // flip before the next poll.
  useEffect(() => {
    const toAwaiting = () => {
      setStatus((prev) => {
        if (!prev?.pr || prev.pr.derivedStatus !== 'changes_requested') return prev
        return { ...prev, pr: { ...prev.pr, derivedStatus: 'open', mergeable_state: 'blocked' } }
      })
    }
    const toReady = () => {
      setStatus((prev) => {
        if (!prev?.pr || prev.pr.derivedStatus !== 'draft') return prev
        return { ...prev, pr: { ...prev.pr, draft: false, derivedStatus: 'open', mergeable_state: 'clean' } }
      })
    }
    window.addEventListener('bornastar-optimistic-awaiting', toAwaiting)
    window.addEventListener('bornastar-optimistic-ready', toReady)
    return () => {
      window.removeEventListener('bornastar-optimistic-awaiting', toAwaiting)
      window.removeEventListener('bornastar-optimistic-ready', toReady)
    }
  }, [])

  // Top-bar's split button fires this event when the user picks either
  // "Create PR" or "Create as draft". Running the flow here (instead of
  // duplicating the logic) keeps the auto-commit + suggestion + rename
  // pipeline in a single place.
  const createPRRef = useRef<(asDraft?: boolean) => void>(() => {})

  // ── PR draft — load on mount, debounce save on edit ────────────────────
  useEffect(() => {
    // Drafts live on the worktree only — main chats skip this. We only
    // load what the user (or a previous Create PR) typed; we never
    // auto-fill from the branch diff on first view. The summary is only
    // surfaced later, as part of the PR body once the PR exists.
    if (!worktreeId) { setPrTitle(''); setPrBody(''); return }
    fetch(`/api/projects/${projectId}/worktrees/${worktreeId}/pr-draft`)
      .then((r) => r.ok ? r.json() : null)
      .then((d) => {
        if (d) { setPrTitle(d.title ?? ''); setPrBody(d.body ?? '') }
      })
      .catch(() => {})
  }, [projectId, worktreeId])

  const scheduleDraftSave = useCallback((title: string, body: string) => {
    if (!worktreeId) return
    if (prSaveTimer.current) clearTimeout(prSaveTimer.current)
    prSaveTimer.current = setTimeout(() => {
      fetch(`/api/projects/${projectId}/worktrees/${worktreeId}/pr-draft`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, body }),
      }).catch(() => {})
    }, 600)
  }, [projectId, worktreeId])

  // ── Todos — DB-backed (Todo model). Scoped by worktree (or session for
  // main chats). Optimistic UI: state updates immediately, server call
  // follows; on failure we reconcile by re-fetching.
  const refreshTodos = useCallback(async () => {
    if (!worktreeId && !sessionId) { setTodos([]); return }
    try {
      const res = await fetch(`/api/projects/${projectId}/todos${qs()}`)
      if (res.ok) {
        const data = await res.json()
        setTodos(data.todos ?? [])
      }
    } catch {}
  }, [projectId, qs, worktreeId, sessionId])

  useEffect(() => { refreshTodos() }, [refreshTodos])

  // Pull the live "Current changes" summary while a PR is open — lets the
  // user see every push that landed after PR creation. Polled on the same
  // 15s cadence as git status via the status change.
  useEffect(() => {
    const pr = status?.pr
    const hasOpen = !!pr && pr.state === 'open'
    if (!worktreeId || !hasOpen) { setCurrentChangesSummary(''); return }
    fetch(`/api/projects/${projectId}/worktrees/${worktreeId}/pr-suggestion`)
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (d?.body) setCurrentChangesSummary(d.body) })
      .catch(() => {})
  }, [projectId, worktreeId, status])

  async function addTodo() {
    const content = newTodoContent.trim()
    if (!content) return
    // Optimistic — insert immediately so Enter feels instant. If the POST
    // fails we roll the tempo back and surface the error inline.
    const tempId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const optimistic: Todo = {
      id: tempId,
      content,
      done: false,
      position: todos.length,
      createdAt: new Date().toISOString(),
    }
    setTodos((prev) => [...prev, optimistic])
    setNewTodoContent('')
    try {
      const res = await fetch(`/api/projects/${projectId}/todos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, worktreeId, sessionId: worktreeId ? null : sessionId }),
      })
      if (!res.ok) {
        const t = await res.json().catch(() => ({}))
        throw new Error(t.error || `HTTP ${res.status}`)
      }
      const real = (await res.json()) as Todo
      setTodos((prev) => prev.map((p) => p.id === tempId ? real : p))
    } catch (e) {
      // Roll back the optimistic insert and surface the reason.
      setTodos((prev) => prev.filter((p) => p.id !== tempId))
      setError(`Add todo failed: ${e instanceof Error ? e.message : 'unknown'}`)
    }
  }

  async function toggleTodo(todoId: string, done: boolean) {
    setTodos((prev) => prev.map((t) => t.id === todoId ? { ...t, done } : t))
    try {
      const res = await fetch(`/api/projects/${projectId}/todos/${todoId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ done }),
      })
      if (!res.ok) refreshTodos()
    } catch { refreshTodos() }
  }

  async function deleteTodo(todoId: string) {
    setTodos((prev) => prev.filter((t) => t.id !== todoId))
    try {
      await fetch(`/api/projects/${projectId}/todos/${todoId}`, { method: 'DELETE' })
    } catch { refreshTodos() }
  }

  // ── Git actions ────────────────────────────────────────────────────────
  const openCommitModal = () => {
    if (!status) return
    setCommitMessage(`chore: update ${status.uncommitted} file${status.uncommitted === 1 ? '' : 's'}`)
    setShowCommitModal(true)
  }

  async function commitAndPush() {
    if (!commitMessage.trim()) return
    setBusy('commit')
    setShowCommitModal(false)
    try {
      const payload = JSON.stringify({ message: commitMessage.trim(), worktreeId, sessionId })
      const c = await fetch(`/api/projects/${projectId}/git/commit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload })
      if (!c.ok) { const t = await c.json().catch(() => ({})); throw new Error(t.error || 'commit failed') }
      const p = await fetch(`/api/projects/${projectId}/git/push`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload })
      if (!p.ok) {
        const t = await p.json().catch(() => ({}))
        if (t.code === 'protected') throw new Error('Main is protected. Move these changes to a branch first.')
        if (t.code === 'no_auth') throw new Error('GitHub not connected.')
        throw new Error(t.error || 'push failed')
      }
      setError(null)
      const wasChangesRequested = status?.pr?.derivedStatus === 'changes_requested'
      // Pull fresh state first — in prod the API may already reflect
      // "review dismissed" after the push. Then, if we still see
      // changes_requested, apply the optimistic flip so the UI moves
      // forward even before the next poll ticks through.
      await refreshStatus()
      if (wasChangesRequested) {
        window.dispatchEvent(new CustomEvent('bornastar-optimistic-awaiting'))
      }
    } catch (e) { setError(e instanceof Error ? e.message : 'Action failed') }
    finally { setBusy(null) }
  }

  const createPR = useCallback(async (asDraft: boolean = false) => {
    if (!status) return
    setBusy('pr')
    try {
      // Pull a fresh suggestion right before creating — gives us a decent
      // title + body even when the user didn't type anything. If they DID
      // type, we respect their wording.
      let title = prTitle.trim()
      let body = prBody
      if (!title || !body) {
        try {
          const s = await fetch(`/api/projects/${projectId}/worktrees/${worktreeId}/pr-suggestion`)
          if (s.ok) {
            const sug = await s.json()
            if (!title) title = sug.title || `Changes from ${status.branch}`
            if (!body) body = sug.body || ''
          }
        } catch {}
      }
      if (!title) title = `Changes from ${status.branch}`

      // If the working tree is dirty or there are unpushed commits, the
      // backend auto-commits + pushes before opening the PR. That's the
      // Conductor-style "one-click PR" flow — no need to commit first.
      const needsAutoCommit = status.uncommitted > 0 || status.commitsAhead > 0
      const res = await fetch(`/api/projects/${projectId}/worktrees/${worktreeId}/pr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, body, draft: asDraft, autoCommit: needsAutoCommit, commitMessage: title }),
      })
      if (!res.ok) { const t = await res.json().catch(() => ({})); throw new Error(t.error || 'create PR failed') }

      // Sync worktree name to the PR title so the sidebar reflects what
      // the PR is about. Chats inside the worktree keep their own names.
      fetch(`/api/projects/${projectId}/worktrees/${worktreeId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: title.slice(0, 80) }),
      }).then(() => window.dispatchEvent(new CustomEvent('bornastar-refresh-worktrees'))).catch(() => {})

      // Mirror locally so the PR read-only view shows the real data
      // immediately without waiting for the next poll.
      setPrTitle(title)
      setPrBody(body)
      await refreshStatus()
    } catch (e) { setError(e instanceof Error ? e.message : 'Create PR failed') }
    finally { setBusy(null) }
  }, [projectId, worktreeId, status, prTitle, prBody, refreshStatus])

  // Keep the ref in sync so the event listener always calls the
  // latest closure (avoids stale `status` inside the handler).
  useEffect(() => { createPRRef.current = createPR }, [createPR])

  // External trigger from the top bar's split button.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ asDraft?: boolean }>).detail
      createPRRef.current(!!detail?.asDraft)
    }
    window.addEventListener('bornastar-create-pr', handler)
    return () => window.removeEventListener('bornastar-create-pr', handler)
  }, [])

  async function mergePR() {
    setBusy('merge')
    try {
      const res = await fetch(`/api/projects/${projectId}/worktrees/${worktreeId}/pr/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'merge' }),
      })
      if (!res.ok) { const t = await res.json().catch(() => ({})); throw new Error(t.error || 'merge failed') }
      await refreshStatus()
    } catch (e) { setError(e instanceof Error ? e.message : 'Merge failed') }
    finally { setBusy(null) }
  }

  async function updateBranch() {
    setBusy('update')
    try {
      const res = await fetch(`/api/projects/${projectId}/git/update-branch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ worktreeId, sessionId }),
      })
      if (!res.ok) { const t = await res.json().catch(() => ({})); if (t.conflict) throw new Error('Conflicts. Resolve in terminal.'); throw new Error(t.error || 'update failed') }
      await refreshStatus()
    } catch (e) { setError(e instanceof Error ? e.message : 'Update branch failed') }
    finally { setBusy(null) }
  }

  // ── Render ───────────────────────────────────────────────────────────────
  const pr = status?.pr ?? null
  const isMain = !worktreeId
  const hasUncommitted = (status?.uncommitted ?? 0) > 0
  const hasUnpushed = (status?.commitsAhead ?? 0) > 0
  const isBehind = (status?.commitsBehind ?? 0) > 0
  const hasOpenPr = !!pr && pr.state === 'open'
  // Effective merged state — if the user dismissed the banner via
  // Continue, stop treating the worktree as "merged-loud" for UI
  // purposes so rows fall back to their regular single-action form.
  const isMergedRaw = !!pr && pr.merged
  const isMerged = isMergedRaw && !mergedBannerDismissed
  // Same pattern for Closed — distinct from Merged because the PR was
  // rejected, not accepted. Dismissal via "Start over".
  const isClosedRaw = !!pr && !pr.merged && pr.state === 'closed'
  const isClosed = isClosedRaw && !closedBannerDismissed
  const isReadyToMerge = hasOpenPr && pr && (pr.derivedStatus === 'approved' || (pr.derivedStatus === 'open' && pr.mergeable_state === 'clean'))
  // Git section is hidden when nothing is happening git-wise. Mirrors Conductor.
  const showGitSection = !!status && (
    hasUncommitted || hasUnpushed || isBehind || hasOpenPr || isMerged || !status.githubConnected || (isMain && status.mainProtected)
  )
  // Ready-to-merge and Merged states show a prominent banner already —
  // the "Git status" heading under it with an empty list looks awkward.
  // Show the heading only when at least one row will actually render.
  const isReadyToMergeBanner = !!(isReadyToMerge && !isMerged)
  const hasPrRow = hasOpenPr && !isReadyToMergeBanner
  const hasNoPrRow = !hasOpenPr && !isMerged && !isMain
  const hasMainProtectedRow = !!(isMain && status?.mainProtected && (hasUncommitted || hasUnpushed))
  const showGitHeading = !!status && (
    !status.githubConnected ||
    hasUncommitted ||
    (!isMain && isBehind) ||
    hasPrRow ||
    hasNoPrRow ||
    hasMainProtectedRow ||
    isReadyToMerge ||
    isMerged ||
    isClosed
  )

  // When a PR is open, the draft title/body shouldn't be user-editable
  // anymore (would desync from GitHub). Show PR content read-only instead.
  const displayTitle = hasOpenPr && pr ? pr.title : prTitle
  const displayBody = hasOpenPr && pr ? (pr.body ?? '') : prBody
  const lockFields = hasOpenPr || isMerged

  return (
    <div className="relative flex h-full flex-col overflow-y-auto px-5 py-5 text-[12px]">
      {/* ── PR composition (always visible, borderless like Conductor) ──── */}
      <input
        value={displayTitle}
        onChange={(e) => { if (lockFields) return; setPrTitle(e.target.value); scheduleDraftSave(e.target.value, prBody) }}
        placeholder="PR title"
        readOnly={lockFields}
        className="mb-3 w-full border-0 bg-transparent p-0 text-[14px] font-medium text-zinc-200 placeholder-zinc-600 outline-none"
      />
      {/* PR description — once a PR exists, the body is read-only and
          can be long, so we cap the height and scroll inside the block.
          While editable (no PR yet), it grows naturally with the user's
          typing up to the same cap. */}
      <div
        className={`mb-4 w-full overflow-y-auto ${lockFields ? 'rounded-md border border-[#2B2B2B] px-3 py-2' : ''}`}
        style={{ maxHeight: lockFields ? '180px' : '320px', backgroundColor: lockFields ? 'rgba(255,255,255,0.02)' : 'transparent' }}
      >
        <textarea
          value={displayBody}
          onChange={(e) => { if (lockFields) return; setPrBody(e.target.value); scheduleDraftSave(prTitle, e.target.value) }}
          rows={Math.max(2, displayBody.split('\n').length)}
          placeholder="PR description"
          readOnly={lockFields}
          className="w-full resize-none border-0 bg-transparent p-0 text-[12px] text-zinc-300 placeholder-zinc-600 outline-none"
        />
      </div>


      {/* ── Git status (conditional) ─────────────────────────────────────── */}
      {showGitSection && (
        <>
          {showGitHeading && (
            <div className="mb-2 text-[12px] font-medium text-zinc-300">Git status</div>
          )}

          {/* Ready-to-merge / Merged states are presented as plain rows
              here. The full-bar prominence lives in the right-panel top
              navbar; this section just lists the action so the user can
              act from inside Checks too. */}
          {/* Unsupported row — generic bucket for states we can't
              resolve in-app (CI failing, binary conflict, etc). Shows
              a label + guidance to handle the issue on GitHub; the
              #PR chip in the top bar handles the actual navigation.
              Polling will flip the state automatically on next push. */}
          {(() => {
            const label = deriveUnsupportedLabel(status)
            if (!label) return null
            return (
              <Row
                indicator="gray"
                label={`${label} · needs attention on GitHub`}
              />
            )
          })()}

          {isReadyToMerge && pr && (
            <Row
              indicator="green"
              label="Ready to merge"
              action={<button onClick={mergePR} disabled={busy !== null} className="rounded border border-[#2B2B2B] px-2 py-1 text-[11px] font-medium text-zinc-300 hover:border-[#3A3A3A] hover:bg-white/[0.03] disabled:opacity-40">Merge</button>}
            />
          )}
          {isMerged && pr && (
            <Row
              indicator="purple"
              label="Merged"
              action={
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => window.dispatchEvent(new CustomEvent('bornastar-continue-merged'))}
                    className="rounded border border-[#2B2B2B] px-2 py-1 text-[11px] font-medium text-zinc-300 hover:border-[#3A3A3A] hover:bg-white/[0.03]"
                  >
                    Continue
                  </button>
                  <button
                    onClick={() => {
                      if (hasUncommitted || hasUnpushed) setShowArchiveConfirm(true)
                      else onArchive?.()
                    }}
                    className="rounded border border-[#2B2B2B] px-2 py-1 text-[11px] font-medium text-zinc-300 hover:border-[#3A3A3A] hover:bg-white/[0.03]"
                  >
                    Archive
                  </button>
                </div>
              }
            />
          )}

          {!isMerged && !isClosed && pr?.derivedStatus === 'draft' && (
            <Row
              indicator="gray"
              label={`PR #${pr.number} · Draft`}
              action={
                <button
                  onClick={async () => {
                    try {
                      const res = await fetch(`/api/projects/${projectId}/worktrees/${worktreeId}/pr/mark-ready`, { method: 'POST' })
                      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'mark ready failed')
                      window.dispatchEvent(new CustomEvent('bornastar-optimistic-ready'))
                      await refreshStatus()
                    } catch (e) { setError(e instanceof Error ? e.message : 'Mark ready failed') }
                  }}
                  className="rounded border border-[#2B2B2B] px-2 py-1 text-[11px] font-medium text-zinc-300 hover:border-[#3A3A3A] hover:bg-white/[0.03]"
                >
                  Mark ready for review
                </button>
              }
            />
          )}

          {isClosed && pr && (
            <Row
              indicator="red"
              label={`PR #${pr.number} · Closed`}
              action={
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => window.dispatchEvent(new CustomEvent('bornastar-start-over-closed'))}
                    className="rounded border border-[#2B2B2B] px-2 py-1 text-[11px] font-medium text-zinc-300 hover:border-[#3A3A3A] hover:bg-white/[0.03]"
                  >
                    Start over
                  </button>
                  <button
                    onClick={() => {
                      if (hasUncommitted || hasUnpushed) setShowArchiveConfirm(true)
                      else onArchive?.()
                    }}
                    className="rounded border border-[#2B2B2B] px-2 py-1 text-[11px] font-medium text-zinc-300 hover:border-[#3A3A3A] hover:bg-white/[0.03]"
                  >
                    Archive
                  </button>
                </div>
              }
            />
          )}

          {status && !status.githubConnected && (
            <Row indicator="red" label="GitHub not connected" action={<a href="/api/auth/github/start" className="rounded border border-[#2B2B2B] px-2 py-1 text-[11px] font-medium text-zinc-300 hover:border-[#3A3A3A] hover:bg-white/[0.03] disabled:opacity-40">Connect</a>} />
          )}

          {hasUncommitted && status && (
            <Row
              indicator="amber"
              label={`${status.uncommitted} uncommitted change${status.uncommitted === 1 ? '' : 's'}`}
              action={
                status.githubConnected && !(isMain && status.mainProtected) ? (
                  isMerged || isClosed ? (
                    // Loud state (Merged or Closed) still up: combined
                    // buttons dismiss the banner AND run the action in
                    // one go. Same dispatch pattern for both — just
                    // different event names.
                    (() => {
                      const dismissEvent = isMerged ? 'bornastar-continue-merged' : 'bornastar-start-over-closed'
                      const verb = isMerged ? 'Continue' : 'Start over'
                      return (
                        <div className="flex items-center gap-1.5">
                          <button
                            onClick={() => {
                              window.dispatchEvent(new CustomEvent(dismissEvent))
                              openCommitModal()
                            }}
                            disabled={busy !== null}
                            className="rounded border border-[#2B2B2B] px-2 py-1 text-[11px] font-medium text-zinc-300 hover:border-[#3A3A3A] hover:bg-white/[0.03] disabled:opacity-40"
                          >
                            {verb} &amp; commit and push
                          </button>
                          <button
                            onClick={() => {
                              window.dispatchEvent(new CustomEvent(dismissEvent))
                              createPR()
                            }}
                            disabled={busy !== null}
                            className="rounded border border-[#2B2B2B] px-2 py-1 text-[11px] font-medium text-zinc-300 hover:border-[#3A3A3A] hover:bg-white/[0.03] disabled:opacity-40"
                          >
                            {verb} &amp; create PR
                          </button>
                        </div>
                      )
                    })()
                  ) : (
                    <button onClick={openCommitModal} disabled={busy !== null} className="rounded border border-[#2B2B2B] px-2 py-1 text-[11px] font-medium text-zinc-300 hover:border-[#3A3A3A] hover:bg-white/[0.03] disabled:opacity-40">Commit and push</button>
                  )
                ) : null
              }
            />
          )}

          {!isMain && isBehind && (
            <Row
              indicator="amber"
              label={`${status!.commitsBehind} commit${status!.commitsBehind === 1 ? '' : 's'} behind main`}
              action={<button onClick={updateBranch} disabled={busy !== null} className="rounded border border-[#2B2B2B] px-2 py-1 text-[11px] font-medium text-zinc-300 hover:border-[#3A3A3A] hover:bg-white/[0.03] disabled:opacity-40">Update branch</button>}
            />
          )}

          {/* "N commits not pushed" row removed — after Start over the
              commits are usually already on origin/branch; the only
              meaningful next step is "Create PR", which is covered by
              the row below. Keeping both created a misleading duplicate. */}

          {/* Conflicts row — distinct action: kick off the rebase +
              resolver overlay. Handled by the top-bar button too, so
              this mirror the state but the CTA is optional. */}
          {hasOpenPr && pr && (pr.derivedStatus === 'conflicts' || pr.mergeable_state === 'dirty') && (
            <Row
              indicator="amber"
              label={`PR #${pr.number} · Merge conflicts`}
              action={
                <button
                  onClick={async () => {
                    // Mock mode short-circuits to the pre-fab file set.
                    if (MOCK_GIT_STATUS && MOCK_CONFLICTS) {
                      window.dispatchEvent(new CustomEvent('bornastar-open-conflict-resolver', { detail: { files: MOCK_CONFLICTS.files } }))
                      return
                    }
                    try {
                      const res = await fetch(`/api/projects/${projectId}/worktrees/${worktreeId}/rebase/start`, { method: 'POST' })
                      const data = await res.json().catch(() => ({}))
                      if (data.status === 'conflict') {
                        window.dispatchEvent(new CustomEvent('bornastar-open-conflict-resolver', { detail: { files: data.files ?? [] } }))
                      } else if (data.status === 'clean') {
                        await refreshStatus()
                      }
                    } catch {}
                  }}
                  className="rounded border border-[#2B2B2B] px-2 py-1 text-[11px] font-medium text-zinc-300 hover:border-[#3A3A3A] hover:bg-white/[0.03]"
                >
                  Resolve conflicts
                </button>
              }
            />
          )}

          {/* Awaiting / Changes requested passive row — no action
              button (the #PR chip in the top bar handles "open on
              GitHub"). Skipped for Draft because the dedicated Draft
              row above already shows the status + Mark ready, and
              skipped for Conflicts because the Conflicts row above
              handles that state. */}
          {hasOpenPr && pr && !isReadyToMerge && pr.derivedStatus !== 'draft' && pr.derivedStatus !== 'conflicts' && pr.mergeable_state !== 'dirty' && (() => {
            const awaiting = pr.derivedStatus === 'open' && pr.mergeable_state !== 'clean'
            const label = awaiting ? `PR #${pr.number} · Awaiting approval` : prLabel(pr)
            const indicator = awaiting ? 'amber' : prIndicator(pr.derivedStatus)
            return <Row indicator={indicator} label={label} />
          })()}

          {/* "No PR open" row — only shown when neither an open PR nor
              a live merged banner is competing for attention. Once the
              merged banner is dismissed (Continue), this reappears so
              new work can be turned into a follow-up PR. */}
          {!hasOpenPr && !isMain && !isMerged && !isClosed && status && (
            <Row
              indicator="gray"
              label="No PR open"
              action={status.githubConnected && (status.commitsAhead > 0 || hasUncommitted) ? (
                <SplitCreatePRButton onCreate={(asDraft) => createPR(asDraft)} disabled={busy !== null} />
              ) : <span className="text-[11px] text-zinc-600">Nothing to push</span>}
            />
          )}

          <div className="mb-4" />
        </>
      )}

      {/* Error surfacing — outside Git section so it's visible even in idle. */}
      {error && (
        <div className="mb-3 rounded border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-[11px] text-red-300">
          {error}
          <button onClick={() => setError(null)} className="ml-2 text-red-200 hover:text-red-100">Dismiss</button>
        </div>
      )}

      {/* ── Your todos (always visible, borderless list) ─────────────────── */}
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[12px] font-medium text-zinc-300">Your todos</span>
        <button
          onClick={() => setTodoInputOpen(true)}
          className="flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-300"
        >
          <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          Add
        </button>
      </div>
      <div className="flex flex-col gap-0.5">
        {todos.length === 0 && !todoInputOpen && (
          <div className="text-[12px] text-zinc-500">No todos yet</div>
        )}
        {todos.map((t) => (
          <div key={t.id} className="group flex items-center gap-2 py-0.5">
            <button
              onClick={() => toggleTodo(t.id, !t.done)}
              className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border ${t.done ? 'border-emerald-500 bg-emerald-500' : 'border-zinc-600 hover:border-zinc-400'}`}
            >
              {t.done && (
                <svg className="h-2.5 w-2.5 text-[#1F1F1F]" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              )}
            </button>
            <span className={`flex-1 text-[12px] ${t.done ? 'text-zinc-500 line-through' : 'text-zinc-200'}`}>{t.content}</span>
            <button
              onClick={() => deleteTodo(t.id)}
              className="invisible text-zinc-600 hover:text-zinc-300 group-hover:visible"
              title="Delete"
            >
              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        ))}
        {todoInputOpen && (
          <div className="flex items-center gap-2 py-0.5">
            <span className="h-3.5 w-3.5 shrink-0 rounded border border-zinc-600" />
            <input
              autoFocus
              value={newTodoContent}
              onChange={(e) => setNewTodoContent(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { addTodo(); }
                if (e.key === 'Escape') { setTodoInputOpen(false); setNewTodoContent('') }
              }}
              onBlur={() => { if (!newTodoContent.trim()) setTodoInputOpen(false) }}
              placeholder="Type a todo and press Enter"
              className="flex-1 border-0 bg-transparent p-0 text-[12px] text-zinc-200 placeholder-zinc-600 outline-none"
            />
          </div>
        )}
      </div>

      {/* ── Modals ─────────────────────────────────────────────────────── */}
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
              <button onClick={() => setShowCommitModal(false)} className="rounded border border-[#3A3A3A] px-3 py-1 text-[11px] text-zinc-300 hover:bg-white/5">Cancel</button>
              <button onClick={commitAndPush} disabled={!commitMessage.trim()} className="rounded bg-emerald-600 px-3 py-1 text-[11px] font-medium text-white hover:bg-emerald-500 disabled:opacity-40">Commit and push</button>
            </div>
          </div>
        </div>
      )}

      {showArchiveConfirm && (
        <div className="absolute inset-0 z-20 flex items-center justify-center" style={{ backgroundColor: 'rgba(0,0,0,0.55)' }}>
          <div className="w-[440px] rounded-md border border-[#2B2B2B] p-4 shadow-xl" style={{ backgroundColor: '#252526' }}>
            <div className="mb-2 text-[12px] font-medium text-zinc-200">Archive worktree?</div>

            {/* Context-aware body — separate copy for Merged vs Closed
                vs plain, so the user understands what's at stake. */}
            {isMergedRaw ? (
              <>
                <div className="mb-3 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-200">
                  <div className="mb-1 font-medium">This branch was already merged into main (PR #{pr?.number}).</div>
                  {hasUncommitted && (
                    <div>{status!.uncommitted} uncommitted change{status!.uncommitted === 1 ? '' : 's'} will be lost if you archive now.</div>
                  )}
                  {hasUnpushed && (
                    <div>{status!.commitsAhead} commit{status!.commitsAhead === 1 ? '' : 's'} not yet pushed will be lost too.</div>
                  )}
                </div>
                <div className="mb-3 text-[11px] text-zinc-400">
                  To keep this work, cancel and use one of the <span className="text-zinc-200">Continue &amp; commit and push</span> / <span className="text-zinc-200">Continue &amp; create PR</span> actions on the right — that pushes the follow-up edits and opens a new PR for them.
                </div>
              </>
            ) : isClosedRaw ? (
              <>
                <div className="mb-3 rounded border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-[11px] text-red-200">
                  <div className="mb-1 font-medium">PR #{pr?.number} was closed without merging.</div>
                  {hasUncommitted && (
                    <div>{status!.uncommitted} uncommitted change{status!.uncommitted === 1 ? '' : 's'} will be lost if you archive now.</div>
                  )}
                  {hasUnpushed && (
                    <div>{status!.commitsAhead} commit{status!.commitsAhead === 1 ? '' : 's'} not yet pushed will be lost too.</div>
                  )}
                </div>
                <div className="mb-3 text-[11px] text-zinc-400">
                  To keep this work, cancel and use <span className="text-zinc-200">Start over &amp; commit and push</span> or <span className="text-zinc-200">Start over &amp; create PR</span> — the commits land on the branch (and optionally into a new PR #{(pr?.number ?? 0) + 1}).
                </div>
              </>
            ) : (
              <>
                <div className="mb-3 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-200">
                  {hasUncommitted && (
                    <div>{status!.uncommitted} uncommitted change{status!.uncommitted === 1 ? '' : 's'} will be lost.</div>
                  )}
                  {hasUnpushed && (
                    <div>{status!.commitsAhead} commit{status!.commitsAhead === 1 ? '' : 's'} on this branch haven&apos;t been pushed yet.</div>
                  )}
                </div>
                <div className="mb-3 text-[11px] text-zinc-400">The worktree and its files will be removed from the sandbox. The branch stays on GitHub (push it first if you want to keep the work).</div>
              </>
            )}

            <div className="flex justify-end gap-2">
              <button onClick={() => setShowArchiveConfirm(false)} className="rounded border border-[#3A3A3A] px-3 py-1 text-[11px] text-zinc-300 hover:bg-white/5">Cancel</button>
              <button
                onClick={() => { setShowArchiveConfirm(false); onArchive?.() }}
                className="rounded bg-red-600 px-3 py-1 text-[11px] font-medium text-white hover:bg-red-500"
              >
                Archive anyway
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Row({ indicator, label, action }: { indicator: 'red' | 'amber' | 'blue' | 'gray' | 'green' | 'purple' | 'orange'; label: string; action?: React.ReactNode }) {
  const dot = {
    red: 'bg-red-500',
    amber: 'bg-amber-500',
    blue: 'bg-blue-500',
    gray: 'bg-zinc-600',
    green: 'bg-emerald-500',
    purple: 'bg-purple-500',
    orange: 'bg-orange-500',
  }[indicator]
  return (
    <div className="flex items-center gap-2 py-1">
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
      <span className="flex-1 text-[12px] text-zinc-300">{label}</span>
      {action}
    </div>
  )
}

function prIndicator(status: PullRequest['derivedStatus']): 'blue' | 'amber' | 'green' | 'red' | 'purple' | 'gray' | 'orange' {
  switch (status) {
    case 'draft': return 'gray'
    case 'open': return 'blue'
    case 'changes_requested': return 'orange'
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
