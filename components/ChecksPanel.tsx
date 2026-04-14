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
}

export function ChecksPanel({ projectId, sessionId, worktreeId, onArchive }: ChecksPanelProps) {
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

  // Commit message / move-to-branch modals.
  const [showCommitModal, setShowCommitModal] = useState(false)
  const [commitMessage, setCommitMessage] = useState('')
  const [showMoveToBranchModal, setShowMoveToBranchModal] = useState(false)
  const [newBranchName, setNewBranchName] = useState('')
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
      await refreshStatus()
    } catch (e) { setError(e instanceof Error ? e.message : 'Action failed') }
    finally { setBusy(null) }
  }

  async function createPR() {
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
        body: JSON.stringify({ title, body, draft: prDraft, autoCommit: needsAutoCommit, commitMessage: title }),
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
  }

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
      if (!res.ok) { const t = await res.json().catch(() => ({})); throw new Error(t.error || 'move failed') }
      setNewBranchName('')
      await refreshStatus()
      window.dispatchEvent(new CustomEvent('bornastar-refresh-worktrees'))
    } catch (e) { setError(e instanceof Error ? e.message : 'Move failed') }
    finally { setBusy(null) }
  }

  // ── Render ───────────────────────────────────────────────────────────────
  const pr = status?.pr ?? null
  const isMain = !worktreeId
  const hasUncommitted = (status?.uncommitted ?? 0) > 0
  const hasUnpushed = (status?.commitsAhead ?? 0) > 0
  const isBehind = (status?.commitsBehind ?? 0) > 0
  const hasOpenPr = !!pr && pr.state === 'open'
  const isMerged = !!pr && pr.merged
  const isReadyToMerge = hasOpenPr && pr && (pr.derivedStatus === 'approved' || (pr.derivedStatus === 'open' && pr.mergeable_state === 'clean'))
  // Git section is hidden when nothing is happening git-wise. Mirrors Conductor.
  const showGitSection = !!status && (
    hasUncommitted || hasUnpushed || isBehind || hasOpenPr || isMerged || !status.githubConnected || (isMain && status.mainProtected)
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
      <textarea
        value={displayBody}
        onChange={(e) => { if (lockFields) return; setPrBody(e.target.value); scheduleDraftSave(prTitle, e.target.value) }}
        rows={Math.max(2, displayBody.split('\n').length)}
        placeholder="PR description"
        readOnly={lockFields}
        className="mb-4 w-full resize-none border-0 bg-transparent p-0 text-[12px] text-zinc-300 placeholder-zinc-600 outline-none"
      />

      {/* Current changes — live diff summary, only once a PR is open. The
          PR body above is frozen at PR-creation time; this block shows
          what the branch actually holds right now so the user can see
          pushes that landed after the PR opened. */}
      {hasOpenPr && currentChangesSummary && (
        <div className="mb-6 rounded border border-[#2B2B2B] px-3 py-2" style={{ backgroundColor: 'rgba(255,255,255,0.02)' }}>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Current changes</div>
          <pre className="whitespace-pre-wrap break-words font-sans text-[11px] text-zinc-400">{currentChangesSummary}</pre>
        </div>
      )}

      {/* ── Git status (conditional) ─────────────────────────────────────── */}
      {showGitSection && (
        <>
          {isMerged && (
            <div className="mb-3 rounded-md border border-purple-500/40 p-3" style={{ backgroundColor: 'rgba(168, 85, 247, 0.12)' }}>
              <div className="mb-1.5 flex items-center gap-2">
                <span className="rounded bg-purple-600 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">Merged</span>
                <a href={pr?.html_url} target="_blank" rel="noreferrer" className="text-[11px] text-purple-200 hover:text-purple-100">#{pr?.number} — view on GitHub ↗</a>
              </div>
              <div className="mb-2 text-[11px] text-zinc-400">
                Your changes are now in <span className="font-mono text-zinc-300">main</span>. Continue working on this branch or archive it.
              </div>
              <button
                onClick={() => {
                  // Archive wipes the worktree. If the user made new
                  // changes after the merge and didn't push, the confirm
                  // modal lets them back out before losing anything.
                  if (hasUncommitted || hasUnpushed) setShowArchiveConfirm(true)
                  else onArchive?.()
                }}
                className="rounded border border-[#3C3C3C] px-2.5 py-1 text-[11px] text-zinc-200 hover:bg-white/5"
              >
                Archive
              </button>
            </div>
          )}
          {!isMerged && isReadyToMerge && pr && (
            <div className="mb-3 rounded-md border border-emerald-500/40 p-3" style={{ backgroundColor: 'rgba(16, 185, 129, 0.12)' }}>
              <div className="mb-1.5 flex items-center gap-2">
                <span className="rounded bg-emerald-600 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">Ready to merge</span>
                <a href={pr.html_url} target="_blank" rel="noreferrer" className="text-[11px] text-emerald-200 hover:text-emerald-100">#{pr.number} — view on GitHub ↗</a>
              </div>
              <div className="mb-2 text-[11px] text-zinc-400">Checks passed and the PR is approved.</div>
              <button onClick={mergePR} disabled={busy !== null} className="rounded bg-emerald-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-emerald-500 disabled:opacity-40">Merge</button>
            </div>
          )}

          <div className="mb-2 text-[12px] font-medium text-zinc-300">Git status</div>

          {status && !status.githubConnected && (
            <Row indicator="red" label="GitHub not connected" action={<a href="/api/auth/github/start" className="text-[11px] font-medium text-zinc-300 hover:text-zinc-100 disabled:opacity-40">Connect</a>} />
          )}

          {hasUncommitted && status && (
            <Row
              indicator="amber"
              label={`${status.uncommitted} uncommitted change${status.uncommitted === 1 ? '' : 's'}`}
              action={status.githubConnected && !(isMain && status.mainProtected) && (
                <button onClick={openCommitModal} disabled={busy !== null} className="text-[11px] font-medium text-zinc-300 hover:text-zinc-100 disabled:opacity-40">Commit and push</button>
              )}
            />
          )}

          {!isMain && isBehind && (
            <Row
              indicator="amber"
              label={`${status!.commitsBehind} commit${status!.commitsBehind === 1 ? '' : 's'} behind main`}
              action={<button onClick={updateBranch} disabled={busy !== null} className="text-[11px] font-medium text-zinc-300 hover:text-zinc-100 disabled:opacity-40">Update branch</button>}
            />
          )}

          {hasUnpushed && !hasOpenPr && !isMerged && !hasUncommitted && (
            <Row
              indicator="blue"
              label={`${status!.commitsAhead} commit${status!.commitsAhead === 1 ? '' : 's'} not pushed`}
              action={<button onClick={openCommitModal} disabled={busy !== null} className="text-[11px] font-medium text-zinc-300 hover:text-zinc-100 disabled:opacity-40">Push</button>}
            />
          )}

          {hasOpenPr && pr && !isReadyToMerge && (() => {
            // When the repo has branch protection and reviewers haven't
            // signed off yet, the GitHub API returns review_decision=
            // REVIEW_REQUIRED. Reflect that as "Awaiting approval" so the
            // user knows they can't merge until someone reviews — even if
            // CI is otherwise green.
            const awaiting = pr.derivedStatus === 'open' && pr.mergeable_state !== 'clean'
            const label = awaiting ? `PR #${pr.number} · Awaiting approval` : prLabel(pr)
            const indicator = awaiting ? 'amber' : prIndicator(pr.derivedStatus)
            return (
              <Row
                indicator={indicator}
                label={label}
                action={<a href={pr.html_url} target="_blank" rel="noreferrer" className="text-[11px] font-medium text-zinc-300 hover:text-zinc-100 disabled:opacity-40">View PR #{pr.number}</a>}
              />
            )
          })()}

          {!hasOpenPr && !isMerged && !isMain && status && (
            <Row
              indicator="gray"
              label="No PR open"
              action={status.githubConnected && (status.commitsAhead > 0 || hasUncommitted) ? (
                <div className="flex items-center gap-1">
                  <label className="flex items-center gap-1 text-[10px] text-zinc-400">
                    <input type="checkbox" checked={prDraft} onChange={(e) => setPrDraft(e.target.checked)} className="h-3 w-3" />
                    Draft
                  </label>
                  <button onClick={createPR} disabled={busy !== null} className="text-[11px] font-medium text-zinc-300 hover:text-zinc-100 disabled:opacity-40">Create PR</button>
                </div>
              ) : <span className="text-[11px] text-zinc-600">Nothing to push</span>}
            />
          )}

          {isMain && status?.mainProtected && (hasUncommitted || hasUnpushed) && (
            <Row
              indicator="red"
              label="Main is protected — push blocked"
              action={<button onClick={() => setShowMoveToBranchModal(true)} disabled={busy !== null} className="text-[11px] font-medium text-zinc-300 hover:text-zinc-100 disabled:opacity-40">Move to a branch</button>}
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
              <button onClick={() => setShowMoveToBranchModal(false)} className="rounded border border-[#3A3A3A] px-3 py-1 text-[11px] text-zinc-300 hover:bg-white/5">Cancel</button>
              <button onClick={moveToBranch} disabled={busy !== null} className="rounded bg-emerald-600 px-3 py-1 text-[11px] font-medium text-white hover:bg-emerald-500 disabled:opacity-40">Move</button>
            </div>
          </div>
        </div>
      )}

      {showArchiveConfirm && (
        <div className="absolute inset-0 z-20 flex items-center justify-center" style={{ backgroundColor: 'rgba(0,0,0,0.55)' }}>
          <div className="w-[420px] rounded-md border border-[#2B2B2B] p-4 shadow-xl" style={{ backgroundColor: '#252526' }}>
            <div className="mb-2 text-[12px] font-medium text-zinc-200">Archive worktree?</div>
            <div className="mb-3 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-200">
              {hasUncommitted && (
                <div>{status!.uncommitted} uncommitted change{status!.uncommitted === 1 ? '' : 's'} will be lost.</div>
              )}
              {hasUnpushed && (
                <div>{status!.commitsAhead} commit{status!.commitsAhead === 1 ? '' : 's'} on this branch haven&apos;t been pushed yet.</div>
              )}
            </div>
            <div className="mb-3 text-[11px] text-zinc-400">The worktree and its files will be removed from the sandbox. The branch stays on GitHub (push it first if you want to keep the work).</div>
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
    <div className="flex items-center gap-2 py-1">
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
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
