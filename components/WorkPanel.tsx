'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { MarkdownRenderer } from './MarkdownRenderer'
import { ChatTabs } from './ChatTabs'
import { CodeMirrorFileView, type CodeMirrorFileViewHandle } from './CodeMirrorFileView'
import { InlineDiffEditor, type InlineDiffEditorHandle } from './InlineDiffEditor'
import { ChecksPanel } from './ChecksPanel'
import { useGitStatus, deriveBadge } from '@/lib/hooks/useGitStatus'
import { ReportBadge } from './ChatReport'
import type { ChatReport } from '@/lib/report-types'

// ── Thinking Indicator ────────────────────────────────────────────────────

const THINKING_PHASES_DIRECT = [
  'Understanding your question...',
  'Analyzing the context...',
  'Reading relevant code...',
  'Formulating response...',
  'Putting it all together...',
]

const THINKING_PHASES_SKILL = (name: string) => [
  `${name} is reviewing the request...`,
  `${name} is analyzing the codebase...`,
  `${name} is thinking through the approach...`,
  `${name} is crafting a detailed response...`,
  `${name} is finalizing...`,
]

const THINKING_PHASES_TEAM = [
  'Dividing work into stages...',
  'Team is collaborating...',
  'Employees analyzing their parts...',
  'Processing through the pipeline...',
  'Consolidating team outputs...',
]

function ThinkingIndicator({ mode, employeeName }: { mode: 'direct' | 'skill' | 'team'; employeeName?: string }) {
  const [phaseIndex, setPhaseIndex] = useState(0)
  const [fade, setFade] = useState(true)

  const phases = mode === 'team'
    ? THINKING_PHASES_TEAM
    : mode === 'skill' && employeeName
      ? THINKING_PHASES_SKILL(employeeName)
      : THINKING_PHASES_DIRECT

  useEffect(() => {
    setPhaseIndex(0)
    setFade(true)
  }, [mode, employeeName])

  useEffect(() => {
    const interval = setInterval(() => {
      setFade(false)
      setTimeout(() => {
        setPhaseIndex((prev) => (prev + 1) % phases.length)
        setFade(true)
      }, 300)
    }, 3000)
    return () => clearInterval(interval)
  }, [phases.length])

  return (
    <div className="flex items-center gap-2.5 px-3 py-2">
      <div className="relative h-2 w-2">
        <div className="absolute inset-0 animate-ping rounded-full bg-violet-400/60" />
        <div className="absolute inset-0 rounded-full bg-violet-400" />
      </div>
      <span
        className={`text-[12px] text-zinc-400 transition-opacity duration-300 ${fade ? 'opacity-100' : 'opacity-0'}`}
      >
        {phases[phaseIndex]}
      </span>
    </div>
  )
}

// ── Live Step Message ─────────────────────────────────────────────────────
// Renders tool calls and file changes inline in the chat as the agent works.

function LiveStepMessage({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false)

  let parsed: { type?: string; label?: string; path?: string; action?: string; diff?: string } = {}
  try { parsed = JSON.parse(content) } catch { /* use raw */ }

  if (parsed.type === 'file_changed') {
    const isDelete = parsed.action === 'delete_file'
    return (
      <div className="flex justify-start pl-1">
        <div className="w-full max-w-[85%]">
          <button
            onClick={() => parsed.diff && setExpanded(!expanded)}
            className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[11px] transition-colors ${parsed.diff ? 'cursor-pointer hover:bg-white/5' : 'cursor-default'}`}
          >
            <span className={`font-mono text-[10px] font-bold ${isDelete ? 'text-red-400' : 'text-emerald-400'}`}>
              {isDelete ? 'D' : 'M'}
            </span>
            <span className="font-mono text-zinc-400">{parsed.path}</span>
            {parsed.diff && (
              <svg className={`ml-auto h-3 w-3 shrink-0 text-zinc-600 transition-transform ${expanded ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
              </svg>
            )}
          </button>
          {expanded && parsed.diff && (
            <div className="mt-1 overflow-x-auto rounded-lg border border-white/5 bg-black/50 p-3 font-mono text-[10px] leading-relaxed">
              {parsed.diff.split('\n').map((line, i) => {
                let color = 'text-zinc-500'
                if (line.startsWith('+') && !line.startsWith('+++')) color = 'text-emerald-400'
                else if (line.startsWith('-') && !line.startsWith('---')) color = 'text-red-400'
                else if (line.startsWith('@@')) color = 'text-blue-400'
                else if (line.startsWith('diff') || line.startsWith('index') || line.startsWith('---') || line.startsWith('+++')) color = 'text-zinc-600'
                return <div key={i} className={`whitespace-pre ${color}`}>{line || ' '}</div>
              })}
            </div>
          )}
        </div>
      </div>
    )
  }

  // Tool call step
  const label = parsed.label ?? content
  const icon = getToolIcon(label)
  return (
    <div className="flex justify-start pl-1">
      <div className="flex items-center gap-2 text-[11px] text-zinc-500">
        <span className="text-zinc-600">{icon}</span>
        <span className="font-mono">{label}</span>
      </div>
    </div>
  )
}

function getToolIcon(label: string): string {
  if (label.startsWith('Reading')) return '→'
  if (label.startsWith('Writing') || label.startsWith('Editing')) return '✎'
  if (label.startsWith('Deleting')) return '✕'
  if (label.startsWith('Listing')) return '≡'
  if (label.startsWith('Running') || label.startsWith('Searching')) return '⌘'
  return '·'
}

// ── Sidebar ───────────────────────────────────────────────────────────────
// Sidebar with collapsible repository folder(s). Each repo contains one
// unified list of items: main chats AND worktrees together (no section
// separation), differentiated by icon. A thin "+ add chat / + add worktree"
// row sits inside the repo, before the items list — so when multiple repos
// exist, each one controls where new items go.
//
// - Chats live directly on the project's main branch (no isolation)
// - Worktrees are isolated git branches; each worktree contains 1+ chats
//
// The active "thing" is either a main chat (selected via mainChatId) or a
// worktree (selected via worktreeId, with one of its chats currently open).

interface SidebarChat {
  id: string
  name: string
  // ISO timestamp of the last update — shown as "2h", "1d" etc. on hover.
  updatedAt?: string
}

interface SidebarWorktree {
  id: string
  name: string
  branchName: string
  updatedAt?: string
  sessions: SidebarChat[]
}

// Format an ISO timestamp as a compact relative age — "now", "5m", "2h",
// "1d", "100d". Used for the "last activity" badge in the sidebar.
function formatRelativeAge(iso?: string): string | null {
  if (!iso) return null
  const then = new Date(iso).getTime()
  if (isNaN(then)) return null
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000))
  if (seconds < 60) return 'now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d`
}

