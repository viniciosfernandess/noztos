'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { diffLines } from 'diff'
import { MarkdownRenderer } from './MarkdownRenderer'
// ChatTabs removed — companion mode replaced tab-based chat
import { CodeMirrorFileView, type CodeMirrorFileViewHandle } from './CodeMirrorFileView'
import { InlineDiffEditor, type InlineDiffEditorHandle } from './InlineDiffEditor'
import { ChecksPanel } from './ChecksPanel'
import { SplitCreatePRButton } from './SplitCreatePRButton'
import { ConflictResolver } from './ConflictResolver'
import { ResolveConflictsSplitButton } from './ResolveConflictsSplitButton'
import { MOCK_CONFLICTS, MOCK_GIT_STATUS } from '@/lib/mocks/checks-demo'
import { useGitStatus, deriveBadge, deriveUnsupportedLabel } from '@/lib/hooks/useGitStatus'
import { useCompanionStream, type ChatMessage } from '@/lib/hooks/useCompanionStream'
import { ClaudeToolCard, SessionResultCard, ModeSelector, ModelSelector, ThinkingSelector, CompanionStatusBadge } from './ClaudeToolCard'
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
        <div className="flex flex-col">
              {/* Workspace is the only unit of work. "Workspace" is the
                  user-facing name for what git calls a worktree. */}
              <button
                onClick={onNewWorktree}
                className="flex w-full items-center gap-2 pl-9 pr-4 py-1.5 text-left text-zinc-500 hover:bg-white/[0.03] hover:text-zinc-300"
                title="New workspace"
              >
                <svg className="h-3 w-3 shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                </svg>
                <span className="text-[11px]">new workspace</span>
              </button>

              {/* Centered empty state — only shown when there are no
                  workspaces at all. Anchored mid-sidebar so the "new
                  workspace" button stays at the top and the empty
                  message gets the visual weight. */}
              {worktrees.length === 0 && (
                <div className="flex min-h-[240px] flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
                  <svg className="h-8 w-8 text-zinc-700" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0021 18V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v12a2.25 2.25 0 002.25 2.25z" />
                  </svg>
                  <div className="text-[11px] font-medium text-zinc-400">No workspaces yet</div>
                </div>
              )}

              {/* Legacy main-chat list hidden — kept in state only for
                  backward compat of already-created main chats. New
                  items never land here. */}
              {false && mainChats.map((s) => {
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
  type ArchivedChat = { id: string; name: string; updatedAt: string }
  type ArchivedWorktree = {
    id: string; name: string; branchName: string; updatedAt: string
    sessions: { id: string; name: string }[]
  }
  const [chats, setChats] = useState<ArchivedChat[]>([])
  const [worktrees, setWorktrees] = useState<ArchivedWorktree[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previousOverflow }
  }, [])

  useEffect(() => {
    // Archived lives forever — no expiration. Load chats + worktrees in
    // parallel; the chats endpoint already excludes any chat whose parent
    // worktree is also archived (those surface nested under the worktree).
    Promise.all([
      fetch(`/api/projects/${projectId}/chat-sessions/archived`).then((r) => r.ok ? r.json() : { sessions: [] }),
      fetch(`/api/projects/${projectId}/worktrees/archived`).then((r) => r.ok ? r.json() : { worktrees: [] }),
    ])
      .then(([s, w]) => {
        setChats(s.sessions ?? [])
        setWorktrees(w.worktrees ?? [])
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [projectId])

  async function restoreChat(id: string) {
    await fetch(`/api/projects/${projectId}/chat-sessions/${id}/restore`, { method: 'POST' })
    setChats((prev) => prev.filter((s) => s.id !== id))
    onRestored()
  }

  async function restoreWorktree(id: string) {
    await fetch(`/api/projects/${projectId}/worktrees/${id}/restore`, { method: 'POST' })
    setWorktrees((prev) => prev.filter((w) => w.id !== id))
    onRestored()
  }

  const empty = !loading && chats.length === 0 && worktrees.length === 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="flex h-[600px] max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-white/10 shadow-2xl"
        style={{ backgroundColor: '#181818' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-[#2B2B2B] px-5 py-3">
          <h3 className="text-[13px] font-semibold text-zinc-100">Archived</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading && <p className="px-5 py-6 text-center text-[11px] text-zinc-500">Loading…</p>}
          {empty && <p className="px-5 py-6 text-center text-[11px] text-zinc-500">Nothing archived yet.</p>}

          {/* Archived worktrees — bundled with their chats */}
          {worktrees.map((w) => (
            <div key={w.id} className="border-b border-[#2B2B2B] px-5 py-3 last:border-b-0">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <svg className="h-3.5 w-3.5 text-zinc-500" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 8h14M5 8a2 2 0 01-2-2V5a2 2 0 012-2h14a2 2 0 012 2v1a2 2 0 01-2 2M5 8v11a2 2 0 002 2h10a2 2 0 002-2V8M10 12h4" />
                    </svg>
                    <p className="truncate text-[12px] font-medium text-zinc-100">{w.name}</p>
                    <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-zinc-500">{w.branchName}</span>
                  </div>
                  <p className="mt-0.5 text-[10px] text-zinc-600">
                    Archived {new Date(w.updatedAt).toLocaleDateString()} · {w.sessions.length} {w.sessions.length === 1 ? 'chat' : 'chats'} inside
                  </p>
                </div>
                <button
                  onClick={() => restoreWorktree(w.id)}
                  className="rounded-md border border-[#3C3C3C] px-2.5 py-1 text-[11px] text-zinc-300 hover:border-white/30 hover:bg-white/5"
                >
                  Restore
                </button>
              </div>
              {w.sessions.length > 0 && (
                <ul className="mt-2 ml-5 border-l border-[#2B2B2B] pl-3">
                  {w.sessions.map((s) => (
                    <li key={s.id} className="py-0.5 text-[11px] text-zinc-500 truncate">↳ {s.name}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}

          {/* Standalone archived chats */}
          {chats.map((s) => (
            <div key={s.id} className="flex items-center justify-between border-b border-[#2B2B2B] px-5 py-3 last:border-b-0">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12px] text-zinc-200">{s.name}</p>
                <p className="mt-0.5 text-[10px] text-zinc-600">
                  Archived {new Date(s.updatedAt).toLocaleDateString()}
                </p>
              </div>
              <button
                onClick={() => restoreChat(s.id)}
                className="ml-3 rounded-md border border-[#3C3C3C] px-2.5 py-1 text-[11px] text-zinc-300 hover:border-white/30 hover:bg-white/5"
              >
                Restore
              </button>
            </div>
          ))}
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
  type TrashedChat = { id: string; name: string; trashedAt: string; daysLeft: number }
  type TrashedWorktree = {
    id: string; name: string; branchName: string; trashedAt: string; daysLeft: number
    sessions: { id: string; name: string }[]
  }
  const [chats, setChats] = useState<TrashedChat[]>([])
  const [worktrees, setWorktrees] = useState<TrashedWorktree[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previousOverflow }
  }, [])

  function reload() {
    setLoading(true)
    // Fetch both trash buckets in parallel. Worktree card bundles its
    // child chats; the chats endpoint returns only items whose parent
    // worktree is still active (standalone entries).
    Promise.all([
      fetch(`/api/projects/${projectId}/chat-sessions/trash`).then((r) => r.ok ? r.json() : { sessions: [] }),
      fetch(`/api/projects/${projectId}/worktrees/trash`).then((r) => r.ok ? r.json() : { worktrees: [] }),
    ])
      .then(([s, w]) => {
        setChats(s.sessions ?? [])
        setWorktrees(w.worktrees ?? [])
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  async function restoreChat(id: string) {
    await fetch(`/api/projects/${projectId}/chat-sessions/${id}/restore`, { method: 'POST' })
    setChats((prev) => prev.filter((s) => s.id !== id))
    onChanged()
  }

  async function deleteChatForever(id: string) {
    await fetch(`/api/projects/${projectId}/chat-sessions/${id}/delete-forever`, { method: 'POST' })
    setChats((prev) => prev.filter((s) => s.id !== id))
    onChanged()
  }

  async function restoreWorktree(id: string) {
    await fetch(`/api/projects/${projectId}/worktrees/${id}/restore`, { method: 'POST' })
    setWorktrees((prev) => prev.filter((w) => w.id !== id))
    onChanged()
  }

  async function deleteWorktreeForever(id: string) {
    await fetch(`/api/projects/${projectId}/worktrees/${id}/delete-forever`, { method: 'POST' })
    setWorktrees((prev) => prev.filter((w) => w.id !== id))
    onChanged()
  }

  const empty = !loading && chats.length === 0 && worktrees.length === 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="flex h-[600px] max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-white/10 shadow-2xl"
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
          {loading && <p className="px-5 py-6 text-center text-[11px] text-zinc-500">Loading…</p>}
          {empty && <p className="px-5 py-6 text-center text-[11px] text-zinc-500">Trash is empty.</p>}

          {/* Trashed worktrees — bundled with the chats they carried in */}
          {worktrees.map((w) => (
            <div key={w.id} className="border-b border-[#2B2B2B] px-5 py-3 last:border-b-0">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <svg className="h-3.5 w-3.5 text-zinc-500" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3 7h18M5 7v13a2 2 0 002 2h10a2 2 0 002-2V7M9 7V5a2 2 0 012-2h2a2 2 0 012 2v2" />
                    </svg>
                    <p className="truncate text-[12px] font-medium text-zinc-100">{w.name}</p>
                    <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-zinc-500">{w.branchName}</span>
                  </div>
                  <p className="mt-0.5 text-[10px] text-zinc-600">
                    Expires in {w.daysLeft} {w.daysLeft === 1 ? 'day' : 'days'} · {w.sessions.length} {w.sessions.length === 1 ? 'chat' : 'chats'} inside
                  </p>
                </div>
                <div className="flex gap-1.5">
                  <button
                    onClick={() => restoreWorktree(w.id)}
                    className="rounded-md border border-[#3C3C3C] px-2.5 py-1 text-[11px] text-zinc-300 hover:border-white/30 hover:bg-white/5"
                  >
                    Restore
                  </button>
                  <button
                    onClick={() => deleteWorktreeForever(w.id)}
                    className="rounded-md border border-red-500/30 px-2.5 py-1 text-[11px] text-red-400 hover:border-red-500/60 hover:bg-red-500/10"
                  >
                    Delete forever
                  </button>
                </div>
              </div>
              {w.sessions.length > 0 && (
                <ul className="mt-2 ml-5 border-l border-[#2B2B2B] pl-3">
                  {w.sessions.map((s) => (
                    <li key={s.id} className="py-0.5 text-[11px] text-zinc-500 truncate">↳ {s.name}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}

          {/* Standalone trashed chats — parent worktree is still active */}
          {chats.map((s) => (
            <div key={s.id} className="flex items-center justify-between gap-2 border-b border-[#2B2B2B] px-5 py-3 last:border-b-0">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12px] text-zinc-200">{s.name}</p>
                <p className="mt-0.5 text-[10px] text-zinc-600">
                  Expires in {s.daysLeft} {s.daysLeft === 1 ? 'day' : 'days'}
                </p>
              </div>
              <button
                onClick={() => restoreChat(s.id)}
                className="rounded-md border border-[#3C3C3C] px-2.5 py-1 text-[11px] text-zinc-300 hover:border-white/30 hover:bg-white/5"
              >
                Restore
              </button>
              <button
                onClick={() => deleteChatForever(s.id)}
                className="rounded-md border border-red-500/30 px-2.5 py-1 text-[11px] text-red-400 hover:border-red-500/60 hover:bg-red-500/10"
              >
                Delete forever
              </button>
            </div>
          ))}
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
  const [rightPanelTab, setRightPanelTab] = useState<'explorer' | 'changes' | 'checks'>('explorer')
  // Main-state refresh telemetry — timestamp of the last successful
  // refresh-main, plus an in-flight flag so the UI can disable the
  // button + show a spinner.
  const [mainRefreshedAt, setMainRefreshedAt] = useState<number | null>(null)
  const [mainRefreshing, setMainRefreshing] = useState(false)
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
  // chatMessages state removed — the legacy Bornastar engine that wrote
  // into it is gone. Chat content lives in companion.messages inside the
  // ChatPanel. Kept as a comment marker so nobody re-adds the old poll.
  // Claude Code messages per Bornastar chat session. Lives here (parent of
  // ChatPanel) so that switching between chats doesn't throw away each
  // one's conversation — ChatPanel re-mounts on sessionId change to keep
  // state isolated, and seeds itself from this store.
  const [companionMessagesBySession, setCompanionMessagesBySession] = useState<Record<string, ChatMessage[]>>({})
  const [teamRunState, setTeamRunState] = useState<unknown>(null)
  const [teamRunActive, setTeamRunActive] = useState(false)

  // Session + worktree management
  const [mainChats, setMainChats] = useState<SessionInfo[]>([])
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [activeWorktreeId, setActiveWorktreeId] = useState<string | null>(null)
  // Worktree IDs whose Merged banner the user has dismissed via "Continue".
  // Suppresses the purple state locally without touching the PR — the user
  // keeps working on the already-merged branch until they archive.
  const [continuedMergedWorktrees, setContinuedMergedWorktrees] = useState<Set<string>>(new Set())
  // Same pattern for closed/rejected PRs — "Start over" hides the red
  // banner. The PR stays closed on GitHub; the worktree acts fresh.
  const [startedOverClosedWorktrees, setStartedOverClosedWorktrees] = useState<Set<string>>(new Set())
  // Open conflict resolver overlay for a given worktree + file list.
  // Null = no overlay showing.
  const [conflictSession, setConflictSession] = useState<{ worktreeId: string; files: import('./conflicts/types').ConflictFile[] } | null>(null)
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
    // Push-based — stats (per-worktree/chat diff rollups) depend on the
    // same filesystem the explorer watches, so we piggy-back on the
    // `bornastar-fs-change` signal instead of running a 5 s poll.
    let debounce: ReturnType<typeof setTimeout> | null = null
    function onFsChange() {
      if (debounce) return
      debounce = setTimeout(() => { debounce = null; fetchStats() }, 600)
    }
    window.addEventListener('bornastar-fs-change', onFsChange)
    return () => {
      cancelled = true
      window.removeEventListener('bornastar-fs-change', onFsChange)
      if (debounce) clearTimeout(debounce)
    }
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

  // Stable callback so ChatPanel's sync effect doesn't loop (a new inline
  // reference each render would retrigger the effect → setState → render → …).
  // We read activeSessionId from a ref so the callback stays referentially
  // stable even when the active chat switches.
  const activeSessionIdRef = useRef(activeSessionId)
  useEffect(() => { activeSessionIdRef.current = activeSessionId }, [activeSessionId])
  const handleCompanionMessagesChange = useCallback((msgs: ChatMessage[]) => {
    const sid = activeSessionIdRef.current
    if (!sid) return
    setCompanionMessagesBySession((prev) => {
      // Skip the set if identical reference — React still re-runs effects
      // but at least no re-render storm on redundant updates.
      if (prev[sid] === msgs) return prev
      return { ...prev, [sid]: msgs }
    })
  }, [])

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

  // Force Explorer when leaving a workspace — Changes/Checks tabs
  // disappear in the main-state, so leaving them selected would render
  // an empty body.
  useEffect(() => {
    if (!activeWorktreeId && rightPanelTab !== 'explorer') setRightPanelTab('explorer')
  }, [activeWorktreeId, rightPanelTab])

  // Refresh main in-place. Callable manually (button) or automatically
  // via the interval below. Skipped while a workspace is active-less
  // edge case: the sandbox's main directory never collides with any
  // worktree's directory, so this is always safe to run.
  const refreshMain = useCallback(async () => {
    if (mainRefreshing) return
    setMainRefreshing(true)
    try {
      const res = await fetch(`/api/projects/${projectId}/git/refresh-main`, { method: 'POST' })
      if (res.ok) {
        const data = await res.json().catch(() => ({}))
        setMainRefreshedAt(typeof data.refreshedAt === 'number' ? data.refreshedAt : Date.now())
      }
    } catch {}
    setMainRefreshing(false)
  }, [projectId, mainRefreshing])

  // Auto-refresh every 5 minutes regardless of workspace state — main
  // lives in its own dir, updating it doesn't disturb anyone's work.
  useEffect(() => {
    refreshMain()
    const t = setInterval(refreshMain, 5 * 60 * 1000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  // ChecksPanel's "Continue" on a merged banner fires this event — we
  // flip the active worktree into the "continued" set so the purple
  // banner hides until the user either archives or reopens the tab.
  useEffect(() => {
    const handler = () => {
      if (!activeWorktreeId) return
      setContinuedMergedWorktrees((prev) => new Set(prev).add(activeWorktreeId))
    }
    window.addEventListener('bornastar-continue-merged', handler)
    return () => window.removeEventListener('bornastar-continue-merged', handler)
  }, [activeWorktreeId])

  // Same deal for the Closed state — "Start over" hides the red banner.
  useEffect(() => {
    const handler = () => {
      if (!activeWorktreeId) return
      setStartedOverClosedWorktrees((prev) => new Set(prev).add(activeWorktreeId))
    }
    window.addEventListener('bornastar-start-over-closed', handler)
    return () => window.removeEventListener('bornastar-start-over-closed', handler)
  }, [activeWorktreeId])

  // ChecksPanel's "Resolve conflicts" row fires this with the file
  // list — we open the ConflictResolver overlay scoped to the active
  // worktree. Top-bar CTA uses setConflictSession directly.
  useEffect(() => {
    const handler = (e: Event) => {
      if (!activeWorktreeId) return
      const detail = (e as CustomEvent<{ files?: import('./conflicts/types').ConflictFile[] }>).detail
      setConflictSession({ worktreeId: activeWorktreeId, files: detail?.files ?? [] })
    }
    window.addEventListener('bornastar-open-conflict-resolver', handler)
    return () => window.removeEventListener('bornastar-open-conflict-resolver', handler)
  }, [activeWorktreeId])

  // Load on mount
  useEffect(() => {
    reloadAll(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  // Persist "user viewed this chat" so unread state survives refresh /
  // device switch. Fire-and-forget — the in-memory Set is already
  // updated by the click handlers in the sidebar.
  useEffect(() => {
    if (!activeSessionId) return
    fetch(`/api/projects/${projectId}/chat-sessions/${activeSessionId}/mark-read`, {
      method: 'POST',
    }).catch(() => {})
  }, [activeSessionId, projectId])

  // ── Unread detection (SSE-driven, not polling) ─────────────────────
  // Seed the initial unread set from the DB so a refresh / fresh tab
  // picks up unread chats that accumulated while the user was offline.
  useEffect(() => {
    fetch(`/api/projects/${projectId}/chat-sessions/unread`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (!data?.unreadIds) return
        setUnreadSessionIds(new Set<string>(data.unreadIds))
      })
      .catch(() => {})
  }, [projectId])

  // Subscribe to the same companion SSE stream the ChatPanel uses, but
  // at the WorkPanel level and unfiltered. Whenever Claude emits an
  // assistant / tool event, look at its bornastarSessionId — if it's a
  // chat OTHER than the one the user is currently viewing, flag it as
  // unread. The SSE bus already multiplexes every chat's events through
  // one connection per user, so this costs no extra DB queries.
  const activeSessionIdForUnreadRef = useRef<string | null>(activeSessionId)
  useEffect(() => { activeSessionIdForUnreadRef.current = activeSessionId }, [activeSessionId])
  useEffect(() => {
    const controller = new AbortController()
    async function listen() {
      try {
        const res = await fetch('/api/companion/stream', { signal: controller.signal })
        if (!res.ok || !res.body) return
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue
            try {
              const event = JSON.parse(line.slice(6)) as {
                type?: string
                payload?: {
                  bornastarSessionId?: string
                  event?: { type?: string; message?: { content?: { type?: string }[] } }
                  projectPath?: string
                  paths?: string[]
                }
              }

              // File-system changes pushed by the companion watcher.
              // Fires whenever a file in the project tree is created,
              // edited or deleted. We dispatch a DOM event so the
              // Explorer, Changes panel and stats rows can refetch on
              // demand instead of polling on an interval.
              if (event.type === 'fs_change') {
                const paths = event.payload?.paths ?? []
                window.dispatchEvent(new CustomEvent('bornastar-fs-change', {
                  detail: { projectPath: event.payload?.projectPath, paths },
                }))
                continue
              }

              if (event.type !== 'claude_event') continue
              const inner = event.payload?.event
              const sid = event.payload?.bornastarSessionId
              if (!sid || sid === activeSessionIdForUnreadRef.current) continue
              // Only assistant text/tool_use blocks count — system
              // metrics ('result') and user echoes shouldn't mark unread.
              const isContentEvent =
                inner?.type === 'assistant'
                || (inner?.type === 'user' && inner.message?.content?.some((c) => c.type === 'tool_result'))
              if (!isContentEvent) continue
              setUnreadSessionIds((prev) => {
                if (prev.has(sid)) return prev
                const next = new Set(prev)
                next.add(sid)
                return next
              })
            } catch { /* non-JSON line, skip */ }
          }
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') { /* ignore stream errors */ }
      }
    }
    listen()
    return () => controller.abort()
  }, [projectId])

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

  // Count changed files for the Changes tab badge — real stats first,
  // falls back to the mock array length while the backend isn't wired
  // (so the badge matches the rows the user actually sees).
  const realChangedCount = Object.values(worktreeStats).reduce((sum, s) => sum + s.files, 0)
    + Object.values(chatStats).reduce((sum, s) => sum + s.files, 0)
  const changedFilesCount = realChangedCount > 0 ? realChangedCount : MOCK_CHANGES.length

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
                  key={activeSessionId ?? 'empty'}
                  projectId={projectId}
                  sessionId={activeSessionId}
                  initialCompanionMessages={activeSessionId ? (companionMessagesBySession[activeSessionId] ?? []) : []}
                  onCompanionMessagesChange={handleCompanionMessagesChange}
                  sessionName={
                    activeWorktreeId
                      ? worktrees.find((w) => w.id === activeWorktreeId)?.sessions.find((s) => s.id === activeSessionId)?.name ?? 'Chat'
                      : mainChats.find((s) => s.id === activeSessionId)?.name ?? 'Chat'
                  }
                  isWorktreeChat={!!activeWorktreeId}
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
                onClick={handleNewWorktree}
                className="rounded-full border border-white/20 px-4 py-1.5 text-[12px] font-medium text-zinc-200 transition-colors hover:border-white/40 hover:bg-white/5"
              >
                + New workspace
              </button>
            </div>
          </div>
        )}
      </div>

        {/* Right: Explorer / Changes / Terminal panel */}
        <div className={`relative flex min-w-0 shrink-0 flex-col border-l border-[#2B2B2B] transition-all duration-200 ${rightPanelExpanded ? 'w-[50%]' : 'w-[30%]'}`} style={{ backgroundColor: '#1F1F1F' }}>
          {/* Conflict resolver overlay — covers the whole right panel
              (tabs + body + bottom terminal) so the user is focused on
              resolving. Chat column stays live on the left. */}
          {conflictSession && (
            <ConflictResolver
              projectId={projectId}
              worktreeId={conflictSession.worktreeId}
              initialFiles={conflictSession.files}
              onClose={() => setConflictSession(null)}
              onDone={() => {
                setConflictSession(null)
                window.dispatchEvent(new CustomEvent('bornastar-refresh-worktrees'))
              }}
            />
          )}
          {/* Main-state top bar (no workspace active) — shows "main ·
              updated X ago" + manual Refresh. Auto-updates every 5
              minutes in background so the Explorer tree always
              reflects latest origin/main. */}
          {!activeWorktreeId && (
            <div className="flex shrink-0 items-center justify-between border-b border-[#2B2B2B] px-3 py-2" style={{ backgroundColor: '#1B1B1B' }}>
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-mono text-zinc-400">main</span>
                <span className="text-[10px] text-zinc-600">·</span>
                <span className="text-[10px] text-zinc-500" title={mainRefreshedAt ? new Date(mainRefreshedAt).toLocaleString() : ''}>
                  {(() => {
                    if (mainRefreshing && !mainRefreshedAt) return 'Refreshing…'
                    if (!mainRefreshedAt) return 'Not refreshed yet'
                    const diff = Date.now() - mainRefreshedAt
                    const s = Math.floor(diff / 1000)
                    if (s < 10) return 'just now'
                    if (s < 60) return `${s}s ago`
                    const m = Math.floor(s / 60)
                    if (m < 60) return `updated ${m} min ago`
                    const h = Math.floor(m / 60)
                    return `updated ${h}h ago`
                  })()}
                </span>
              </div>
              <div className="group relative">
                <button
                  onClick={refreshMain}
                  disabled={mainRefreshing}
                  aria-label="Refresh main from origin"
                  className="flex h-6 w-6 items-center justify-center rounded text-zinc-400 hover:bg-white/5 hover:text-zinc-200 disabled:opacity-40"
                >
                  <svg className={`h-3 w-3 ${mainRefreshing ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
                  </svg>
                </button>
                {/* Hover tooltip — explains what clicking does. The
                    click itself is the action; no extra confirm. */}
                <div className="pointer-events-none absolute right-0 top-full z-20 mt-1 w-52 rounded-md border border-[#2B2B2B] p-2.5 opacity-0 shadow-xl transition-opacity group-hover:opacity-100" style={{ backgroundColor: '#252526' }}>
                  <div className="mb-0.5 text-[11px] font-medium text-zinc-200">Refresh main</div>
                  <div className="text-[10px] leading-snug text-zinc-400">Pull the latest from origin/main and rebuild the file tree.</div>
                </div>
              </div>
            </div>
          )}
          {/* Workspace-state top bar — the big PR-aware one we already
              had. Only renders when a workspace is active. */}
          {activeWorktreeId && (() => {
            const pr = activeGitStatus?.pr
            const isContinued = !!activeWorktreeId && continuedMergedWorktrees.has(activeWorktreeId)
            const isStartedOver = !!activeWorktreeId && startedOverClosedWorktrees.has(activeWorktreeId)
            // "Continue" from a merged banner hides the loud state so
            // the user can keep making follow-up edits on the same
            // worktree — the PR is still technically merged on GitHub.
            const prMerged = !!pr?.merged && !isContinued
            const prReady = !!pr && !prMerged && !isContinued && (
              pr.derivedStatus === 'approved' ||
              (pr.derivedStatus === 'open' && pr.mergeable_state === 'clean')
            )
            // Changes requested gets its own visual lane — reviewer
            // flagged something and the user needs to push fixes before
            // the PR can move forward. Distinct orange so it doesn't
            // look like the calmer "Awaiting review" yellow.
            const prChangesRequested = !!pr && !prMerged && !prReady && !isContinued && pr.derivedStatus === 'changes_requested'
            // Closed (rejected) — the PR was closed without merging.
            // "Start over" dismisses the banner locally; user keeps the
            // branch and can later open a follow-up PR.
            const prClosed = !!pr && !prMerged && pr.state === 'closed' && !isStartedOver
            // Draft PR — author still iterating, reviewers NOT notified
            // yet. Takes precedence over "Awaiting" because draft PRs
            // are technically open too.
            const prDraft = !!pr && !prMerged && !prClosed && pr.derivedStatus === 'draft'
            // Merge conflicts — GitHub computed that the branch can't
            // be merged cleanly onto main. Distinct from awaiting /
            // changes requested: this is a technical git issue, not a
            // human decision.
            const prConflicts = !!pr && !prMerged && !prClosed && (
              pr.derivedStatus === 'conflicts' ||
              (pr.mergeable_state === 'dirty' && pr.state === 'open')
            )
            // Catch-all for states we can't (yet) resolve in-app —
            // CI failing, binary conflicts, submodule conflicts,
            // branch deleted on remote, etc. Rendered in neutral zinc
            // with a "fix it on GitHub" label. User goes to the PR,
            // fixes there, comes back to edit locally; polling picks
            // up the new state on next push.
            const prAwaiting = !!pr && !prMerged && !prReady && !prChangesRequested && !prDraft && !prConflicts && !isContinued && pr.state === 'open'
            const unsupportedState = deriveUnsupportedLabel(activeGitStatus)
            const prUnsupported = !!unsupportedState && !prMerged && !prClosed && !prReady && !prChangesRequested && !prAwaiting && !prDraft && !prConflicts

            // Subdued tech palette — solid color, but more refined than
            // a flashy saturated fill. The accent CTA button supplies
            // the contrast so the bar reads sophisticated, not loud.
            const bg = prMerged ? '#3B1A6B'             // deep violet
              : prReady ? '#0F4F3C'                     // deep emerald
              : prChangesRequested ? '#5B1F0F'          // deep coral/orange
              : prConflicts ? '#3F2A0A'                 // darker amber — tech problem
              : prAwaiting ? '#5C3F0F'                  // deep amber
              : prClosed ? '#4A0F1E'                    // deep crimson
              : prDraft ? '#27272A'                     // zinc-800 — neutral
              : prUnsupported ? '#2A2A2A'               // zinc — needs GitHub
              : '#1B1B1B'
            const border = prMerged ? 'border-purple-900'
              : prReady ? 'border-emerald-900'
              : prChangesRequested ? 'border-orange-900'
              : prConflicts ? 'border-amber-900'
              : prAwaiting ? 'border-amber-900'
              : prClosed ? 'border-red-900'
              : prDraft ? 'border-zinc-700'
              : prUnsupported ? 'border-zinc-700'
              : 'border-[#2B2B2B]'
            const pillLabel = prMerged ? 'Merged'
              : prReady ? 'Ready to merge'
              : prChangesRequested ? 'Changes requested'
              : prConflicts ? 'Conflicts'
              : prAwaiting ? 'Awaiting review'
              : prClosed ? 'Closed'
              : prDraft ? 'Draft'
              : prUnsupported ? (unsupportedState ?? 'Needs attention')
              : ''
            const isLoud = prMerged || prReady || prChangesRequested || prConflicts || prAwaiting || prClosed || prDraft || prUnsupported

            // Suppress the Working indicator when the PR is the headline
            // state — the user's attention belongs to the PR at that point.
            const chatWorking = !!activeSessionId && busySessions.has(activeSessionId) && !prMerged && !prReady && !prAwaiting

            // Right-side actions.
            //   • PR-loud states → primary CTA (Merge / Archive / View).
            //   • If the user kept editing after the PR was created and
            //     has uncommitted or unpushed work, we also surface
            //     "Commit and push" next to the CTA so those edits can
            //     reach the same PR in one click (a push on the PR's
            //     head branch auto-updates it).
            //   • No PR → Commit and push + Create PR as before.
            let rightButton: React.ReactNode = null
            const pending = activeGitStatus
              ? (activeGitStatus.uncommitted > 0 || activeGitStatus.commitsAhead > 0)
              : false
            if (pr?.html_url && isLoud) {
              // Merged state gets TWO buttons — Continue (dismiss the
              // purple banner and keep working on the branch) and Archive
              // (close the worktree, with confirm if pending work exists).
              if (prMerged && activeWorktreeId) {
                const wtId = activeWorktreeId
                const hasPending = (activeGitStatus?.uncommitted ?? 0) > 0 || (activeGitStatus?.commitsAhead ?? 0) > 0
                const doArchive = async () => {
                  // If there's pending work, route the user through the
                  // Checks panel's archive confirm modal instead of
                  // wiping silently.
                  if (hasPending) {
                    setRightPanelTab('checks')
                    return
                  }
                  const res = await fetch(`/api/projects/${projectId}/worktrees/${wtId}/archive`, { method: 'POST' })
                  if (res.ok) {
                    setWorktrees((prev) => prev.filter((w) => w.id !== wtId))
                    setActiveWorktreeId(null)
                    setActiveSessionId(null)
                  }
                }
                rightButton = (
                  <>
                    <button
                      onClick={() => setContinuedMergedWorktrees((prev) => new Set(prev).add(wtId))}
                      className="rounded-md border border-white/25 bg-white/10 px-3 py-1 text-[11px] font-semibold text-white hover:bg-white/15"
                    >
                      Continue
                    </button>
                    <button
                      onClick={doArchive}
                      className="rounded-md bg-purple-500 px-3 py-1 text-[11px] font-semibold text-white shadow-sm hover:bg-purple-400"
                    >
                      Archive
                    </button>
                  </>
                )
              } else if (prClosed && activeWorktreeId) {
                // Closed state gets two buttons: Start over (dismiss
                // banner, return to normal flow — branch + commits
                // preserved) and Archive (close worktree entirely).
                const wtId = activeWorktreeId
                const hasPending = (activeGitStatus?.uncommitted ?? 0) > 0 || (activeGitStatus?.commitsAhead ?? 0) > 0
                const doArchive = async () => {
                  if (hasPending) { setRightPanelTab('checks'); return }
                  const res = await fetch(`/api/projects/${projectId}/worktrees/${wtId}/archive`, { method: 'POST' })
                  if (res.ok) {
                    setWorktrees((prev) => prev.filter((w) => w.id !== wtId))
                    setActiveWorktreeId(null)
                    setActiveSessionId(null)
                  }
                }
                rightButton = (
                  <>
                    <button
                      onClick={() => setStartedOverClosedWorktrees((prev) => new Set(prev).add(wtId))}
                      className="rounded-md border border-white/25 bg-white/10 px-3 py-1 text-[11px] font-semibold text-white hover:bg-white/15"
                    >
                      Start over
                    </button>
                    <button
                      onClick={doArchive}
                      className="rounded-md bg-red-500 px-3 py-1 text-[11px] font-semibold text-white shadow-sm hover:bg-red-400"
                    >
                      Archive
                    </button>
                  </>
                )
              } else if (prReady) {
                // Ready to merge → real action button. Awaiting /
                // Changes requested are passive states (user just
                // waits for reviewer); the #PR chip on the left covers
                // "open on GitHub" so we leave this side empty there.
                rightButton = (
                  <button
                    onClick={() => window.open(pr.html_url, '_blank', 'noopener,noreferrer')}
                    className="rounded-md bg-emerald-500 px-3 py-1 text-[11px] font-semibold text-white shadow-sm hover:bg-emerald-400"
                  >
                    Merge
                  </button>
                )
              } else if (prConflicts && activeWorktreeId) {
                // Conflicts → user picks between manual resolver
                // overlay or delegating to the chat agent.
                const wtId = activeWorktreeId
                rightButton = (
                  <ResolveConflictsSplitButton
                    onManual={async () => {
                      if (MOCK_GIT_STATUS && MOCK_CONFLICTS) {
                        setConflictSession({ worktreeId: wtId, files: MOCK_CONFLICTS.files })
                        return
                      }
                      try {
                        const res = await fetch(`/api/projects/${projectId}/worktrees/${wtId}/rebase/start`, { method: 'POST' })
                        const data = await res.json().catch(() => ({}))
                        if (data.status === 'conflict') {
                          setConflictSession({ worktreeId: wtId, files: data.files ?? [] })
                        }
                      } catch {}
                    }}
                    onAgent={() => {
                      // Send a structured prompt to the active chat so
                      // the agent handles the rebase + resolution +
                      // push. User watches the conversation — if the
                      // agent picks wrong, they can correct inline.
                      window.dispatchEvent(new CustomEvent('bornastar-agent-prompt', {
                        detail: {
                          text: 'Merge the remote branch (main) into this branch and resolve the conflicts. After resolving, commit and push the merged result back to the branch. Explain each decision you make at a conflict so I can review.',
                        },
                      }))
                    }}
                  />
                )
              } else if (prDraft && activeWorktreeId) {
                // Draft → single action that flips the PR to "ready for
                // review". Backend hits the GraphQL mutation and the
                // next poll swings the bar to Awaiting / Ready.
                const wtId = activeWorktreeId
                const markReady = async () => {
                  try {
                    const res = await fetch(`/api/projects/${projectId}/worktrees/${wtId}/pr/mark-ready`, { method: 'POST' })
                    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'mark ready failed')
                    // Next poll reflects the real state. In the
                    // meantime, optimistically broadcast so the panel
                    // and this bar update without waiting.
                    window.dispatchEvent(new CustomEvent('bornastar-optimistic-ready'))
                  } catch {}
                }
                rightButton = (
                  <button
                    onClick={markReady}
                    className="rounded-md bg-white px-3 py-1 text-[11px] font-semibold text-zinc-900 shadow-sm hover:bg-zinc-100"
                  >
                    Mark ready for review
                  </button>
                )
              }
            } else if (activeGitStatus && !chatWorking) {
              // While the chat is working, the bar is "owned" by the
              // Working… indicator on the left — hide the action buttons
              // so the user's attention stays on the in-flight task. PR
              // banners (above) keep priority and still take over.
              const uncommitted = activeGitStatus.uncommitted
              const ahead = activeGitStatus.commitsAhead
              const buttons: React.ReactNode[] = []
              if (uncommitted > 0 || (ahead > 0 && !activeWorktreeId)) {
                // Commit-and-push covers both "dirty tree" and "main has
                // unpushed commits". Single action either way.
                buttons.push(
                  <button
                    key="commit"
                    onClick={() => setRightPanelTab('checks')}
                    title="Commit and push"
                    className="flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-[11px] font-semibold text-amber-300 hover:border-amber-500/60 hover:bg-amber-500/20"
                  >
                    {/* Up-arrow into a tray = push */}
                    <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={2.2} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 7.5m0 0L7.5 12m4.5-4.5v12" />
                    </svg>
                    Commit and push
                  </button>
                )
              }
              if ((uncommitted > 0 || ahead > 0) && activeWorktreeId) {
                buttons.push(
                  <SplitCreatePRButton
                    key="pr"
                    variant="emerald"
                    onCreate={(asDraft) => {
                      // Delegate to ChecksPanel (it owns the whole
                      // create flow: suggestion → auto-commit → push →
                      // PR POST → worktree rename). Switching to the
                      // tab also ensures the user sees the result.
                      setRightPanelTab('checks')
                      window.dispatchEvent(new CustomEvent('bornastar-create-pr', { detail: { asDraft } }))
                    }}
                  />
                )
              }
              if (buttons.length > 0) rightButton = <>{buttons}</>
            }

            return (
              <div className={`flex min-h-[40px] shrink-0 items-center justify-between border-b ${border} px-3 py-2`} style={{ backgroundColor: bg }}>
                <div className="flex min-w-0 items-center gap-2">
                  {isLoud && pr ? (
                    <>
                      {/* Worktree icon + PR number — single chip that
                          always links out to the PR on GitHub. Hover
                          reveals an "Open on GitHub" tooltip so the
                          affordance is discoverable across states. */}
                      <a
                        href={pr.html_url}
                        target="_blank"
                        rel="noreferrer"
                        className="group/prchip relative flex items-center gap-1.5 rounded-md bg-white/10 px-2 py-1 text-[11px] font-semibold text-white hover:bg-white/15"
                      >
                        <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={2.2} stroke="currentColor">
                          <circle cx="6" cy="6" r="2" />
                          <circle cx="6" cy="18" r="2" />
                          <circle cx="18" cy="18" r="2" />
                          <path d="M6 8v8M8 6h6a4 4 0 014 4v8" strokeLinecap="round" />
                        </svg>
                        #{pr.number}
                        <svg className="h-2.5 w-2.5 opacity-60 group-hover/prchip:opacity-100" fill="none" viewBox="0 0 24 24" strokeWidth={2.2} stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                        </svg>
                        <span className="pointer-events-none absolute left-0 top-full z-30 mt-1 whitespace-nowrap rounded-md border border-white/10 bg-zinc-900 px-2 py-1 text-[10px] font-normal text-zinc-100 opacity-0 shadow-lg transition-opacity duration-150 group-hover/prchip:opacity-100">
                          Open on GitHub
                        </span>
                      </a>
                      {/* Status label next to the chip — bigger, prominent. */}
                      <span className="text-[13px] font-semibold text-white">{pillLabel}</span>
                    </>
                  ) : null}
                  {chatWorking && (
                    <span className="flex items-center gap-2 text-[11px] font-medium text-emerald-300">
                      {/* Pulsing dot — calmer than a full spinner but
                          still reads as "alive". Two layers: a soft glow
                          ring + a solid center. */}
                      <span className="relative flex h-2 w-2 items-center justify-center">
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
                      </span>
                      {/* Shimmering label — the gradient sweeps left→right
                          while the agent is busy, gives the bar a feeling
                          of being "in motion" without spinning anything. */}
                      <span
                        className="bg-clip-text text-transparent"
                        style={{
                          backgroundImage: 'linear-gradient(90deg, rgba(110,231,183,0.7) 0%, rgba(110,231,183,1) 50%, rgba(110,231,183,0.7) 100%)',
                          backgroundSize: '200% 100%',
                          animation: 'bornastar-shimmer 1.6s linear infinite',
                        }}
                      >
                        Working
                      </span>
                      {/* Animated trailing dots — staggered so they bounce
                          one after the other. */}
                      <span className="inline-flex gap-0.5">
                        <span className="h-1 w-1 rounded-full bg-emerald-400" style={{ animation: 'bornastar-bounce 1s infinite', animationDelay: '0ms' }} />
                        <span className="h-1 w-1 rounded-full bg-emerald-400" style={{ animation: 'bornastar-bounce 1s infinite', animationDelay: '160ms' }} />
                        <span className="h-1 w-1 rounded-full bg-emerald-400" style={{ animation: 'bornastar-bounce 1s infinite', animationDelay: '320ms' }} />
                      </span>
                      <style>{`
                        @keyframes bornastar-shimmer {
                          0% { background-position: 200% 0; }
                          100% { background-position: -200% 0; }
                        }
                        @keyframes bornastar-bounce {
                          0%, 80%, 100% { transform: translateY(0); opacity: 0.4; }
                          40% { transform: translateY(-2px); opacity: 1; }
                        }
                      `}</style>
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  {rightButton}
                </div>
              </div>
            )
          })()}
          {/* Tabs row. Only Explorer is visible when no workspace is
              active (main state is a read-only snapshot — Changes and
              Checks don't apply until the user starts a workspace). */}
          <div className="flex shrink-0 items-center border-b border-[#2B2B2B] px-3" style={{ backgroundColor: '#1F1F1F' }}>
            {activeWorktreeId && (
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
                  <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-amber-400">
                    {changedFilesCount}
                  </span>
                )}
                {rightPanelTab === 'changes' && (
                  <span className="absolute bottom-0 left-2 right-2 h-[2px] rounded-full bg-white" />
                )}
              </button>
            )}
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
            {activeWorktreeId && (
              <button
                onClick={() => setRightPanelTab('checks')}
                className={`relative flex items-center gap-1.5 px-3 py-2.5 text-[12px] font-medium transition-colors ${
                  statusBadge
                    ? (rightPanelTab === 'checks' ? 'text-amber-300' : 'text-amber-400 hover:text-amber-300')
                    : (rightPanelTab === 'checks' ? 'text-zinc-100' : 'text-zinc-500 hover:text-zinc-300')
                }`}
              >
                Checks
                {rightPanelTab === 'checks' && (
                  <span className={`absolute bottom-0 left-2 right-2 h-[2px] rounded-full ${statusBadge ? 'bg-amber-400' : 'bg-white'}`} />
                )}
              </button>
            )}
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
            {activeWorktreeId && (
              <span className="mr-2 text-[11px] font-medium text-zinc-500">
                {worktrees.find((w) => w.id === activeWorktreeId)?.branchName ?? 'branch'} (branch)
              </span>
            )}
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
          <div className="min-h-0 flex-1 overflow-hidden" style={{ backgroundColor: '#181818' }}>
            {rightPanelTab === 'explorer' && (
              <FileTree key={activeWorktreeId ?? 'main'} projectId={projectId} worktreeId={activeWorktreeId} hasActiveSession={!!activeSessionId} mainState={!activeWorktreeId} />
            )}
            {rightPanelTab === 'changes' && (
              <ChangesList
                key={activeWorktreeId ?? 'main'}
                projectId={projectId}
                worktreeId={activeWorktreeId}
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
            {rightPanelTab === 'checks' && (
              <ChecksPanel
                projectId={projectId}
                sessionId={activeSessionId}
                worktreeId={activeWorktreeId}
                mergedBannerDismissed={!!activeWorktreeId && continuedMergedWorktrees.has(activeWorktreeId)}
                closedBannerDismissed={!!activeWorktreeId && startedOverClosedWorktrees.has(activeWorktreeId)}
                onArchive={async () => {
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

          {/* Terminal panel — retrátil. Checks now lives up in the header
              tab row next to Explorer/Changes; this stays terminal-only. */}
          {hasOpenChat && terminalOpen ? (
            <div className="flex h-1/2 shrink-0 flex-col border-t border-[#2B2B2B]" style={{ backgroundColor: '#181818' }}>
              <div className="flex shrink-0 items-center border-b border-[#2B2B2B] px-2" style={{ backgroundColor: '#1F1F1F' }}>
                <div className="flex items-center gap-1 px-2 py-1.5">
                  <svg className="h-3 w-3 text-emerald-400" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0021 18V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v12a2.25 2.25 0 002.25 2.25z" />
                  </svg>
                  <span className="text-[10px] font-medium text-zinc-300">Terminal</span>
                </div>
                <div className="flex-1" />
                <button
                  onClick={() => setTerminalOpen(false)}
                  className="flex h-5 w-5 items-center justify-center rounded text-zinc-600 hover:bg-white/5 hover:text-zinc-400"
                  title="Close terminal"
                >
                  <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                  </svg>
                </button>
              </div>
              <TerminalBody projectId={projectId} sessionId={activeSessionId} worktreeId={activeWorktreeId} />
            </div>
          ) : hasOpenChat ? (
            <button
              onClick={() => setTerminalOpen(true)}
              className="flex shrink-0 items-center gap-2 border-t border-[#2B2B2B] px-3 py-3 text-left transition-colors hover:bg-white/10"
              style={{ backgroundColor: '#252526' }}
            >
              <svg className="h-3.5 w-3.5 text-zinc-300" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 15.75l7.5-7.5 7.5 7.5" />
              </svg>
              <svg className="h-3.5 w-3.5 text-emerald-400" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0021 18V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v12a2.25 2.25 0 002.25 2.25z" />
              </svg>
              <span className="text-[12px] font-medium text-zinc-200">Terminal</span>
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
// Data types — the real list will get hydrated from the per-worktree /
// per-session change endpoints when the integration lands.

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
  fullDiff?: DiffLine[]
  uncommitted?: boolean
  // First worktree that touched this file — used to fetch the correct
  // version when opening the inline diff. Optional because the legacy
  // mock data doesn't carry it.
  worktreeId?: string
}

function getMockChangeForPath(path: string): MockChangedFile | null {
  return MOCK_CHANGES.find((f) => f.path === path) ?? null
}

// Empty until the real change feed is wired. Populate via API once the
// worktree changes endpoint is hooked in; ChangesList handles empty
// state natively.
const MOCK_CHANGES: MockChangedFile[] = []

const STATUS_ICONS: Record<string, { symbol: string; text: string; bg: string; border: string }> = {
  M: { symbol: '•', text: 'text-amber-400', bg: 'bg-amber-400/10', border: 'border-amber-400/30' },
  A: { symbol: '+', text: 'text-emerald-400', bg: 'bg-emerald-400/10', border: 'border-emerald-400/30' },
  D: { symbol: '−', text: 'text-red-400', bg: 'bg-red-400/10', border: 'border-red-400/30' },
}

// Compact inline diff for the Changes tab drill-in view. Fetches the file's
// current and original content from the per-file endpoint and builds hunks
// via jsdiff (LCS-based, so inserts/deletes don't cascade). Only the
// changed lines + 3 lines of context before/after are rendered — the rest
// of the file is skipped entirely, so a small edit to a 500-line file
// shows ~7 lines, not 500.
function buildHunksFromContents(original: string, current: string, contextLines = 3): DiffHunk[] {
  const parts = diffLines(original, current)
  // Flatten parts into a linear stream of typed lines. Track running old /
  // new line numbers so each line has the correct "sidebar" line number.
  type FlatLine = { type: 'context' | 'add' | 'remove'; content: string; oldLine?: number; newLine?: number }
  const flat: FlatLine[] = []
  let oldLine = 0
  let newLine = 0
  for (const p of parts) {
    // jsdiff strips the trailing newline — re-split strictly on \n and drop
    // the final empty string that appears when the chunk ended in \n.
    const pieces = p.value.split('\n')
    if (pieces.length > 0 && pieces[pieces.length - 1] === '') pieces.pop()
    for (const piece of pieces) {
      if (p.added) {
        newLine += 1
        flat.push({ type: 'add', content: piece, newLine })
      } else if (p.removed) {
        oldLine += 1
        flat.push({ type: 'remove', content: piece, oldLine })
      } else {
        oldLine += 1
        newLine += 1
        flat.push({ type: 'context', content: piece, oldLine, newLine })
      }
    }
  }

  // Group changed regions into hunks with `contextLines` context on each
  // side. Consecutive changes with ≤ (contextLines * 2) context between
  // them get merged into a single hunk to avoid a broken-up view.
  const changedIndices: number[] = []
  flat.forEach((l, i) => { if (l.type !== 'context') changedIndices.push(i) })
  if (changedIndices.length === 0) return []

  const ranges: Array<{ start: number; end: number }> = []
  let rangeStart = Math.max(0, changedIndices[0] - contextLines)
  let rangeEnd = Math.min(flat.length - 1, changedIndices[0] + contextLines)
  for (let k = 1; k < changedIndices.length; k++) {
    const idx = changedIndices[k]
    const expandedStart = Math.max(0, idx - contextLines)
    const expandedEnd = Math.min(flat.length - 1, idx + contextLines)
    if (expandedStart <= rangeEnd + 1) {
      rangeEnd = Math.max(rangeEnd, expandedEnd)
    } else {
      ranges.push({ start: rangeStart, end: rangeEnd })
      rangeStart = expandedStart
      rangeEnd = expandedEnd
    }
  }
  ranges.push({ start: rangeStart, end: rangeEnd })

  return ranges.map((r) => {
    const hunkLines: DiffLine[] = []
    for (let i = r.start; i <= r.end; i++) {
      const l = flat[i]
      hunkLines.push({
        type: l.type,
        content: l.content,
        oldLine: l.oldLine,
        newLine: l.newLine,
      })
    }
    const first = flat[r.start]
    return {
      oldStart: first.oldLine ?? 1,
      newStart: first.newLine ?? 1,
      lines: hunkLines,
    }
  })
}

function InlineDiffView({
  projectId,
  path,
  worktreeId,
  onAttachToCurrent,
  onAttachToNew,
  fileStatus,
}: {
  projectId: string
  path: string
  worktreeId: string | null
  onAttachToCurrent: (filePath: string, fileStatus: 'M' | 'A' | 'D', hunk: DiffHunk) => void
  onAttachToNew: (filePath: string, fileStatus: 'M' | 'A' | 'D', hunk: DiffHunk) => void
  fileStatus: 'M' | 'A' | 'D'
}) {
  const [state, setState] = useState<{ content: string; originalContent: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    const qs = worktreeId ? `?worktree=${worktreeId}` : ''
    fetch(`/api/projects/${projectId}/repository/files/${encodeURIComponent(path)}${qs}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((data) => {
        if (cancelled) return
        setState({ content: data.content ?? '', originalContent: data.originalContent ?? '' })
        setLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err?.message ?? 'failed to load diff')
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [projectId, path, worktreeId])

  if (loading) {
    return <div className="flex h-full items-center justify-center text-[11px] text-zinc-500">Loading diff…</div>
  }
  if (error) {
    return <div className="flex h-full items-center justify-center text-[11px] text-red-400">Failed: {error}</div>
  }
  if (!state) return null

  const hunks = buildHunksFromContents(state.originalContent, state.content, 3)

  if (hunks.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-[11px] text-zinc-500">
        No changes in this file.
      </div>
    )
  }

  return (
    <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
      {hunks.map((hunk, hi) => (
        <DiffHunkView
          key={hi}
          hunk={hunk}
          filePath={path}
          onCopy={() => {
            const text = hunk.lines.map((l) => {
              const marker = l.type === 'add' ? '+' : l.type === 'remove' ? '-' : ' '
              return `${marker}${l.content}`
            }).join('\n')
            navigator.clipboard?.writeText(text).catch(() => {})
          }}
          onAttachToCurrent={() => onAttachToCurrent(path, fileStatus, hunk)}
          onAttachToNew={() => onAttachToNew(path, fileStatus, hunk)}
        />
      ))}
    </div>
  )
}

function ChangesList({
  projectId,
  worktreeId,
  selectMode,
  onExitSelectMode,
  onAttachToCurrent,
  onAttachToNew,
  onBulkAttachToCurrent,
  onBulkAttachToNew,
  onOpenFile,
}: {
  projectId: string
  worktreeId?: string | null
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

  // Fetch real modified files from the repository API — replaces the old
  // MOCK_CHANGES array. Polls every 5s so new edits from active chats show
  // up live, matching the Explorer tree refresh cadence. Hunks aren't
  // returned here yet, so drill-into-diff view falls back to a simple
  // header + open-in-explorer action until the per-file diff endpoint ships.
  const [realChanges, setRealChanges] = useState<MockChangedFile[]>([])
  useEffect(() => {
    let cancelled = false
    const wtqs = worktreeId ? `?worktree=${worktreeId}` : ''
    async function load() {
      try {
        const res = await fetch(`/api/projects/${projectId}/repository/files${wtqs}`)
        if (!res.ok) return
        const data = await res.json()
        if (cancelled) return
        const allFiles = data.files ?? []
        const modFiles = allFiles.filter((f: { isModified?: boolean }) => f.isModified)
        const mapped: MockChangedFile[] = modFiles.map((f: {
          path: string; isNew?: boolean; added?: number; removed?: number;
          worktrees?: { id: string; name: string }[]
        }) => ({
          path: f.path,
          status: (f.isNew ? 'A' : 'M') as 'M' | 'A' | 'D',
          added: f.added ?? 0,
          removed: f.removed ?? 0,
          hunks: [],
          worktreeId: worktreeId ?? f.worktrees?.[0]?.id,
        }))
        setRealChanges(mapped)
      } catch (err) {
        console.error('[ChangesList] fetch failed:', err)
      }
    }
    load()
    // Push-based refresh — refetch only when the companion watcher
    // reports a real filesystem change. Debounced to coalesce burst
    // saves (editor format-on-save hits us 3-4x per save).
    let debounce: ReturnType<typeof setTimeout> | null = null
    function onFsChange() {
      if (debounce) return
      debounce = setTimeout(() => { debounce = null; load() }, 400)
    }
    window.addEventListener('bornastar-fs-change', onFsChange)
    return () => {
      cancelled = true
      window.removeEventListener('bornastar-fs-change', onFsChange)
      if (debounce) clearTimeout(debounce)
    }
  }, [projectId, worktreeId])

  const filtered = realChanges
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
  const openedFile = openedPath ? filtered.find((f) => f.path === openedPath) : null
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

        {/* Inline diff — fetched from per-file endpoint using the worktree
            that touched this file. Uses jsdiff for real LCS-based hunks
            with 3 lines of context before/after each change, so a small
            edit in a large file shows only the relevant block. */}
        <InlineDiffView
          projectId={projectId}
          path={openedFile.path}
          worktreeId={openedFile.worktreeId ?? null}
          fileStatus={openedFile.status}
          onAttachToCurrent={onAttachToCurrent}
          onAttachToNew={onAttachToNew}
        />
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
            onClick={() => {
              if (selectMode) { toggleSelect(file.path); return }
              setOpenedPath(file.path)
            }}
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

            {/* U badge — only on files that haven't been committed yet. Sits
                where the status square would go so committed/uncommitted
                are immediately distinguishable at the end of the row. */}
            {file.uncommitted && (
              <span
                title="Uncommitted"
                className="flex h-4 w-4 shrink-0 items-center justify-center rounded border border-amber-400/40 bg-amber-400/10 text-[10px] font-bold leading-none text-amber-400"
              >
                U
              </span>
            )}

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
// Read-only Shiki renderer — used inside the main-state file overlay.
// Same engine that powers the diff views: one-dark-pro theme, custom
// indent guides, VS Code-ish proportions. Sits body-only inside the
// parent overlay so the parent renders the header / back button.
function ReadOnlyShikiView({ path, content }: { path: string; content: string }) {
  const htmlLines = useShikiLines(content, path)
  const plainLines = content.split('\n')
  const effIndents = getEffectiveIndents(plainLines)
  return (
    <div className="h-full overflow-y-auto overflow-x-hidden text-[13px] leading-[1.5] font-mono" style={{ backgroundColor: '#1F1F1F' }}>
      {htmlLines.map((lineHtml, i) => (
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
      ))}
    </div>
  )
}

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

function FileTree({ projectId, worktreeId, hasActiveSession, mainState }: { projectId: string; worktreeId?: string | null; hasActiveSession?: boolean; mainState?: boolean }) {
  // Query-string helper: append ?worktree=ID to every file API call so the
  // tree, reads, writes and PATCH operations all stay scoped to the active
  // worktree. Main (no worktree) continues to use the project root.
  const wtqs = worktreeId ? `?worktree=${worktreeId}` : ''
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
    fetch(`/api/projects/${projectId}/repository/files${wtqs}`)
      .then((r) => r.json())
      .then((data) => { setFiles(data.files ?? []); setLoading(false) })
      .catch(() => setLoading(false))
  }

  useEffect(() => {
    fetchFiles()
    // No polling — the companion daemon's fs watcher pushes a
    // `bornastar-fs-change` window event whenever a real file is added,
    // edited or deleted. We refetch only on that signal (plus a tiny
    // debounce so burst saves don't fire N requests).
    let debounce: ReturnType<typeof setTimeout> | null = null
    function onFsChange() {
      if (debounce) return
      debounce = setTimeout(() => { debounce = null; fetchFiles() }, 400)
    }
    window.addEventListener('bornastar-fs-change', onFsChange)
    return () => {
      window.removeEventListener('bornastar-fs-change', onFsChange)
      if (debounce) clearTimeout(debounce)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, worktreeId])

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
    // Reading order of preference:
    //   1. The active worktree (full isolation — we're inside worktree A, always
    //      read worktree A's copy so the user sees its in-progress state).
    //   2. On main view: a file touched by exactly one worktree shows that
    //      worktree's version. Files touched by several fall back to main.
    const fileEntry = files.find((f) => f.path === path)
    const singleWorktreeId = !worktreeId && fileEntry?.worktrees?.length === 1
      ? fileEntry.worktrees[0].id
      : null
    const effectiveWorktreeId = worktreeId ?? singleWorktreeId
    const worktreeParam = effectiveWorktreeId ? `?worktree=${effectiveWorktreeId}` : ''
    const res = await fetch(`/api/projects/${projectId}/repository/files/${encodeURIComponent(path)}${worktreeParam}`)
    if (res.ok) {
      const data = await res.json()
      setViewingFile({ path, content: data.content, worktreeId: effectiveWorktreeId })
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
      await fetch(`/api/projects/${projectId}/repository/files${wtqs}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, action: 'accept' }),
      })
      // Create empty file via the tools endpoint approach
      const repo = files[0] // just need any file to get repositoryId pattern
      if (repo) {
        await fetch(`/api/projects/${projectId}/repository/files${wtqs}`, {
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
    await fetch(`/api/projects/${projectId}/repository/files${wtqs}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: oldPath, action: 'rename', newName }),
    })
    fetchFiles()
  }

  async function handleDelete(path: string) {
    await fetch(`/api/projects/${projectId}/repository/files${wtqs}`, {
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

    await fetch(`/api/projects/${projectId}/repository/files${wtqs}`, {
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
    <div className="relative flex h-full w-full min-w-0 flex-col border-r border-[#2B2B2B]" style={{ backgroundColor: '#181818' }}>
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
            {/* Workspace file = editable CodeMirror. Main-state file =
                read-only Shiki view (syntax-highlighted + indent
                guides, matches the look of the diff renderer). */}
            {viewingFile.worktreeId ? (
              <CodeMirrorFileView
                ref={editorRef}
                projectId={projectId}
                filePath={viewingFile.path}
                initialContent={viewingFile.content}
                worktreeId={viewingFile.worktreeId}
                onDirtyChange={setEditorDirty}
              />
            ) : (
              <ReadOnlyShikiView path={viewingFile.path} content={viewingFile.content} />
            )}
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
          {/* Edit actions — hidden in main state (read-only preview) */}
          {!mainState && (
            <>
              <button onClick={() => { setCreatingType('file'); setCreatingName('') }} title="New File" className="flex h-5 w-5 items-center justify-center rounded text-zinc-500 hover:bg-white/10 hover:text-zinc-300">
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m3.75 9v6m3-3H9m1.5-12H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                </svg>
              </button>
              <button onClick={() => { setCreatingType('folder'); setCreatingName('') }} title="New Folder" className="flex h-5 w-5 items-center justify-center rounded text-zinc-500 hover:bg-white/10 hover:text-zinc-300">
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 10.5v6m3-3H9m4.06-7.19l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
                </svg>
              </button>
              <button onClick={() => setShowDiffModal(true)} title="View Changes" className="flex h-5 w-5 items-center justify-center rounded text-zinc-500 hover:bg-white/10 hover:text-zinc-300">
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
                </svg>
              </button>
            </>
          )}
          {/* Always-on: search + collapse */}
          <button onClick={() => setShowSearch(!showSearch)} title="Search Files" className="flex h-5 w-5 items-center justify-center rounded text-zinc-500 hover:bg-white/10 hover:text-zinc-300">
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
            </svg>
          </button>
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
  initialCompanionMessages,
  onCompanionMessagesChange,
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
  initialCompanionMessages: ChatMessage[]
  onCompanionMessagesChange: (msgs: ChatMessage[]) => void
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
  const [showSelector, setShowSelector] = useState(false)
  const [selectorTab, setSelectorTab] = useState<'employees' | 'teams'>('employees')
  const [attachments, setAttachments] = useState<{ file: File; preview: string; type: 'image' | 'pdf' | 'text' }[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const [contextPaths, setContextPaths] = useState<string[]>([])

  // ── Persistence seed (with pagination) ────────────────────────────
  // On mount, hydrate the most recent page from the DB. Older messages
  // load on demand when the user scrolls to the top — a full chat with
  // thousands of turns stays snappy because we never hold everything at
  // once in memory or fling it over the wire.
  const PAGE_SIZE = 100
  const [dbSeed, setDbSeed] = useState<{ messages: ChatMessage[]; claudeSessionId: string | null } | null>(null)
  const [hasMoreOlder, setHasMoreOlder] = useState(false)
  const [oldestMessageId, setOldestMessageId] = useState<string | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)

  type DbMessage = {
    id: string; role: ChatMessage['role']; content: string; createdAt: string
    toolName?: string | null; toolInput?: unknown; toolResult?: unknown
    toolUseId?: string | null; toolError?: boolean
    costUsd?: number | null; durationMs?: number | null
  }
  const mapDbMessages = (msgs: DbMessage[]): ChatMessage[] => msgs.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    timestamp: new Date(m.createdAt).getTime(),
    toolName: m.toolName ?? undefined,
    toolInput: m.toolInput as Record<string, unknown> | undefined,
    toolResult: typeof m.toolResult === 'string'
      ? m.toolResult
      : (m.toolResult ? JSON.stringify(m.toolResult) : undefined),
    toolUseId: m.toolUseId ?? undefined,
    toolError: m.toolError ?? undefined,
    costUsd: m.costUsd ?? undefined,
    durationMs: m.durationMs ?? undefined,
  }))

  // Fetch the latest page. Defer hydration into the hook until after it
  // mounts (companion ref available) so we replace / merge correctly
  // instead of relying on the mount-time seed.
  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    fetch(`/api/projects/${projectId}/chat-sessions/${sessionId}/messages?limit=${PAGE_SIZE}`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (cancelled || !data) return
        const msgs = mapDbMessages(data.messages ?? [])
        setDbSeed({ messages: msgs, claudeSessionId: data.claudeSessionId ?? null })
        setHasMoreOlder(!!data.hasMore)
        setOldestMessageId(msgs[0]?.id ?? null)
      })
      .catch(() => {})
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, sessionId])

  // Pick the richest seed available: the DB has the authoritative copy,
  // but while it loads we use whatever the parent cached for this chat.
  const seedMessages = dbSeed?.messages ?? initialCompanionMessages

  // ── Companion stream (Claude Code CLI) ──────────────────────────
  // Tag the hook with this chat's Bornastar session so it filters events
  // belonging to other chats, and hand it the persistence config so
  // every streamed event mirrors to the DB in real time.
  const companion = useCompanionStream(
    sessionId,
    seedMessages,
    sessionId ? { projectId, initialClaudeSessionId: dbSeed?.claudeSessionId ?? null } : undefined,
  )
  const companionConnected = companion.status === 'connected'

  // Mirror every change back up to the parent store so siblings (or this
  // chat re-mounted later) can pick the conversation back up instantly.
  useEffect(() => {
    onCompanionMessagesChange(companion.messages)
  }, [companion.messages, onCompanionMessagesChange])

  // Hydrate the hook with the first DB page as soon as it lands. The
  // hook guards against clobbering in-flight streaming state, so this
  // is safe to fire even if the user already started typing / Claude
  // already started replying.
  useEffect(() => {
    if (!dbSeed) return
    companion.hydrate(dbSeed.messages, dbSeed.claudeSessionId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dbSeed])

  // Load the next older page on scroll-to-top. Uses the hook's
  // prependMessages so the already-rendered array grows upward without
  // tripping over dbSeed (which is the hydrate source, not the render source).
  const loadOlderMessages = useCallback(async () => {
    if (!sessionId || !hasMoreOlder || loadingOlder || !oldestMessageId) return
    setLoadingOlder(true)
    try {
      const res = await fetch(`/api/projects/${projectId}/chat-sessions/${sessionId}/messages?limit=${PAGE_SIZE}&before=${oldestMessageId}`)
      if (!res.ok) return
      const data = await res.json()
      const older = mapDbMessages(data.messages ?? [])
      if (older.length > 0) {
        companion.prependMessages(older)
        setOldestMessageId(older[0].id)
      }
      setHasMoreOlder(!!data.hasMore)
    } catch { /* ignore */ }
    setLoadingOlder(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, sessionId, hasMoreOlder, loadingOlder, oldestMessageId])
  const [claudeMode, setClaudeMode] = useState<'plan' | 'edit' | 'auto' | 'agent'>('auto')

  // The companion daemon has its own project registry with hex IDs keyed by
  // local path. We need to resolve the Bornastar DB projectId → companion hex ID
  // by matching sandboxId (local path) against companion.companionInfo.projects.
  const [sandboxId, setSandboxId] = useState<string | null>(null)
  useEffect(() => {
    fetch(`/api/projects/${projectId}/terminal`)
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (d?.sandboxId) setSandboxId(d.sandboxId) })
      .catch(() => {})
  }, [projectId])

  const companionProjectId = sandboxId && companion.companionInfo?.projects
    ? (companion.companionInfo.projects.find((p) => p.path === sandboxId)?.id ?? null)
    : null

  // External prompts — e.g. "Resolve with agent" on the Conflicts top
  // bar fires this event with a prefilled message. We drop it into the
  // input so the user can tweak before sending (safer than auto-send).
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ text?: string }>).detail
      if (detail?.text) setInput((prev) => prev ? prev : detail.text!)
    }
    window.addEventListener('bornastar-agent-prompt', handler)
    return () => window.removeEventListener('bornastar-agent-prompt', handler)
  }, [])
  const [showToolbarMenu, setShowToolbarMenu] = useState(false)
  const [showContextPicker, setShowContextPicker] = useState(false)
  const [showClearConfirm, setShowClearConfirm] = useState(false)
  const [showReminderModal, setShowReminderModal] = useState(false)
  const [selectedModel, setSelectedModel] = useState<string>('sonnet')
  const [thinkingLevel, setThinkingLevel] = useState<string>('off')
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
    companion.clearMessages()
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

  // Auto-scroll to the newest message. Reduce the companion stream to a
  // single primitive signature (count + last content length) so the dep
  // array stays a fixed shape and doesn't churn on unrelated state changes.
  const lastCompanion = companion.messages[companion.messages.length - 1]
  const scrollSignature = `${companion.messages.length}:${lastCompanion?.content?.length ?? 0}:${companion.isRunning ? 1 : 0}`
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [scrollSignature])

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

  // Notify parent when Claude is running so sidebar shows spinner.
  useEffect(() => {
    onBusyChange(sessionId, companion.isRunning)
  }, [companion.isRunning, sessionId, onBusyChange])

  async function sendMessage(e: React.FormEvent) {
    e.preventDefault()
    const userText = input.trim()
    if ((!userText && attachments.length === 0 && hunkAttachments.length === 0) || companion.isRunning) return

    // If the companion isn't reachable or the project isn't registered on
    // the daemon, bail BEFORE clearing the input so the user doesn't lose
    // their message. Surface a clear error instead of a silent disappear.
    if (!companionConnected || !companionProjectId) {
      console.warn('[chat] cannot send — companion not ready', { companionConnected, companionProjectId })
      return
    }

    const content = hunkAttachments.length > 0
      ? `${hunkAttachments.map((h) => h.formattedContent).join('')}${userText}`
      : userText

    // Auto-rename the chat using the first user message
    const isFirstMessage = companion.messages.filter(m => m.role === 'user').length === 0
    if (isFirstMessage && userText) {
      const title = userText.split(/\s+/).slice(0, 5).join(' ').slice(0, 40)
      onSessionRenamed(title)
    }

    setInput('')
    setAttachments([])
    if (hunkAttachments.length > 0) onClearAllHunkAttachments()
    window.dispatchEvent(new CustomEvent('bornastar-continue-merged'))
    window.dispatchEvent(new CustomEvent('bornastar-start-over-closed'))

    // All chat goes through Claude Code via the companion daemon. Pass the
    // Bornastar session ID so the server can resolve the worktree path and
    // so each chat's bridge is keyed independently on the daemon.
    if (companionConnected && companionProjectId) {
      await companion.sendPrompt(companionProjectId, content, claudeMode, sessionId, {
        model: selectedModel,
        // Haiku has no extended-thinking support — force 'off' regardless
        // of the stored selector state (UI already disables the picker).
        thinking: selectedModel === 'haiku' ? 'off' : (thinkingLevel as 'off' | 'low' | 'medium' | 'high'),
      })
    }
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

      {/* Messages — renders companion stream or legacy engine */}
      <div
        className="flex-1 overflow-y-auto p-4 space-y-3"
        onScroll={(e) => {
          // When the user scrolls near the top, fetch the previous page
          // of messages. 100px threshold so the scrollbar settles on the
          // loading row without fighting the fetch.
          if (e.currentTarget.scrollTop < 100) loadOlderMessages()
        }}
      >
        {/* Infinite-scroll sentinel — visible when older messages exist. */}
        {hasMoreOlder && (
          <div className="flex justify-center py-2 text-[11px] text-zinc-500">
            {loadingOlder ? 'Loading earlier messages…' : 'Scroll up for earlier messages'}
          </div>
        )}

        {/* ── Claude Code via companion ─────────────────────────────── */}
        {companion.messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-3">
            <CompanionStatusBadge status={companion.status} info={companion.companionInfo} />
            <p className="text-sm text-zinc-400">
              {companion.status === 'connecting' ? 'Connecting to companion…' :
               companion.status === 'connected' ? 'Send a message to start coding with Claude Code' :
               companion.status === 'error' ? 'Companion error — check terminal' :
               'Start the companion: bornastar start'}
            </p>
          </div>
        )}
        {companion.messages.map((msg: ChatMessage) => {
          if (msg.role === 'user') {
            return (
              <div key={msg.id} className="flex justify-end">
                <div className="max-w-[85%] rounded-xl bg-[#3C3C3C] px-4 py-2 text-sm text-zinc-100">
                  {msg.content}
                </div>
              </div>
            )
          }
          if (msg.role === 'tool') {
            return <ClaudeToolCard key={msg.id} message={msg} />
          }
          if (msg.role === 'system') {
            // Skip the per-turn cost/duration/turns card — that noise after
            // every reply is distracting and adds nothing for day-to-day use.
            if (msg.costUsd !== undefined) return null
            return (
              <div key={msg.id} className="flex justify-start">
                <p className="text-xs italic text-zinc-500">{msg.content}</p>
              </div>
            )
          }
          return (
            <div key={msg.id} className="flex justify-start">
              <div className="w-full max-w-[90%]">
                <MarkdownRenderer content={msg.content} />
              </div>
            </div>
          )
        })}
        {companion.isRunning && (
          <ThinkingIndicator mode="direct" />
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
                disabled={companion.isRunning}
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


            {/* Model selector — same dropdown style as the mode picker.
                Passes --model <alias> to the Claude CLI; aliases resolve
                to the freshest minor version automatically. */}
            <ModelSelector
              model={selectedModel as 'haiku' | 'sonnet' | 'opus'}
              onChange={(m) => setSelectedModel(m)}
            />

            {/* Thinking selector — only rendered for models that support
                extended thinking (Sonnet + Opus). Haiku 4.5 has no
                thinking capability so the control disappears entirely. */}
            {selectedModel !== 'haiku' && (
              <ThinkingSelector
                thinking={thinkingLevel as 'off' | 'low' | 'medium' | 'high'}
                onChange={(t) => setThinkingLevel(t)}
              />
            )}

            {/* Mode selector — compact dropdown right before the send button */}
            <ModeSelector mode={claudeMode} onChange={setClaudeMode} />

            {/* Submit / stop button */}
            {companion.isRunning ? (
              <button
                type="button"
                onClick={() => companionProjectId && companion.interrupt(companionProjectId, sessionId)}
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
                disabled={(!input.trim() && attachments.length === 0) || !companionConnected || !companionProjectId}
                title={!companionConnected ? 'Start companion: bornastar start' : !companionProjectId ? 'Project not registered in companion' : 'Send'}
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