function ChatsSidebar({
  projectId,
  projectName,
  mainChats,
  worktrees,
  activeSessionId,
  activeWorktreeId,
  unreadIds,
  unreadWorktreeIds,
  busySessions,
  worktreeStats,
  chatStats,
  onSelectMainChat,
  onSelectWorktree,
  onNewMainChat,
  onNewWorktree,
  onAddChatToWorktree,
  onRenameSession,
  onRenameWorktree,
  onToggleUnread,
  onToggleWorktreeUnread,
  onChanged,
}: {
  projectId: string
  projectName: string
  mainChats: SidebarChat[]
  worktrees: SidebarWorktree[]
  activeSessionId: string | null
  activeWorktreeId: string | null
  unreadIds: Set<string>
  unreadWorktreeIds: Set<string>
  busySessions: Set<string>
  worktreeStats: Record<string, { added: number; removed: number; files: number }>
  chatStats: Record<string, { added: number; removed: number; files: number }>
  onSelectMainChat: (id: string) => void
  onSelectWorktree: (worktreeId: string) => void
  onNewMainChat: () => void
  onNewWorktree: () => void
  onAddChatToWorktree: (worktreeId: string) => void
  onRenameSession: (id: string, name: string) => void
  onRenameWorktree: (id: string, name: string) => void
  onToggleUnread: (id: string, unread: boolean) => void
  onToggleWorktreeUnread: (worktreeId: string, unread: boolean) => void
  onChanged: () => void
}) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null)
  const [showArchivedModal, setShowArchivedModal] = useState(false)
  const [showTrashModal, setShowTrashModal] = useState(false)
  const [pendingAction, setPendingAction] = useState<{
    targetType: 'session' | 'worktree'
    targetId: string
    targetName: string
    action: 'archive' | 'trash'
    // Present only when the target has uncommitted work that the confirmation
    // needs to surface (and that we'll discard if the user confirms).
    stats: { added: number; removed: number; files: number } | null
  } | null>(null)

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpenId) return
    function handleClick() { setMenuOpenId(null) }
    document.addEventListener('click', handleClick)
    return () => document.removeEventListener('click', handleClick)
  }, [menuOpenId])

  function startRename(id: string, currentName: string) {
    setEditingId(id)
    setEditValue(currentName)
  }
  function finishSessionRename(id: string) {
    if (editValue.trim()) onRenameSession(id, editValue.trim())
    setEditingId(null)
  }
  function finishWorktreeRename(id: string) {
    if (editValue.trim()) onRenameWorktree(id, editValue.trim())
    setEditingId(null)
  }

  // Archive/trash a chat session. Main chats live on main and can't have
  // uncommitted worktree work, so:
  //   - archive → silent
  //   - trash   → confirmation modal (no stats)
  async function callSessionAction(s: SidebarChat, action: 'archive' | 'trash') {
    if (action === 'archive') {
      try {
        const res = await fetch(`/api/projects/${projectId}/chat-sessions/${s.id}/archive`, { method: 'POST' })
        if (res.ok) onChanged()
      } catch (err) {
        console.error('[sidebar] session archive failed', err)
      }
      return
    }
    // trash → always confirm (with the 7-day notice)
    setPendingAction({
      targetType: 'session',
      targetId: s.id,
      targetName: s.name,
      action: 'trash',
      stats: null,
    })
  }

  // Archive/trash a worktree. Pending-changes status comes from the live
  // poll (worktreeStats):
  //   - archive clean → silent
  //   - archive dirty → modal with discard warning
  //   - trash  clean → modal with 7-day notice
  //   - trash  dirty → modal with 7-day + discard warning
  async function callWorktreeAction(w: SidebarWorktree, action: 'archive' | 'trash') {
    const stat = worktreeStats[w.id]
    const hasChanges = !!stat && (stat.added > 0 || stat.removed > 0)

    if (action === 'archive' && !hasChanges) {
      try {
        const res = await fetch(`/api/projects/${projectId}/worktrees/${w.id}/archive`, { method: 'POST' })
        if (res.ok) onChanged()
      } catch (err) {
        console.error('[sidebar] worktree archive failed', err)
      }
      return
    }

    setPendingAction({
      targetType: 'worktree',
      targetId: w.id,
      targetName: w.name,
      action,
      stats: hasChanges ? stat : null,
    })
  }

  // Confirm callback from the action modal: discard pending work first if
  // any, then perform archive/trash. Used by every flow that opens the modal.
  async function confirmPendingAction() {
    if (!pendingAction) return
    try {
      const base = pendingAction.targetType === 'worktree'
        ? `/api/projects/${projectId}/worktrees/${pendingAction.targetId}`
        : `/api/projects/${projectId}/chat-sessions/${pendingAction.targetId}`
      if (pendingAction.stats) {
        await fetch(`${base}/discard`, { method: 'POST' })
      }
      await fetch(`${base}/${pendingAction.action}`, { method: 'POST' })
      setPendingAction(null)
      onChanged()
    } catch (err) {
      console.error('[sidebar] confirmPendingAction failed', err)
    }
  }

  return (
    <div className="flex h-full w-72 shrink-0 flex-col border-r border-white/10" style={{ backgroundColor: '#1F1F1F' }}>

      {/* Scrollable list — starts directly with add buttons */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pt-2">
        <div>
              {/* Thin add rows */}
              <button
                onClick={onNewMainChat}
                className="flex w-full items-center gap-2 pl-9 pr-4 py-1.5 text-left text-zinc-500 hover:bg-white/[0.03] hover:text-zinc-300"
                title="New chat on main"
              >
                <svg className="h-3 w-3 shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                </svg>
                <span className="text-[11px]">add chat</span>
                <span className="text-[11px] text-zinc-700">(main)</span>
              </button>
              <button
                onClick={onNewWorktree}
                className="flex w-full items-center gap-2 pl-9 pr-4 py-1.5 text-left text-zinc-500 hover:bg-white/[0.03] hover:text-zinc-300"
                title="New worktree"
              >
                <svg className="h-3 w-3 shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                </svg>
                <span className="text-[11px]">add worktree</span>
                <span className="text-[11px] text-zinc-700">(branch)</span>
              </button>

              {/* Unified items list — main chats first, then worktrees */}
              {mainChats.length === 0 && worktrees.length === 0 && (
                <p className="px-9 py-2 text-[10px] text-zinc-600">No chats yet</p>
              )}

              {mainChats.map((s) => {
                const active = activeSessionId === s.id && !activeWorktreeId
                const unread = unreadIds.has(s.id) && !active
                return (
                  <ChatRow
                    key={s.id}
                    chat={s}
                    active={active}
                    unread={unread}
                    stats={chatStats[s.id]}
                    busy={busySessions.has(s.id)}
                    editing={editingId === s.id}
                    editValue={editValue}
                    setEditValue={setEditValue}
                    onClick={() => onSelectMainChat(s.id)}
                    onStartRename={() => startRename(s.id, s.name)}
                    onFinishRename={() => finishSessionRename(s.id)}
                    onCancelRename={() => setEditingId(null)}
                    menuOpen={menuOpenId === s.id}
                    setMenuOpen={(v) => setMenuOpenId(v ? s.id : null)}
                    onToggleUnread={() => onToggleUnread(s.id, !unread)}
                    onArchive={() => callSessionAction(s, 'archive')}
                    onTrash={() => callSessionAction(s, 'trash')}
                  />
                )
              })}

              {worktrees.map((w) => {
                const isActiveWorktree = activeWorktreeId === w.id
                const stat = worktreeStats[w.id]
                const hasChanges = stat && (stat.added > 0 || stat.removed > 0)
                const isUnread =
                  !isActiveWorktree &&
                  (unreadWorktreeIds.has(w.id) || w.sessions.some((s) => unreadIds.has(s.id)))
                // Worktree is "busy" if ANY of its nested sessions is busy
                const isWorktreeBusy = w.sessions.some((s) => busySessions.has(s.id))
                return (
                  <div
                    key={w.id}
                    onClick={() => onSelectWorktree(w.id)}
                    className={`group relative flex cursor-pointer items-center gap-2 pl-3 pr-4 py-3.5 ${
                      isActiveWorktree ? 'bg-white/[0.05]' : 'hover:bg-white/[0.025]'
                    }`}
                  >
                    {isWorktreeBusy ? (
                      <LoadingSpinner className={`h-3.5 w-3.5 shrink-0 ${isActiveWorktree ? 'text-violet-300' : 'text-violet-400'}`} />
                    ) : (
                    <svg
                      className={`h-3.5 w-3.5 shrink-0 ${
                        isActiveWorktree
                          ? 'text-zinc-200'
                          : isUnread
                            ? 'text-yellow-400'
                            : 'text-zinc-500'
                      }`}
                      fill="none"
                      viewBox="0 0 16 16"
                      stroke="currentColor"
                      strokeWidth="1.5"
                    >
                      <circle cx="4" cy="4" r="1.5" fill="currentColor" />
                      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
                      <path d="M4 5.5 L4 9 Q4 12 7 12 L10.5 12" strokeLinecap="round" />
                    </svg>
                    )}

                    {editingId === w.id ? (
                      <input
                        autoFocus
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onBlur={() => finishWorktreeRename(w.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') finishWorktreeRename(w.id)
                          if (e.key === 'Escape') setEditingId(null)
                        }}
                        onClick={(e) => e.stopPropagation()}
                        className="min-w-0 flex-1 bg-transparent text-[13px] text-zinc-100 outline-none"
                      />
                    ) : (
                      <div
                        className="flex min-w-0 flex-1 flex-col"
                        onDoubleClick={(e) => { e.stopPropagation(); startRename(w.id, w.name) }}
                      >
                        <span className={`truncate text-[13px] ${isActiveWorktree ? 'text-zinc-100' : 'text-zinc-300'}`}>
                          {w.name}
                        </span>
                        <span className="truncate font-mono text-[10px] text-zinc-500/70">
                          {w.branchName}
                          {formatRelativeAge(w.updatedAt) && (
                            <span className="ml-2 hidden group-hover:inline">· {formatRelativeAge(w.updatedAt)}</span>
                          )}
                        </span>
                      </div>
                    )}

                    {hasChanges && (
                      <span className="shrink-0 rounded-md border border-white/10 bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10px] tabular-nums">
                        <span className="text-emerald-400">+{stat.added}</span>
                        <span className="ml-1 text-red-400">-{stat.removed}</span>
                      </span>
                    )}

                    <div className="relative shrink-0">
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          setMenuOpenId(menuOpenId === w.id ? null : w.id)
                        }}
                        className={`text-zinc-500 hover:text-zinc-200 ${menuOpenId === w.id ? 'block' : 'hidden group-hover:block'}`}
                      >
                        <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 24 24">
                          <circle cx="5" cy="12" r="1.8" />
                          <circle cx="12" cy="12" r="1.8" />
                          <circle cx="19" cy="12" r="1.8" />
                        </svg>
                      </button>
                      {menuOpenId === w.id && (
                        <div
                          className="absolute right-0 top-full z-30 mt-1 w-44 rounded-lg border border-white/10 py-1 shadow-xl"
                          style={{ backgroundColor: '#252526' }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            onClick={() => { setMenuOpenId(null); startRename(w.id, w.name) }}
                            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-zinc-300 hover:bg-white/5"
                          >
                            Rename
                          </button>
                          <button
                            onClick={() => { setMenuOpenId(null); onAddChatToWorktree(w.id) }}
                            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-zinc-300 hover:bg-white/5"
                          >
                            Add chat
                          </button>
                          <button
                            onClick={() => {
                              setMenuOpenId(null)
                              onToggleWorktreeUnread(w.id, !unreadWorktreeIds.has(w.id))
                            }}
                            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-zinc-300 hover:bg-white/5"
                          >
                            {unreadWorktreeIds.has(w.id) ? 'Mark as read' : 'Mark as unread'}
                          </button>
                          <button
                            onClick={() => { setMenuOpenId(null); callWorktreeAction(w, 'archive') }}
                            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-zinc-300 hover:bg-white/5"
                          >
                            Archive
                          </button>
                          <div className="my-1 h-px bg-white/5" />
                          <button
                            onClick={() => { setMenuOpenId(null); callWorktreeAction(w, 'trash') }}
                            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-red-400 hover:bg-red-500/10"
                          >
                            Delete worktree
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
        </div>
      </div>

      {/* Footer — archive + trash (fixed at bottom) */}
      <div className="shrink-0 border-t border-white/10">
        <button
          onClick={() => setShowArchivedModal(true)}
          className="flex w-full items-center gap-2.5 px-4 py-1.5 text-left text-zinc-500 hover:bg-white/[0.03] hover:text-zinc-300"
        >
          <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z" />
          </svg>
          <span className="text-[11px]">Archived</span>
        </button>
        <button
          onClick={() => setShowTrashModal(true)}
          className="flex w-full items-center gap-2.5 px-4 py-1.5 text-left text-zinc-500 hover:bg-white/[0.03] hover:text-zinc-300"
        >
          <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
          </svg>
          <span className="text-[11px]">Trash</span>
        </button>
      </div>

      {/* Modals */}
      {showArchivedModal && (
        <ArchivedModal
          projectId={projectId}
          onClose={() => setShowArchivedModal(false)}
          onRestored={() => { setShowArchivedModal(false); onChanged() }}
        />
      )}
      {showTrashModal && (
        <TrashModal
          projectId={projectId}
          onClose={() => setShowTrashModal(false)}
          onChanged={() => onChanged()}
        />
      )}
      {pendingAction && (
        <ConfirmActionModal
          targetName={pendingAction.targetName}
          targetType={pendingAction.targetType}
          action={pendingAction.action}
          pendingStats={pendingAction.stats}
          onCancel={() => setPendingAction(null)}
          onConfirm={confirmPendingAction}
        />
      )}
    </div>
  )
}

// ── Reusable chat row ─────────────────────────────────────────────────────

// Animated loading spinner — used as a session "busy" indicator in the
// sidebar and tab bar when an agent is processing a message.
function LoadingSpinner({ className = '' }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} fill="none" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2.5" strokeOpacity="0.2" />
      <path d="M22 12a10 10 0 00-10-10" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  )
}

function ChatRow({
  chat,
  active,
  unread,
  busy,
  stats,
  editing,
  editValue,
  setEditValue,
  onClick,
  onStartRename,
  onFinishRename,
  onCancelRename,
  menuOpen,
  setMenuOpen,
  onToggleUnread,
  onArchive,
  onTrash,
}: {
  chat: SidebarChat
  active: boolean
  unread: boolean
  busy: boolean
  stats?: { added: number; removed: number; files: number }
  editing: boolean
  editValue: string
  setEditValue: (v: string) => void
  onClick: () => void
  onStartRename: () => void
  onFinishRename: () => void
  onCancelRename: () => void
  menuOpen: boolean
  setMenuOpen: (open: boolean) => void
  onToggleUnread: () => void
  onArchive: () => void
  onTrash: () => void
}) {
  return (
    <div
      onClick={onClick}
      className={`group relative flex cursor-pointer items-center gap-2 pl-3 pr-4 py-3.5 ${
        active ? 'bg-white/[0.05]' : 'hover:bg-white/[0.025]'
      }`}
    >
      {busy ? (
        <LoadingSpinner className={`h-3.5 w-3.5 shrink-0 ${active ? 'text-violet-300' : 'text-violet-400'}`} />
      ) : (
      <svg
        className={`h-3.5 w-3.5 shrink-0 ${active ? 'text-zinc-200' : unread ? 'text-yellow-400' : 'text-zinc-500'}`}
        fill="none"
        viewBox="0 0 16 16"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <path strokeLinejoin="round" d="M2.75 4.25 Q2.75 2.75 4.25 2.75 L11.75 2.75 Q13.25 2.75 13.25 4.25 L13.25 9.5 Q13.25 11 11.75 11 L7 11 L4.25 13.5 L4.25 11 Q2.75 11 2.75 9.5 Z" />
      </svg>
      )}

      {editing ? (
        <input
          autoFocus
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={onFinishRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onFinishRename()
            if (e.key === 'Escape') onCancelRename()
          }}
          onClick={(e) => e.stopPropagation()}
          className="min-w-0 flex-1 bg-transparent text-[13px] text-zinc-100 outline-none"
        />
      ) : (
        <div
          className="flex min-w-0 flex-1 flex-col"
          onDoubleClick={(e) => { e.stopPropagation(); onStartRename() }}
        >
          <span className={`truncate text-[13px] ${active ? 'text-zinc-100' : 'text-zinc-300'}`}>
            {chat.name}
          </span>
          <span className="truncate font-mono text-[10px] text-zinc-500/70">
            main
            {formatRelativeAge(chat.updatedAt) && (
              <span className="ml-2 hidden group-hover:inline">· {formatRelativeAge(chat.updatedAt)}</span>
            )}
          </span>
        </div>
      )}

      {stats && (stats.added > 0 || stats.removed > 0) && (
        <span className="shrink-0 rounded-md border border-white/10 bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10px] tabular-nums">
          <span className="text-emerald-400">+{stats.added}</span>
          <span className="ml-1 text-red-400">-{stats.removed}</span>
        </span>
      )}

      <div className="relative shrink-0">
        <button
          onClick={(e) => { e.stopPropagation(); setMenuOpen(!menuOpen) }}
          className={`text-zinc-500 hover:text-zinc-200 ${menuOpen ? 'block' : 'hidden group-hover:block'}`}
        >
          <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 24 24">
            <circle cx="5" cy="12" r="1.8" />
            <circle cx="12" cy="12" r="1.8" />
            <circle cx="19" cy="12" r="1.8" />
          </svg>
        </button>
        {menuOpen && (
          <div
            className="absolute right-0 top-full z-30 mt-1 w-44 rounded-lg border border-white/10 py-1 shadow-xl"
            style={{ backgroundColor: '#252526' }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => { setMenuOpen(false); onStartRename() }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-zinc-300 hover:bg-white/5"
            >
              Rename
            </button>
            <button
              onClick={() => { setMenuOpen(false); onToggleUnread() }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-zinc-300 hover:bg-white/5"
            >
              {unread ? 'Mark as read' : 'Mark as unread'}
            </button>
            <button
              onClick={() => { setMenuOpen(false); onArchive() }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-zinc-300 hover:bg-white/5"
            >
              Archive
            </button>
            <div className="my-1 h-px bg-white/5" />
            <button
              onClick={() => { setMenuOpen(false); onTrash() }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-red-400 hover:bg-red-500/10"
            >
              Delete chat
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Archived modal ────────────────────────────────────────────────────────

function ArchivedModal({
  projectId,
  onClose,
  onRestored,
}: {
  projectId: string
  onClose: () => void
  onRestored: () => void
}) {
  const [items, setItems] = useState<{ id: string; name: string; updatedAt: string }[]>([])
  const [loading, setLoading] = useState(true)

  // Lock background scroll while the modal is mounted
  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previousOverflow }
  }, [])

  useEffect(() => {
    fetch(`/api/projects/${projectId}/chat-sessions/archived`)
      .then((r) => r.json())
      .then((d) => setItems(d.sessions ?? []))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [projectId])

  async function restore(id: string) {
    await fetch(`/api/projects/${projectId}/chat-sessions/${id}/restore`, { method: 'POST' })
    setItems((prev) => prev.filter((s) => s.id !== id))
    onRestored()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="flex h-[560px] max-h-[80vh] w-full max-w-md flex-col overflow-hidden rounded-xl border border-white/10 shadow-2xl"
        style={{ backgroundColor: '#181818' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-[#2B2B2B] px-5 py-3">
          <h3 className="text-[13px] font-semibold text-zinc-100">Archived chats</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <p className="px-5 py-6 text-center text-[11px] text-zinc-500">Loading...</p>
          ) : items.length === 0 ? (
            <p className="px-5 py-6 text-center text-[11px] text-zinc-500">No archived chats.</p>
          ) : (
            items.map((s) => (
              <div key={s.id} className="flex items-center justify-between border-b border-[#2B2B2B] px-5 py-3 last:border-b-0">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12px] text-zinc-200">{s.name}</p>
                  <p className="mt-0.5 text-[10px] text-zinc-600">
                    Archived {new Date(s.updatedAt).toLocaleDateString()}
                  </p>
                </div>
                <button
                  onClick={() => restore(s.id)}
                  className="ml-3 rounded-md border border-[#3C3C3C] px-2.5 py-1 text-[11px] text-zinc-300 hover:border-white/30 hover:bg-white/5"
                >
                  Restore
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

// ── Trash modal ───────────────────────────────────────────────────────────

function TrashModal({
  projectId,
  onClose,
  onChanged,
}: {
  projectId: string
  onClose: () => void
  onChanged: () => void
}) {
  const [items, setItems] = useState<{ id: string; name: string; trashedAt: string; daysLeft: number }[]>([])
  const [loading, setLoading] = useState(true)

  // Lock background scroll while the modal is mounted
  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previousOverflow }
  }, [])

  function reload() {
    setLoading(true)
    fetch(`/api/projects/${projectId}/chat-sessions/trash`)
      .then((r) => r.json())
      .then((d) => setItems(d.sessions ?? []))
      .catch(() => {})
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  async function restore(id: string) {
    await fetch(`/api/projects/${projectId}/chat-sessions/${id}/restore`, { method: 'POST' })
    setItems((prev) => prev.filter((s) => s.id !== id))
    onChanged()
  }

  async function deleteForever(id: string) {
    await fetch(`/api/projects/${projectId}/chat-sessions/${id}/delete-forever`, { method: 'POST' })
    setItems((prev) => prev.filter((s) => s.id !== id))
    onChanged()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="flex h-[560px] max-h-[80vh] w-full max-w-md flex-col overflow-hidden rounded-xl border border-white/10 shadow-2xl"
        style={{ backgroundColor: '#181818' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-[#2B2B2B] px-5 py-3">
          <h3 className="text-[13px] font-semibold text-zinc-100">Trash</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <p className="px-5 py-6 text-center text-[11px] text-zinc-500">Loading...</p>
          ) : items.length === 0 ? (
            <p className="px-5 py-6 text-center text-[11px] text-zinc-500">Trash is empty.</p>
          ) : (
            items.map((s) => (
              <div key={s.id} className="flex items-center justify-between gap-2 border-b border-[#2B2B2B] px-5 py-3 last:border-b-0">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12px] text-zinc-200">{s.name}</p>
                  <p className="mt-0.5 text-[10px] text-zinc-600">
                    Expires in {s.daysLeft} {s.daysLeft === 1 ? 'day' : 'days'}
                  </p>
                </div>
                <button
                  onClick={() => restore(s.id)}
                  className="rounded-md border border-[#3C3C3C] px-2.5 py-1 text-[11px] text-zinc-300 hover:border-white/30 hover:bg-white/5"
                >
                  Restore
                </button>
                <button
                  onClick={() => deleteForever(s.id)}
                  className="rounded-md border border-red-500/30 px-2.5 py-1 text-[11px] text-red-400 hover:border-red-500/60 hover:bg-red-500/10"
                >
                  Delete forever
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

// ── Pending changes modal ─────────────────────────────────────────────────

// Adaptive confirmation modal for archive/delete actions on chats and
// worktrees. Behavior:
//   - action=trash → always shows the "stays in trash 7 days" line
//   - pendingStats present → also shows the +/- file diff and warns work
//                            will be lost (caller is expected to discard
//                            the worktree before performing the action)
//
// Cancel keeps everything as-is. Confirm runs the caller's onConfirm.
function ConfirmActionModal({
  targetName,
  targetType,
  action,
  pendingStats,
  onCancel,
  onConfirm,
}: {
  targetName: string
  targetType: 'session' | 'worktree'
  action: 'archive' | 'trash'
  pendingStats: { added: number; removed: number; files: number } | null
  onCancel: () => void
  onConfirm: () => void
}) {
  const isTrash = action === 'trash'
  const isWorktree = targetType === 'worktree'
  const noun = isWorktree ? 'worktree' : 'chat'
  const verbCap = isTrash ? 'Delete' : 'Archive'
  const verbLow = isTrash ? 'delete' : 'archive'
  const confirmLabel = pendingStats ? `Discard & ${verbLow}` : verbCap

  let title: string
  if (isTrash && pendingStats) title = `Delete ${noun} with pending changes`
  else if (isTrash) title = `Delete ${noun}`
  else title = `Archive ${noun} with pending changes`

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onCancel}>
      <div
        className="w-full max-w-sm overflow-hidden rounded-xl border border-white/10 shadow-2xl"
        style={{ backgroundColor: '#181818' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-[#2B2B2B] px-5 py-3">
          <h3 className="text-[13px] font-semibold text-zinc-100">{title}</h3>
        </div>
        <div className="px-5 py-4">
          <p className="text-[12px] leading-relaxed text-zinc-300">
            <span className="font-medium text-zinc-100">{targetName}</span>
          </p>

          {isTrash && (
            <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
              Stays in your trash for <span className="text-zinc-300">7 days</span>, then it&apos;s gone for good. You can restore it before that.
            </p>
          )}

          {pendingStats && (
            <>
              <div className="mt-3 flex items-center gap-3 rounded-md border border-[#2B2B2B] px-3 py-2 font-mono text-[11px]">
                <span className="text-emerald-400">+{pendingStats.added}</span>
                <span className="text-red-400">-{pendingStats.removed}</span>
                <span className="text-zinc-600">·</span>
                <span className="text-zinc-500">
                  {pendingStats.files} {pendingStats.files === 1 ? 'file' : 'files'}
                </span>
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-amber-400/80">
                There&apos;s uncommitted work in this worktree. If you continue, it will be discarded.
              </p>
            </>
          )}
        </div>
        <div className="flex border-t border-[#2B2B2B]">
          <button
            onClick={onCancel}
            className="flex-1 border-r border-[#2B2B2B] px-4 py-2.5 text-[12px] text-zinc-400 hover:bg-white/5 hover:text-zinc-200"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 px-4 py-2.5 text-[12px] text-red-400 hover:bg-red-500/10"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Types ──────────────────────────────────────────────────────────────────

interface FileEntry {
  id: string
  path: string
  isModified: boolean
  isNew: boolean
  sizeBytes: number
  // Cross-worktree info — present only when at least one open worktree touched this file
  added?: number
  removed?: number
  worktrees?: { id: string; name: string }[]
}

interface HiredEmployee {
  id: string
  name: string
  color: string
  role: string
}

interface TeamInfo {
  id: string
  name: string
  memberIds: string[]
  hasBuilder: boolean
  order: string[]
  canRecreateTasks: Record<string, string>
}

interface Message {
  id: string
  content: string
  sender: string
  mode: string
  activeSkillId: string | null
  report: Record<string, unknown> | null
  createdAt: string
}

type ChatMode = 'no_skill' | 'skill' | 'team'

interface WorkPanelProps {
  projectId: string
  hiredEmployees: HiredEmployee[]
  teams: TeamInfo[]
  sidebarOpen?: boolean
}

interface SessionInfo {
  id: string
  name: string
  worktreeId?: string | null
  updatedAt?: string
}

interface WorktreeInfo {
  id: string
  name: string
  branchName: string
  updatedAt?: string
  sessions: { id: string; name: string; updatedAt?: string }[]
}

export function WorkPanel({ projectId, hiredEmployees, teams, sidebarOpen = true }: WorkPanelProps) {
  const [terminalOpen, setTerminalOpen] = useState(true)
  // Bottom panel active tab — Terminal by default, Checks shows git state
  // with the commit / push / PR / merge action buttons.
  const [bottomTab, setBottomTab] = useState<'terminal' | 'checks'>('terminal')
  const [rightPanelTab, setRightPanelTab] = useState<'explorer' | 'changes'>('explorer')
  // Changes tab: select-mode toggle. When on, rows show checkboxes and the
  // action bar at the bottom replaces the default row click behavior with
  // selection toggling. Lives up here (not inside ChangesList) so the header
  // icon can drive it.
  const [changesSelectMode, setChangesSelectMode] = useState(false)
  const [rightPanelExpanded, setRightPanelExpanded] = useState(false)
  const [showTargetBranchPicker, setShowTargetBranchPicker] = useState(false)
  const [targetBranchSearch, setTargetBranchSearch] = useState('')
  // Scratchpad — per-project free-form notes, referenced via @notes in chat
  const [showScratchpad, setShowScratchpad] = useState(false)
  const [scratchpadContent, setScratchpadContent] = useState('')
  // Sessions that are currently processing (agent is working) — shown as
  // spinner icons in the sidebar + worktree tab bar
  const [busySessions, setBusySessions] = useState<Set<string>>(new Set())

  // Hunk attachments from the Changes panel → injected into the next chat
  // message. Stored as an array so the user can accumulate multiple hunks
  // (even across different files) before sending. Each entry is cleared
  // individually via its chip's × button, or all at once on send.
  const [pendingHunkAttachments, setPendingHunkAttachments] = useState<Array<{
    filePath: string
    fileStatus: 'M' | 'A' | 'D'
    focusStart: number
    focusEnd: number
    formattedContent: string
    lineRange: string
  }>>([])

  // Stable callback passed to ChatPanel — prevents infinite re-renders by
  // keeping the reference identity across parent renders.
  const handleBusyChange = useCallback((sid: string, busy: boolean) => {
    setBusySessions((prev) => {
      const alreadyHas = prev.has(sid)
      if (busy && alreadyHas) return prev
      if (!busy && !alreadyHas) return prev
      const next = new Set(prev)
      if (busy) next.add(sid)
      else next.delete(sid)
      return next
    })
  }, [])

  // Load scratchpad from localStorage on mount (per-project)
  useEffect(() => {
    try {
      const saved = localStorage.getItem(`bornastar:scratchpad:${projectId}`)
      if (saved !== null) setScratchpadContent(saved)
    } catch { /* ignore */ }
  }, [projectId])

  // Debounced save to localStorage whenever content changes
  useEffect(() => {
    const timer = setTimeout(() => {
      try { localStorage.setItem(`bornastar:scratchpad:${projectId}`, scratchpadContent) } catch { /* ignore */ }
    }, 400)
    return () => clearTimeout(timer)
  }, [projectId, scratchpadContent])
  const [activeMode, setActiveMode] = useState<ChatMode>('no_skill')
  const [activeSkillId, setActiveSkillId] = useState<string | null>(null)
  const [activeTeamId, setActiveTeamId] = useState<string | null>(null)
  const [chatMessages, setChatMessages] = useState<Message[]>([])
  const [teamRunState, setTeamRunState] = useState<unknown>(null)
  const [teamRunActive, setTeamRunActive] = useState(false)

  // Session + worktree management
  const [mainChats, setMainChats] = useState<SessionInfo[]>([])
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [activeWorktreeId, setActiveWorktreeId] = useState<string | null>(null)
  // Git status for the currently-active chat context (main or worktree).
  // Drives the colored badge next to the branch label in the right panel.
  const { status: activeGitStatus } = useGitStatus(projectId, activeSessionId, activeWorktreeId, 30000)
  const statusBadge = deriveBadge(activeGitStatus)
  const [worktreeTabMenuId, setWorktreeTabMenuId] = useState<string | null>(null)
  const [worktreeTabMenuPos, setWorktreeTabMenuPos] = useState<{ top: number; left: number } | null>(null)
  const [closingWorktreeChat, setClosingWorktreeChat] = useState<{ worktreeId: string; sessionId: string; sessionName: string } | null>(null)
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null)
  const [renamingTabValue, setRenamingTabValue] = useState('')
  const [projectMeta, setProjectMeta] = useState<{ name: string; repoName?: string } | null>(null)
  const [unreadSessionIds, setUnreadSessionIds] = useState<Set<string>>(new Set())
  // Manual "mark worktree as unread" flag — independent from individual chat
  // unread state. The worktree icon is yellow if it's in this set OR if any
  // nested chat is unread. Both clear when the user enters the worktree.
  const [unreadWorktreeIds, setUnreadWorktreeIds] = useState<Set<string>>(new Set())
  const [worktreeStats, setWorktreeStats] = useState<Record<string, { added: number; removed: number; files: number }>>({})
  const [chatStats, setChatStats] = useState<Record<string, { added: number; removed: number; files: number }>>({})

  // Poll diff stats for all worktrees AND main chats every 5s, in parallel
  useEffect(() => {
    let cancelled = false
    async function fetchStats() {
      try {
        const [wtRes, chatRes] = await Promise.all([
          fetch(`/api/projects/${projectId}/worktrees/stats`),
          fetch(`/api/projects/${projectId}/chat-sessions/stats`),
        ])
        if (wtRes.ok) {
          const data = await wtRes.json()
          if (!cancelled) setWorktreeStats(data)
        }
        if (chatRes.ok) {
          const data = await chatRes.json()
          if (!cancelled) setChatStats(data)
        }
      } catch { /* ignore */ }
    }
    fetchStats()
    const interval = setInterval(fetchStats, 5000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [projectId])

  // Close worktree tab menu on outside click
  useEffect(() => {
    if (!worktreeTabMenuId) return
    function handleClick() { setWorktreeTabMenuId(null); setWorktreeTabMenuPos(null) }
    document.addEventListener('click', handleClick)
    return () => document.removeEventListener('click', handleClick)
  }, [worktreeTabMenuId])

  // Load project metadata once
  useEffect(() => {
    fetch(`/api/projects/${projectId}`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (data) setProjectMeta({
          name: data.project?.name ?? 'project',
          repoName: data.repository?.repo ?? undefined,
        })
      })
      .catch(() => {})
  }, [projectId])

  const activeEmployee = hiredEmployees.find((e) => e.id === activeSkillId)
  const activeTeam = teams.find((t) => t.id === activeTeamId)

  // Load (or reload) main chats AND worktrees together. Used after any
  // mutation in the sidebar (create, archive, trash, restore).
  const reloadAll = useCallback(async (preserveActive: boolean = true) => {
    try {
      const [chatsRes, worktreesRes] = await Promise.all([
        fetch(`/api/projects/${projectId}/chat-sessions`),
        fetch(`/api/projects/${projectId}/worktrees`),
      ])
      const chatsData = await chatsRes.json()
      const worktreesData = await worktreesRes.json()
      const allSessions: SessionInfo[] = chatsData.sessions ?? []
      const main = allSessions.filter((s) => !s.worktreeId)
      const wts: WorktreeInfo[] = worktreesData.worktrees ?? []

      setMainChats(main)
      setWorktrees(wts)

      if (!preserveActive) {
        // No previous active — pick the most recent main chat or worktree
        if (main.length > 0) {
          setActiveSessionId(main[main.length - 1].id)
          setActiveWorktreeId(null)
        } else if (wts.length > 0) {
          setActiveWorktreeId(wts[wts.length - 1].id)
          setActiveSessionId(wts[wts.length - 1].sessions[0]?.id ?? null)
        } else {
          setActiveSessionId(null)
          setActiveWorktreeId(null)
        }
      }
    } catch { /* ignore */ }
  }, [projectId])

  // Other parts of the app (e.g. the ChecksPanel after move-to-branch) can
  // ask the sidebar to refresh worktrees by dispatching this event.
  useEffect(() => {
    const handler = () => reloadAll(true)
    window.addEventListener('bornastar-refresh-worktrees', handler)
    return () => window.removeEventListener('bornastar-refresh-worktrees', handler)
  }, [reloadAll])

  // Load on mount
  useEffect(() => {
    reloadAll(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  // Load messages when active session changes
  useEffect(() => {
    if (!activeSessionId) { setChatMessages([]); return }
    fetch(`/api/projects/${projectId}/chat-sessions/${activeSessionId}`)
      .then((r) => r.json())
      .then((data) => setChatMessages((data.messages ?? []).map((m: Message) => ({ ...m, mode: m.mode ?? 'no_skill', activeSkillId: m.activeSkillId ?? null }))))
      .catch(() => setChatMessages([]))
  }, [activeSessionId, projectId])

  // Detect new messages in non-active sessions — mark as unread
  useEffect(() => {
    let lastCheck = new Date().toISOString()
    const interval = setInterval(async () => {
      try {
        const r = await fetch(`/api/projects/${projectId}/chat/status?after=${lastCheck}`)
        if (!r.ok) return
        const d = await r.json()
        const newMsgs: { sessionId?: string; sender: string }[] = d.messages ?? []
        // Only mark assistant/employee messages — not user echoes or steps
        const replies = newMsgs.filter(m => m.sender !== 'user' && m.sender !== 'step' && m.sessionId && m.sessionId !== activeSessionId)
        if (replies.length > 0) {
          setUnreadSessionIds((prev) => {
            const next = new Set(prev)
            replies.forEach(m => { if (m.sessionId) next.add(m.sessionId) })
            return next
          })
        }
        lastCheck = new Date().toISOString()
      } catch { /* ignore */ }
    }, 3000)
    return () => clearInterval(interval)
  }, [projectId, activeSessionId])

  // Check for active team run
  useEffect(() => {
    fetch(`/api/projects/${projectId}/team-run`)
      .then((r) => r.json())
      .then((data) => {
        if (data.active && data.lastRun) {
          setTeamRunState(data.lastRun.state)
          setTeamRunActive(true)
          setActiveMode('team')
        } else if (data.lastRun) {
          setTeamRunState(data.lastRun.state)
          setTeamRunActive(false)
        }
      })
      .catch(() => {})
  }, [projectId])

  // Listen for team run state updates
  useEffect(() => {
    function handleUpdate(e: Event) {
      const detail = (e as CustomEvent).detail
      if (detail) { setTeamRunState(detail); setTeamRunActive(true) }
    }
    window.addEventListener('teamrun-update', handleUpdate)
    return () => window.removeEventListener('teamrun-update', handleUpdate)
  }, [])

  // Listen for session replacement (clear conversation)
  useEffect(() => {
    function handleReplace(e: Event) {
      const { oldId, newId } = (e as CustomEvent).detail
      if (activeSessionId === oldId) setActiveSessionId(newId)
      reloadAll(true)
    }
    window.addEventListener('session-replaced', handleReplace)
    return () => window.removeEventListener('session-replaced', handleReplace)
  }, [activeSessionId, reloadAll])

  // Create a new chat directly on main (no worktree).
  async function handleNewMainChat() {
    const res = await fetch(`/api/projects/${projectId}/chat-sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    if (res.ok) {
      const session = await res.json()
      setMainChats((prev) => [...prev, { id: session.id, name: session.name, worktreeId: null }])
      setActiveSessionId(session.id)
      setActiveWorktreeId(null)
      setChatMessages([])
    }
  }

  // Create a new worktree (provisions branch + first chat).
  async function handleNewWorktree() {
    const res = await fetch(`/api/projects/${projectId}/worktrees`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    if (res.ok) {
      const { worktree, session } = await res.json()
      setWorktrees((prev) => [...prev, {
        id: worktree.id,
        name: worktree.name,
        branchName: worktree.branchName,
        sessions: [{ id: session.id, name: session.name }],
      }])
      setActiveWorktreeId(worktree.id)
      setActiveSessionId(session.id)
      setChatMessages([])
    }
  }

  // Add another chat to an existing worktree (collaboration on the same branch).
  async function handleAddChatToWorktree(worktreeId: string) {
    const res = await fetch(`/api/projects/${projectId}/chat-sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ worktreeId }),
    })
    if (res.ok) {
      const session = await res.json()
      setWorktrees((prev) => prev.map((w) =>
        w.id === worktreeId
          ? { ...w, sessions: [...w.sessions, { id: session.id, name: session.name }] }
          : w
      ))
      setActiveWorktreeId(worktreeId)
      setActiveSessionId(session.id)
      setChatMessages([])
    }
  }

  // ── Hunk attach handlers ────────────────────────────────────────────────
  //
  // When the user clicks "Attach to current chat" or "Attach to new chat" on
  // a diff hunk card, we build a formatted snippet that will be prepended to
  // their next chat message (with a "focused on lines X-Y" marker).

  function buildHunkAttachmentPayload(
    filePath: string,
    fileStatus: 'M' | 'A' | 'D',
    hunk: DiffHunk,
  ): {
    filePath: string
    fileStatus: 'M' | 'A' | 'D'
    focusStart: number
    focusEnd: number
    formattedContent: string
    lineRange: string
  } {
    // Compute focus range from hunk — min..max of any line number present
    const oldNums = hunk.lines.map((l) => l.oldLine).filter((n): n is number => typeof n === 'number')
    const newNums = hunk.lines.map((l) => l.newLine).filter((n): n is number => typeof n === 'number')
    const allNums = [...oldNums, ...newNums]
    const focusStart = allNums.length > 0 ? Math.min(...allNums) : hunk.newStart
    const focusEnd = allNums.length > 0 ? Math.max(...allNums) : hunk.newStart

    // Format: file header + diff block with markers around the focused hunk.
    // TODO: when the real git diff API is wired, include the full file here
    // with the hunk lines highlighted. For now we send the hunk diff itself.
    const diffLines = hunk.lines.map((l) => {
      const marker = l.type === 'add' ? '+' : l.type === 'remove' ? '-' : ' '
      return `${marker}${l.content}`
    }).join('\n')

    const formattedContent = [
      `📎 Attached from Changes — ${filePath} (${fileStatus})`,
      `Focus: lines ${focusStart}–${focusEnd}`,
      '```diff',
      diffLines,
      '```',
      '',
    ].join('\n')

    return {
      filePath,
      fileStatus,
      focusStart,
      focusEnd,
      formattedContent,
      lineRange: focusStart === focusEnd ? `line ${focusStart}` : `lines ${focusStart}-${focusEnd}`,
    }
  }

  async function handleAttachHunkToCurrentChat(filePath: string, fileStatus: 'M' | 'A' | 'D', hunk: DiffHunk) {
    const payload = buildHunkAttachmentPayload(filePath, fileStatus, hunk)
    // If no chat is active, create a new main chat first (user is implicitly
    // viewing main changes when they have no worktree/chat open)
    if (!activeSessionId && !activeWorktreeId) {
      await handleNewMainChat()
    }
    // Accumulate — same file+range is a no-op so double-clicks don't duplicate.
    setPendingHunkAttachments((prev) => {
      const dup = prev.some((p) =>
        p.filePath === payload.filePath &&
        p.focusStart === payload.focusStart &&
        p.focusEnd === payload.focusEnd,
      )
      return dup ? prev : [...prev, payload]
    })
  }

  async function handleAttachHunkToNewChat(filePath: string, fileStatus: 'M' | 'A' | 'D', hunk: DiffHunk) {
    const payload = buildHunkAttachmentPayload(filePath, fileStatus, hunk)
    // New chat follows the current context: inside a worktree → add chat to
    // that worktree. Otherwise (main or empty) → new main chat.
    if (activeWorktreeId) {
      await handleAddChatToWorktree(activeWorktreeId)
    } else {
      await handleNewMainChat()
    }
    // New chat starts fresh with exactly one attachment.
    setPendingHunkAttachments([payload])
  }

  // Bulk attach — used by the select-mode action bar in the Changes panel.
  // We flatten every hunk of every selected file into an array of payloads
  // (dedup'd by filePath+range) and hand the whole batch to the same state
  // the single-hunk flow uses — so the chat input renders them as chips just
  // like individual attaches do.
  function flattenSelectedToPayloads(files: MockChangedFile[]) {
    const seen = new Set<string>()
    const out: Array<ReturnType<typeof buildHunkAttachmentPayload>> = []
    for (const f of files) {
      for (const h of f.hunks) {
        const p = buildHunkAttachmentPayload(f.path, f.status, h)
        const key = `${p.filePath}:${p.focusStart}-${p.focusEnd}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push(p)
      }
    }
    return out
  }

  async function handleBulkAttachToCurrentChat(files: MockChangedFile[]) {
    if (files.length === 0) return
    if (!activeSessionId && !activeWorktreeId) {
      await handleNewMainChat()
    }
    const payloads = flattenSelectedToPayloads(files)
    // Append + dedupe against whatever's already staged.
    setPendingHunkAttachments((prev) => {
      const seen = new Set(prev.map((p) => `${p.filePath}:${p.focusStart}-${p.focusEnd}`))
      const merged = [...prev]
      for (const p of payloads) {
        const key = `${p.filePath}:${p.focusStart}-${p.focusEnd}`
        if (!seen.has(key)) { seen.add(key); merged.push(p) }
      }
      return merged
    })
  }

  async function handleBulkAttachToNewChat(files: MockChangedFile[]) {
    if (files.length === 0) return
    if (activeWorktreeId) {
      await handleAddChatToWorktree(activeWorktreeId)
    } else {
      await handleNewMainChat()
    }
    setPendingHunkAttachments(flattenSelectedToPayloads(files))
  }

  async function handleCloseWorktreeChat(worktreeId: string, sessionId: string) {
    // Close the chat (status → closed, messages preserved in DB)
    await fetch(`/api/projects/${projectId}/chat-sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'closed' }),
    })
    // Update local state — remove from worktree sessions
    setWorktrees((prev) => prev.map((w) =>
      w.id === worktreeId
        ? { ...w, sessions: w.sessions.filter((s) => s.id !== sessionId) }
        : w
    ))
    // If the closed chat was active, switch to the next available one
    if (activeSessionId === sessionId) {
      const wt = worktrees.find((w) => w.id === worktreeId)
      const remaining = wt?.sessions.filter((s) => s.id !== sessionId) ?? []
      setActiveSessionId(remaining[0]?.id ?? null)
      setChatMessages([])
    }
  }

  async function handleRenameSession(id: string, name: string) {
    await fetch(`/api/projects/${projectId}/chat-sessions/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    setMainChats((prev) => prev.map((s) => s.id === id ? { ...s, name } : s))
    setWorktrees((prev) => prev.map((w) => ({
      ...w,
      sessions: w.sessions.map((s) => s.id === id ? { ...s, name } : s),
    })))
  }

  async function handleRenameWorktree(id: string, name: string) {
    await fetch(`/api/projects/${projectId}/worktrees/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    setWorktrees((prev) => prev.map((w) => w.id === id ? { ...w, name } : w))
  }

  function handleSelectEmployee(emp: HiredEmployee) {
    setActiveMode('skill')
    setActiveSkillId(emp.id)
    setActiveTeamId(null)
  }

  function handleSelectTeam(team: TeamInfo) {
    setActiveMode('team')
    setActiveTeamId(team.id)
    setActiveSkillId(null)
  }

  function handleClearSelection() {
    setActiveMode('no_skill')
    setActiveSkillId(null)
    setActiveTeamId(null)
  }

  // Count changed files for the Changes tab badge — sum of all worktree + chat stats files
  const changedFilesCount = Object.values(worktreeStats).reduce((sum, s) => sum + s.files, 0)
    + Object.values(chatStats).reduce((sum, s) => sum + s.files, 0)

  const hasOpenChat = activeSessionId !== null

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Main area (sidebar + chat + file tree + minimap) */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: Chats sidebar */}
        {sidebarOpen && <ChatsSidebar
          projectId={projectId}
          projectName={projectMeta?.name ?? 'project'}
          mainChats={mainChats}
          worktrees={worktrees}
          activeSessionId={activeSessionId}
          activeWorktreeId={activeWorktreeId}
          unreadIds={unreadSessionIds}
          unreadWorktreeIds={unreadWorktreeIds}
          busySessions={busySessions}
          worktreeStats={worktreeStats}
          chatStats={chatStats}
          onSelectMainChat={(id) => {
            setActiveSessionId(id)
            setActiveWorktreeId(null)
            setUnreadSessionIds((prev) => {
              if (!prev.has(id)) return prev
              const next = new Set(prev)
              next.delete(id)
              return next
            })
          }}
          onSelectWorktree={(worktreeId) => {
            const wt = worktrees.find((w) => w.id === worktreeId)
            if (!wt) return
            setActiveWorktreeId(worktreeId)
            // Clear the manual "marked as unread" flag — entering counts as
            // having seen it. Individual chat unread states are untouched.
            setUnreadWorktreeIds((prev) => {
              if (!prev.has(worktreeId)) return prev
              const next = new Set(prev)
              next.delete(worktreeId)
              return next
            })
            // Prefer opening the first actually-unread chat (so the user
            // lands on what needs their attention); otherwise the first chat.
            const targetSession = wt.sessions.find((s) => unreadSessionIds.has(s.id)) ?? wt.sessions[0]
            if (targetSession) {
              setActiveSessionId(targetSession.id)
              setUnreadSessionIds((prev) => {
                if (!prev.has(targetSession.id)) return prev
                const next = new Set(prev)
                next.delete(targetSession.id)
                return next
              })
            }
          }}
          onNewMainChat={handleNewMainChat}
          onNewWorktree={handleNewWorktree}
          onAddChatToWorktree={handleAddChatToWorktree}
          onRenameSession={handleRenameSession}
          onRenameWorktree={handleRenameWorktree}
          onToggleUnread={(id, unread) => {
            setUnreadSessionIds((prev) => {
              const next = new Set(prev)
              if (unread) next.add(id)
              else next.delete(id)
              return next
            })
          }}
          onToggleWorktreeUnread={(worktreeId, unread) => {
            setUnreadWorktreeIds((prev) => {
              const next = new Set(prev)
              if (unread) next.add(worktreeId)
              else next.delete(worktreeId)
              return next
            })
          }}
          onChanged={() => reloadAll(false)}
        />}

        {/* Center-left: Chat */}
        <div className="flex min-w-0 flex-1 flex-col">
          {hasOpenChat ? (
            <div className="flex flex-1 flex-col overflow-hidden">
              {/* Worktree header + chat tabs — only when inside a worktree */}
              {activeWorktreeId && (() => {
                const wt = worktrees.find((w) => w.id === activeWorktreeId)
                if (!wt) return null
                return (
                  <>
                    {/* Top bar — worktree name + branch + target selector + actions */}
                    <div className="flex shrink-0 items-center gap-2 border-b border-[#2B2B2B] px-4 py-2" style={{ backgroundColor: '#1F1F1F' }}>
                      {/* Branch icon */}
                      <svg
                        className="h-3.5 w-3.5 shrink-0 text-zinc-500"
                        fill="none"
                        viewBox="0 0 16 16"
                        stroke="currentColor"
                        strokeWidth="1.5"
                      >
                        <circle cx="4" cy="4" r="1.5" fill="currentColor" />
                        <circle cx="12" cy="12" r="1.5" fill="currentColor" />
                        <path d="M4 5.5 L4 9 Q4 12 7 12 L10.5 12" strokeLinecap="round" />
                      </svg>

                      {/* Worktree name + (branch) */}
                      <span className="min-w-0 truncate text-[12px] font-medium text-zinc-300">{wt.name}</span>
                      <span className="text-[10px] text-zinc-600">(branch)</span>

                      {/* Arrow → */}
                      <svg className="h-3 w-3 shrink-0 text-zinc-600" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
                      </svg>

                      {/* Target branch pill — clickable dropdown */}
                      <div className="relative">
                        <button
                          onClick={() => { setShowTargetBranchPicker(!showTargetBranchPicker); setTargetBranchSearch('') }}
                          className="flex items-center gap-1 rounded-md border border-[#3C3C3C] px-2 py-0.5 transition-colors hover:border-zinc-500 hover:bg-white/5"
                          style={{ backgroundColor: '#2A2A2A' }}
                        >
                          <span className="font-mono text-[11px] text-zinc-300">origin/main</span>
                          <svg className="h-2.5 w-2.5 text-zinc-500" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                          </svg>
                        </button>

                        {/* Target branch picker dropdown */}
                        {showTargetBranchPicker && (
                          <>
                            <div className="fixed inset-0 z-40" onClick={() => setShowTargetBranchPicker(false)} />
                            <div
                              className="absolute left-0 top-full z-50 mt-1 w-64 overflow-hidden rounded-xl border border-white/15 shadow-2xl shadow-black/50"
                              style={{ backgroundColor: '#252526' }}
                            >
                              {/* Search input */}
                              <div className="flex items-center gap-2 border-b border-[#2B2B2B] px-3 py-2">
                                <svg className="h-3 w-3 shrink-0 text-zinc-500" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
                                </svg>
                                <input
                                  autoFocus
                                  value={targetBranchSearch}
                                  onChange={(e) => setTargetBranchSearch(e.target.value)}
                                  placeholder="Select target branch..."
                                  className="min-w-0 flex-1 bg-transparent text-[11px] text-zinc-200 placeholder-zinc-600 outline-none"
                                />
                              </div>
                              {/* Branch list */}
                              <div className="max-h-48 overflow-y-auto py-1">
                                {['main', 'develop', 'staging'].filter(
                                  (b) => !targetBranchSearch || b.includes(targetBranchSearch.toLowerCase())
                                ).map((branch) => (
                                  <button
                                    key={branch}
                                    onClick={() => setShowTargetBranchPicker(false)}
                                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] transition-colors hover:bg-white/5 ${
                                      branch === 'main' ? 'text-zinc-100' : 'text-zinc-400'
                                    }`}
                                  >
                                    {branch === 'main' && (
                                      <svg className="h-3 w-3 shrink-0 text-violet-400" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                                      </svg>
                                    )}
                                    {branch !== 'main' && <div className="h-3 w-3 shrink-0" />}
                                    <span className="font-mono">{branch}</span>
                                  </button>
                                ))}
                              </div>
                            </div>
                          </>
                        )}
                      </div>

                      <div className="flex-1" />

                      {/* Scratchpad */}
                      <button
                        type="button"
                        onClick={() => setShowScratchpad(true)}
                        title="Scratchpad"
                        className="text-zinc-500 transition-colors hover:text-zinc-300"
                      >
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zM19.5 14.25v4.75A2.25 2.25 0 0117.25 21H5.25A2.25 2.25 0 013 18.75V6.75A2.25 2.25 0 015.25 4.5h4.75" />
                        </svg>
                      </button>

                      {/* History */}
                      <button
                        type="button"
                        title="Session history"
                        className="text-zinc-500 transition-colors hover:text-zinc-300"
                      >
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                          <circle cx="12" cy="12" r="9" />
                          <path strokeLinecap="round" d="M12 7.5V12l3 1.5" />
                          <path strokeLinecap="round" d="M3.51 9A9 9 0 0112 3c2.49 0 4.74 1.01 6.36 2.64" />
                          <path strokeLinecap="round" strokeLinejoin="round" d="M3 4.5v4h4" />
                        </svg>
                      </button>

                      {/* Minimize */}
                      <button
                        onClick={() => {
                          setActiveWorktreeId(null)
                          setActiveSessionId(null)
                          setChatMessages([])
                        }}
                        title="Minimize worktree"
                        className="text-zinc-500 transition-colors hover:text-zinc-300"
                      >
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 12h-15" />
                        </svg>
                      </button>
                    </div>

                    {/* Chat tabs bar — scroll horizontal when overflow */}
                    <div className="flex shrink-0 items-center border-b border-[#2B2B2B]" style={{ backgroundColor: '#181818' }}>
                      <div className="flex min-w-0 flex-1 items-center overflow-x-auto scrollbar-none">
                        {wt.sessions.map((s) => {
                          const tabActive = activeSessionId === s.id
                          const tabUnread = !tabActive && unreadSessionIds.has(s.id)
                          const tabBusy = busySessions.has(s.id)
                          const isRenaming = renamingTabId === s.id
                          return (
                            <div
                              key={s.id}
                              className={`group/tab flex w-44 shrink-0 items-center border-r border-[#2B2B2B] ${
                                tabActive
                                  ? 'bg-[#1F1F1F]'
                                  : 'hover:bg-white/5'
                              }`}
                            >
                              <div
                                onClick={() => {
                                  setActiveSessionId(s.id)
                                  setUnreadSessionIds((prev) => {
                                    if (!prev.has(s.id)) return prev
                                    const next = new Set(prev)
                                    next.delete(s.id)
                                    return next
                                  })
                                }}
                                onDoubleClick={() => {
                                  setRenamingTabId(s.id)
                                  setRenamingTabValue(s.name)
                                }}
                                className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 pl-3 pr-1.5 py-2.5 text-[11px]"
                              >
                                {tabBusy ? (
                                  <LoadingSpinner className={`h-3 w-3 shrink-0 ${tabActive ? 'text-violet-300' : 'text-violet-400'}`} />
                                ) : (
                                <svg
                                  className={`h-3 w-3 shrink-0 ${
                                    tabActive ? 'text-zinc-200' : tabUnread ? 'text-yellow-400' : 'text-zinc-500'
                                  }`}
                                  fill="none"
                                  viewBox="0 0 16 16"
                                  stroke="currentColor"
                                  strokeWidth="1.5"
                                >
                                  <path strokeLinejoin="round" d="M2.75 4.25 Q2.75 2.75 4.25 2.75 L11.75 2.75 Q13.25 2.75 13.25 4.25 L13.25 9.5 Q13.25 11 11.75 11 L7 11 L4.25 13.5 L4.25 11 Q2.75 11 2.75 9.5 Z" />
                                </svg>
                                )}
                                {isRenaming ? (
                                  <input
                                    autoFocus
                                    value={renamingTabValue}
                                    onChange={(e) => setRenamingTabValue(e.target.value)}
                                    onBlur={() => {
                                      if (renamingTabValue.trim()) handleRenameSession(s.id, renamingTabValue.trim())
                                      setRenamingTabId(null)
                                    }}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') { if (renamingTabValue.trim()) handleRenameSession(s.id, renamingTabValue.trim()); setRenamingTabId(null) }
                                      if (e.key === 'Escape') setRenamingTabId(null)
                                    }}
                                    onClick={(e) => e.stopPropagation()}
                                    className="min-w-0 flex-1 bg-transparent text-[11px] text-zinc-100 outline-none"
                                  />
                                ) : (
                                  <span className={`min-w-0 truncate ${tabActive ? 'text-zinc-200' : tabUnread ? 'text-zinc-300' : 'text-zinc-500'}`}>
                                    {s.name}
                                  </span>
                                )}
                              </div>
                              {/* 3-dot menu trigger — appears on hover */}
                              <button
                                data-tab-menu-trigger={s.id}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  if (worktreeTabMenuId === s.id) {
                                    setWorktreeTabMenuId(null)
                                    setWorktreeTabMenuPos(null)
                                  } else {
                                    const rect = e.currentTarget.getBoundingClientRect()
                                    setWorktreeTabMenuPos({ top: rect.bottom + 4, left: rect.left })
                                    setWorktreeTabMenuId(s.id)
                                  }
                                }}
                                className="mr-1.5 hidden h-4 w-4 shrink-0 items-center justify-center rounded text-zinc-600 transition-colors hover:bg-white/10 hover:text-zinc-300 group-hover/tab:flex"
                              >
                                <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 24 24">
                                  <circle cx="5" cy="12" r="1.5" />
                                  <circle cx="12" cy="12" r="1.5" />
                                  <circle cx="19" cy="12" r="1.5" />
                                </svg>
                              </button>
                            </div>
                          )
                        })}
                        <button
                          onClick={() => handleAddChatToWorktree(activeWorktreeId)}
                          className="flex items-center px-3 py-2.5 text-zinc-500 hover:text-zinc-200"
                          title="Add chat to this worktree"
                        >
                          <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  </>
                )
              })()}

              <div className="flex flex-1 overflow-hidden">
                <ChatPanel
                  projectId={projectId}
                  sessionId={activeSessionId}
                  sessionName={
                    activeWorktreeId
                      ? worktrees.find((w) => w.id === activeWorktreeId)?.sessions.find((s) => s.id === activeSessionId)?.name ?? 'Chat'
                      : mainChats.find((s) => s.id === activeSessionId)?.name ?? 'Chat'
                  }
                  isWorktreeChat={!!activeWorktreeId}
                  messages={chatMessages}
                  setMessages={setChatMessages}
                  activeMode={activeMode}
                  activeSkillId={activeSkillId}
                  activeTeamId={activeTeamId}
                  activeEmployee={activeEmployee}
                  activeTeam={activeTeam}
                  hiredEmployees={hiredEmployees}
                  teams={teams}
                  onSelectEmployee={handleSelectEmployee}
                  onSelectTeam={handleSelectTeam}
                  onClearSelection={handleClearSelection}
                  onSessionRenamed={(name: string) => {
                    handleRenameSession(activeSessionId!, name)
                    if (activeWorktreeId) {
                      const wt = worktrees.find((w) => w.id === activeWorktreeId)
                      const isCodenameStill = wt && /^[A-Z][a-z]+ v\d+$/.test(wt.name)
                      if (wt && wt.sessions.length === 1 && wt.sessions[0].id === activeSessionId && isCodenameStill) {
                        handleRenameWorktree(wt.id, name)
                      }
                    }
                  }}
                  onMinimize={() => {
                    setActiveSessionId(null)
                    setActiveWorktreeId(null)
                    setChatMessages([])
                  }}
                  onOpenScratchpad={() => setShowScratchpad(true)}
                  onBusyChange={handleBusyChange}
                  hunkAttachments={pendingHunkAttachments}
                  onClearHunkAttachment={(index) => setPendingHunkAttachments((prev) => prev.filter((_, i) => i !== index))}
                  onClearAllHunkAttachments={() => setPendingHunkAttachments([])}
                />
              </div>
            </div>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-5" style={{ backgroundColor: '#1F1F1F' }}>
            <style>{`
              @keyframes terminal-blink { 0%,49% { opacity: 1 } 50%,100% { opacity: 0 } }
              @keyframes type-msg { 0% { width: 0 } 20% { width: 100% } 100% { width: 100% } }
              @keyframes fade-in-3 { 0%,28% { opacity: 0 } 32% { opacity: 1 } }
              @keyframes fade-in-4 { 0%,42% { opacity: 0 } 46% { opacity: 1 } }
              @keyframes fade-in-5 { 0%,56% { opacity: 0 } 60% { opacity: 1 } }
              @keyframes fade-in-6 { 0%,70% { opacity: 0 } 74% { opacity: 1 } }
              @keyframes pulse-glow { 0%,100% { opacity: 0.3 } 50% { opacity: 0.8 } }
              .t-blink { animation: terminal-blink 1s step-end infinite; }
              .t-type { animation: type-msg 10s steps(30, end) infinite; overflow: hidden; white-space: nowrap; }
              .t-fade-3 { animation: fade-in-3 10s ease-out infinite; }
              .t-fade-4 { animation: fade-in-4 10s ease-out infinite; }
              .t-fade-5 { animation: fade-in-5 10s ease-out infinite; }
              .t-fade-6 { animation: fade-in-6 10s ease-out infinite; }
              .glow { animation: pulse-glow 4s ease-in-out infinite; }
            `}</style>

            {/* Mini terminal — Claude Code meets Bornastar */}
            <div className="relative">
              <div className="glow absolute -inset-6 rounded-2xl" style={{ background: 'radial-gradient(ellipse at center, rgba(0,120,212,0.06) 0%, transparent 70%)' }} />

              <div className="relative w-72 overflow-hidden rounded-lg border border-[#2B2B2B]" style={{ backgroundColor: '#181818' }}>
                {/* Title bar */}
                <div className="flex items-center gap-1.5 border-b border-[#2B2B2B] px-3 py-1.5">
                  <div className="h-2 w-2 rounded-full bg-[#FF5F57]" />
                  <div className="h-2 w-2 rounded-full bg-[#FFBD2E]" />
                  <div className="h-2 w-2 rounded-full bg-[#28C840]" />
                  <span className="ml-2 text-[9px] text-zinc-600">claude</span>
                </div>

                {/* Terminal body */}
                <div className="space-y-2 px-3 py-3 font-mono text-[10px] leading-relaxed">
                  {/* User message — typing effect, right aligned */}
                  <div className="flex justify-end">
                    <div className="t-type rounded-md bg-[#313131] px-2 py-1 text-zinc-300">
                      make a miracle in this repo
                    </div>
                  </div>

                  {/* Claude thinking */}
                  <div className="t-fade-3">
                    <span className="text-zinc-600 italic">hmm, let me think...</span>
                  </div>

                  {/* Claude responds */}
                  <div className="t-fade-4 flex items-center gap-1">
                    <span className="text-zinc-400">say no more. calling</span>
                    <span className="font-semibold text-white">bornastar</span>
                  </div>

                  {/* Done */}
                  <div className="t-fade-5 flex items-center gap-1">
                    <span className="text-[#28C840]">✓</span>
                    <span className="text-zinc-400">miracle shipped.</span>
                  </div>

                  {/* Cursor */}
                  <div className="t-fade-6">
                    <span className="t-blink text-zinc-500">_</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="text-center">
              <p className="text-sm font-medium text-zinc-300">Let&apos;s build something.</p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={handleNewMainChat}
                className="rounded-full border border-white/20 px-4 py-1.5 text-[12px] font-medium text-zinc-200 transition-colors hover:border-white/40 hover:bg-white/5"
              >
                + New chat <span className="ml-0.5 text-[10px] text-zinc-500">(main)</span>
              </button>
              <button
                onClick={handleNewWorktree}
                className="rounded-full border border-white/20 px-4 py-1.5 text-[12px] font-medium text-zinc-200 transition-colors hover:border-white/40 hover:bg-white/5"
              >
                + New worktree <span className="ml-0.5 text-[10px] text-zinc-500">(branch)</span>
              </button>
            </div>
          </div>
        )}
      </div>

        {/* Right: Explorer / Changes / Terminal panel */}
        <div className={`flex min-w-0 shrink-0 flex-col border-l border-[#2B2B2B] transition-all duration-200 ${rightPanelExpanded ? 'w-[50%]' : 'w-[30%]'}`} style={{ backgroundColor: '#1F1F1F' }}>
          {/* Tabs: Changes | Explorer + context label */}
          <div className="flex shrink-0 items-center border-b border-[#2B2B2B] px-3" style={{ backgroundColor: '#1F1F1F' }}>
            <button
              onClick={() => setRightPanelTab('changes')}
              className={`relative flex items-center gap-1.5 px-3 py-2.5 text-[12px] font-medium transition-colors ${
                rightPanelTab === 'changes'
                  ? 'text-zinc-100'
                  : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              Changes
              {changedFilesCount > 0 && (
                <span className="rounded-full bg-white/10 px-1.5 py-0.5 text-[10px] tabular-nums text-zinc-300">
                  {changedFilesCount}
                </span>
              )}
              {rightPanelTab === 'changes' && (
                <span className="absolute bottom-0 left-2 right-2 h-[2px] rounded-full bg-white" />
              )}
            </button>
            <button
              onClick={() => { setRightPanelTab('explorer'); setChangesSelectMode(false) }}
              className={`relative flex items-center gap-1.5 px-3 py-2.5 text-[12px] font-medium transition-colors ${
                rightPanelTab === 'explorer'
                  ? 'text-zinc-100'
                  : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              Explorer
              {rightPanelTab === 'explorer' && (
                <span className="absolute bottom-0 left-2 right-2 h-[2px] rounded-full bg-white" />
              )}
            </button>
            {/* Select-mode toggle — only on Changes tab. Swaps the whole
                panel into multi-select so the user can bulk-attach several
                changed files (and all their hunks) to a chat in one go. */}
            {rightPanelTab === 'changes' && (
              <button
                onClick={() => setChangesSelectMode((v) => !v)}
                title={changesSelectMode ? 'Exit select mode' : 'Select changes'}
                className={`ml-2 transition-colors ${changesSelectMode ? 'text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'}`}
              >
                {/* Checkbox-with-check icon — reads as "select" */}
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <rect x="3.5" y="3.5" width="17" height="17" rx="2.5" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 12.5l3 3 5-6" />
                </svg>
              </button>
            )}
            <div className="flex-1" />
            {statusBadge && (
              <span className="mr-2 flex items-center gap-1.5 text-[10px] text-zinc-400">
                <span className={`h-1.5 w-1.5 rounded-full ${statusBadge.color}`} />
                {statusBadge.label}
              </span>
            )}
            <span className="mr-2 text-[11px] font-medium text-zinc-500">
              {activeWorktreeId
                ? `${worktrees.find((w) => w.id === activeWorktreeId)?.branchName ?? 'branch'} (branch)`
                : 'main'}
            </span>
            {/* Expand/collapse panel toggle */}
            <button
              onClick={() => setRightPanelExpanded(!rightPanelExpanded)}
              title={rightPanelExpanded ? 'Collapse panel' : 'Expand panel'}
              className="text-zinc-500 transition-colors hover:text-zinc-300"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <path d={rightPanelExpanded ? 'M15 3v18' : 'M9 3v18'} />
              </svg>
            </button>
          </div>

          {/* Panel content — takes remaining space above terminal */}
          <div className="min-h-0 flex-1 overflow-y-auto" style={{ backgroundColor: '#181818' }}>
            {rightPanelTab === 'explorer' && (
              <FileTree projectId={projectId} hasActiveSession={!!activeSessionId} />
            )}
            {rightPanelTab === 'changes' && (
              <ChangesList
                selectMode={changesSelectMode}
                onExitSelectMode={() => setChangesSelectMode(false)}
                onAttachToCurrent={handleAttachHunkToCurrentChat}
                onAttachToNew={handleAttachHunkToNewChat}
                onBulkAttachToCurrent={handleBulkAttachToCurrentChat}
                onBulkAttachToNew={handleBulkAttachToNewChat}
                onOpenFile={(path) => {
                  setRightPanelTab('explorer')
                  // Dispatch AFTER the Explorer tab is mounted — setState is
                  // async and FileTree listens only while mounted.
                  setTimeout(() => {
                    window.dispatchEvent(new CustomEvent('explorer-open-file', { detail: path }))
                  }, 50)
                }}
              />
            )}
          </div>

          {/* Bottom panel — Terminal + Checks tabs. Terminal is the default;
              Checks overlays the same area with the git / PR action panel. */}
          {hasOpenChat && terminalOpen ? (
            <div className="flex h-1/2 shrink-0 flex-col border-t border-[#2B2B2B]" style={{ backgroundColor: '#181818' }}>
              {/* Tab bar */}
              <div className="flex shrink-0 items-center gap-0.5 border-b border-[#2B2B2B] px-2" style={{ backgroundColor: '#1F1F1F' }}>
                <button
                  onClick={() => setBottomTab('terminal')}
                  className={`flex items-center gap-1.5 px-2.5 py-2 text-[11px] font-medium transition-colors ${bottomTab === 'terminal' ? 'text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'}`}
                >
                  <svg className={`h-3 w-3 ${bottomTab === 'terminal' ? 'text-emerald-400' : ''}`} fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0021 18V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v12a2.25 2.25 0 002.25 2.25z" />
                  </svg>
                  Terminal
                  {bottomTab === 'terminal' && <span className="absolute bottom-0 left-2 right-2 h-[2px] rounded-full bg-white" />}
                </button>
                <button
                  onClick={() => setBottomTab('checks')}
                  className={`relative flex items-center gap-1.5 px-2.5 py-2 text-[11px] font-medium transition-colors ${bottomTab === 'checks' ? 'text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'}`}
                >
                  <svg className={`h-3 w-3 ${bottomTab === 'checks' ? 'text-emerald-400' : ''}`} fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  Checks
                  {bottomTab === 'checks' && <span className="absolute bottom-0 left-2 right-2 h-[2px] rounded-full bg-white" />}
                </button>
                <div className="flex-1" />
                <button
                  onClick={() => setTerminalOpen(false)}
                  className="flex h-5 w-5 items-center justify-center rounded text-zinc-600 hover:bg-white/5 hover:text-zinc-400"
                  title="Collapse panel"
                >
                  <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                  </svg>
                </button>
              </div>
              {/* Tab body — a single slot; each panel owns its own scroll. */}
              <div className="relative min-h-0 flex-1">
                {bottomTab === 'terminal' && (
                  <TerminalBody projectId={projectId} sessionId={activeSessionId} worktreeId={activeWorktreeId} />
                )}
                {bottomTab === 'checks' && (
                  <ChecksPanel
                    projectId={projectId}
                    sessionId={activeSessionId}
                    worktreeId={activeWorktreeId}
                    onArchive={async () => {
                      // Merged worktree archive — no dirty-changes modal
                      // needed since the merge already consumed them.
                      if (!activeWorktreeId) return
                      const res = await fetch(`/api/projects/${projectId}/worktrees/${activeWorktreeId}/archive`, { method: 'POST' })
                      if (res.ok) {
                        setWorktrees((prev) => prev.filter((w) => w.id !== activeWorktreeId))
                        setActiveWorktreeId(null)
                        setActiveSessionId(null)
                      }
                    }}
                  />
                )}
              </div>
            </div>
          ) : hasOpenChat ? (
            /* Bottom panel collapsed — thin bar to pull up */
            <button
              onClick={() => setTerminalOpen(true)}
              className="flex shrink-0 items-center gap-2 border-t border-[#2B2B2B] px-3 py-1.5 text-left transition-colors hover:bg-white/5"
              style={{ backgroundColor: '#1F1F1F' }}
            >
              <svg className="h-3 w-3 text-zinc-500" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 15.75l7.5-7.5 7.5 7.5" />
              </svg>
              <svg className="h-3 w-3 text-emerald-400" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0021 18V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v12a2.25 2.25 0 002.25 2.25z" />
              </svg>
              <span className="text-[10px] text-zinc-500">Terminal · Checks</span>
            </button>
          ) : null}
        </div>
      </div>

      {/* Worktree tab menu — rendered at root level to escape overflow-hidden */}
      {worktreeTabMenuId && worktreeTabMenuPos && (() => {
        const wt = worktrees.find((w) => w.sessions.some((s) => s.id === worktreeTabMenuId))
        const session = wt?.sessions.find((s) => s.id === worktreeTabMenuId)
        if (!wt || !session) return null
        const canClose = wt.sessions.length > 1
        return (
          <>
            <div className="fixed inset-0 z-40" onClick={() => { setWorktreeTabMenuId(null); setWorktreeTabMenuPos(null) }} />
            <div
              className="fixed z-50 w-40 rounded-lg border border-white/10 py-1 shadow-2xl shadow-black/60"
              style={{ backgroundColor: '#252526', top: worktreeTabMenuPos.top, left: worktreeTabMenuPos.left }}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                onClick={() => {
                  setWorktreeTabMenuId(null)
                  setWorktreeTabMenuPos(null)
                  setRenamingTabId(session.id)
                  setRenamingTabValue(session.name)
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-zinc-300 hover:bg-white/5"
              >
                Rename
              </button>
              <button
                onClick={() => {
                  setWorktreeTabMenuId(null)
                  setUnreadSessionIds((prev) => {
                    const next = new Set(prev)
                    if (next.has(session.id)) next.delete(session.id)
                    else next.add(session.id)
                    return next
                  })
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-zinc-300 hover:bg-white/5"
              >
                {unreadSessionIds.has(session.id) ? 'Mark as read' : 'Mark as unread'}
              </button>
              {canClose && (
                <>
                  <div className="my-1 h-px bg-white/5" />
                  <button
                    onClick={() => {
                      setWorktreeTabMenuId(null)
                      setClosingWorktreeChat({ worktreeId: wt.id, sessionId: session.id, sessionName: session.name })
                    }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-red-400 hover:bg-red-500/10"
                  >
                    Close chat
                  </button>
                </>
              )}
            </div>
          </>
        )
      })()}

      {/* Scratchpad modal — per-project free-form notes */}
      {showScratchpad && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setShowScratchpad(false)}
        >
          <div
            className="flex h-[70vh] max-h-[620px] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-white/15 shadow-2xl shadow-black/60"
            style={{ backgroundColor: '#1F1F1F' }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex shrink-0 items-center gap-2 border-b border-[#2B2B2B] px-5 py-3">
              <svg className="h-4 w-4 text-zinc-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zM19.5 14.25v4.75A2.25 2.25 0 0117.25 21H5.25A2.25 2.25 0 013 18.75V6.75A2.25 2.25 0 015.25 4.5h4.75" />
              </svg>
              <h3 className="text-[13px] font-semibold text-zinc-100">Scratchpad</h3>
              <span className="text-[11px] text-zinc-600">
                Reference with <span className="rounded bg-white/10 px-1 py-0.5 font-mono text-[10px] text-zinc-300">@notes</span> in chat
              </span>
              <div className="flex-1" />
              <button
                onClick={() => setShowScratchpad(false)}
                className="text-zinc-500 transition-colors hover:text-zinc-300"
                title="Close"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Textarea */}
            <textarea
              autoFocus
              value={scratchpadContent}
              onChange={(e) => setScratchpadContent(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') setShowScratchpad(false) }}
              placeholder="Use this as a scratchpad. Reference with @notes in chat to inject it as context for the agent."
              className="min-h-0 flex-1 resize-none bg-transparent px-5 py-4 text-[13px] leading-relaxed text-zinc-200 placeholder-zinc-600 outline-none"
              style={{ backgroundColor: '#181818' }}
            />

            {/* Footer — autosave hint */}
            <div className="flex shrink-0 items-center justify-between border-t border-[#2B2B2B] px-5 py-2">
              <span className="text-[10px] text-zinc-600">
                {scratchpadContent.length > 0
                  ? `${scratchpadContent.length.toLocaleString()} characters · auto-saved`
                  : 'Empty · auto-saved'}
              </span>
              <span className="text-[10px] text-zinc-600">
                Press <kbd className="rounded bg-white/10 px-1 font-mono text-[9px] text-zinc-400">Esc</kbd> to close
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Close worktree chat confirmation */}
      {closingWorktreeChat && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setClosingWorktreeChat(null)}>
          <div
            className="w-full max-w-xs overflow-hidden rounded-xl border border-white/10 shadow-2xl"
            style={{ backgroundColor: '#181818' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-4">
              <p className="text-[13px] font-semibold text-zinc-100">Close chat?</p>
              <p className="mt-1.5 text-[11px] leading-relaxed text-zinc-500">
                <span className="text-zinc-300">{closingWorktreeChat.sessionName}</span> will be removed from this worktree. The conversation history is preserved and can be viewed later.
              </p>
            </div>
            <div className="flex border-t border-[#2B2B2B]">
              <button
                onClick={() => setClosingWorktreeChat(null)}
                className="flex-1 border-r border-[#2B2B2B] px-4 py-2.5 text-[12px] text-zinc-400 hover:bg-white/5 hover:text-zinc-200"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  handleCloseWorktreeChat(closingWorktreeChat.worktreeId, closingWorktreeChat.sessionId)
                  setClosingWorktreeChat(null)
                }}
                className="flex-1 px-4 py-2.5 text-[12px] text-red-400 hover:bg-red-500/10"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}

// ── File Tree ──────────────────────────────────────────────────────────────

// ── Syntax Highlighting (Prism.js) ─────────────────────────────────────────

import Prism from 'prismjs'
import 'prismjs/components/prism-typescript'
import 'prismjs/components/prism-jsx'
import 'prismjs/components/prism-tsx'
import 'prismjs/components/prism-json'
import 'prismjs/components/prism-css'
import 'prismjs/components/prism-python'
import 'prismjs/components/prism-bash'
import 'prismjs/components/prism-yaml'
import 'prismjs/components/prism-markdown'
import 'prismjs/components/prism-sql'
import 'prism-themes/themes/prism-vsc-dark-plus.css'

const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
  json: 'json', css: 'css', scss: 'css', py: 'python',
  sh: 'bash', yml: 'yaml', yaml: 'yaml', md: 'markdown',
  sql: 'sql', html: 'markup', xml: 'markup',
}

function getLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  return EXT_TO_LANG[ext] ?? 'typescript'
}

// ── Shiki integration ────────────────────────────────────────────────────
// Uses shiki (TextMate grammars + VS Code Dark+ theme) for syntax highlighting
// — same engine as VS Code, so colors match Cursor/Conductor exactly.
import { highlightLines, getLanguageFromFilename } from '@/lib/shiki'

/**
 * React hook that highlights a whole file with shiki and returns one HTML
 * string per line. While loading, returns the escaped plain lines as a
 * fallback so the UI renders immediately.
 */
/** Visible indent in spaces (tabs counted as 2). */
function getLineIndent(content: string): number {
  const match = content.match(/^([ \t]*)/)
  if (!match) return 0
  let indent = 0
  for (const ch of match[1]) indent += ch === '\t' ? 2 : 1
  return indent
}

/**
 * Style for a code line:
 *  1. Wrap long lines (pre-wrap + break-all)
 *  2. Hanging indent: wrapped continuation lines start at the original
 *     indent column (via padding-left + negative text-indent). Keeps
 *     shiki's HTML untouched — safe, doesn't strip any colored spans.
 *  3. Indent guides — subtle vertical lines at each 2-space level.
 */
// Empty lines have no leading whitespace of their own, which makes indent
// guides "break" visually on blank rows. VS Code / Cursor paper over this
// by inheriting the indent of the nearest non-empty line. We do the same:
// an empty line gets the indent of the next non-empty line (falling back to
// the previous one at end-of-file).
function getEffectiveIndents(lines: string[]): number[] {
  const raw = lines.map((l) => ({ empty: l.trim().length === 0, indent: getLineIndent(l) }))
  const eff = raw.map((r) => (r.empty ? 0 : r.indent))
  // Forward pass: empty lines borrow from the next non-empty line
  for (let i = raw.length - 1; i >= 0; i--) {
    if (raw[i].empty) eff[i] = eff[i + 1] ?? 0
  }
  // Backward pass: trailing empties borrow from previous non-empty
  for (let i = 0; i < raw.length; i++) {
    if (raw[i].empty && eff[i] === 0) eff[i] = eff[i - 1] ?? 0
  }
  return eff
}

function getCodeLineStyle(content: string, effectiveIndent?: number): React.CSSProperties {
  const base: React.CSSProperties = {
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    overflowWrap: 'anywhere',
  }
  const ownIndent = getLineIndent(content)
  const isEmpty = content.trim().length === 0
  const indent = isEmpty && effectiveIndent !== undefined ? effectiveIndent : ownIndent
  if (indent < 2) return base

  const step = 2
  const guideSpan = Math.floor(indent / step) * step
  return {
    ...base,
    // Hanging indent trick: padding pushes wrapped lines right, text-indent
    // pulls only the first line back so the leading whitespace (already in
    // shiki's HTML) renders at col 0 — visually identical to no-hanging.
    paddingLeft: `${indent}ch`,
    textIndent: `-${indent}ch`,
    // Indent guides drawn in the padding zone.
    backgroundImage:
      'repeating-linear-gradient(to right, rgba(255,255,255,0.13) 0 1px, transparent 1px 2ch)',
    backgroundSize: `${guideSpan}ch 100%`,
    backgroundRepeat: 'no-repeat',
    backgroundPosition: '0 0',
  }
}

// No-op — shiki HTML is passed through untouched, hanging indent is done
// purely with CSS (see getCodeLineStyle).
function stripLeadingWhitespaceHtml(html: string): string {
  return html
}

function useShikiLines(content: string, filename: string): string[] {
  const [lines, setLines] = useState<string[]>(() =>
    content.split('\n').map((l) => l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'))
  )
  useEffect(() => {
    let cancelled = false
    const lang = getLanguageFromFilename(filename)
    highlightLines(content, lang).then((result) => {
      if (!cancelled) setLines(result)
    }).catch(() => { /* keep plain fallback */ })
    return () => { cancelled = true }
  }, [content, filename])
  return lines
}

function IndentGuides({ line }: { line: string }) {
  const match = line.match(/^(\s+)/)
  if (!match) return null
  const spaces = match[1].length
  const tabSize = 2
  const levels = Math.floor(spaces / tabSize)
  if (levels === 0) return null

  return (
    <>
      {Array.from({ length: levels }).map((_, i) => (
        <span
          key={i}
          className="absolute top-0 bottom-0"
          style={{
            left: `${i * tabSize}ch`,
            width: '1px',
            backgroundColor: 'rgba(255,255,255,0.08)',
          }}
        />
      ))}
    </>
  )
}

function highlightCode(code: string, filename: string): string {
  const lang = getLanguage(filename)
  const grammar = Prism.languages[lang] ?? Prism.languages.typescript
  try {
    return Prism.highlight(code, grammar, lang)
  } catch {
    return code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }
}

// ── File Icons ─────────────────────────────────────────────────────────────

const FILE_ICON_COLORS: Record<string, string> = {
  ts: '#3178c6', tsx: '#3178c6',
  js: '#f7df1e', jsx: '#f7df1e',
  json: '#292929', py: '#3572A5',
  html: '#e34c26', css: '#563d7c',
  scss: '#c6538c', md: '#083fa1',
  yml: '#cb171e', yaml: '#cb171e',
  sql: '#e38c00', sh: '#89e051',
  env: '#ecd53f', lock: '#8b8b8b',
  png: '#a4c639', jpg: '#a4c639', gif: '#a4c639', svg: '#ffb13b',
  txt: '#8b8b8b', csv: '#237346',
  toml: '#9c4221', xml: '#0060ac',
  prisma: '#2d3748', gitignore: '#f54d27',
}

function getFileIconColor(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  // Special filenames
  if (name === '.gitignore') return FILE_ICON_COLORS.gitignore
  if (name === '.env' || name.startsWith('.env.')) return FILE_ICON_COLORS.env
  if (name === 'package.json') return '#cb3837'
  if (name === 'tsconfig.json') return '#3178c6'
  return FILE_ICON_COLORS[ext] ?? '#8b8b8b'
}

function getFileIconLetter(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    ts: 'TS', tsx: 'TX', js: 'JS', jsx: 'JX',
    json: '{}', py: 'PY', html: '<>', css: '#',
    scss: 'S#', md: 'M', yml: 'Y', yaml: 'Y',
    sql: 'SQ', sh: '$', env: 'E', lock: 'L',
    png: 'I', jpg: 'I', gif: 'I', svg: 'SV',
    txt: 'T', csv: 'CS', toml: 'TM', xml: 'X',
    prisma: 'P', gitignore: 'G',
  }
  if (name === '.gitignore') return 'G'
  if (name.startsWith('.env')) return 'E'
  return map[ext] ?? (ext.slice(0, 2).toUpperCase() || 'F')
}

function FileIcon({ name, size = 20 }: { name: string; size?: number }) {
  const color = getFileIconColor(name)
  const letter = getFileIconLetter(name)
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-sm font-mono font-bold"
      style={{ minWidth: size, width: size, height: size, fontSize: size * 0.5, color, lineHeight: 1 }}
    >
      {letter}
    </span>
  )
}


// ── Changes List ─────────────────────────────────────────────────────────
// ⚠️ MOCK data for visual testing. Replace with real git diff data later.

interface DiffLine {
  type: 'context' | 'add' | 'remove'
  content: string
  // Line numbers — oldLine for context/remove, newLine for context/add
  oldLine?: number
  newLine?: number
}

interface DiffHunk {
  // Starting line in the old file, for display
  oldStart: number
  newStart: number
  lines: DiffLine[]
}

interface MockChangedFile {
  path: string
  status: 'M' | 'A' | 'D'
  added: number
  removed: number
  hunks: DiffHunk[]
  // Optional: full file content with diff markers for the "Open file" view.
  // Each line is a DiffLine so unchanged lines show as context and
  // modified/added/removed lines render with highlight.
  fullDiff?: DiffLine[]
}

// Helper — find a mock change by path (used by the Explorer "Open file" flow
// to render the file in diff view instead of the raw file viewer).
function getMockChangeForPath(path: string): MockChangedFile | null {
  return MOCK_CHANGES.find((f) => f.path === path) ?? null
}

// ⚠️ MOCK data — simulates one chat "Add loading state to Button" having
// produced two file changes (one modified + one added). Replace with real
// git diff data from the active chat session when the backend lands.
//
// The data here is hand-crafted so every piece of the review flow can be
// walked through in the UI: the list row, the hunk card, and the full-file
// diff view that opens when the user clicks "Open file".
const MOCK_CHAT_ID = 'mock-chat-loading-button'
const MOCK_CHAT_NAME = 'Add loading state to Button'

// ── Change 1 ────────────────────────────────────────────────────────────────
// components/Button.tsx — Modified: add `loading` prop with spinner + disabled
// while loading. A single hunk spanning the function signature and JSX.
const MOCK_BUTTON_HUNK: DiffHunk = {
  oldStart: 1,
  newStart: 1,
  lines: [
    { type: 'context', content: "import { ReactNode } from 'react'", oldLine: 1, newLine: 1 },
    { type: 'context', content: '', oldLine: 2, newLine: 2 },
    { type: 'context', content: 'interface ButtonProps {', oldLine: 3, newLine: 3 },
    { type: 'context', content: '  children: ReactNode', oldLine: 4, newLine: 4 },
    { type: 'context', content: '  onClick?: () => void', oldLine: 5, newLine: 5 },
    { type: 'context', content: "  variant?: 'primary' | 'secondary'", oldLine: 6, newLine: 6 },
    { type: 'add',     content: '  loading?: boolean', newLine: 7 },
    { type: 'context', content: '}', oldLine: 7, newLine: 8 },
    { type: 'context', content: '', oldLine: 8, newLine: 9 },
    { type: 'remove',  content: "export function Button({ children, onClick, variant = 'primary' }: ButtonProps) {", oldLine: 9 },
    { type: 'add',     content: "export function Button({ children, onClick, variant = 'primary', loading = false }: ButtonProps) {", newLine: 10 },
    { type: 'context', content: '  return (', oldLine: 10, newLine: 11 },
    { type: 'remove',  content: '    <button onClick={onClick} className={`btn btn-${variant}`}>', oldLine: 11 },
    { type: 'add',     content: '    <button onClick={onClick} disabled={loading} className={`btn btn-${variant} ${loading ? "btn-loading" : ""}`}>', newLine: 12 },
    { type: 'add',     content: '      {loading && <span className="spinner" aria-hidden />}', newLine: 13 },
    { type: 'context', content: '      {children}', oldLine: 12, newLine: 14 },
    { type: 'context', content: '    </button>', oldLine: 13, newLine: 15 },
    { type: 'context', content: '  )', oldLine: 14, newLine: 16 },
    { type: 'context', content: '}', oldLine: 15, newLine: 17 },
  ],
}

// ── Change 2 ────────────────────────────────────────────────────────────────
// lib/useAsyncAction.ts — Added: new hook that wraps async handlers so the
// Button can show a loading state during the call. Pure-add hunk (no context
// lines since the file didn't exist before).
const MOCK_HOOK_HUNK: DiffHunk = {
  oldStart: 0,
  newStart: 1,
  lines: [
    { type: 'add', content: "import { useCallback, useState } from 'react'", newLine: 1 },
    { type: 'add', content: '', newLine: 2 },
    { type: 'add', content: '// Wraps an async handler so callers get back a `pending` flag alongside', newLine: 3 },
    { type: 'add', content: '// the bound action — useful for driving Button `loading` props without', newLine: 4 },
    { type: 'add', content: '// each caller having to manage its own useState.', newLine: 5 },
    { type: 'add', content: 'export function useAsyncAction<T extends unknown[]>(fn: (...args: T) => Promise<void>) {', newLine: 6 },
    { type: 'add', content: '  const [pending, setPending] = useState(false)', newLine: 7 },
    { type: 'add', content: '  const run = useCallback(async (...args: T) => {', newLine: 8 },
    { type: 'add', content: '    setPending(true)', newLine: 9 },
    { type: 'add', content: '    try { await fn(...args) } finally { setPending(false) }', newLine: 10 },
    { type: 'add', content: '  }, [fn])', newLine: 11 },
    { type: 'add', content: '  return { run, pending }', newLine: 12 },
    { type: 'add', content: '}', newLine: 13 },
  ],
}

const MOCK_CHANGES: MockChangedFile[] = [
  {
    path: 'components/Button.tsx',
    status: 'M',
    added: 4,
    removed: 2,
    hunks: [MOCK_BUTTON_HUNK],
    // Full-file diff mirrors the hunk here because the file is small enough
    // to show in its entirety. For longer files we'd pad with context lines.
    fullDiff: MOCK_BUTTON_HUNK.lines,
  },
  {
    path: 'lib/useAsyncAction.ts',
    status: 'A',
    added: 13,
    removed: 0,
    hunks: [MOCK_HOOK_HUNK],
    fullDiff: MOCK_HOOK_HUNK.lines,
  },
]

// Exposed so future integration can check "did this come from the mock chat"
// and keep the two flows from cross-polluting.
void MOCK_CHAT_ID
void MOCK_CHAT_NAME

const STATUS_ICONS: Record<string, { symbol: string; text: string; bg: string; border: string }> = {
  M: { symbol: '•', text: 'text-amber-400', bg: 'bg-amber-400/10', border: 'border-amber-400/30' },
  A: { symbol: '+', text: 'text-emerald-400', bg: 'bg-emerald-400/10', border: 'border-emerald-400/30' },
  D: { symbol: '−', text: 'text-red-400', bg: 'bg-red-400/10', border: 'border-red-400/30' },
}

function ChangesList({
  selectMode,
  onExitSelectMode,
  onAttachToCurrent,
  onAttachToNew,
  onBulkAttachToCurrent,
  onBulkAttachToNew,
  onOpenFile,
}: {
  // Whether the panel is in multi-select mode (header icon toggles this).
  selectMode: boolean
  onExitSelectMode: () => void
  // Single-hunk attach — used inside the per-file diff view.
  onAttachToCurrent: (filePath: string, fileStatus: 'M' | 'A' | 'D', hunk: DiffHunk) => void
  onAttachToNew: (filePath: string, fileStatus: 'M' | 'A' | 'D', hunk: DiffHunk) => void
  // Whole-file bulk attach — takes every hunk of every selected file.
  onBulkAttachToCurrent: (files: MockChangedFile[]) => void
  onBulkAttachToNew: (files: MockChangedFile[]) => void
  onOpenFile: (filePath: string) => void
}) {
  const [openedPath, setOpenedPath] = useState<string | null>(null)
  // Selected file paths in select mode. Cleared whenever select mode exits.
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
  useEffect(() => { if (!selectMode) setSelectedPaths(new Set()) }, [selectMode])

  const filtered = MOCK_CHANGES
  const selectedFiles = filtered.filter((f) => selectedPaths.has(f.path))
  const allSelected = filtered.length > 0 && selectedPaths.size === filtered.length

  function toggleSelect(path: string) {
    setSelectedPaths((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path); else next.add(path)
      return next
    })
  }
  function toggleSelectAll() {
    if (allSelected) setSelectedPaths(new Set())
    else setSelectedPaths(new Set(filtered.map((f) => f.path)))
  }
  function cancelSelection() {
    setSelectedPaths(new Set())
    onExitSelectMode()
  }

  function formatPath(fullPath: string) {
    const parts = fullPath.split('/')
    const fileName = parts.pop()!
    const dir = parts.join('/')
    return { dir, fileName }
  }

  // If a file is opened, show its diff view (takes over the whole panel)
  const openedFile = openedPath ? MOCK_CHANGES.find((f) => f.path === openedPath) : null
  if (openedFile) {
    const { dir, fileName } = formatPath(openedFile.path)
    const st = STATUS_ICONS[openedFile.status]
    // Navigate to prev/next file in the filtered list — no wrap-around
    const currentIndex = filtered.findIndex((f) => f.path === openedFile.path)
    const prevFile = currentIndex > 0 ? filtered[currentIndex - 1] : null
    const nextFile = currentIndex >= 0 && currentIndex < filtered.length - 1
      ? filtered[currentIndex + 1]
      : null
    return (
      <div className="flex h-full flex-col">
        {/* Back header */}
        <div className="flex shrink-0 items-center gap-1 border-b border-[#2B2B2B] px-2 py-2" style={{ backgroundColor: '#1F1F1F' }}>
          <button
            onClick={() => setOpenedPath(null)}
            title="Back to changes"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-300"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
            </svg>
          </button>
          {/* Prev / next file nav — no wrap, disables at boundaries */}
          <button
            onClick={() => prevFile && setOpenedPath(prevFile.path)}
            disabled={!prevFile}
            title={prevFile ? `Previous: ${prevFile.path}` : 'No previous file'}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-300 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-zinc-500"
          >
            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
            </svg>
          </button>
          <button
            onClick={() => nextFile && setOpenedPath(nextFile.path)}
            disabled={!nextFile}
            title={nextFile ? `Next: ${nextFile.path}` : 'No next file'}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-300 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-zinc-500"
          >
            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 5l7 7-7 7M5 5l7 7-7 7" />
            </svg>
          </button>
          <div className="flex min-w-0 flex-1 items-baseline gap-1 pl-1">
            {dir && <span className="shrink-0 text-[11px] text-zinc-600">{dir}/</span>}
            <span className="truncate text-[12px] font-medium text-zinc-200">{fileName}</span>
          </div>
          {/* Open file in Explorer */}
          <button
            onClick={() => onOpenFile(openedFile.path)}
            className="shrink-0 rounded border border-[#3C3C3C] px-2 py-0.5 text-[10px] font-medium text-zinc-300 transition-colors hover:border-zinc-500 hover:bg-white/5"
            style={{ backgroundColor: '#2A2A2A' }}
          >
            Open file
          </button>
          <span className="shrink-0 font-mono text-[10px] tabular-nums">
            {openedFile.added > 0 && <span className="text-emerald-400">+{openedFile.added}</span>}
            {openedFile.removed > 0 && <span className="ml-1 text-red-400">-{openedFile.removed}</span>}
          </span>
          <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[11px] font-bold leading-none ${st.text} ${st.bg} ${st.border}`}>
            {st.symbol}
          </span>
        </div>

        {/* Diff hunks */}
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
          {openedFile.hunks.map((hunk, hi) => (
            <DiffHunkView
              key={hi}
              hunk={hunk}
              filePath={openedFile.path}
              onCopy={() => {
                const text = hunk.lines.map((l) => {
                  const marker = l.type === 'add' ? '+' : l.type === 'remove' ? '-' : ' '
                  return `${marker}${l.content}`
                }).join('\n')
                navigator.clipboard?.writeText(text).catch(() => {})
              }}
              onAttachToCurrent={() => onAttachToCurrent(openedFile.path, openedFile.status, hunk)}
              onAttachToNew={() => onAttachToNew(openedFile.path, openedFile.status, hunk)}
            />
          ))}
        </div>
      </div>
    )
  }

  if (filtered.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-[11px] text-zinc-500">No changes yet.</p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* Select-all header — only visible in select mode. Gives the user a
          one-click way to grab every change (e.g., for a full-review prompt). */}
      {selectMode && (
        <div className="flex shrink-0 items-center gap-2 border-b border-[#2B2B2B] px-3 py-2" style={{ backgroundColor: '#1F1F1F' }}>
          <button
            onClick={toggleSelectAll}
            className="flex items-center gap-2 text-[11px] font-medium text-zinc-300 hover:text-zinc-100"
          >
            <span className={`flex h-3.5 w-3.5 items-center justify-center rounded border ${allSelected ? 'border-emerald-500 bg-emerald-500' : 'border-zinc-600'}`}>
              {allSelected && (
                <svg className="h-2.5 w-2.5 text-[#1F1F1F]" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              )}
            </span>
            {allSelected ? 'Deselect all' : 'Select all'}
          </button>
          <span className="ml-auto text-[10px] text-zinc-500 tabular-nums">
            {selectedPaths.size} of {filtered.length} selected
          </span>
        </div>
      )}

      {/* Rows */}
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
      {filtered.map((file) => {
        const { dir, fileName } = formatPath(file.path)
        const st = STATUS_ICONS[file.status]
        const isSelected = selectedPaths.has(file.path)
        return (
          <button
            key={file.path}
            onClick={() => selectMode ? toggleSelect(file.path) : setOpenedPath(file.path)}
            className={`group flex w-full items-center gap-2 px-3 py-2 text-left transition-colors ${isSelected ? 'bg-white/[0.06]' : 'hover:bg-white/[0.04]'}`}
          >
            {/* Selection checkbox — only in select mode */}
            {selectMode && (
              <span className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border ${isSelected ? 'border-emerald-500 bg-emerald-500' : 'border-zinc-600 group-hover:border-zinc-400'}`}>
                {isSelected && (
                  <svg className="h-2.5 w-2.5 text-[#1F1F1F]" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </span>
            )}

            {/* File path — dir small, then filename */}
            <div className="flex min-w-0 flex-1 items-baseline gap-1">
              {dir && <span className="shrink-0 text-[11px] text-zinc-600">{dir}/</span>}
              <span className="truncate text-[13px] font-medium text-zinc-200">{fileName}</span>
            </div>

            {/* +/- stats */}
            <span className="shrink-0 font-mono text-[10px] tabular-nums">
              {file.added > 0 && <span className="text-emerald-400">+{file.added}</span>}
              {file.removed > 0 && <span className="ml-1 text-red-400">-{file.removed}</span>}
            </span>

            {/* Status indicator — colored square with symbol */}
            <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[11px] font-bold leading-none ${st.text} ${st.bg} ${st.border}`}>
              {st.symbol}
            </span>
          </button>
        )
      })}
      </div>

      {/* Bottom action bar — appears whenever something is selected in select
          mode. Mirrors the per-hunk actions but applied to every hunk of every
          selected file. Cancel exits select mode entirely. */}
      {selectMode && selectedPaths.size > 0 && (
        <div className="flex shrink-0 items-center gap-2 border-t border-[#2B2B2B] px-3 py-2" style={{ backgroundColor: '#1F1F1F' }}>
          <span className="text-[10px] font-medium text-zinc-400 tabular-nums">
            {selectedPaths.size} selected
          </span>
          <div className="flex-1" />
          <button
            onClick={cancelSelection}
            className="rounded border border-[#3C3C3C] px-2 py-1 text-[10px] font-medium text-zinc-300 transition-colors hover:border-zinc-500 hover:bg-white/5"
          >
            Cancel
          </button>
          <button
            onClick={() => { onBulkAttachToNew(selectedFiles); cancelSelection() }}
            className="rounded border border-[#3C3C3C] px-2 py-1 text-[10px] font-medium text-zinc-300 transition-colors hover:border-zinc-500 hover:bg-white/5"
          >
            Attach to new chat
          </button>
          <button
            onClick={() => { onBulkAttachToCurrent(selectedFiles); cancelSelection() }}
            className="rounded bg-emerald-600 px-2.5 py-1 text-[10px] font-medium text-white transition-colors hover:bg-emerald-500"
          >
            Attach to current chat
          </button>
        </div>
      )}
    </div>
  )
}

// Action button with custom tooltip that fades in on hover.
function HunkActionButton({
  onClick,
  tooltip,
  children,
}: {
  onClick: () => void
  tooltip: string
  children: React.ReactNode
}) {
  return (
    <div className="group/hba relative">
      <button
        onClick={onClick}
        className="flex h-6 w-6 items-center justify-center rounded text-zinc-400 transition-colors hover:bg-white/10 hover:text-zinc-100"
      >
        {children}
      </button>
      {/* Tooltip */}
      <div className="pointer-events-none absolute right-0 top-full z-30 mt-1 whitespace-nowrap rounded-md border border-white/10 px-2 py-1 text-[10px] text-zinc-200 opacity-0 shadow-lg transition-opacity duration-150 group-hover/hba:opacity-100"
        style={{ backgroundColor: '#252526' }}
      >
        {tooltip}
      </div>
    </div>
  )
}

// Plain file viewer using shiki (VS Code Dark+ theme) — shown when the
// user opens a file without diff data. Wraps long lines, keeps line numbers
// sticky, and inherits color from the theme.
function ShikiFileView({
  path,
  content,
  onClose,
}: {
  path: string
  content: string
  onClose: () => void
}) {
  const htmlLines = useShikiLines(content, path)
  const plainLines = content.split('\n')
  return (
    <div className="absolute inset-0 z-10 flex flex-col" style={{ backgroundColor: '#181818' }}>
      <div className="flex shrink-0 items-center justify-between border-b border-[#2B2B2B] px-3 py-1.5" style={{ backgroundColor: '#313131' }}>
        <div className="flex items-center gap-1.5">
          <FileIcon name={path.split('/').pop() ?? ''} size={14} />
          <span className="text-[10px] font-medium text-zinc-300">{path}</span>
        </div>
        <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300">
          <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div className="flex-1 overflow-y-auto overflow-x-hidden text-[13px] leading-[1.5] font-mono" style={{ backgroundColor: '#1F1F1F' }}>
        {(() => { const effIndents = getEffectiveIndents(plainLines); return htmlLines.map((lineHtml, i) => (
          <div key={i} className="flex w-full min-w-0 hover:bg-white/5">
            <span className="w-12 shrink-0 select-none pr-3 text-right align-top text-[11px] text-zinc-500">
              {i + 1}
            </span>
            <code
              className="min-w-0 flex-1 block pr-4"
              style={getCodeLineStyle(plainLines[i] ?? '', effIndents[i])}
              dangerouslySetInnerHTML={{ __html: stripLeadingWhitespaceHtml(lineHtml) || '&nbsp;' }}
            />
          </div>
        )) })()}
      </div>
    </div>
  )
}

// Full-file diff view — shown in the Explorer when the user opens a file
// that has mock changes. Renders the whole file with added/removed lines
// highlighted inline (Cursor / VS Code style).
function FullFileDiffView({
  filePath,
  lines,
  onClose,
}: {
  filePath: string
  lines: DiffLine[]
  onClose: () => void
}) {
  // Highlight all lines in a single pass so shiki can track multi-line
  // context (template literals, JSX tags, etc). We join with \n, highlight,
  // then split back.
  const joinedContent = lines.map((l) => l.content).join('\n')
  const highlightedLines = useShikiLines(joinedContent, filePath)

  return (
    <div className="absolute inset-0 z-10 flex flex-col" style={{ backgroundColor: '#181818' }}>
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-[#2B2B2B] px-3 py-1.5" style={{ backgroundColor: '#313131' }}>
        <div className="flex items-center gap-1.5">
          <FileIcon name={filePath.split('/').pop() ?? ''} size={14} />
          <span className="text-[10px] font-medium text-zinc-300">{filePath}</span>
          <span className="rounded bg-amber-400/10 px-1 text-[9px] font-bold text-amber-400">diff</span>
        </div>
        <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300" title="Close">
          <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Body — full file with diff markers inline. NO horizontal scroll. */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden font-mono text-[13px] leading-[1.5]" style={{ backgroundColor: '#1F1F1F' }}>
        {(() => { const effIndents = getEffectiveIndents(lines.map((l) => l.content)); return lines.map((line, i) => {
          const bg =
            line.type === 'add' ? 'bg-emerald-500/25'
            : line.type === 'remove' ? 'bg-red-500/25'
            : ''
          const marker =
            line.type === 'add' ? '+' : line.type === 'remove' ? '−' : ' '
          const markerColor =
            line.type === 'add' ? 'text-emerald-300'
            : line.type === 'remove' ? 'text-red-300'
            : 'text-zinc-700'
          const displayLine = line.type === 'remove' ? line.oldLine : (line.newLine ?? line.oldLine)
          const html = highlightedLines[i] || ''
          // Line-number color: on colored diff rows the muted zinc-700 vanishes
          // against the saturated bg — bump to a tinted zinc that reads clearly
          // on green/red while staying subtle on context rows.
          const lineNumColor =
            line.type === 'add' ? 'text-emerald-200/80'
            : line.type === 'remove' ? 'text-red-200/80'
            : 'text-zinc-500'
          return (
            <div key={i} className={`flex w-full min-w-0 hover:bg-white/[0.03] ${bg}`}>
              <span className={`w-12 shrink-0 select-none pr-3 pt-0 text-right text-[11px] ${lineNumColor}`}>
                {displayLine ?? ''}
              </span>
              <span className={`w-4 shrink-0 select-none text-center ${markerColor}`}>{marker}</span>
              <code
                className="min-w-0 flex-1 block pr-4"
                style={getCodeLineStyle(line.content, effIndents[i])}
                dangerouslySetInnerHTML={{ __html: stripLeadingWhitespaceHtml(html) || '&nbsp;' }}
              />
            </div>
          )
        }) })()}
      </div>
    </div>
  )
}

// Renders a single diff hunk as a card with line numbers + colored rows
function DiffHunkView({
  hunk,
  filePath,
  onCopy,
  onAttachToCurrent,
  onAttachToNew,
}: {
  hunk: DiffHunk
  filePath?: string
  onCopy: () => void
  onAttachToCurrent: () => void
  onAttachToNew: () => void
}) {
  const [copied, setCopied] = useState(false)
  // Highlight all lines together so shiki keeps context (strings, etc.).
  const joined = hunk.lines.map((l) => l.content).join('\n')
  const hlLines = useShikiLines(joined, filePath || 'file.txt')
  function handleCopy() {
    onCopy()
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }
  return (
    <div className="overflow-hidden rounded-md border border-[#2B2B2B]" style={{ backgroundColor: '#1F1F1F' }}>
      {/* Action bar — always visible */}
      <div className="flex items-center justify-end gap-1 border-b border-[#2B2B2B] px-1.5 py-1" style={{ backgroundColor: '#252526' }}>
        {/* Copy block */}
        <HunkActionButton
          onClick={handleCopy}
          tooltip={copied ? 'Copied!' : 'Copy block'}
        >
          {copied ? (
            <svg className="h-3.5 w-3.5 text-emerald-400" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
            </svg>
          ) : (
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <rect x="9" y="9" width="11" height="11" rx="2" ry="2" />
              <path d="M5 15V6a2 2 0 012-2h9" />
            </svg>
          )}
        </HunkActionButton>

        {/* Attach to current chat — chat bubble (same style as sidebar) */}
        <HunkActionButton onClick={onAttachToCurrent} tooltip="Attach to current chat">
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth="1.5">
            <path strokeLinejoin="round" d="M2.75 4.25 Q2.75 2.75 4.25 2.75 L11.75 2.75 Q13.25 2.75 13.25 4.25 L13.25 9.5 Q13.25 11 11.75 11 L7 11 L4.25 13.5 L4.25 11 Q2.75 11 2.75 9.5 Z" />
          </svg>
        </HunkActionButton>

        {/* Attach to new chat — chat bubble with + inside */}
        <HunkActionButton onClick={onAttachToNew} tooltip="Attach to new chat">
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth="1.5">
            <path strokeLinejoin="round" d="M2.75 4.25 Q2.75 2.75 4.25 2.75 L11.75 2.75 Q13.25 2.75 13.25 4.25 L13.25 9.5 Q13.25 11 11.75 11 L7 11 L4.25 13.5 L4.25 11 Q2.75 11 2.75 9.5 Z" />
            <path strokeLinecap="round" d="M8 5.5V8.5 M6.5 7H9.5" strokeWidth="1.5" />
          </svg>
        </HunkActionButton>
      </div>

      {/* Lines */}
      <div className="font-mono text-[12px] leading-[1.5]">
        {(() => { const effIndents = getEffectiveIndents(hunk.lines.map((l) => l.content)); return hunk.lines.map((line, i) => {
          const bg =
            line.type === 'add'
              ? 'bg-emerald-500/25'
              : line.type === 'remove'
                ? 'bg-red-500/25'
                : ''
          const marker =
            line.type === 'add' ? '+' : line.type === 'remove' ? '−' : ' '
          const markerColor =
            line.type === 'add'
              ? 'text-emerald-300'
              : line.type === 'remove'
                ? 'text-red-300'
                : 'text-zinc-700'
          const textColor =
            line.type === 'add'
              ? 'text-emerald-200'
              : line.type === 'remove'
                ? 'text-red-200'
                : 'text-zinc-400'
          const displayLine = line.type === 'remove' ? line.oldLine : (line.newLine ?? line.oldLine)
          const html = hlLines[i] || ''
          const lineNumColor =
            line.type === 'add' ? 'text-emerald-200/80'
            : line.type === 'remove' ? 'text-red-200/80'
            : 'text-zinc-500'
          return (
            <div key={i} className={`flex ${bg}`}>
              <span className={`w-10 shrink-0 select-none pr-2 text-right text-[10px] ${lineNumColor}`}>
                {displayLine ?? ''}
              </span>
              <span className={`w-4 shrink-0 select-none text-center ${markerColor}`}>{marker}</span>
              <code
                className="min-w-0 flex-1 block pr-2"
                style={getCodeLineStyle(line.content, effIndents[i])}
                dangerouslySetInnerHTML={{ __html: stripLeadingWhitespaceHtml(html) || '&nbsp;' }}
              />
            </div>
          )
        }) })()}
      </div>
    </div>
  )
}

// ── File Tree ──────────────────────────────────────────────────────────────

function FileTree({ projectId, hasActiveSession }: { projectId: string; hasActiveSession?: boolean }) {
  const [files, setFiles] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [viewingFile, setViewingFile] = useState<{ path: string; content: string; worktreeId?: string | null } | null>(null)
  // Editor dirty-buffer tracking. When the user tries to close the editor
  // with unsaved edits, we show a confirm modal instead of discarding silently.
  const editorRef = useRef<CodeMirrorFileViewHandle | null>(null)
  const [editorDirty, setEditorDirty] = useState(false)
  const [showCloseConfirm, setShowCloseConfirm] = useState(false)
  const attemptCloseEditor = useCallback(() => {
    if (editorRef.current?.isDirty()) { setShowCloseConfirm(true); return }
    setViewingFile(null)
  }, [])
  const [search, setSearch] = useState('')
  const [showSearch, setShowSearch] = useState(false)
  const [collapseKey, setCollapseKey] = useState(0)
  const [creatingType, setCreatingType] = useState<'file' | 'folder' | null>(null)
  const [creatingName, setCreatingName] = useState('')
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; path: string } | null>(null)
  const [showDiffModal, setShowDiffModal] = useState(false)
  const [rootDragOver, setRootDragOver] = useState(false)
  const [renameModal, setRenameModal] = useState<{ path: string; currentName: string } | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deleteModal, setDeleteModal] = useState<string | null>(null)
  const [noChatModal, setNoChatModal] = useState(false)
  const [showChangesPanel, setShowChangesPanel] = useState(false)
  const [reviewingFile, setReviewingFile] = useState<string | null>(null)
  const [revertingAll, setRevertingAll] = useState(false)
  const [acceptingAll, setAcceptingAll] = useState(false)
  const [showReviewModal, setShowReviewModal] = useState(false)
  const [reviewFilePath, setReviewFilePath] = useState<string | null>(null)
  // Ancestor paths that should be auto-expanded — set by the "Open file"
  // button in Changes so the tree reveals the target file.
  const [expandPaths, setExpandPaths] = useState<Set<string>>(new Set())
  // Full-file diff view — shown when user opens a file with mock changes
  const [diffViewingFile, setDiffViewingFile] = useState<{ path: string; lines: DiffLine[]; worktreeId?: string | null } | null>(null)
  // Dirty-buffer tracking for the inline diff editor, mirroring what the
  // regular file editor does — unsaved edits pop the save/discard modal.
  const diffEditorRef = useRef<InlineDiffEditorHandle | null>(null)
  const [diffEditorDirty, setDiffEditorDirty] = useState(false)
  const [showDiffCloseConfirm, setShowDiffCloseConfirm] = useState(false)
  const attemptCloseDiffEditor = useCallback(() => {
    if (diffEditorRef.current?.isDirty()) { setShowDiffCloseConfirm(true); return }
    setDiffViewingFile(null)
  }, [])
  const creatingRef = useRef<HTMLInputElement>(null)

  // Listen for cross-panel "open file in explorer" requests
  useEffect(() => {
    function handleOpenFile(e: Event) {
      const path = (e as CustomEvent<string>).detail
      if (!path) return
      // Compute all parent paths (e.g. src/components/WorkPanel.tsx →
      // {src, src/components}) so folders auto-expand down to the file.
      const parts = path.split('/')
      const ancestors = new Set<string>()
      for (let i = 1; i < parts.length; i++) {
        ancestors.add(parts.slice(0, i).join('/'))
      }
      // Use a fresh Set each time so FolderNode's useEffect fires even when
      // the user clicks "Open file" on the same path twice in a row.
      setExpandPaths(ancestors)
      setSelectedPath(path)
      // If the file has mock diff data, open the diff viewer directly
      const mock = getMockChangeForPath(path)
      if (mock?.fullDiff) {
        setDiffViewingFile({ path, lines: mock.fullDiff })
      }
    }
    window.addEventListener('explorer-open-file', handleOpenFile)
    return () => window.removeEventListener('explorer-open-file', handleOpenFile)
  }, [])

  function fetchFiles() {
    fetch(`/api/projects/${projectId}/repository/files`)
      .then((r) => r.json())
      .then((data) => { setFiles(data.files ?? []); setLoading(false) })
      .catch(() => setLoading(false))
  }

  useEffect(() => {
    fetchFiles()
    // Re-fetch every 5s so changes from any active chat appear in the tree
    const interval = setInterval(fetchFiles, 5000)
    return () => clearInterval(interval)
  }, [projectId])

  useEffect(() => {
    if (creatingType && creatingRef.current) creatingRef.current.focus()
  }, [creatingType])

  // Close context menu on click outside
  useEffect(() => {
    if (!contextMenu) return
    const close = () => setContextMenu(null)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [contextMenu])

  async function handleSelectFile(path: string) {
    setSelectedPath(path)
    // If the file is modified by exactly one worktree, read that version so
    // the user sees the agent's in-progress edits. For files touched by
    // multiple worktrees, fall back to main (the merge view comes later).
    const fileEntry = files.find((f) => f.path === path)
    const singleWorktreeId = fileEntry?.worktrees && fileEntry.worktrees.length === 1
      ? fileEntry.worktrees[0].id
      : null
    const worktreeParam = singleWorktreeId ? `?worktree=${singleWorktreeId}` : ''
    const res = await fetch(`/api/projects/${projectId}/repository/files/${encodeURIComponent(path)}${worktreeParam}`)
    if (res.ok) {
      const data = await res.json()
      setViewingFile({ path, content: data.content, worktreeId: singleWorktreeId })
    }
  }

  function getSelectedFolder(): string {
    if (!selectedPath) return ''
    const file = files.find((f) => f.path === selectedPath)
    if (file) {
      const parts = selectedPath.split('/')
      return parts.length > 1 ? parts.slice(0, -1).join('/') : ''
    }
    return selectedPath
  }

  async function handleCreate() {
    if (!creatingName.trim() || !creatingType) return
    const folder = getSelectedFolder()
    const path = folder ? `${folder}/${creatingName.trim()}` : creatingName.trim()

    if (creatingType === 'file') {
      await fetch(`/api/projects/${projectId}/repository/files`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, action: 'accept' }),
      })
      // Create empty file via the tools endpoint approach
      const repo = files[0] // just need any file to get repositoryId pattern
      if (repo) {
        await fetch(`/api/projects/${projectId}/repository/files`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path, action: 'create', content: '' }),
        })
      }
    }

    setCreatingType(null)
    setCreatingName('')
    setSelectedPath(path)
    fetchFiles()
  }

  async function handleRename(oldPath: string, newName: string) {
    await fetch(`/api/projects/${projectId}/repository/files`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: oldPath, action: 'rename', newName }),
    })
    fetchFiles()
  }

  async function handleDelete(path: string) {
    await fetch(`/api/projects/${projectId}/repository/files`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, action: 'delete' }),
    })
    if (selectedPath === path) setSelectedPath(null)
    if (viewingFile?.path === path) setViewingFile(null)
    fetchFiles()
  }

  async function handleMoveFile(fromPath: string, toFolder: string) {
    const fileName = fromPath.split('/').pop() ?? ''
    const newPath = toFolder ? `${toFolder}/${fileName}` : fileName
    if (newPath === fromPath) return

    await fetch(`/api/projects/${projectId}/repository/files`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: fromPath, action: 'move', newPath }),
    })
    setSelectedPath(newPath)
    fetchFiles()
  }

  function handleContextMenu(e: React.MouseEvent, path: string) {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY, path })
  }

  function handlePinToChat(path: string) {
    window.dispatchEvent(new CustomEvent('pin-context', { detail: path }))
    setContextMenu(null)
  }

  async function handleDownload(path: string) {
    const res = await fetch(`/api/projects/${projectId}/repository/files/${encodeURIComponent(path)}`)
    if (res.ok) {
      const data = await res.json()
      const blob = new Blob([data.content], { type: 'text/plain' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = path.split('/').pop() ?? 'file'
      a.click()
      URL.revokeObjectURL(url)
    }
    setContextMenu(null)
  }

  const modifiedFiles = files.filter((f) => f.isModified)
  const filteredFiles = search ? files.filter((f) => f.path.toLowerCase().includes(search.toLowerCase())) : files
  const tree = buildTree(filteredFiles)

  return (
    <div className="relative flex w-full min-w-0 flex-col border-r border-[#2B2B2B]" style={{ backgroundColor: '#181818' }}>
      {/* Inline diff editor overlay — shown when the user opens a file that
          has pending changes. Context and add lines are editable; removed
          lines are read-only red widgets for visual reference only. Saves
          route to the correct worktree (or main) via the same PUT endpoint
          the plain file editor uses. */}
      {diffViewingFile && (
        <div className="absolute inset-0 z-10 flex flex-col" style={{ backgroundColor: '#181818' }}>
          <div className="flex shrink-0 items-center gap-2 border-b border-[#2B2B2B] px-3 py-1.5" style={{ backgroundColor: '#313131' }}>
            <button
              onClick={attemptCloseDiffEditor}
              className="flex items-center text-zinc-400 hover:text-zinc-200"
              aria-label="Back to files"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <div className="flex items-center gap-1.5">
              <FileIcon name={diffViewingFile.path.split('/').pop() ?? ''} size={14} />
              <span className="text-[10px] font-medium text-zinc-300">{diffViewingFile.path}</span>
              {diffEditorDirty && <span className="h-1.5 w-1.5 rounded-full bg-amber-400" title="Unsaved changes" />}
            </div>
          </div>
          <div className="flex-1 min-h-0">
            <InlineDiffEditor
              ref={diffEditorRef}
              projectId={projectId}
              filePath={diffViewingFile.path}
              lines={diffViewingFile.lines}
              worktreeId={diffViewingFile.worktreeId ?? null}
              onDirtyChange={setDiffEditorDirty}
            />
          </div>

          {showDiffCloseConfirm && (
            <div className="absolute inset-0 z-20 flex items-center justify-center" style={{ backgroundColor: 'rgba(0,0,0,0.55)' }}>
              <div className="w-[320px] rounded-md border border-[#2B2B2B] p-4 shadow-xl" style={{ backgroundColor: '#252526' }}>
                <div className="mb-2 text-[12px] font-medium text-zinc-200">Save changes to {diffViewingFile.path.split('/').pop()}?</div>
                <div className="mb-4 text-[11px] text-zinc-400">Your changes will be lost if you don&apos;t save them.</div>
                <div className="flex justify-end gap-2">
                  <button
                    onClick={() => setShowDiffCloseConfirm(false)}
                    className="rounded border border-[#3A3A3A] px-3 py-1 text-[11px] text-zinc-300 hover:bg-white/5"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => {
                      diffEditorRef.current?.discard()
                      setShowDiffCloseConfirm(false)
                      setDiffViewingFile(null)
                    }}
                    className="rounded border border-[#3A3A3A] px-3 py-1 text-[11px] text-zinc-300 hover:bg-white/5"
                  >
                    Discard
                  </button>
                  <button
                    onClick={async () => {
                      const ok = await diffEditorRef.current?.save()
                      if (ok) { setShowDiffCloseConfirm(false); setDiffViewingFile(null) }
                    }}
                    className="rounded bg-emerald-600 px-3 py-1 text-[11px] font-medium text-white hover:bg-emerald-500"
                  >
                    Save
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* File editor overlay — CodeMirror, editable. Edits live in memory;
          only Ctrl/Cmd+S (or the modal's Save button) writes to the sandbox.
          Closing with unsaved edits triggers the save/discard confirm modal. */}
      {viewingFile && (
        <div className="absolute inset-0 z-10 flex flex-col" style={{ backgroundColor: '#181818' }}>
          <div className="flex shrink-0 items-center gap-2 border-b border-[#2B2B2B] px-3 py-1.5" style={{ backgroundColor: '#313131' }}>
            <button
              onClick={attemptCloseEditor}
              className="flex items-center text-zinc-400 hover:text-zinc-200"
              aria-label="Back to files"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <div className="flex items-center gap-1.5">
              <FileIcon name={viewingFile.path.split('/').pop() ?? ''} size={14} />
              <span className="text-[10px] font-medium text-zinc-300">{viewingFile.path}</span>
              {/* Unsaved-indicator dot, VS Code style */}
              {editorDirty && <span className="h-1.5 w-1.5 rounded-full bg-amber-400" title="Unsaved changes" />}
            </div>
          </div>
          <div className="flex-1 min-h-0">
            <CodeMirrorFileView
              ref={editorRef}
              projectId={projectId}
              filePath={viewingFile.path}
              initialContent={viewingFile.content}
              worktreeId={viewingFile.worktreeId ?? null}
              onDirtyChange={setEditorDirty}
            />
          </div>

          {showCloseConfirm && (
            <div className="absolute inset-0 z-20 flex items-center justify-center" style={{ backgroundColor: 'rgba(0,0,0,0.55)' }}>
              <div className="w-[320px] rounded-md border border-[#2B2B2B] p-4 shadow-xl" style={{ backgroundColor: '#252526' }}>
                <div className="mb-2 text-[12px] font-medium text-zinc-200">Save changes to {viewingFile.path.split('/').pop()}?</div>
                <div className="mb-4 text-[11px] text-zinc-400">Your changes will be lost if you don&apos;t save them.</div>
                <div className="flex justify-end gap-2">
                  <button
                    onClick={() => setShowCloseConfirm(false)}
                    className="rounded border border-[#3A3A3A] px-3 py-1 text-[11px] text-zinc-300 hover:bg-white/5"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => {
                      editorRef.current?.discard()
                      setShowCloseConfirm(false)
                      setViewingFile(null)
                    }}
                    className="rounded border border-[#3A3A3A] px-3 py-1 text-[11px] text-zinc-300 hover:bg-white/5"
                  >
                    Discard
                  </button>
                  <button
                    onClick={async () => {
                      const ok = await editorRef.current?.save()
                      if (ok) { setShowCloseConfirm(false); setViewingFile(null) }
                    }}
                    className="rounded bg-emerald-600 px-3 py-1 text-[11px] font-medium text-white hover:bg-emerald-500"
                  >
                    Save
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Explorer header with action buttons */}
      <div className="flex items-center justify-between border-b border-[#2B2B2B] px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-300">Explorer</span>
        <div className="flex items-center gap-0.5">
          {modifiedFiles.length > 0 && (
            <span className="mr-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
              {modifiedFiles.length}
            </span>
          )}
          {/* New File */}
          <button onClick={() => { setCreatingType('file'); setCreatingName('') }} title="New File" className="flex h-5 w-5 items-center justify-center rounded text-zinc-500 hover:bg-white/10 hover:text-zinc-300">
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m3.75 9v6m3-3H9m1.5-12H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
            </svg>
          </button>
          {/* New Folder */}
          <button onClick={() => { setCreatingType('folder'); setCreatingName('') }} title="New Folder" className="flex h-5 w-5 items-center justify-center rounded text-zinc-500 hover:bg-white/10 hover:text-zinc-300">
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 10.5v6m3-3H9m4.06-7.19l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
            </svg>
          </button>
          {/* Diff / Changes */}
          <button onClick={() => setShowDiffModal(true)} title="View Changes" className="flex h-5 w-5 items-center justify-center rounded text-zinc-500 hover:bg-white/10 hover:text-zinc-300">
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
            </svg>
          </button>
          {/* Search */}
          <button onClick={() => setShowSearch(!showSearch)} title="Search Files" className="flex h-5 w-5 items-center justify-center rounded text-zinc-500 hover:bg-white/10 hover:text-zinc-300">
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
            </svg>
          </button>
          {/* Collapse All */}
          <button onClick={() => setCollapseKey((k) => k + 1)} title="Collapse All" className="flex h-5 w-5 items-center justify-center rounded text-zinc-500 hover:bg-white/10 hover:text-zinc-300">
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 9V4.5M9 9H4.5M9 9L3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5l5.25 5.25" />
            </svg>
          </button>
        </div>
      </div>

      {/* Search bar */}
      {showSearch && (
        <div className="border-b border-zinc-200 px-3 py-1.5">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter files..."
            autoFocus
            className="w-full rounded border border-zinc-200 bg-zinc-50 px-2 py-1 text-xs text-zinc-700 placeholder-zinc-500 outline-none focus:border-zinc-400"
          />
        </div>
      )}

      {/* Inline create input */}
      {creatingType && (
        <div className="border-b border-zinc-200 px-3 py-1.5">
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-zinc-400">{creatingType === 'file' ? '📄' : '📁'}</span>
            <input
              ref={creatingRef}
              type="text"
              value={creatingName}
              onChange={(e) => setCreatingName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') setCreatingType(null) }}
              onBlur={() => { if (!creatingName.trim()) setCreatingType(null) }}
              placeholder={`New ${creatingType} name...`}
              className="flex-1 rounded border border-zinc-300 bg-white px-2 py-0.5 text-xs text-zinc-700 outline-none focus:border-zinc-500"
            />
          </div>
          <p className="mt-1 text-[9px] text-zinc-400">
            Creating in: {getSelectedFolder() || '/ (root)'} — Enter to confirm, Esc to cancel
          </p>
        </div>
      )}

      {/* File tree — drop on empty area = move to root */}
      <div
        className={`flex-1 overflow-y-auto py-1 transition-colors ${rootDragOver ? 'bg-blue-50 ring-1 ring-inset ring-blue-300' : ''}`}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setRootDragOver(true) }}
        onDragLeave={() => setRootDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setRootDragOver(false)
          const fromPath = e.dataTransfer.getData('text/plain')
          if (fromPath && fromPath.includes('/')) {
            handleMoveFile(fromPath, '')
          }
        }}
      >
        {loading ? (
          <p className="px-3 py-2 text-xs text-zinc-400">Loading...</p>
        ) : filteredFiles.length === 0 ? (
          <p className="px-3 py-2 text-xs text-zinc-400">{search ? 'No matches' : 'No files'}</p>
        ) : (
          <TreeNode node={tree} depth={0} selectedPath={selectedPath} onSelect={handleSelectFile} collapseKey={collapseKey} expandPaths={expandPaths} onContextMenu={handleContextMenu} onMove={handleMoveFile} />
        )}
      </div>

      {/* Changes bar + review panel */}
      {modifiedFiles.length > 0 && (
        <div className="shrink-0 border-t border-[#2B2B2B]">
          {/* Toggle bar */}
          <button
            onClick={() => setShowChangesPanel(!showChangesPanel)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-white/5"
          >
            <svg className={`h-3 w-3 text-zinc-500 transition-transform ${showChangesPanel ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 15.75l7.5-7.5 7.5 7.5" />
            </svg>
            <span className="text-[11px] font-semibold text-amber-400">{modifiedFiles.length} change{modifiedFiles.length !== 1 ? 's' : ''}</span>
            <div className="flex-1" />
            {/* Accept all */}
            <span
              onClick={(e) => {
                e.stopPropagation()
                if (acceptingAll) return
                setAcceptingAll(true)
                Promise.all(modifiedFiles.map((f) =>
                  fetch(`/api/projects/${projectId}/repository/files`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: f.path, action: 'accept' }),
                  })
                )).then(() => { fetchFiles(); setAcceptingAll(false); setShowChangesPanel(false) })
                  .catch(() => setAcceptingAll(false))
              }}
              className="text-[10px] text-emerald-400 hover:text-emerald-300"
            >
              {acceptingAll ? 'Accepting...' : 'Accept All'}
            </span>
            <span className="text-zinc-600">·</span>
            {/* Revert all */}
            <span
              onClick={(e) => {
                e.stopPropagation()
                if (revertingAll) return
                setRevertingAll(true)
                fetch(`/api/projects/${projectId}/repository/files/revert-all`, { method: 'POST' })
                  .then(() => { fetchFiles(); setRevertingAll(false); setShowChangesPanel(false) })
                  .catch(() => setRevertingAll(false))
              }}
              className="text-[10px] text-red-400 hover:text-red-300"
            >
              {revertingAll ? 'Reverting...' : 'Revert All'}
            </span>
          </button>

          {/* Expanded panel — file list */}
          {showChangesPanel && (
            <div className="border-t border-[#2B2B2B]">
              {/* Review all button */}
              <button
                onClick={(e) => { e.stopPropagation(); setShowReviewModal(true); setReviewFilePath(null) }}
                className="flex w-full items-center justify-center gap-1.5 border-b border-[#2B2B2B] px-3 py-1.5 text-[10px] font-medium text-zinc-400 hover:bg-violet-500/5"
              >
                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m5.231 13.888L8.25 21v-3.375C5.25 14.437 3 11.25 3 8.25 3 5.108 5.108 3 8.25 3h7.5C18.892 3 21 5.108 21 8.25c0 3-2.25 6.188-5.25 9.375z" />
                </svg>
                Review All Changes
              </button>
              {/* File list */}
              <div className="max-h-44 overflow-y-auto px-1 py-1">
                {modifiedFiles.map((f) => {
                  const fileName = f.path.split('/').pop() ?? f.path
                  const wtLabel = f.worktrees && f.worktrees.length > 0
                    ? f.worktrees.length === 1
                      ? f.worktrees[0].name
                      : `${f.worktrees.length} worktrees`
                    : null
                  return (
                    <div
                      key={f.id}
                      className={`group flex items-center gap-2 rounded px-2 py-1.5 ${
                        reviewingFile === f.id ? 'bg-white/10' : 'hover:bg-white/5'
                      }`}
                      title={f.worktrees?.map((w) => w.name).join(', ')}
                    >
                      <span className={`text-[10px] font-mono font-bold ${f.isNew ? 'text-emerald-400' : 'text-amber-400'}`}>{f.isNew ? 'U' : 'M'}</span>
                      <button
                        onClick={() => { setReviewFilePath(f.path); setShowReviewModal(true) }}
                        className="min-w-0 flex-1 text-left"
                      >
                        <p className="text-[10px] text-zinc-300 truncate">{fileName}</p>
                        <p className="text-[8px] text-zinc-600 truncate">
                          {wtLabel ? <span className="text-[#0078D4]">{wtLabel}</span> : null}
                          {wtLabel ? <span className="mx-1">·</span> : null}
                          {f.path}
                        </p>
                      </button>
                      {/* +/- inline */}
                      {(f.added || f.removed) ? (
                        <span className="font-mono text-[9px] tabular-nums">
                          {f.added ? <span className="text-emerald-400">+{f.added}</span> : null}
                          {f.removed ? <span className="ml-1 text-red-400">-{f.removed}</span> : null}
                        </span>
                      ) : null}
                      {/* Accept */}
                      <button
                        onClick={() => {
                          fetch(`/api/projects/${projectId}/repository/files`, {
                            method: 'PATCH',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ path: f.path, action: 'accept' }),
                          }).then(() => fetchFiles())
                        }}
                        title="Accept change"
                        className="hidden h-5 w-5 shrink-0 items-center justify-center rounded text-emerald-500 hover:bg-emerald-500/10 group-hover:flex"
                      >
                        <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                        </svg>
                      </button>
                      {/* Reject (revert) */}
                      <button
                        onClick={() => {
                          fetch(`/api/projects/${projectId}/repository/files`, {
                            method: 'PATCH',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ path: f.path, action: 'revert' }),
                          }).then(() => fetchFiles())
                        }}
                        title="Revert change"
                        className="hidden h-5 w-5 shrink-0 items-center justify-center rounded text-red-400 hover:bg-red-500/10 group-hover:flex"
                      >
                        <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3" />
                        </svg>
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Review diff modal */}
      {showReviewModal && (
        <ChangesReviewModal
          projectId={projectId}
          files={modifiedFiles}
          initialFile={reviewFilePath}
          onAccept={(path) => {
            fetch(`/api/projects/${projectId}/repository/files`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ path, action: 'accept' }),
            }).then(() => fetchFiles())
          }}
          onRevert={(path) => {
            fetch(`/api/projects/${projectId}/repository/files`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ path, action: 'revert' }),
            }).then(() => fetchFiles())
          }}
          onClose={() => { setShowReviewModal(false); setReviewFilePath(null) }}
        />
      )}

      {/* Right-click context menu */}
      {contextMenu && (
        <div
          className="fixed z-50 w-44 rounded-lg border border-zinc-200 bg-white py-1 shadow-lg"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button onClick={() => {
            // Check if chat is open by dispatching event and seeing if it's caught
            if (hasActiveSession) {
              handlePinToChat(contextMenu.path)
            } else {
              setNoChatModal(true)
              setContextMenu(null)
            }
          }} className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-zinc-300 hover:bg-white/5">
            <svg className="h-3 w-3 text-zinc-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244" /></svg>
            Pin to chat
          </button>
          <button onClick={() => handleDownload(contextMenu.path)} className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-zinc-300 hover:bg-white/5">
            <svg className="h-3 w-3 text-zinc-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" /></svg>
            Download
          </button>
          <div className="my-1 border-t border-[#2B2B2B]" />
          <button onClick={() => {
            setRenameModal({ path: contextMenu.path, currentName: contextMenu.path.split('/').pop() ?? '' })
            setRenameValue(contextMenu.path.split('/').pop() ?? '')
            setContextMenu(null)
          }} className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-zinc-300 hover:bg-white/5">
            <svg className="h-3 w-3 text-zinc-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L6.832 19.82a4.5 4.5 0 01-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 011.13-1.897L16.863 4.487z" /></svg>
            Rename
          </button>
          <button onClick={() => { setDeleteModal(contextMenu.path); setContextMenu(null) }} className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-red-500 hover:bg-red-50">
            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" /></svg>
            Delete
          </button>
        </div>
      )}

      {/* Rename modal */}
      {renameModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-sm rounded-xl bg-white p-6 shadow-xl">
            <h3 className="text-sm font-semibold text-zinc-800">Rename</h3>
            <p className="mt-1 text-[10px] text-zinc-400">{renameModal.path}</p>
            <input
              autoFocus
              type="text"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && renameValue.trim()) { handleRename(renameModal.path, renameValue.trim()); setRenameModal(null) }
                if (e.key === 'Escape') setRenameModal(null)
              }}
              className="mt-3 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-800 outline-none focus:border-zinc-500"
            />
            <div className="mt-4 flex gap-2">
              <button
                onClick={() => { if (renameValue.trim()) { handleRename(renameModal.path, renameValue.trim()); setRenameModal(null) } }}
                className="flex h-8 flex-1 items-center justify-center rounded-lg bg-zinc-800 text-xs font-medium text-white hover:bg-zinc-700"
              >
                Rename
              </button>
              <button onClick={() => setRenameModal(null)} className="flex h-8 flex-1 items-center justify-center rounded-lg text-xs text-zinc-500 hover:text-zinc-800">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation modal */}
      {deleteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-sm rounded-xl bg-white p-6 shadow-xl">
            <h3 className="text-sm font-semibold text-zinc-800">Delete file?</h3>
            <p className="mt-1 text-xs text-zinc-500">
              Are you sure you want to delete <strong>{deleteModal.split('/').pop()}</strong>? This action cannot be undone.
            </p>
            <p className="mt-1 text-[10px] text-zinc-400">{deleteModal}</p>
            <div className="mt-4 flex gap-2">
              <button
                onClick={() => { handleDelete(deleteModal); setDeleteModal(null) }}
                className="flex h-8 flex-1 items-center justify-center rounded-lg bg-red-600 text-xs font-medium text-white hover:bg-red-700"
              >
                Delete
              </button>
              <button onClick={() => setDeleteModal(null)} className="flex h-8 flex-1 items-center justify-center rounded-lg text-xs text-zinc-500 hover:text-zinc-800">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* No chat open modal */}
      {noChatModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-sm rounded-xl bg-white p-6 shadow-xl">
            <h3 className="text-sm font-semibold text-zinc-800">No chat open</h3>
            <p className="mt-1 text-xs text-zinc-500">
              Open a chat first to pin files as context. Click &quot;New Chat&quot; to start.
            </p>
            <div className="mt-4">
              <button onClick={() => setNoChatModal(false)} className="flex h-8 w-full items-center justify-center rounded-lg bg-zinc-800 text-xs font-medium text-white hover:bg-zinc-700">
                Got it
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Diff modal */}
      {showDiffModal && (
        <DiffModal
          projectId={projectId}
          files={files}
          onClose={() => setShowDiffModal(false)}
        />
      )}
    </div>
  )
}

// ── Tree helpers ───────────────────────────────────────────────────────────

interface TreeNodeData {
  name: string
  path: string
  isFile: boolean
  isModified: boolean
  isNew: boolean
  added?: number
  removed?: number
  worktrees?: { id: string; name: string }[]
  children: TreeNodeData[]
}

function buildTree(files: FileEntry[]): TreeNodeData {
  const root: TreeNodeData = { name: '', path: '', isFile: false, isModified: false, isNew: false, children: [] }
  for (const file of files) {
    const parts = file.path.split('/')
    let current = root
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      const isLast = i === parts.length - 1
      let child = current.children.find((c) => c.name === part)
      if (!child) {
        child = {
          name: part,
          path: parts.slice(0, i + 1).join('/'),
          isFile: isLast,
          isModified: isLast ? file.isModified : false,
          isNew: isLast ? (file.isNew ?? false) : false,
          added: isLast ? file.added : undefined,
          removed: isLast ? file.removed : undefined,
          worktrees: isLast ? file.worktrees : undefined,
          children: [],
        }
        current.children.push(child)
      }
      current = child
    }
  }
  function processNode(node: TreeNodeData) {
    node.children.sort((a, b) => { if (a.isFile !== b.isFile) return a.isFile ? 1 : -1; return a.name.localeCompare(b.name) })
    node.children.forEach(processNode)
    // Propagate modified/new status + aggregated +/- to folders
    if (!node.isFile) {
      node.isModified = node.children.some((c) => c.isModified)
      node.isNew = node.children.some((c) => c.isNew)
      // Aggregate added/removed from descendants so a folder shows the total
      const sumAdded = node.children.reduce((s, c) => s + (c.added ?? 0), 0)
      const sumRemoved = node.children.reduce((s, c) => s + (c.removed ?? 0), 0)
      if (sumAdded > 0 || sumRemoved > 0) {
        node.added = sumAdded
        node.removed = sumRemoved
      }
    }
  }
  processNode(root)
  return root
}

interface TreeProps {
  node: TreeNodeData
  depth: number
  selectedPath: string | null
  onSelect: (p: string) => void
  collapseKey?: number
  // When a path is in this set (including its ancestors), the folder
  // auto-expands to reveal the target. Used by "Open file" from Changes.
  expandPaths?: Set<string>
  onContextMenu?: (e: React.MouseEvent, path: string) => void
  onMove?: (fromPath: string, toFolder: string) => void
}

function TreeNode({ node, depth, selectedPath, onSelect, collapseKey, expandPaths, onContextMenu, onMove }: TreeProps) {
  return (
    <>
      {node.children.map((child) => (
        child.isFile ? (
          <FileNodeDraggable
            key={child.path}
            child={child}
            depth={depth}
            selectedPath={selectedPath}
            onSelect={onSelect}
            onContextMenu={onContextMenu}
            onMove={onMove}
          />
        ) : (
          <FolderNode key={child.path} node={child} depth={depth} selectedPath={selectedPath} onSelect={onSelect} collapseKey={collapseKey} expandPaths={expandPaths} onContextMenu={onContextMenu} onMove={onMove} />
        )
      ))}
    </>
  )
}

function FileNodeDraggable({ child, depth, selectedPath, onSelect, onContextMenu, onMove }: {
  child: TreeNodeData; depth: number; selectedPath: string | null; onSelect: (p: string) => void
  onContextMenu?: (e: React.MouseEvent, path: string) => void
  onMove?: (fromPath: string, toFolder: string) => void
}) {
  return (
    <button
      key={child.path}
      draggable
      onDragStart={(e) => { e.dataTransfer.setData('text/plain', child.path); e.dataTransfer.effectAllowed = 'move' }}
      onClick={() => onSelect(child.path)}
      onContextMenu={(e) => onContextMenu?.(e, child.path)}
      title={child.worktrees && child.worktrees.length > 0 ? `Modified in: ${child.worktrees.map((w) => w.name).join(', ')}` : undefined}
      className={`flex w-full min-w-0 items-center gap-2 py-1 text-left text-[13px] hover:bg-white/5 cursor-grab active:cursor-grabbing ${selectedPath === child.path ? 'bg-white/10 text-zinc-200' : ''}`}
      style={{ paddingLeft: `${depth * 16 + 16}px`, paddingRight: 8 }}
    >
      <FileIcon name={child.name} />
      <span className={`flex-1 truncate ${child.isNew ? 'text-emerald-400' : child.isModified ? 'text-amber-400' : 'text-zinc-300'}`}>{child.name}</span>
      {/* +/- stats when at least one chat touched the file */}
      {(child.added || child.removed) ? (
        <span className="shrink-0 font-mono text-[9px] tabular-nums">
          {child.added ? <span className="text-emerald-400">+{child.added}</span> : null}
          {child.removed ? <span className="ml-1 text-red-400">-{child.removed}</span> : null}
        </span>
      ) : (
        <>
          {child.isNew && <span className="shrink-0 text-[9px] font-bold text-emerald-400">U</span>}
          {child.isModified && !child.isNew && <span className="shrink-0 text-[9px] font-bold text-amber-400">M</span>}
        </>
      )}
    </button>
  )
}

function FolderNode({ node, depth, selectedPath, onSelect, collapseKey, expandPaths, onContextMenu, onMove }: TreeProps) {
  const [expanded, setExpanded] = useState(depth < 1)
  const [dragOver, setDragOver] = useState(false)

  useEffect(() => {
    if (collapseKey && collapseKey > 0) setExpanded(false)
  }, [collapseKey])

  // Auto-expand when this folder's path is an ancestor of a requested path.
  useEffect(() => {
    if (!expandPaths || expandPaths.size === 0) return
    if (expandPaths.has(node.path)) setExpanded(true)
  }, [expandPaths, node.path])

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOver(true)
  }

  function handleDragLeave() {
    setDragOver(false)
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
    const fromPath = e.dataTransfer.getData('text/plain')
    if (fromPath && onMove) {
      const fileName = fromPath.split('/').pop() ?? ''
      const toPath = node.path ? `${node.path}/${fileName}` : fileName
      if (toPath !== fromPath) {
        onMove(fromPath, node.path)
      }
    }
  }

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        draggable
        onDragStart={(e) => { e.dataTransfer.setData('text/plain', node.path); e.dataTransfer.effectAllowed = 'move' }}
        className={`flex w-full min-w-0 items-center py-1 text-left text-[13px] text-zinc-300 hover:bg-white/5 cursor-grab active:cursor-grabbing ${dragOver ? 'bg-blue-100 ring-1 ring-blue-400' : ''}`}
        style={{ paddingLeft: `${depth * 16 + 4}px`, paddingRight: 8 }}
      >
        <span className={`inline-flex h-4 w-4 shrink-0 items-center justify-center text-zinc-400 transition-transform ${expanded ? 'rotate-90' : ''}`}>
          <svg className="h-2.5 w-2.5" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
          </svg>
        </span>
        <span className="mr-1.5 text-sm">{expanded ? '📂' : '📁'}</span>
        <span className={`flex-1 truncate ${node.isNew ? 'text-emerald-600' : node.isModified ? 'text-amber-600' : ''}`}>{node.name}</span>
        {node.isNew && <span className="shrink-0 text-[9px] font-bold text-emerald-500">U</span>}
        {node.isModified && !node.isNew && <span className="shrink-0 text-[9px] font-bold text-amber-500">M</span>}
      </button>
      {expanded && <TreeNode node={node} depth={depth + 1} selectedPath={selectedPath} onSelect={onSelect} collapseKey={collapseKey} expandPaths={expandPaths} onContextMenu={onContextMenu} onMove={onMove} />}
    </div>
  )
}

// ── Diff Modal ─────────────────────────────────────────────────────────────

function DiffModal({ projectId, files, onClose }: { projectId: string; files: FileEntry[]; onClose: () => void }) {
  const [diffFiles, setDiffFiles] = useState<{ path: string; original: string; current: string }[]>([])
  const [selectedDiff, setSelectedDiff] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const modifiedFiles = files.filter((f) => f.isModified)

  useEffect(() => {
    Promise.all(
      modifiedFiles.map(async (f) => {
        const res = await fetch(`/api/projects/${projectId}/repository/files/${encodeURIComponent(f.path)}`)
        if (res.ok) {
          const data = await res.json()
          return { path: f.path, original: data.originalContent ?? '', current: data.content ?? '' }
        }
        return null
      })
    ).then((results) => {
      setDiffFiles(results.filter((r): r is NonNullable<typeof r> => r !== null))
      setLoading(false)
    })
  }, [])

  // Group by folder
  const folders = new Map<string, typeof diffFiles>()
  for (const f of diffFiles) {
    const parts = f.path.split('/')
    const folder = parts.length > 1 ? parts.slice(0, -1).join('/') : '/'
    if (!folders.has(folder)) folders.set(folder, [])
    folders.get(folder)!.push(f)
  }

  const selectedFile = diffFiles.find((f) => f.path === selectedDiff)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="flex h-[80vh] w-[90vw] max-w-5xl flex-col rounded-2xl bg-white shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-200 px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold text-zinc-800">Changes</h2>
            <p className="text-xs text-zinc-500">{modifiedFiles.length} file{modifiedFiles.length !== 1 ? 's' : ''} modified</p>
          </div>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600">
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {loading ? (
          <div className="flex flex-1 items-center justify-center">
            <p className="text-sm text-zinc-400">Loading changes...</p>
          </div>
        ) : modifiedFiles.length === 0 ? (
          <div className="flex flex-1 items-center justify-center">
            <p className="text-sm text-zinc-400">No changes detected</p>
          </div>
        ) : (
          <div className="flex flex-1 overflow-hidden">
            {/* Left: file list grouped by folder */}
            <div className="w-64 shrink-0 overflow-y-auto border-r border-zinc-200 py-2">
              {[...folders.entries()].map(([folder, folderFiles]) => (
                <div key={folder} className="mb-2">
                  <p className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                    {folder} <span className="text-amber-600">({folderFiles.length})</span>
                  </p>
                  {folderFiles.map((f) => (
                    <button
                      key={f.path}
                      onClick={() => setSelectedDiff(f.path)}
                      className={`flex w-full items-center gap-1.5 px-3 py-1 text-left text-xs hover:bg-white/5 ${selectedDiff === f.path ? 'bg-violet-500/15 text-zinc-200' : 'text-amber-600'}`}
                    >
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
                      <span className="truncate">{f.path.split('/').pop()}</span>
                    </button>
                  ))}
                </div>
              ))}
            </div>

            {/* Right: diff view */}
            <div className="flex-1 overflow-auto bg-white p-4 font-mono text-xs">
              {selectedFile ? (
                <div>
                  <p className="mb-3 text-sm font-medium text-zinc-700">{selectedFile.path}</p>
                  {(() => {
                    const origLines = selectedFile.original.split('\n')
                    const currLines = selectedFile.current.split('\n')
                    const maxLines = Math.max(origLines.length, currLines.length)
                    return (
                      <div className="space-y-0">
                        {Array.from({ length: maxLines }).map((_, i) => {
                          const orig = origLines[i]
                          const curr = currLines[i]
                          if (orig === curr) {
                            return <div key={i} className="flex py-px text-zinc-500"><span className="mr-3 w-8 text-right text-zinc-300 select-none">{i + 1}</span>{curr}</div>
                          }
                          return (
                            <div key={i}>
                              {orig !== undefined && <div className="flex bg-red-50 py-px text-red-700"><span className="mr-3 w-8 text-right text-red-300 select-none">-</span>{orig}</div>}
                              {curr !== undefined && <div className="flex bg-emerald-50 py-px text-emerald-700"><span className="mr-3 w-8 text-right text-emerald-300 select-none">+</span>{curr}</div>}
                            </div>
                          )
                        })}
                      </div>
                    )
                  })()}
                </div>
              ) : (
                <div className="flex h-full items-center justify-center">
                  <p className="text-zinc-400">Select a file to view diff</p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Chat Panel ─────────────────────────────────────────────────────────────

function ChatPanel({
  projectId,
  sessionId,
  sessionName,
  isWorktreeChat,
  messages,
  setMessages,
  activeMode,
  activeSkillId,
  activeTeamId,
  activeEmployee,
  activeTeam,
  hiredEmployees,
  teams,
  onSelectEmployee,
  onSelectTeam,
  onClearSelection,
  onSessionRenamed,
  onMinimize,
  onOpenScratchpad,
  onBusyChange,
  hunkAttachments,
  onClearHunkAttachment,
  onClearAllHunkAttachments,
}: {
  projectId: string
  sessionId: string
  sessionName: string
  isWorktreeChat: boolean
  onMinimize: () => void
  onOpenScratchpad: () => void
  onBusyChange: (sessionId: string, busy: boolean) => void
  hunkAttachments: Array<{
    filePath: string
    fileStatus: 'M' | 'A' | 'D'
    focusStart: number
    focusEnd: number
    formattedContent: string
    lineRange: string
  }>
  onClearHunkAttachment: (index: number) => void
  onClearAllHunkAttachments: () => void
  messages: Message[]
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>
  activeMode: ChatMode
  activeSkillId: string | null
  activeTeamId: string | null
  activeEmployee?: HiredEmployee
  activeTeam?: TeamInfo
  hiredEmployees: HiredEmployee[]
  teams: TeamInfo[]
  onSelectEmployee: (e: HiredEmployee) => void
  onSelectTeam: (t: TeamInfo) => void
  onClearSelection: () => void
  onSessionRenamed: (name: string) => void
}) {
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [showSelector, setShowSelector] = useState(false)
  const [selectorTab, setSelectorTab] = useState<'employees' | 'teams'>('employees')
  const [attachments, setAttachments] = useState<{ file: File; preview: string; type: 'image' | 'pdf' | 'text' }[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const [contextPaths, setContextPaths] = useState<string[]>([])
  const [showToolbarMenu, setShowToolbarMenu] = useState(false)
  const [showContextPicker, setShowContextPicker] = useState(false)
  const [showClearConfirm, setShowClearConfirm] = useState(false)
  const [showReminderModal, setShowReminderModal] = useState(false)
  const [selectedModel, setSelectedModel] = useState<string>('sonnet')
  const [thinkingLevel, setThinkingLevel] = useState<string>('off')
  const [permissionMode, setPermissionMode] = useState<'leitura' | 'planejamento' | 'edicao'>('leitura')
  const [contextPercentage, setContextPercentage] = useState(0)
  const [showContextTooltip, setShowContextTooltip] = useState(false)
  const [compacting, setCompacting] = useState(false)

  // Poll context usage after messages change
  useEffect(() => {
    if (!sessionId) return
    fetch(`/api/projects/${projectId}/chat-sessions/${sessionId}/context?model=${selectedModel}`)
      .then((r) => r.json())
      .then((data) => setContextPercentage(data.percentage ?? 0))
      .catch(() => {})
  }, [messages.length, sessionId, projectId, selectedModel])

  async function handleCompact() {
    if (!sessionId || compacting) return
    setCompacting(true)
    try {
      await fetch(`/api/projects/${projectId}/chat-sessions/${sessionId}/context`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: selectedModel }),
      })
      setContextPercentage(10) // reset visual
    } catch { /* ignore */ }
    setCompacting(false)
  }
  const bottomRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const ACCEPTED_TYPES = {
    'image/png': 'image',
    'image/jpeg': 'image',
    'image/gif': 'image',
    'image/webp': 'image',
    'application/pdf': 'pdf',
    'text/plain': 'text',
    'text/markdown': 'text',
    'text/csv': 'text',
    'application/json': 'text',
  } as Record<string, 'image' | 'pdf' | 'text'>

  function handleFiles(fileList: FileList) {
    const newAttachments: typeof attachments = []
    for (const file of Array.from(fileList)) {
      const type = ACCEPTED_TYPES[file.type]
      if (!type && !file.name.match(/\.(txt|md|csv|json|ts|tsx|js|jsx|py|html|css|yml|yaml|toml|xml|sql|sh|env)$/i)) continue

      const fileType = type ?? 'text'
      let preview = ''
      if (fileType === 'image') {
        preview = URL.createObjectURL(file)
      }
      newAttachments.push({ file, preview, type: fileType })
    }
    setAttachments((prev) => [...prev, ...newAttachments])
  }

  async function handleClearConversation() {
    // Close old session (preserve in DB), create new one in its place
    if (sessionId) {
      await fetch(`/api/projects/${projectId}/chat-sessions/${sessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'closed' }),
      })
      const res = await fetch(`/api/projects/${projectId}/chat-sessions`, { method: 'POST' })
      if (res.ok) {
        const newSession = await res.json()
        onSessionRenamed('New Chat')
        // Dispatch event for parent to update session list
        window.dispatchEvent(new CustomEvent('session-replaced', { detail: { oldId: sessionId, newId: newSession.id, name: newSession.name } }))
      }
    }
    setMessages([])
    setContextPaths([])
    setAttachments([])
    setInput('')
  }

  function removeAttachment(index: number) {
    setAttachments((prev) => {
      const next = [...prev]
      if (next[index].preview) URL.revokeObjectURL(next[index].preview)
      next.splice(index, 1)
      return next
    })
  }

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  // Listen for pin-context events from the file tree
  useEffect(() => {
    function handlePinContext(e: Event) {
      const path = (e as CustomEvent<string>).detail
      if (path) setContextPaths((prev) => prev.includes(path) ? prev : [...prev, path])
    }
    window.addEventListener('pin-context', handlePinContext)
    return () => window.removeEventListener('pin-context', handlePinContext)
  }, [])

  const [slashFilter, setSlashFilter] = useState('')
  const [slashMatch, setSlashMatch] = useState<HiredEmployee | TeamInfo | null>(null)
  const [openedViaButton, setOpenedViaButton] = useState(false)

  // Detect / at the START of input
  useEffect(() => {
    // Only trigger slash behavior if / is at position 0
    if (input.startsWith('/') && input.indexOf('/') === 0) {
      const filter = input.slice(1).toLowerCase().trim()
      setSlashFilter(filter)

      const allNames = [
        ...hiredEmployees.map((e) => e.name.toLowerCase()),
        ...teams.map((t) => t.name.toLowerCase()),
      ]
      const hasMatch = filter === '' || allNames.some((n) => n.includes(filter))

      // Check for exact match — auto-select immediately
      const exactEmp = hiredEmployees.find((e) => e.name.toLowerCase() === filter)
      const exactTeam = teams.find((t) => t.name.toLowerCase() === filter)

      if (exactEmp) {
        onSelectEmployee(exactEmp)
        setShowSelector(false)
        setSlashFilter('')
        setSlashMatch(null)
        setOpenedViaButton(false)
        // Remove the /name from input, keep anything after
        const rest = input.slice(1 + exactEmp.name.length).trimStart()
        setInput(rest)
        return
      }
      if (exactTeam) {
        onSelectTeam(exactTeam)
        setShowSelector(false)
        setSlashFilter('')
        setSlashMatch(null)
        setOpenedViaButton(false)
        const rest = input.slice(1 + exactTeam.name.length).trimStart()
        setInput(rest)
        return
      }

      setSlashMatch(null)

      if (hasMatch) {
        setShowSelector(true)
      } else {
        setShowSelector(false)
        setSlashFilter('')
      }
    } else if (!openedViaButton) {
      if (slashFilter !== '') setSlashFilter('')
      if (slashMatch) setSlashMatch(null)
    }
  }, [input])

  const [teamProcessing, setTeamProcessing] = useState(false)
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const agentPollingRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [liveStepIds, setLiveStepIds] = useState<Set<string>>(new Set())

  // Notify parent (WorkPanel) whenever this chat becomes busy / idle, so the
  // sidebar + worktree tab bar can swap icons for a loading spinner.
  useEffect(() => {
    onBusyChange(sessionId, sending || teamProcessing)
  }, [sending, teamProcessing, sessionId, onBusyChange])

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current)
      if (agentPollingRef.current) clearInterval(agentPollingRef.current)
    }
  }, [])

  async function sendMessage(e: React.FormEvent) {
    e.preventDefault()
    const userText = input.trim()
    // Allow sending with just attachments (no text) when hunks are pinned
    if ((!userText && attachments.length === 0 && hunkAttachments.length === 0) || sending || teamProcessing) return

    // Prepend each hunk attachment in order so the agent sees them all as
    // part of the user's context. All chips clear on send.
    const content = hunkAttachments.length > 0
      ? `${hunkAttachments.map((h) => h.formattedContent).join('')}${userText}`
      : userText

    const userMsg: Message = {
      id: `temp-${Date.now()}`,
      content,
      sender: 'user',
      mode: activeMode,
      activeSkillId: activeSkillId,
      report: null,
      createdAt: new Date().toISOString(),
    }
    // Auto-rename the chat using the first user message (first 5 words)
    const isFirstMessage = messages.filter(m => m.sender === 'user').length === 0
    if (isFirstMessage && userText) {
      const title = userText.split(/\s+/).slice(0, 5).join(' ').slice(0, 40)
      onSessionRenamed(title)
    }

    setMessages((prev) => [...prev, userMsg])
    setLiveStepIds(new Set()) // clear previous session's live steps
    setInput('')
    setAttachments([])
    if (hunkAttachments.length > 0) onClearAllHunkAttachments()
    setSending(true)

    // Start polling for real-time tool calls (all modes)
    const pollAfter = new Date().toISOString()
    const seenAgentStepIds = new Set<string>()
    agentPollingRef.current = setInterval(async () => {
      try {
        const r = await fetch(`/api/projects/${projectId}/chat/status?after=${pollAfter}`)
        if (!r.ok) return
        const d = await r.json()
        const newSteps = (d.messages ?? []).filter((m: Message) =>
          m.sender === 'step' && !seenAgentStepIds.has(m.id)
        )
        if (newSteps.length > 0) {
          newSteps.forEach((m: Message) => seenAgentStepIds.add(m.id))
          setMessages(prev => [...prev, ...newSteps])
          setLiveStepIds(prev => {
            const next = new Set(prev)
            newSteps.forEach((m: Message) => next.add(m.id))
            return next
          })
        }
      } catch { /* ignore */ }
    }, 1000)

    try {
      const res = await fetch(`/api/projects/${projectId}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content,
          mode: activeMode,
          activeSkillId: activeSkillId ?? undefined,
          activeTeamId: activeTeamId ?? undefined,
          sessionId: sessionId ?? undefined,
          model: selectedModel !== 'sonnet' ? selectedModel : undefined,
          thinkingBudget: thinkingLevel !== 'off' ? { off: 0, low: 5000, medium: 10000, high: 30000 }[thinkingLevel] : undefined,
          permissionMode,
          contextPaths: contextPaths.length > 0 ? contextPaths : undefined,
          teamConfig: activeTeam ? {
            order: activeTeam.order,
            canRecreateTasks: activeTeam.canRecreateTasks,
            hasBuilder: activeTeam.hasBuilder,
          } : undefined,
        }),
      })

      if (res.ok) {
        const data = await res.json()

        if (data.processing) {
          // Team mode — stop agent polling, start team polling
          if (agentPollingRef.current) { clearInterval(agentPollingRef.current); agentPollingRef.current = null }
          setTeamProcessing(true)
          setSending(false)
          const pollAfter = new Date().toISOString()
          const seenIds = new Set<string>()
          const pollStartTime = Date.now()
          const POLL_TIMEOUT = 5 * 60 * 1000 // 5 minutes

          pollingRef.current = setInterval(async () => {
            // Timeout check
            if (Date.now() - pollStartTime > POLL_TIMEOUT) {
              if (pollingRef.current) clearInterval(pollingRef.current)
              pollingRef.current = null
              setTeamProcessing(false)
              setMessages((prev) => [...prev, {
                id: `timeout-${Date.now()}`,
                content: 'Team processing timed out. Please try again.',
                sender: 'system',
                mode: 'team',
                activeSkillId: null,
                report: null,
                createdAt: new Date().toISOString(),
              }])
              return
            }

            try {
              // Poll for new chat messages
              const pollRes = await fetch(`/api/projects/${projectId}/chat/status?after=${pollAfter}`)
              if (pollRes.ok) {
                const pollData = await pollRes.json()

                // Filter: show employee responses in chat, keep plan/step for mini map
                const allNewMsgs = (pollData.messages ?? []).filter((m: Message) => {
                  if (seenIds.has(m.id) || m.sender === 'user') return false
                  seenIds.add(m.id)
                  return true
                })

                // Add all to messages (mini map reads plan/step, chat filters them out)
                if (allNewMsgs.length > 0) {
                  setMessages((prev) => [...prev, ...allNewMsgs.map((m: Message) => ({
                    ...m,
                    createdAt: m.createdAt ?? new Date().toISOString(),
                  }))])
                }

                // Also poll TeamRun state for mini map
                const runRes = await fetch(`/api/projects/${projectId}/team-run`)
                if (runRes.ok) {
                  const runData = await runRes.json()
                  if (runData.lastRun?.state) {
                    // Update parent state via a custom event (will be picked up by WorkPanel)
                    window.dispatchEvent(new CustomEvent('teamrun-update', { detail: runData.lastRun.state }))
                  }
                }

                // Check if team is done
                const isDone = allNewMsgs.some((m: Message) => m.sender === 'team')
                if (isDone) {
                  if (pollingRef.current) clearInterval(pollingRef.current)
                  pollingRef.current = null
                  setTeamProcessing(false)
                }
              }
            } catch { /* ignore polling errors */ }
          }, 1500)

          return
        }

        // Sync mode (no_skill / skill)
        if (data.replies) {
          const newMsgs = data.replies.map((r: ChatReplyRaw) => ({
            id: r.id,
            content: r.content,
            sender: r.sender,
            mode: r.mode,
            activeSkillId: r.activeSkillId,
            report: null,
            createdAt: new Date().toISOString(),
          }))
          setMessages((prev) => [...prev, ...newMsgs])
        }
      } else {
        // API returned error
        try {
          const errData = await res.json()
          setMessages((prev) => [...prev, {
            id: `err-${Date.now()}`,
            content: errData.error || 'Something went wrong. Please try again.',
            sender: 'system',
            mode: activeMode,
            activeSkillId: null,
            report: null,
            createdAt: new Date().toISOString(),
          }])
        } catch {
          setMessages((prev) => [...prev, {
            id: `err-${Date.now()}`,
            content: 'Something went wrong. Please try again.',
            sender: 'system',
            mode: activeMode,
            activeSkillId: null,
            report: null,
            createdAt: new Date().toISOString(),
          }])
        }
      }
    } catch (err) {
      setMessages((prev) => [...prev, {
        id: `err-${Date.now()}`,
        content: `Connection error: ${err instanceof Error ? err.message : 'Please check your connection and try again.'}`,
        sender: 'system',
        mode: activeMode,
        activeSkillId: null,
        report: null,
        createdAt: new Date().toISOString(),
      }])
    }
    // Stop agent polling
    if (agentPollingRef.current) { clearInterval(agentPollingRef.current); agentPollingRef.current = null }
    setSending(false)
  }

  const hasAnyone = hiredEmployees.length > 0 || teams.length > 0

  // Get color for sender
  function getSenderColor(sender: string): string {
    const emp = hiredEmployees.find((e) => e.name === sender)
    if (emp) return emp.color
    if (sender === 'Builder') return 'from-red-600 to-red-700'
    return ''
  }

  return (
    <div
      className={`flex flex-1 flex-col border-r border-[#2B2B2B] ${isDragging ? 'ring-2 ring-inset ring-white/30' : ''}`}
      style={{ backgroundColor: '#1F1F1F' }}
      onDragOver={(e) => { e.preventDefault(); setIsDragging(true) }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={(e) => { e.preventDefault(); setIsDragging(false); if (e.dataTransfer.files.length > 0) handleFiles(e.dataTransfer.files) }}
    >
      {/* Chat header bar */}
      {!isWorktreeChat && (
        <div className="flex shrink-0 items-center gap-2 border-b border-[#2B2B2B] px-4 py-2">
          <svg
            className="h-3.5 w-3.5 shrink-0 text-zinc-500"
            fill="none"
            viewBox="0 0 16 16"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path strokeLinejoin="round" d="M2.75 4.25 Q2.75 2.75 4.25 2.75 L11.75 2.75 Q13.25 2.75 13.25 4.25 L13.25 9.5 Q13.25 11 11.75 11 L7 11 L4.25 13.5 L4.25 11 Q2.75 11 2.75 9.5 Z" />
          </svg>
          <span className="min-w-0 truncate text-[12px] font-medium text-zinc-300">{sessionName}</span>
          <span className="text-[10px] text-zinc-600">(main)</span>
          <div className="flex-1" />
          {/* Scratchpad — free-form notes referenced via @notes */}
          <button
            type="button"
            onClick={onOpenScratchpad}
            title="Scratchpad"
            className="text-zinc-500 transition-colors hover:text-zinc-300"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zM19.5 14.25v4.75A2.25 2.25 0 0117.25 21H5.25A2.25 2.25 0 013 18.75V6.75A2.25 2.25 0 015.25 4.5h4.75" />
            </svg>
          </button>
          {/* History button — placeholder, logic TBD */}
          <button
            type="button"
            title="Session history"
            className="text-zinc-500 transition-colors hover:text-zinc-300"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <circle cx="12" cy="12" r="9" />
              <path strokeLinecap="round" d="M12 7.5V12l3 1.5" />
              <path strokeLinecap="round" d="M3.51 9A9 9 0 0112 3c2.49 0 4.74 1.01 6.36 2.64" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 4.5v4h4" />
            </svg>
          </button>
          {/* Minimize — close this chat view, go back to empty state */}
          <button
            type="button"
            onClick={onMinimize}
            title="Minimize chat"
            className="text-zinc-500 transition-colors hover:text-zinc-300"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 12h-15" />
            </svg>
          </button>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {messages.length === 0 && (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-zinc-400">Send a message or type <strong>/</strong> to select a skill</p>
          </div>
        )}
        {messages.map((msg) => {
          // Never show plan messages
          if (msg.sender === 'plan') return null

          // Step messages — only show if they're from the current live session
          if (msg.sender === 'step') {
            if (!liveStepIds.has(msg.id)) return null
            return <LiveStepMessage key={msg.id} content={msg.content} />
          }

          // User message — bubble
          if (msg.sender === 'user') {
            return (
              <div key={msg.id} className="flex justify-end">
                <div className="max-w-[85%] rounded-xl bg-[#3C3C3C] px-4 py-2 text-sm text-zinc-100">
                  {msg.content}
                </div>
              </div>
            )
          }

          // System message — subtle warning
          if (msg.sender === 'system') {
            return (
              <div key={msg.id} className="flex justify-start">
                <p className="text-xs italic text-amber-400">{msg.content}</p>
              </div>
            )
          }

          // AI / employee response — no bubble, full width
          return (
            <div key={msg.id} className="flex justify-start">
              <div className="w-full max-w-[90%]">
                {msg.sender !== 'claude' && (
                  <div className="mb-1.5 flex items-center gap-1.5">
                    <span className={`inline-block rounded bg-gradient-to-br ${getSenderColor(msg.sender)} px-1.5 py-0.5 text-[9px] font-bold text-white`}>
                      {msg.sender}
                    </span>
                  </div>
                )}
                <MarkdownRenderer content={msg.content} />
                {msg.report && (
                  <ReportBadge report={msg.report as unknown as ChatReport} projectId={projectId} sessionId={sessionId} />
                )}
              </div>
            </div>
          )
        })}
        {/* Thinking indicator — dynamic status messages */}
        {(sending || teamProcessing) && (
          <ThinkingIndicator
            mode={teamProcessing ? 'team' : activeMode === 'skill' && activeEmployee ? 'skill' : 'direct'}
            employeeName={activeMode === 'skill' && activeEmployee ? activeEmployee.name : undefined}
          />
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input area with selector — no bg / no border, inherits the chat
          background so the floating card sits directly on the messages area */}
      <div className="relative shrink-0">
        {/* Selector popup — opens ABOVE the input */}
        {showSelector && (
          <div className="absolute bottom-full left-0 right-0 z-10 border-t border-zinc-200 bg-white p-3 shadow-lg">
            {!hasAnyone ? (
              <p className="text-xs text-zinc-500">No employees or teams yet. Go to <strong>My Team</strong> to hire and create teams.</p>
            ) : (
              <>
                <div className="mb-2 flex gap-2">
                  <button
                    onClick={() => setSelectorTab('employees')}
                    className={`rounded px-2 py-1 text-[10px] font-medium ${selectorTab === 'employees' ? 'bg-zinc-800 text-white' : 'bg-zinc-100 text-zinc-600'}`}
                  >
                    Employees
                  </button>
                  <button
                    onClick={() => setSelectorTab('teams')}
                    className={`rounded px-2 py-1 text-[10px] font-medium ${selectorTab === 'teams' ? 'bg-zinc-800 text-white' : 'bg-zinc-100 text-zinc-600'}`}
                  >
                    Teams
                  </button>
                </div>

                {selectorTab === 'employees' && (() => {
                  const filtered = hiredEmployees.filter((e) => !slashFilter || e.name.toLowerCase().includes(slashFilter))
                  return (
                    <div className="flex flex-wrap gap-1.5">
                      {filtered.length === 0 ? (
                        <p className="text-xs text-zinc-400">{hiredEmployees.length === 0 ? 'No employees hired yet.' : 'No match.'}</p>
                      ) : (
                        filtered.map((emp) => (
                          <button
                            key={emp.id}
                            onClick={() => { onSelectEmployee(emp); setShowSelector(false); setInput(''); setSlashFilter('') }}
                            className={`rounded-lg bg-gradient-to-br ${emp.color} px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-transform hover:scale-105`}
                          >
                            {emp.name}
                          </button>
                        ))
                      )}
                    </div>
                  )
                })()}

                {selectorTab === 'teams' && (() => {
                  const filtered = teams.filter((t) => !slashFilter || t.name.toLowerCase().includes(slashFilter))
                  return (
                    <div className="space-y-1.5">
                      {filtered.length === 0 ? (
                        <p className="text-xs text-zinc-400">{teams.length === 0 ? 'No teams created yet.' : 'No match.'}</p>
                      ) : (
                        filtered.map((team) => (
                          <button
                            key={team.id}
                            onClick={() => { onSelectTeam(team); setShowSelector(false); setInput(''); setSlashFilter('') }}
                            className="flex w-full items-center gap-2 rounded-lg bg-zinc-800 px-3 py-2 text-left transition-colors hover:bg-zinc-700"
                          >
                            <span className="text-xs font-semibold text-white">{team.name}</span>
                            <span className="text-[10px] text-zinc-400">{team.order.length} members</span>
                            {!team.hasBuilder && (
                              <span className="rounded bg-amber-500/20 px-1 py-0.5 text-[9px] text-amber-400">no builder</span>
                            )}
                          </button>
                        ))
                      )}
                    </div>
                  )
                })()}
              </>
            )}
          </div>
        )}

        {/* Input area — single floating card (VSCode Claude style) */}
        <form onSubmit={sendMessage} className="shrink-0 px-3 pb-3 pt-1">
          <div
            className="flex flex-col rounded-2xl border border-[#3C3C3C] shadow-xl shadow-black/30 transition-colors focus-within:border-[#505050]"
            style={{ backgroundColor: '#313131' }}
          >
            {/* Attachment previews */}
            {attachments.length > 0 && (
              <div className="flex flex-wrap gap-1.5 px-3 pt-2.5">
                {attachments.map((att, i) => (
                  <div key={i} className="group relative">
                    {att.type === 'image' ? (
                      <img src={att.preview} alt="" className="h-12 w-12 rounded-lg border border-zinc-200 object-cover" />
                    ) : (
                      <div className="flex h-12 items-center rounded-lg border border-zinc-200 bg-zinc-50 px-2">
                        <div>
                          <p className="max-w-[80px] truncate text-[10px] font-medium text-zinc-700">{att.file.name}</p>
                          <p className="text-[9px] text-zinc-400">{att.type === 'pdf' ? 'PDF' : 'Text'}</p>
                        </div>
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => removeAttachment(i)}
                      className="absolute -right-1 -top-1 hidden h-4 w-4 items-center justify-center rounded-full bg-zinc-800 text-white group-hover:flex"
                    >
                      <svg className="h-2.5 w-2.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Active skill/team badge */}
            {activeMode !== 'no_skill' && (
              <div className="flex items-center gap-1.5 px-3 pt-2.5">
                {activeMode === 'skill' && activeEmployee && (
                  <div className="flex items-center gap-1">
                    <span className={`rounded bg-gradient-to-br ${activeEmployee.color} px-2 py-0.5 text-[10px] font-semibold text-white`}>
                      {activeEmployee.name}
                    </span>
                    <button type="button" onClick={onClearSelection} className="text-zinc-400 hover:text-zinc-600">
                      <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                )}
                {activeMode === 'team' && activeTeam && (
                  <div className="flex items-center gap-1">
                    <span className="rounded bg-zinc-800 px-2 py-0.5 text-[10px] font-semibold text-white">
                      {activeTeam.name}
                    </span>
                    <button type="button" onClick={onClearSelection} className="text-zinc-400 hover:text-zinc-600">
                      <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Hunk attachment chips — compact pills that wrap across rows
                so multiple can be stacked before sending. Each has its own ×
                to remove. Clicking outside a chip does nothing — send clears
                them all. */}
            {hunkAttachments.length > 0 && (
              <div className="flex flex-wrap gap-1.5 border-b border-[#3C3C3C] px-3 py-2">
                {hunkAttachments.map((att, i) => {
                  const fileName = att.filePath.split('/').pop() ?? att.filePath
                  return (
                    <div
                      key={`${att.filePath}:${att.focusStart}-${att.focusEnd}:${i}`}
                      className="flex min-w-0 max-w-[220px] items-center gap-1.5 rounded-md border border-white/10 px-1.5 py-1"
                      style={{ backgroundColor: '#2A2A2A' }}
                      title={`${att.filePath} · ${att.lineRange}`}
                    >
                      <svg className="h-3 w-3 shrink-0 text-zinc-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M18.375 12.739l-7.693 7.693a4.5 4.5 0 01-6.364-6.364l10.94-10.94A3 3 0 1119.5 7.372L8.552 18.32m.009-.01l-.01.01m5.699-9.941l-7.81 7.81a1.5 1.5 0 002.112 2.13" />
                      </svg>
                      <span className="truncate text-[11px] font-medium text-zinc-200">{fileName}</span>
                      <span className="shrink-0 text-[10px] text-zinc-500">{att.lineRange.replace('line ', 'L').replace('lines ', 'L')}</span>
                      <button
                        type="button"
                        onClick={() => onClearHunkAttachment(i)}
                        className="shrink-0 text-zinc-500 hover:text-zinc-200"
                        title="Remove"
                      >
                        <svg className="h-2.5 w-2.5" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  )
                })}
              </div>
            )}

            {/* Textarea row */}
            <div className="px-3 pt-3">
              <textarea
                value={input}
                onChange={(e) => {
                  setInput(e.target.value)
                  // Auto-resize
                  e.target.style.height = 'auto'
                  const maxHeight = 36 * 4 // 4x the base line height
                  e.target.style.height = Math.min(e.target.scrollHeight, maxHeight) + 'px'
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    sendMessage(e)
                  }
                }}
                placeholder={activeMode === 'team' ? `Message ${activeTeam?.name ?? 'team'}...` : activeMode === 'skill' ? `Message ${activeEmployee?.name ?? 'employee'}...` : 'Message Claude...'}
                disabled={sending || teamProcessing}
                rows={1}
                className="w-full resize-none bg-transparent text-sm text-zinc-200 placeholder-zinc-500 outline-none disabled:opacity-50"
                style={{ maxHeight: `${36 * 4}px` }}
              />
            </div>

            {/* Context badges */}
            {contextPaths.length > 0 && (
              <div className="flex flex-wrap gap-1.5 px-3 pt-1.5">
                {contextPaths.map((path, i) => (
                  <div key={i} className="flex items-center gap-1 rounded bg-blue-50 px-2 py-0.5 text-[10px] text-blue-700">
                    <svg className="h-3 w-3 text-blue-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
                    </svg>
                    <span className="font-medium">{path}</span>
                    <button type="button" onClick={() => setContextPaths((prev) => prev.filter((_, j) => j !== i))} className="text-blue-400 hover:text-blue-600">
                      <svg className="h-2.5 w-2.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Bottom toolbar — inside the card, all controls + submit */}
            <div className="relative flex items-center gap-1 px-2 py-2">
            <button
              type="button"
              onClick={() => setShowToolbarMenu(!showToolbarMenu)}
              title="More options"
              className="flex h-6 w-6 items-center justify-center rounded text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-200"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
            </button>
            {/* Slash command button (moved here from next to the textarea) */}
            <button
              type="button"
              onClick={() => { setShowSelector(!showSelector); setOpenedViaButton(!showSelector) }}
              title="Select employee / team"
              className="flex h-6 w-6 items-center justify-center rounded text-[11px] font-bold text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-200"
            >
              /
            </button>

            {/* Toolbar popup menu */}
            {showToolbarMenu && (
              <div className="absolute bottom-full left-2 z-20 mb-1 w-48 rounded-lg border border-[#2B2B2B] py-1 shadow-lg" style={{ backgroundColor: '#313131' }}>
                <button
                  type="button"
                  onClick={() => { fileInputRef.current?.click(); setShowToolbarMenu(false) }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-zinc-300 hover:bg-white/5"
                >
                  <svg className="h-3.5 w-3.5 text-zinc-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M18.375 12.739l-7.693 7.693a4.5 4.5 0 01-6.364-6.364l10.94-10.94A3 3 0 1119.5 7.372L8.552 18.32m.009-.01l-.01.01m5.699-9.941l-7.81 7.81a1.5 1.5 0 002.112 2.13" />
                  </svg>
                  Attach file
                </button>
                <button
                  type="button"
                  onClick={() => { setShowToolbarMenu(false); setShowContextPicker(true) }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-zinc-300 hover:bg-white/5"
                >
                  <svg className="h-3.5 w-3.5 text-zinc-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
                  </svg>
                  Add context
                </button>
                <div className="my-1 border-t border-[#2B2B2B]" />
                <button
                  type="button"
                  onClick={() => { setShowToolbarMenu(false); setShowClearConfirm(true) }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-red-400 hover:bg-red-500/10"
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                  </svg>
                  Clear conversation
                </button>
              </div>
            )}

            {/* Spacer */}
            <div className="flex-1" />

            {/* Reminder button */}
            <button
              type="button"
              onClick={() => setShowReminderModal(true)}
              title="Create reminder"
              className="flex h-6 w-6 items-center justify-center rounded text-amber-400 transition-colors hover:bg-amber-500/10 hover:text-amber-300"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" />
              </svg>
            </button>

            {/* Context usage circle */}
            <div
              className="relative"
              onMouseEnter={() => setShowContextTooltip(true)}
              onMouseLeave={() => setShowContextTooltip(false)}
            >
              <button
                type="button"
                onClick={handleCompact}
                disabled={compacting}
                className="flex h-6 w-6 items-center justify-center"
                title={`${contextPercentage}% context used`}
              >
                <svg className="h-5 w-5" viewBox="0 0 36 36">
                  {/* Background circle */}
                  <circle cx="18" cy="18" r="15" fill="none" stroke="#e4e4e7" strokeWidth="3" />
                  {/* Progress circle */}
                  <circle
                    cx="18" cy="18" r="15"
                    fill="none"
                    stroke={contextPercentage > 90 ? '#ef4444' : '#D97757'}
                    strokeWidth="3"
                    strokeDasharray={`${contextPercentage * 0.94} 94`}
                    strokeLinecap="round"
                    transform="rotate(-90 18 18)"
                  />
                </svg>
              </button>

              {showContextTooltip && (
                <div className="absolute bottom-full right-0 z-20 mb-1 w-44 rounded-lg border border-zinc-200 bg-white px-3 py-2 shadow-lg">
                  <p className="text-[10px] font-medium text-zinc-700">{contextPercentage}% context used</p>
                  <p className="mt-0.5 text-[9px] text-zinc-400">
                    {compacting ? 'Compacting...' : 'Click to compact context now'}
                  </p>
                </div>
              )}
            </div>

            {/* Model selector */}
            <select
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              className="rounded border border-[#2B2B2B] bg-white/5 px-1.5 py-0.5 text-[10px] text-zinc-300 outline-none hover:bg-white/10"
            >
              <option value="haiku">Haiku 4.5</option>
              <option value="sonnet">Sonnet 4</option>
              <option value="opus">Opus 4</option>
            </select>

            {/* Thinking selector */}
            <select
              value={thinkingLevel}
              onChange={(e) => setThinkingLevel(e.target.value)}
              className="rounded border border-[#2B2B2B] bg-white/5 px-1.5 py-0.5 text-[10px] text-zinc-300 outline-none hover:bg-white/10"
            >
              <option value="off">Thinking: Off</option>
              <option value="low">Thinking: Low</option>
              <option value="medium">Thinking: Medium</option>
              <option value="high">Thinking: High</option>
            </select>

            {/* Mode selector */}
            <select
              value={permissionMode}
              onChange={(e) => setPermissionMode(e.target.value as 'leitura' | 'planejamento' | 'edicao')}
              className="rounded border border-[#2B2B2B] bg-white/5 px-1.5 py-0.5 text-[10px] text-zinc-300 outline-none hover:bg-white/10"
            >
              <option value="leitura">Ask</option>
              <option value="planejamento">Plan</option>
              <option value="edicao">Agent</option>
            </select>

            {/* Submit / stop button — inside the card, rightmost */}
            {(sending || teamProcessing) ? (
              <button
                type="button"
                onClick={() => {
                  if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null }
                  setTeamProcessing(false)
                  setSending(false)
                }}
                title="Stop"
                className="ml-1 flex h-7 w-7 items-center justify-center rounded-lg bg-white text-zinc-900 transition-colors hover:bg-zinc-200"
              >
                <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 24 24">
                  <rect x="6" y="6" width="12" height="12" rx="2" />
                </svg>
              </button>
            ) : (
              <button
                type="submit"
                disabled={!input.trim() && attachments.length === 0}
                title="Send"
                className="ml-1 flex h-7 w-7 items-center justify-center rounded-lg bg-white text-zinc-900 transition-colors hover:bg-zinc-200 disabled:opacity-30"
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 10.5L12 3m0 0l7.5 7.5M12 3v18" />
                </svg>
              </button>
            )}

            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,.txt,.md,.csv,.json,.ts,.tsx,.js,.jsx,.py,.html,.css,.yml,.yaml,.xml,.sql,.sh"
              onChange={(e) => { if (e.target.files) handleFiles(e.target.files); e.target.value = '' }}
              className="hidden"
            />
            </div>
          </div>

          {/* Context picker modal */}
          {showContextPicker && (
            <ContextPicker
              projectId={projectId}
              onSelect={(path: string) => { setContextPaths((prev: string[]) => [...prev, path]); setShowContextPicker(false) }}
              onClose={() => setShowContextPicker(false)}
            />
          )}
        </form>

        {/* Clear conversation confirmation */}
        {showClearConfirm && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
            <div className="w-full max-w-sm rounded-xl border border-[#2B2B2B] p-6 shadow-xl" style={{ backgroundColor: '#181818' }}>
              <h3 className="text-sm font-semibold text-zinc-100">Clear conversation?</h3>
              <p className="mt-1 text-xs text-zinc-400">
                This will start a fresh conversation. The current chat history will be saved but no longer visible here.
              </p>
              <div className="mt-4 flex gap-2">
                <button
                  onClick={() => { setShowClearConfirm(false); handleClearConversation() }}
                  className="flex h-8 flex-1 items-center justify-center rounded-lg bg-red-600 text-xs font-medium text-white hover:bg-red-700"
                >
                  Clear
                </button>
                <button
                  onClick={() => setShowClearConfirm(false)}
                  className="flex h-8 flex-1 items-center justify-center rounded-lg text-xs text-zinc-400 hover:text-zinc-200"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Reminder modal */}
        {showReminderModal && (
          <ReminderModal
            projectId={projectId}
            onClose={() => setShowReminderModal(false)}
          />
        )}
      </div>
    </div>
  )
}

interface ChatReplyRaw {
  id: string
  content: string
  sender: string
  mode: string
  activeSkillId: string | null
}

// ── Changes Review Modal ──────────────────────────────────────────────────

// Diff chunk: a group of consecutive changed lines with context
interface DiffChunk {
  startLineOrig: number
  startLineCurr: number
  lines: { type: 'context' | 'added' | 'removed'; lineNumOrig?: number; lineNumCurr?: number; text: string }[]
}

function computeChunks(originalLines: string[], currentLines: string[], contextSize: number = 3): DiffChunk[] {
  // Find changed line indices
  const maxLen = Math.max(originalLines.length, currentLines.length)
  const changedIndices: number[] = []
  for (let i = 0; i < maxLen; i++) {
    const o = i < originalLines.length ? originalLines[i] : undefined
    const c = i < currentLines.length ? currentLines[i] : undefined
    if (o !== c) changedIndices.push(i)
  }

  if (changedIndices.length === 0) return []

  // Group into ranges with context
  const ranges: { start: number; end: number }[] = []
  let rangeStart = changedIndices[0]
  let rangeEnd = changedIndices[0]

  for (let i = 1; i < changedIndices.length; i++) {
    if (changedIndices[i] <= rangeEnd + contextSize * 2 + 1) {
      rangeEnd = changedIndices[i]
    } else {
      ranges.push({ start: rangeStart, end: rangeEnd })
      rangeStart = changedIndices[i]
      rangeEnd = changedIndices[i]
    }
  }
  ranges.push({ start: rangeStart, end: rangeEnd })

  // Build chunks
  return ranges.map((range) => {
    const chunkStart = Math.max(0, range.start - contextSize)
    const chunkEnd = Math.min(maxLen - 1, range.end + contextSize)
    const lines: DiffChunk['lines'] = []

    for (let i = chunkStart; i <= chunkEnd; i++) {
      const origLine = i < originalLines.length ? originalLines[i] : undefined
      const currLine = i < currentLines.length ? currentLines[i] : undefined

      if (origLine === currLine) {
        lines.push({ type: 'context', lineNumOrig: i + 1, lineNumCurr: i + 1, text: origLine ?? '' })
      } else {
        if (origLine !== undefined) {
          lines.push({ type: 'removed', lineNumOrig: i + 1, text: origLine })
        }
        if (currLine !== undefined) {
          lines.push({ type: 'added', lineNumCurr: i + 1, text: currLine })
        }
      }
    }

    return { startLineOrig: chunkStart + 1, startLineCurr: chunkStart + 1, lines }
  })
}

interface ReviewFileInfo {
  path: string
  type: 'modified' | 'renamed' | 'new' | 'deleted'
  oldPath?: string // for renames
  isNew: boolean
}

function ChangesReviewModal({
  projectId,
  files,
  initialFile,
  onAccept,
  onRevert,
  onClose,
}: {
  projectId: string
  files: FileEntry[]
  initialFile: string | null
  onAccept: (path: string) => void
  onRevert: (path: string) => void
  onClose: () => void
}) {
  const [reviewFiles, setReviewFiles] = useState<ReviewFileInfo[]>([])
  const [activeFile, setActiveFile] = useState<string | null>(initialFile)
  const [diffData, setDiffData] = useState<{ original: string; current: string } | null>(null)
  const [loadingDiff, setLoadingDiff] = useState(false)

  // Detect renames: new file with same content as a deleted original
  useEffect(() => {
    async function detectRenames() {
      const fileDetails = await Promise.all(
        files.map(async (f) => {
          try {
            const res = await fetch(`/api/projects/${projectId}/repository/files/${encodeURIComponent(f.path)}`)
            const data = await res.json()
            return { ...f, content: data.content ?? '', originalContent: data.originalContent ?? '' }
          } catch {
            return { ...f, content: '', originalContent: '' }
          }
        })
      )

      const result: ReviewFileInfo[] = []
      const matched = new Set<string>()

      // ── Detect renames/moves ──
      // Strategy: compare every pair of modified files.
      // If file A's content === file B's originalContent (or vice versa),
      // and they have different paths, one was moved to the other.
      // Also: if content === originalContent but path changed (move without edit),
      // we detect by checking if two files share identical content and one is "new".

      // Case 1: New file (empty originalContent) with content matching another file's originalContent
      const newFiles = fileDetails.filter((f) => f.originalContent === '' && f.isNew)
      const existingFiles = fileDetails.filter((f) => f.originalContent !== '')

      for (const nf of newFiles) {
        if (matched.has(nf.path)) continue
        const match = existingFiles.find(
          (ef) => !matched.has(ef.path) && ef.originalContent === nf.content
        )
        if (match) {
          // nf is the new location, match is the old location
          result.push({ path: nf.path, type: 'renamed', oldPath: match.path, isNew: false })
          matched.add(nf.path)
          matched.add(match.path)
          continue
        }
      }

      // Case 2: Two modified files where content is identical but paths differ
      // (file was moved: old path has originalContent restored or different, new path has the content)
      for (let i = 0; i < fileDetails.length; i++) {
        const a = fileDetails[i]
        if (matched.has(a.path)) continue
        for (let j = i + 1; j < fileDetails.length; j++) {
          const b = fileDetails[j]
          if (matched.has(b.path)) continue
          // Same content, different paths, and one of them has content === the other's original
          if (a.content === b.originalContent && a.originalContent === '' && a.path !== b.path) {
            result.push({ path: a.path, type: 'renamed', oldPath: b.path, isNew: false })
            matched.add(a.path)
            matched.add(b.path)
          } else if (b.content === a.originalContent && b.originalContent === '' && a.path !== b.path) {
            result.push({ path: b.path, type: 'renamed', oldPath: a.path, isNew: false })
            matched.add(a.path)
            matched.add(b.path)
          }
          // Both modified, same content in both, different originalContent (moved + both tracked)
          else if (a.content === b.content && a.content !== a.originalContent && b.content !== b.originalContent && a.path !== b.path) {
            // The one whose originalContent matches the shared content is the "old" location
            if (a.originalContent === a.content) {
              result.push({ path: b.path, type: 'renamed', oldPath: a.path, isNew: false })
            } else {
              result.push({ path: a.path, type: 'renamed', oldPath: b.path, isNew: false })
            }
            matched.add(a.path)
            matched.add(b.path)
          }
        }
      }

      // Add remaining unmatched files
      for (const f of fileDetails) {
        if (matched.has(f.path)) continue
        if (f.content === f.originalContent) {
          // No actual content change — skip (shouldn't be isModified, but just in case)
          continue
        }
        if (f.isNew && f.originalContent === '') {
          result.push({ path: f.path, type: 'new', isNew: true })
        } else {
          result.push({ path: f.path, type: 'modified', isNew: false })
        }
      }

      setReviewFiles(result)
      if (!initialFile && result.length > 0) setActiveFile(result[0].path)
    }
    detectRenames()
  }, [files, projectId, initialFile])

  // Load diff for active file
  useEffect(() => {
    if (!activeFile) return
    setLoadingDiff(true)
    fetch(`/api/projects/${projectId}/repository/files/${encodeURIComponent(activeFile)}`)
      .then((r) => r.json())
      .then((data) => {
        setDiffData({ original: data.originalContent ?? '', current: data.content ?? '' })
        setLoadingDiff(false)
      })
      .catch(() => setLoadingDiff(false))
  }, [activeFile, projectId])

  const activeInfo = reviewFiles.find((f) => f.path === activeFile)
  const originalLines = diffData?.original.split('\n') ?? []
  const currentLines = diffData?.current.split('\n') ?? []
  const isRenamed = activeInfo?.type === 'renamed'
  const isSameContent = diffData?.original === diffData?.current
  const chunks = diffData && !isSameContent ? computeChunks(originalLines, currentLines) : []

  // Stats
  const addedCount = chunks.reduce((sum, c) => sum + c.lines.filter((l) => l.type === 'added').length, 0)
  const removedCount = chunks.reduce((sum, c) => sum + c.lines.filter((l) => l.type === 'removed').length, 0)

  function handleAction(action: 'accept' | 'revert') {
    if (!activeFile) return
    if (action === 'accept') onAccept(activeFile)
    else onRevert(activeFile)
    const remaining = reviewFiles.filter((f) => f.path !== activeFile)
    if (remaining.length > 0) {
      setActiveFile(remaining[0].path)
      setReviewFiles(remaining)
    } else {
      onClose()
    }
  }

  const TYPE_LABELS: Record<string, { badge: string; color: string }> = {
    modified: { badge: 'M', color: 'text-amber-400' },
    renamed: { badge: 'R', color: 'text-blue-400' },
    new: { badge: 'U', color: 'text-emerald-400' },
    deleted: { badge: 'D', color: 'text-red-400' },
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={onClose}>
      <div
        className="flex h-[85vh] w-[90vw] max-w-6xl flex-col overflow-hidden rounded-2xl border border-[#2B2B2B] shadow-2xl"
        style={{ backgroundColor: '#181818' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-[#2B2B2B] px-5 py-3" style={{ backgroundColor: '#1F1F1F' }}>
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold text-zinc-100">Review Changes</h2>
            <span className="rounded bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-400">{reviewFiles.length} file{reviewFiles.length !== 1 ? 's' : ''}</span>
          </div>
          <button onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 hover:bg-white/5 hover:text-zinc-300">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex flex-1 overflow-hidden">
          {/* File sidebar */}
          <div className="w-56 shrink-0 overflow-y-auto border-r border-[#2B2B2B]" style={{ backgroundColor: '#1F1F1F' }}>
            {reviewFiles.map((f) => {
              const name = f.path.split('/').pop() ?? f.path
              const isActive = activeFile === f.path
              const label = TYPE_LABELS[f.type] ?? TYPE_LABELS.modified
              return (
                <button
                  key={f.path}
                  onClick={() => setActiveFile(f.path)}
                  className={`flex w-full items-center gap-2 px-3 py-2 text-left transition-all ${
                    isActive ? 'bg-white/10 border-l-2 border-violet-500' : 'hover:bg-white/5 border-l-2 border-transparent'
                  }`}
                >
                  <span className={`text-[10px] font-mono font-bold ${label.color}`}>{label.badge}</span>
                  <div className="min-w-0 flex-1">
                    <p className={`text-[11px] truncate ${isActive ? 'text-zinc-200' : 'text-zinc-400'}`}>{name}</p>
                    {f.type === 'renamed' && f.oldPath && (
                      <p className="text-[8px] text-blue-400 truncate">{f.oldPath.split('/').slice(0, -1).join('/')} →</p>
                    )}
                    <p className="text-[8px] text-zinc-600 truncate">{f.path}</p>
                  </div>
                </button>
              )
            })}
          </div>

          {/* Diff view */}
          <div className="flex flex-1 flex-col overflow-hidden">
            {/* Diff header */}
            {activeFile && activeInfo && (
              <div className="flex shrink-0 items-center justify-between border-b border-[#2B2B2B] px-4 py-2" style={{ backgroundColor: '#313131' }}>
                <div className="flex items-center gap-3">
                  {isRenamed && activeInfo.oldPath ? (
                    <span className="text-[11px] text-blue-400">
                      {activeInfo.oldPath} → {activeFile}
                    </span>
                  ) : (
                    <span className="text-[11px] text-zinc-400">{activeFile}</span>
                  )}
                  {!isSameContent && (
                    <div className="flex items-center gap-1.5">
                      {addedCount > 0 && <span className="text-[10px] text-emerald-400">+{addedCount}</span>}
                      {removedCount > 0 && <span className="text-[10px] text-red-400">-{removedCount}</span>}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => handleAction('accept')} className="flex h-7 items-center gap-1 rounded-lg bg-emerald-500/10 px-2.5 text-[10px] font-medium text-emerald-400 hover:bg-emerald-500/20">
                    <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
                    Accept
                  </button>
                  <button onClick={() => handleAction('revert')} className="flex h-7 items-center gap-1 rounded-lg bg-red-500/10 px-2.5 text-[10px] font-medium text-red-400 hover:bg-red-500/20">
                    <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3" /></svg>
                    Revert
                  </button>
                </div>
              </div>
            )}

            {/* Diff content */}
            <div className="flex-1 overflow-auto">
              {loadingDiff ? (
                <div className="flex h-full items-center justify-center">
                  <p className="text-xs text-zinc-500">Loading diff...</p>
                </div>
              ) : !diffData ? (
                <div className="flex h-full items-center justify-center">
                  <p className="text-xs text-zinc-500">Select a file to review</p>
                </div>
              ) : isRenamed && isSameContent ? (
                /* Renamed file — no content changes */
                <div className="flex h-full flex-col items-center justify-center gap-3">
                  <svg className="h-8 w-8 text-blue-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
                  </svg>
                  <div className="text-center">
                    <p className="text-sm font-medium text-blue-300">File Renamed</p>
                    <p className="mt-1 text-[11px] text-zinc-500">{activeInfo?.oldPath}</p>
                    <p className="text-[11px] text-zinc-400">↓</p>
                    <p className="text-[11px] text-blue-400">{activeFile}</p>
                    <p className="mt-2 text-[10px] text-zinc-600">No content changes</p>
                  </div>
                </div>
              ) : isSameContent ? (
                <div className="flex h-full items-center justify-center">
                  <p className="text-xs text-zinc-500">No content changes</p>
                </div>
              ) : (
                /* Chunk-based unified diff */
                <div className="font-mono text-[11px]">
                  {chunks.map((chunk, ci) => (
                    <div key={ci} className={ci > 0 ? 'border-t border-dashed border-[#2B2B2B] mt-1 pt-1' : ''}>
                      {/* Chunk header */}
                      <div className="sticky top-0 z-10 flex items-center gap-2 px-3 py-1" style={{ backgroundColor: '#313131' }}>
                        <span className="text-[9px] text-zinc-600">@@ Line {chunk.startLineOrig} @@</span>
                      </div>
                      {/* Lines */}
                      {chunk.lines.map((line, li) => (
                        <div
                          key={li}
                          className={`flex ${
                            line.type === 'removed' ? 'bg-red-500/10' :
                            line.type === 'added' ? 'bg-emerald-500/10' : ''
                          }`}
                        >
                          <span className={`w-10 shrink-0 select-none pr-2 text-right ${
                            line.type === 'removed' ? 'text-red-400/60' :
                            line.type === 'added' ? 'text-emerald-400/60' : 'text-zinc-600'
                          }`}>
                            {line.lineNumOrig ?? ''}
                          </span>
                          <span className={`w-10 shrink-0 select-none pr-2 text-right ${
                            line.type === 'removed' ? 'text-red-400/60' :
                            line.type === 'added' ? 'text-emerald-400/60' : 'text-zinc-600'
                          }`}>
                            {line.lineNumCurr ?? ''}
                          </span>
                          <span className={`w-4 shrink-0 text-center ${
                            line.type === 'removed' ? 'text-red-400' :
                            line.type === 'added' ? 'text-emerald-400' : 'text-zinc-700'
                          }`}>
                            {line.type === 'removed' ? '-' : line.type === 'added' ? '+' : ' '}
                          </span>
                          <span className={`whitespace-pre px-2 ${
                            line.type === 'removed' ? 'text-red-300' :
                            line.type === 'added' ? 'text-emerald-300' : 'text-zinc-500'
                          }`}>
                            {line.text || ' '}
                          </span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Reminder Modal ────────────────────────────────────────────────────────

function ReminderModal({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [text, setText] = useState('')
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState(false)

  async function handleCreate() {
    if (!text.trim() || creating) return
    setCreating(true)
    try {
      const res = await fetch(`/api/projects/${projectId}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: text.trim().length > 80 ? text.trim().slice(0, 80) + '...' : text.trim(),
          instruction: text.trim(),
          context: { source: 'reminder' },
        }),
      })
      if (res.ok) {
        setCreated(true)
        setTimeout(onClose, 1200)
      }
    } catch { /* ignore */ }
    setCreating(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-full max-w-sm overflow-hidden rounded-xl border border-[#2B2B2B] shadow-xl"
        style={{ backgroundColor: '#181818' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-[#2B2B2B] px-5 py-3" style={{ backgroundColor: '#1F1F1F' }}>
          <h3 className="text-sm font-semibold text-zinc-100">Create Reminder</h3>
          <p className="text-[11px] text-zinc-500">A simple note — goes to Pending in Tasks.</p>
        </div>
        <div className="p-5">
          {created ? (
            <div className="flex items-center gap-2 text-sm text-emerald-400">
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
              </svg>
              Reminder created — find it in Tasks.
            </div>
          ) : (
            <>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="What do you want to remember?"
                rows={3}
                autoFocus
                className="w-full rounded-lg border border-[#2B2B2B] bg-white/5 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:border-white/30 focus:outline-none"
              />
              <div className="mt-3 flex gap-2">
                <button
                  onClick={handleCreate}
                  disabled={!text.trim() || creating}
                  className="flex h-8 flex-1 items-center justify-center rounded-lg bg-white text-xs font-medium text-white transition-colors hover:bg-violet-500 disabled:opacity-30"
                >
                  {creating ? 'Creating...' : 'Create'}
                </button>
                <button
                  onClick={onClose}
                  className="flex h-8 items-center justify-center rounded-lg px-4 text-xs text-zinc-400 hover:text-zinc-200"
                >
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Terminal Body ──────────────────────────────────────────────────────────

function TerminalBody({ projectId, sessionId, worktreeId }: { projectId: string; sessionId?: string | null; worktreeId?: string | null }) {
  const [sandboxStatus, setSandboxStatus] = useState<'disconnected' | 'starting' | 'running'>('disconnected')
  const [history, setHistory] = useState<{ type: 'input' | 'stdout' | 'stderr' | 'system'; text: string }[]>([])
  const [input, setInput] = useState('')
  const [commandHistory, setCommandHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [history.length])

  // Reset terminal when context changes
  const contextKey = worktreeId ?? sessionId ?? projectId
  useEffect(() => {
    setHistory([])
    setInput('')
    setCommandHistory([])
    setHistoryIndex(-1)
  }, [contextKey])

  // Auto-start on mount or context change
  useEffect(() => {
    let mounted = true

    async function autoStart() {
      setSandboxStatus('starting')
      setHistory([{ type: 'system', text: 'Connecting to sandbox...' }])
      try {
        // Check if already running
        const checkRes = await fetch(`/api/projects/${projectId}/terminal`)
        const checkData = await checkRes.json()

        if (checkData.status === 'running' && checkData.sandboxId) {
          if (mounted) {
            setSandboxStatus('running')
            setHistory([{ type: 'system', text: `Connected to sandbox ${checkData.sandboxId.slice(0, 8)}... (${checkData.repo})` }])
            inputRef.current?.focus()
          }
          return
        }

        // Start new sandbox
        if (mounted) setHistory((prev) => [...prev, { type: 'system', text: 'Starting sandbox...' }])
        const res = await fetch(`/api/projects/${projectId}/terminal`, { method: 'POST' })
        const data = await res.json()

        if (mounted) {
          if (data.sandboxId) {
            setSandboxStatus('running')
            setHistory((prev) => [...prev, { type: 'system', text: `Sandbox ready. ID: ${data.sandboxId.slice(0, 8)}...` }])
            inputRef.current?.focus()
          } else {
            setSandboxStatus('disconnected')
            setHistory((prev) => [...prev, { type: 'stderr', text: data.error || 'Failed to start' }])
          }
        }
      } catch {
        if (mounted) {
          setSandboxStatus('disconnected')
          setHistory((prev) => [...prev, { type: 'stderr', text: 'Failed to connect' }])
        }
      }
    }

    autoStart()

    return () => {
      mounted = false
      // Don't stop sandbox on terminal close — idle timer (15 min) handles it
      // This way tasks can still use the container after terminal closes
    }
  }, [projectId, contextKey])

  async function handleStart() {
    setSandboxStatus('starting')
    setHistory([{ type: 'system', text: 'Starting sandbox...' }])
    try {
      const res = await fetch(`/api/projects/${projectId}/terminal`, { method: 'POST' })
      const data = await res.json()
      if (data.sandboxId) {
        setSandboxStatus('running')
        setHistory((prev) => [...prev, { type: 'system', text: `Sandbox ready. ID: ${data.sandboxId.slice(0, 8)}...` }])
        inputRef.current?.focus()
      } else {
        setSandboxStatus('disconnected')
        setHistory((prev) => [...prev, { type: 'stderr', text: data.error || 'Failed to start sandbox' }])
      }
    } catch {
      setSandboxStatus('disconnected')
      setHistory((prev) => [...prev, { type: 'stderr', text: 'Failed to connect' }])
    }
  }

  async function handleExec(cmd: string) {
    if (!cmd.trim()) return
    setHistory((prev) => [...prev, { type: 'input', text: cmd }])
    setCommandHistory((prev) => [cmd, ...prev])
    setHistoryIndex(-1)
    setInput('')

    try {
      const execParams = new URLSearchParams()
      if (worktreeId) execParams.set('worktree', worktreeId)
      else if (sessionId) execParams.set('session', sessionId)
      const execUrl = `/api/projects/${projectId}/terminal/exec${execParams.toString() ? `?${execParams}` : ''}`
      const res = await fetch(execUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: cmd }),
      })
      const data = await res.json()

      if (data.error) {
        setHistory((prev) => [...prev, { type: 'stderr', text: data.error }])
      } else {
        if (data.stdout) setHistory((prev) => [...prev, { type: 'stdout', text: data.stdout }])
        if (data.stderr) setHistory((prev) => [...prev, { type: 'stderr', text: data.stderr }])
        if (!data.stdout && !data.stderr) setHistory((prev) => [...prev, { type: 'system', text: `(exit code: ${data.exitCode})` }])
      }
    } catch (err) {
      setHistory((prev) => [...prev, { type: 'stderr', text: `Error: ${err instanceof Error ? err.message : 'Request failed'}` }])
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      handleExec(input)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (commandHistory.length > 0) {
        const newIndex = Math.min(historyIndex + 1, commandHistory.length - 1)
        setHistoryIndex(newIndex)
        setInput(commandHistory[newIndex])
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (historyIndex > 0) {
        const newIndex = historyIndex - 1
        setHistoryIndex(newIndex)
        setInput(commandHistory[newIndex])
      } else {
        setHistoryIndex(-1)
        setInput('')
      }
    }
  }

  if (sandboxStatus === 'disconnected') {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6">
        <p className="text-[11px] text-zinc-500">No sandbox running</p>
        <button
          onClick={handleStart}
          className="flex h-8 items-center gap-2 rounded-lg bg-emerald-600 px-4 text-[11px] font-medium text-white transition-colors hover:bg-emerald-500"
        >
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.348a1.125 1.125 0 010 1.971l-11.54 6.347a1.125 1.125 0 01-1.667-.985V5.653z" />
          </svg>
          Start Sandbox
        </button>
      </div>
    )
  }

  if (sandboxStatus === 'starting') {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 p-6">
        <svg className="h-4 w-4 animate-spin text-emerald-400" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        <span className="text-[11px] text-zinc-400">Starting sandbox...</span>
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden" onClick={() => inputRef.current?.focus()}>
      <div ref={scrollRef} className="flex-1 overflow-auto p-3 font-mono text-[12px] leading-5">
        {history.map((entry, i) => (
          <div key={i}>
            {entry.type === 'input' && (
              <div className="text-zinc-400">
                <span className="text-emerald-400">bornastar</span>
                <span className="text-zinc-600">:</span>
                <span className="text-sky-400">~/project</span>
                <span className="text-zinc-600">$ </span>
                <span className="text-zinc-200">{entry.text}</span>
              </div>
            )}
            {entry.type === 'stdout' && (
              <pre className="whitespace-pre-wrap text-zinc-300">{entry.text}</pre>
            )}
            {entry.type === 'stderr' && (
              <pre className="whitespace-pre-wrap text-red-400">{entry.text}</pre>
            )}
            {entry.type === 'system' && (
              <div className="text-zinc-600 italic">{entry.text}</div>
            )}
          </div>
        ))}
        {/* Active prompt */}
        <div className="flex items-center text-zinc-400">
          <span className="text-emerald-400">bornastar</span>
          <span className="text-zinc-600">:</span>
          <span className="text-sky-400">~/project</span>
          <span className="text-zinc-600">$ </span>
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            className="flex-1 bg-transparent text-zinc-200 outline-none caret-emerald-400"
            autoFocus
            spellCheck={false}
          />
        </div>
      </div>
    </div>
  )
}

// ── Mini Map (right panel) ─────────────────────────────────────────────────

interface EtapaPlan {
  name: string
  objective: string
  members: string[]
}

interface EtapaState {
  name: string
  objective: string
  members: { name: string; status: 'pending' | 'active' | 'done' | 'recreated'; redirectedTo?: string }[]
  status: 'pending' | 'active' | 'done'
}

function MiniMap({
  projectId,
  activeMode,
  activeEmployee,
  activeTeam,
  messages,
  hiredEmployees,
  teamRunState,
  teamRunActive,
}: {
  projectId: string
  activeMode: ChatMode
  activeEmployee?: HiredEmployee
  activeTeam?: TeamInfo
  messages: Message[]
  hiredEmployees: HiredEmployee[]
  teamRunState: unknown
  teamRunActive: boolean
}) {
  // Poll for running task
  const [runningTask, setRunningTask] = useState<{ id: string; name: string; executorType: string; pausedAtEmployee: string | null; accumulatedContext: { model?: string; intent?: string } } | null>(null)
  const [taskLogs, setTaskLogs] = useState<{ id: string; collaboratorName: string; conclusion: string | null; approved: boolean | null; finishedAt: string | null }[]>([])
  const [taskBuildLogs, setTaskBuildLogs] = useState<{ filesTouched: { path: string }[] }[]>([])
  const [lastCompletedTask, setLastCompletedTask] = useState<{ name: string; completedAt: string; intent?: string } | null>(null)
  const [showLastTask, setShowLastTask] = useState(true)

  useEffect(() => {
    // Fetch last completed task
    fetch(`/api/projects/${projectId}/tasks?status=completed&limit=1`)
      .then((r) => r.json())
      .then((data) => {
        const tasks = data.tasks ?? data ?? []
        if (tasks.length > 0) {
          const t = tasks[0]
          setLastCompletedTask({
            name: t.name,
            completedAt: t.updatedAt ?? t.createdAt,
            intent: t.accumulatedContext?.intent,
          })
        }
      })
      .catch(() => {})
  }, [projectId])

  useEffect(() => {
    function pollTask() {
      fetch(`/api/projects/${projectId}/tasks/running`)
        .then((r) => r.json())
        .then((data) => {
          setRunningTask(data.task ?? null)
          setTaskLogs(data.logs ?? [])
          setTaskBuildLogs(data.buildLogs ?? [])
        })
        .catch(() => {})
    }
    pollTask()
    const interval = setInterval(pollTask, 4000)
    return () => clearInterval(interval)
  }, [projectId])

  const hasRunningTask = !!runningTask
  function getColor(name: string): string {
    const emp = hiredEmployees.find((e) => e.name === name)
    if (emp) return emp.color
    if (name === 'Builder') return 'from-red-600 to-red-700'
    return 'from-zinc-500 to-zinc-600'
  }

  // Build etapas state from TeamRun DB state (persisted) or from messages (live)
  function buildEtapasFromMessages(): EtapaState[] {
    // First try to use the persisted TeamRun state (survives page reload)
    if (teamRunState && Array.isArray(teamRunState) && teamRunState.length > 0) {
      return teamRunState as EtapaState[]
    }

    // Fallback: build from plan messages (live session)
    const planMsg = messages.find((m) => m.sender === 'plan' && m.mode === 'team')
    if (!planMsg) return []

    let plan: { etapas: EtapaPlan[] }
    try {
      plan = JSON.parse(planMsg.content)
    } catch {
      return []
    }

    // Parse step messages
    const stepMsgs = messages.filter((m) => m.sender === 'step' && m.mode === 'team')
    const steps: { type: string; etapaIndex: number; employeeName?: string; etapaName?: string; rejectedBy?: string; redirectedTo?: string }[] = []
    for (const msg of stepMsgs) {
      try { steps.push(JSON.parse(msg.content)) } catch { /* skip */ }
    }

    return plan.etapas.map((etapa, ei) => {
      const etapaStarted = steps.some((s) => s.type === 'etapa_start' && s.etapaIndex === ei)
      const etapaDone = steps.some((s) => s.type === 'etapa_done' && s.etapaIndex === ei)

      const members = etapa.members.map((name) => {
        const employeeDone = steps.some((s) => s.type === 'employee_done' && s.etapaIndex === ei && s.employeeName === name)
        const employeeActive = steps.some((s) => s.type === 'employee_start' && s.etapaIndex === ei && s.employeeName === name) && !employeeDone
        const rejection = steps.find((s) => s.type === 'rejection' && s.etapaIndex === ei && s.rejectedBy === name)

        let status: 'pending' | 'active' | 'done' | 'recreated' = 'pending'
        if (rejection) status = 'recreated'
        else if (employeeDone) status = 'done'
        else if (employeeActive) status = 'active'

        return { name, status, redirectedTo: rejection?.redirectedTo }
      })

      let etapaStatus: 'pending' | 'active' | 'done' = 'pending'
      if (etapaDone) etapaStatus = 'done'
      else if (etapaStarted) etapaStatus = 'active'

      return { name: etapa.name, objective: etapa.objective, members, status: etapaStatus }
    })
  }

  const etapasState = activeMode === 'team' ? buildEtapasFromMessages() : []
  const isDone = messages.some((m) => m.sender === 'team' && m.mode === 'team')
  const hasPlan = messages.some((m) => m.sender === 'plan' && m.mode === 'team')

  const statusDot: Record<string, string> = {
    pending: 'bg-zinc-300',
    active: 'bg-blue-500 animate-pulse',
    done: 'bg-emerald-500',
    recreated: 'bg-amber-500',
  }

  const TASK_EMP_COLORS: Record<string, string> = {
    CEO: 'from-violet-500 to-purple-600',
    Architect: 'from-blue-500 to-cyan-600',
    Designer: 'from-pink-500 to-rose-600',
    Security: 'from-red-500 to-orange-600',
    Builder: 'from-red-600 to-red-700',
    Claude: 'from-zinc-500 to-zinc-600',
  }

  const TASK_INTENT: Record<string, { label: string; color: string }> = {
    build: { label: 'Build', color: 'text-emerald-400' },
    analyze_fix: { label: 'Analyze & Fix', color: 'text-amber-400' },
    conversation: { label: 'Review & Discuss', color: 'text-sky-400' },
  }

  const taskFiles = taskBuildLogs.flatMap((b) => b.filesTouched)
  const taskIntent = runningTask ? TASK_INTENT[runningTask.accumulatedContext?.intent ?? ''] : null

  return (
    <div className="flex w-72 shrink-0 flex-col border-l border-[#2B2B2B]" style={{ backgroundColor: '#181818' }}>
      {/* ── Chat section (top) ── */}
      <div className={`flex flex-col ${hasRunningTask ? 'h-1/2 border-b border-[#2B2B2B]' : 'flex-1'}`}>
        <div className="border-b border-[#2B2B2B] px-3 py-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-300">
            {activeMode === 'team' ? 'Pipeline' : activeMode === 'skill' ? 'Active' : 'Status'}
          </span>
        </div>
        <div className="flex-1 overflow-y-auto py-2">
          {/* No skill */}
          {activeMode === 'no_skill' && (
            <div className="flex h-full items-center justify-center">
              <p className="px-3 text-center text-xs text-zinc-400">Select an employee or team with /</p>
            </div>
          )}

          {/* Skill mode */}
          {activeMode === 'skill' && activeEmployee && (
            <div className="px-3 py-2">
              <div className={`rounded-lg bg-gradient-to-br ${activeEmployee.color} px-3 py-3 shadow-sm`}>
                <p className="text-xs font-bold text-white">{activeEmployee.name}</p>
                <p className="text-[9px] text-white/60">{activeEmployee.role}</p>
              </div>
            </div>
          )}

          {/* Team mode — etapas with sub-pipelines */}
          {activeMode === 'team' && etapasState.length > 0 && (
            <div className="px-2 py-2 space-y-3">
              {isDone && (
                <div className="mx-1 flex items-center gap-1.5 rounded-md bg-emerald-500/10 px-2 py-1.5">
                  <span className="h-2 w-2 rounded-full bg-emerald-500" />
                  <p className="text-[10px] font-medium text-emerald-400">All stages complete</p>
                </div>
              )}
              {etapasState.map((etapa, ei) => (
                <div key={ei} className={`rounded-lg border px-2 py-2 ${
                  etapa.status === 'active' ? 'border-blue-500/30 bg-blue-500/[0.06]' :
                  etapa.status === 'done' ? 'border-emerald-500/20 bg-emerald-500/[0.04]' :
                  'border-[#2B2B2B] bg-white/[0.02]'
                }`}>
                  <div className="mb-1.5 flex items-center gap-1.5">
                    <span className={`flex h-4 w-4 items-center justify-center rounded-full text-[8px] font-bold ${
                      etapa.status === 'done' ? 'bg-emerald-500 text-white' :
                      etapa.status === 'active' ? 'bg-blue-500 text-white' :
                      'bg-zinc-700 text-zinc-400'
                    }`}>
                      {etapa.status === 'done' ? '✓' : ei + 1}
                    </span>
                    <p className="text-[10px] font-semibold text-zinc-300 truncate">{etapa.name}</p>
                  </div>
                  <div className="space-y-0.5 pl-1">
                    {etapa.members.map((member, mi) => (
                      <div key={`${member.name}-${mi}`} className="flex items-center gap-1.5">
                        <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${statusDot[member.status]}`} />
                        <div className={`flex-1 rounded bg-gradient-to-br ${getColor(member.name)} px-1.5 py-0.5 ${
                          member.status === 'pending' ? 'opacity-25' : member.status === 'active' ? 'shadow-sm ring-1 ring-blue-400/40' : ''
                        }`}>
                          <p className="text-[8px] font-semibold text-white">{member.name}</p>
                          {member.status === 'recreated' && member.redirectedTo && (
                            <p className="text-[7px] text-amber-200">rejected → {member.redirectedTo}</p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Team mode — waiting for plan */}
          {activeMode === 'team' && !hasPlan && (activeTeam || teamRunActive) && (
            <div className="px-3 py-2 space-y-1">
              <div className="mb-2 flex items-center gap-1.5">
                {teamRunActive && <span className="h-2 w-2 animate-pulse rounded-full bg-blue-500" />}
                <p className="text-[10px] text-zinc-400">{teamRunActive ? 'Team is working...' : 'Waiting for message...'}</p>
              </div>
              {(activeTeam?.order ?? []).filter((id) => id !== 'builder').map((id) => {
                const emp = hiredEmployees.find((e) => e.id === id)
                const name = emp?.name ?? id
                return (
                  <div key={id} className={`rounded-md bg-gradient-to-br ${getColor(name)} px-2 py-1 opacity-25`}>
                    <p className="text-[9px] font-semibold text-white">{name}</p>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* ── Task section (bottom — only when task is running) ── */}
      {hasRunningTask && runningTask && (
        <div className="flex h-1/2 flex-col">
          <div className="flex items-center justify-between border-b border-[#2B2B2B] px-3 py-2">
            <div className="flex items-center gap-1.5">
              <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" />
              <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-300">Task Running</span>
            </div>
            <a href="#" onClick={(e) => { e.preventDefault(); window.location.hash = '' }} className="text-[9px] text-zinc-400 hover:text-zinc-300">
              Expand →
            </a>
          </div>

          {/* Task info bar */}
          <div className="border-b border-[#2B2B2B] px-3 py-2" style={{ backgroundColor: '#1F1F1F' }}>
            <p className="text-[10px] font-medium text-zinc-200 truncate">{runningTask.name}</p>
            <div className="mt-0.5 flex items-center gap-1.5">
              {taskIntent && <span className={`text-[8px] font-medium ${taskIntent.color}`}>{taskIntent.label}</span>}
              <span className="text-[8px] text-zinc-600">{runningTask.accumulatedContext?.model ?? 'sonnet'}</span>
            </div>
          </div>

          {/* Task live logs (compact) */}
          <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1.5">
            {taskLogs.length === 0 && (
              <div className="flex items-center gap-1.5 py-2">
                <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-violet-500" />
                <span className="text-[9px] text-zinc-500">Starting...</span>
              </div>
            )}
            {taskLogs.map((log) => {
              const empColor = TASK_EMP_COLORS[log.collaboratorName] ?? 'from-zinc-500 to-zinc-600'
              const isActive = !log.finishedAt
              return (
                <div key={log.id} className={`rounded-md border p-2 ${
                  isActive ? 'border-[#2B2B2B] bg-violet-500/[0.06]' : 'border-white/5 bg-white/[0.02]'
                }`}>
                  <div className="flex items-center gap-1.5">
                    <span className={`rounded bg-gradient-to-br ${empColor} px-1 py-0.5 text-[7px] font-bold text-white`}>
                      {log.collaboratorName}
                    </span>
                    {isActive && <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-violet-500" />}
                    {!isActive && log.approved === true && (
                      <svg className="h-2.5 w-2.5 text-emerald-500" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
                    )}
                    {!isActive && log.approved === false && (
                      <span className="text-[7px] font-medium text-red-400">REJ</span>
                    )}
                    {!isActive && log.approved === null && (
                      <svg className="h-2.5 w-2.5 text-emerald-500" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
                    )}
                  </div>
                  {log.conclusion && (
                    <p className="mt-0.5 text-[8px] leading-relaxed text-zinc-500 line-clamp-2">{log.conclusion}</p>
                  )}
                </div>
              )
            })}

            {/* Files */}
            {taskFiles.length > 0 && (
              <div className="rounded-md border border-white/5 bg-white/[0.02] p-2">
                <p className="text-[7px] font-semibold uppercase text-zinc-600 mb-0.5">Files</p>
                {taskFiles.slice(0, 5).map((f, i) => (
                  <p key={i} className="text-[8px] text-zinc-500 truncate">{f.path}</p>
                ))}
                {taskFiles.length > 5 && <p className="text-[8px] text-zinc-600">+{taskFiles.length - 5} more</p>}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Last completed task bar (only when no task running) */}
      {!hasRunningTask && showLastTask && lastCompletedTask && (
        <div className="shrink-0 border-t border-[#2B2B2B] px-3 py-2.5" style={{ backgroundColor: '#1F1F1F' }}>
          <div className="flex items-center gap-2">
            <svg className="h-3 w-3 shrink-0 text-emerald-500" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
            </svg>
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-medium text-zinc-300 truncate">{lastCompletedTask.name}</p>
              <div className="flex items-center gap-1.5 mt-0.5">
                <span className="text-[9px] text-zinc-500">{getTimeAgoMini(lastCompletedTask.completedAt)}</span>
                {lastCompletedTask.intent && (
                  <span className={`text-[8px] font-medium ${
                    lastCompletedTask.intent === 'build' ? 'text-emerald-400' :
                    lastCompletedTask.intent === 'analyze_fix' ? 'text-amber-400' : 'text-sky-400'
                  }`}>
                    {lastCompletedTask.intent === 'build' ? 'Build' : lastCompletedTask.intent === 'analyze_fix' ? 'Analyze' : 'Review'}
                  </span>
                )}
              </div>
            </div>
            <button
              onClick={() => setShowLastTask(false)}
              className="shrink-0 text-zinc-600 hover:text-zinc-400"
            >
              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function getTimeAgoMini(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

// ── Context Picker ─────────────────────────────────────────────────────────

function ContextPicker({
  projectId,
  onSelect,
  onClose,
}: {
  projectId: string
  onSelect: (path: string) => void
  onClose: () => void
}) {
  const [folders, setFolders] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch(`/api/projects/${projectId}/repository/files`)
      .then((r) => r.json())
      .then((data) => {
        const files: { path: string }[] = data.files ?? []
        // Extract unique folder paths
        const folderSet = new Set<string>()
        folderSet.add('/') // root
        for (const f of files) {
          const parts = f.path.split('/')
          for (let i = 1; i <= parts.length - 1; i++) {
            folderSet.add(parts.slice(0, i).join('/'))
          }
        }
        setFolders([...folderSet].sort())
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [projectId])

  const filtered = folders.filter((f) => !search || f.toLowerCase().includes(search.toLowerCase()))

  return (
    <div className="absolute bottom-full left-0 right-0 z-20 mb-1 max-h-64 overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-lg">
      <div className="flex items-center border-b border-[#2B2B2B] px-3 py-2">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search folders..."
          autoFocus
          className="flex-1 text-xs text-zinc-700 placeholder-zinc-500 outline-none"
        />
        <button onClick={onClose} className="ml-2 text-zinc-400 hover:text-zinc-600">
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div className="max-h-48 overflow-y-auto py-1">
        {loading ? (
          <p className="px-3 py-2 text-xs text-zinc-400">Loading...</p>
        ) : filtered.length === 0 ? (
          <p className="px-3 py-2 text-xs text-zinc-400">No folders found</p>
        ) : (
          filtered.map((folder) => (
            <button
              key={folder}
              onClick={() => onSelect(folder)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-300 hover:bg-white/5"
            >
              <svg className="h-3.5 w-3.5 text-zinc-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
              </svg>
              {folder === '/' ? '/ (root)' : folder}
            </button>
          ))
        )}
      </div>
    </div>
  )
}
