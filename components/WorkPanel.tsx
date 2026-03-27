'use client'

import { useState, useEffect, useRef } from 'react'
import { ChatTabs } from './ChatTabs'
import { ReportBadge } from './ChatReport'
import type { ChatReport } from '@/lib/report-types'

// ── Types ──────────────────────────────────────────────────────────────────

interface FileEntry {
  id: string
  path: string
  isModified: boolean
  isNew: boolean
  sizeBytes: number
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
}

interface SessionInfo {
  id: string
  name: string
}

export function WorkPanel({ projectId, hiredEmployees, teams }: WorkPanelProps) {
  const [activeMode, setActiveMode] = useState<ChatMode>('no_skill')
  const [activeSkillId, setActiveSkillId] = useState<string | null>(null)
  const [activeTeamId, setActiveTeamId] = useState<string | null>(null)
  const [chatMessages, setChatMessages] = useState<Message[]>([])
  const [teamRunState, setTeamRunState] = useState<unknown>(null)
  const [teamRunActive, setTeamRunActive] = useState(false)

  // Session management
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)

  const activeEmployee = hiredEmployees.find((e) => e.id === activeSkillId)
  const activeTeam = teams.find((t) => t.id === activeTeamId)

  // Load sessions on mount
  useEffect(() => {
    fetch(`/api/projects/${projectId}/chat-sessions`)
      .then((r) => r.json())
      .then((data) => {
        const loaded = data.sessions ?? []
        setSessions(loaded)
        if (loaded.length > 0) {
          setActiveSessionId(loaded[loaded.length - 1].id)
        }
      })
      .catch(() => {})
  }, [projectId])

  // Load messages when active session changes
  useEffect(() => {
    if (!activeSessionId) { setChatMessages([]); return }
    fetch(`/api/projects/${projectId}/chat-sessions/${activeSessionId}`)
      .then((r) => r.json())
      .then((data) => setChatMessages((data.messages ?? []).map((m: Message) => ({ ...m, mode: m.mode ?? 'no_skill', activeSkillId: m.activeSkillId ?? null }))))
      .catch(() => setChatMessages([]))
  }, [activeSessionId, projectId])

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
      const { oldId, newId, name } = (e as CustomEvent).detail
      setSessions((prev) => prev.map((s) => s.id === oldId ? { id: newId, name } : s))
      if (activeSessionId === oldId) setActiveSessionId(newId)
    }
    window.addEventListener('session-replaced', handleReplace)
    return () => window.removeEventListener('session-replaced', handleReplace)
  }, [activeSessionId])

  async function handleNewSession() {
    const res = await fetch(`/api/projects/${projectId}/chat-sessions`, { method: 'POST' })
    if (res.ok) {
      const session = await res.json()
      setSessions((prev) => [...prev, { id: session.id, name: session.name }])
      setActiveSessionId(session.id)
      setChatMessages([])
    }
  }

  async function handleCloseSession(id: string) {
    await fetch(`/api/projects/${projectId}/chat-sessions/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'closed' }),
    })
    setSessions((prev) => prev.filter((s) => s.id !== id))
    if (activeSessionId === id) {
      const remaining = sessions.filter((s) => s.id !== id)
      setActiveSessionId(remaining.length > 0 ? remaining[remaining.length - 1].id : null)
    }
  }

  async function handleRenameSession(id: string, name: string) {
    await fetch(`/api/projects/${projectId}/chat-sessions/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    setSessions((prev) => prev.map((s) => s.id === id ? { ...s, name } : s))
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

  const hasOpenChat = activeSessionId !== null

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Left: File tree */}
      <div className="flex w-[35%] min-w-0 shrink-0">
        <FileTree projectId={projectId} />
      </div>

      {/* Center: Chat */}
      <div className="flex flex-1 flex-col">
        {hasOpenChat ? (
          <>
            <ChatTabs
              projectId={projectId}
              activeSessionId={activeSessionId}
              sessions={sessions}
              onSelectSession={setActiveSessionId}
              onNewSession={handleNewSession}
              onCloseSession={handleCloseSession}
              onRenameSession={handleRenameSession}
              isWorking={teamRunActive}
            />
            <div className="flex flex-1 overflow-hidden">
              <ChatPanel
                projectId={projectId}
                sessionId={activeSessionId}
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
                onSessionRenamed={(name: string) => handleRenameSession(activeSessionId!, name)}
              />
            </div>
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-4" style={{ backgroundColor: '#15151c' }}>
            <img src="/claude-logo.png" alt="Claude" className="h-16 w-16 rounded-full" />
            <div className="text-center">
              <p className="text-sm font-medium text-zinc-300">Start a conversation</p>
              <p className="mt-1 text-xs text-zinc-400">Open a chat to talk with Claude or your AI team</p>
            </div>
            <button
              onClick={handleNewSession}
              className="rounded-full bg-violet-600 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-violet-500 shadow-sm shadow-violet-500/20"
            >
              New Chat
            </button>
          </div>
        )}
      </div>

      {/* Right: Mini map */}
      <MiniMap
        projectId={projectId}
        activeMode={activeMode}
        activeEmployee={activeEmployee}
        activeTeam={activeTeam}
        messages={chatMessages}
        hiredEmployees={hiredEmployees}
        teamRunState={teamRunState}
        teamRunActive={teamRunActive}
      />
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


// ── File Tree ──────────────────────────────────────────────────────────────

function FileTree({ projectId }: { projectId: string }) {
  const [files, setFiles] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [viewingFile, setViewingFile] = useState<{ path: string; content: string } | null>(null)
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
  const creatingRef = useRef<HTMLInputElement>(null)

  function fetchFiles() {
    fetch(`/api/projects/${projectId}/repository/files`)
      .then((r) => r.json())
      .then((data) => { setFiles(data.files ?? []); setLoading(false) })
      .catch(() => setLoading(false))
  }

  useEffect(() => { fetchFiles() }, [projectId])

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
    const res = await fetch(`/api/projects/${projectId}/repository/files/${encodeURIComponent(path)}`)
    if (res.ok) {
      const data = await res.json()
      setViewingFile({ path, content: data.content })
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
    <div className="relative flex w-full min-w-0 flex-col border-r border-white/15" style={{ backgroundColor: '#1a1a22' }}>
      {/* File viewer overlay */}
      {viewingFile && (
        <div className="absolute inset-0 z-10 flex flex-col" style={{ backgroundColor: '#1a1a22' }}>
          <div className="flex shrink-0 items-center justify-between border-b border-white/15 px-3 py-1.5" style={{ backgroundColor: '#1e1e28' }}>
            <div className="flex items-center gap-1.5">
              <FileIcon name={viewingFile.path.split('/').pop() ?? ''} size={14} />
              <span className="text-[10px] font-medium text-zinc-300">{viewingFile.path}</span>
            </div>
            <button onClick={() => setViewingFile(null)} className="text-zinc-500 hover:text-zinc-300">
              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <div className="flex-1 overflow-auto px-3 py-2 text-[12px] leading-5 font-mono" style={{ backgroundColor: '#15151c' }}>
            <table className="w-full border-collapse">
              <tbody>
                {viewingFile.content.split('\n').map((line, i) => (
                  <tr key={i} className="hover:bg-white/5">
                    <td className="sticky left-0 w-10 shrink-0 select-none pr-4 text-right align-top text-zinc-500" style={{ backgroundColor: '#15151c' }}>{i + 1}</td>
                    <td className={`whitespace-pre relative language-${getLanguage(viewingFile.path)}`}>
                      <IndentGuides line={line} />
                      <code className={`language-${getLanguage(viewingFile.path)}`} dangerouslySetInnerHTML={{ __html: highlightCode(line || ' ', viewingFile.path) }} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Explorer header with action buttons */}
      <div className="flex items-center justify-between border-b border-white/15 px-3 py-2">
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
          <TreeNode node={tree} depth={0} selectedPath={selectedPath} onSelect={handleSelectFile} collapseKey={collapseKey} onContextMenu={handleContextMenu} onMove={handleMoveFile} />
        )}
      </div>

      {/* Changes bar + review panel */}
      {modifiedFiles.length > 0 && (
        <div className="shrink-0 border-t border-white/15">
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
            <div className="border-t border-white/10">
              {/* Review all button */}
              <button
                onClick={(e) => { e.stopPropagation(); setShowReviewModal(true); setReviewFilePath(null) }}
                className="flex w-full items-center justify-center gap-1.5 border-b border-white/10 px-3 py-1.5 text-[10px] font-medium text-violet-400 hover:bg-violet-500/5"
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
                  return (
                    <div
                      key={f.id}
                      className={`group flex items-center gap-2 rounded px-2 py-1.5 ${
                        reviewingFile === f.id ? 'bg-white/10' : 'hover:bg-white/5'
                      }`}
                    >
                      <span className={`text-[10px] font-mono font-bold ${f.isNew ? 'text-emerald-400' : 'text-amber-400'}`}>{f.isNew ? 'U' : 'M'}</span>
                      <button
                        onClick={() => { setReviewFilePath(f.path); setShowReviewModal(true) }}
                        className="min-w-0 flex-1 text-left"
                      >
                        <p className="text-[10px] text-zinc-300 truncate">{fileName}</p>
                        <p className="text-[8px] text-zinc-600 truncate">{f.path}</p>
                      </button>
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
            const hasChatOpen = document.querySelector('[data-chat-open="true"]')
            if (hasChatOpen) {
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
          <div className="my-1 border-t border-white/15" />
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

interface TreeNodeData { name: string; path: string; isFile: boolean; isModified: boolean; isNew: boolean; children: TreeNodeData[] }

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
        child = { name: part, path: parts.slice(0, i + 1).join('/'), isFile: isLast, isModified: isLast ? file.isModified : false, isNew: isLast ? (file.isNew ?? false) : false, children: [] }
        current.children.push(child)
      }
      current = child
    }
  }
  function processNode(node: TreeNodeData) {
    node.children.sort((a, b) => { if (a.isFile !== b.isFile) return a.isFile ? 1 : -1; return a.name.localeCompare(b.name) })
    node.children.forEach(processNode)
    // Propagate modified/new status to folders
    if (!node.isFile) {
      node.isModified = node.children.some((c) => c.isModified)
      node.isNew = node.children.some((c) => c.isNew)
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
  onContextMenu?: (e: React.MouseEvent, path: string) => void
  onMove?: (fromPath: string, toFolder: string) => void
}

function TreeNode({ node, depth, selectedPath, onSelect, collapseKey, onContextMenu, onMove }: TreeProps) {
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
          <FolderNode key={child.path} node={child} depth={depth} selectedPath={selectedPath} onSelect={onSelect} collapseKey={collapseKey} onContextMenu={onContextMenu} onMove={onMove} />
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
      className={`flex w-full min-w-0 items-center gap-2 py-1 text-left text-[13px] hover:bg-white/5 cursor-grab active:cursor-grabbing ${selectedPath === child.path ? 'bg-violet-500/15 text-zinc-200' : ''}`}
      style={{ paddingLeft: `${depth * 16 + 16}px`, paddingRight: 8 }}
    >
      <FileIcon name={child.name} />
      <span className={`flex-1 truncate ${child.isNew ? 'text-emerald-400' : child.isModified ? 'text-amber-400' : 'text-zinc-300'}`}>{child.name}</span>
      {child.isNew && <span className="shrink-0 text-[9px] font-bold text-emerald-400">U</span>}
      {child.isModified && !child.isNew && <span className="shrink-0 text-[9px] font-bold text-amber-400">M</span>}
    </button>
  )
}

function FolderNode({ node, depth, selectedPath, onSelect, collapseKey, onContextMenu, onMove }: TreeProps) {
  const [expanded, setExpanded] = useState(depth < 1)
  const [dragOver, setDragOver] = useState(false)

  useEffect(() => {
    if (collapseKey && collapseKey > 0) setExpanded(false)
  }, [collapseKey])

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
      {expanded && <TreeNode node={node} depth={depth + 1} selectedPath={selectedPath} onSelect={onSelect} collapseKey={collapseKey} onContextMenu={onContextMenu} onMove={onMove} />}
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
}: {
  projectId: string
  sessionId: string
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

  // Cleanup polling on unmount
  useEffect(() => {
    return () => { if (pollingRef.current) clearInterval(pollingRef.current) }
  }, [])

  async function sendMessage(e: React.FormEvent) {
    e.preventDefault()
    const content = input.trim()
    if ((!content && attachments.length === 0) || sending || teamProcessing) return

    const userMsg: Message = {
      id: `temp-${Date.now()}`,
      content,
      sender: 'user',
      mode: activeMode,
      activeSkillId: activeSkillId,
      report: null,
      createdAt: new Date().toISOString(),
    }
    setMessages((prev) => [...prev, userMsg])
    setInput('')
    setAttachments([])
    setSending(true)

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
          // Team mode — start polling for new messages
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
      }
    } catch { /* ignore */ }
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
      className={`flex flex-1 flex-col border-r border-white/15 ${isDragging ? 'ring-2 ring-inset ring-violet-400' : ''}`}
      style={{ backgroundColor: '#15151c' }}
      onDragOver={(e) => { e.preventDefault(); setIsDragging(true) }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={(e) => { e.preventDefault(); setIsDragging(false); if (e.dataTransfer.files.length > 0) handleFiles(e.dataTransfer.files) }}
    >
      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {messages.length === 0 && (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-zinc-400">Send a message or type <strong>/</strong> to select a skill</p>
          </div>
        )}
        {messages.filter((msg) => msg.sender !== 'plan' && msg.sender !== 'step').map((msg) => (
          <div key={msg.id} className={`flex ${msg.sender === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
              msg.sender === 'user'
                ? 'bg-violet-600 text-white'
                : msg.sender === 'system'
                ? 'bg-amber-500/10 border border-amber-500/20 text-amber-400 text-xs italic'
                : 'bg-white/5 border border-white/15 text-zinc-300'
            }`}>
              {msg.sender !== 'user' && msg.sender !== 'system' && msg.sender !== 'claude' && (
                <div className="mb-1 flex items-center gap-1.5">
                  <span className={`inline-block rounded bg-gradient-to-br ${getSenderColor(msg.sender)} px-1.5 py-0.5 text-[9px] font-bold text-white`}>
                    {msg.sender}
                  </span>
                </div>
              )}
              <p className="whitespace-pre-wrap">{msg.content}</p>
              {msg.report && (
                <ReportBadge report={msg.report as unknown as ChatReport} projectId={projectId} sessionId={sessionId} />
              )}
            </div>
          </div>
        ))}
        {teamProcessing && (
          <div className="flex items-center gap-2 rounded-lg bg-zinc-100 px-3 py-2">
            <div className="h-2 w-2 animate-pulse rounded-full bg-blue-500" />
            <p className="text-xs text-zinc-500">Team is working...</p>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input area with selector */}
      <div className="relative shrink-0 border-t border-white/15" style={{ backgroundColor: '#1a1a22' }}>
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

        {/* Input area */}
        <form onSubmit={sendMessage} className="shrink-0 border-t border-white/15">
          {/* Attachment previews */}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 border-b border-white/15 px-3 py-2">
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

          {/* Chat input box (grows with content, max 4x) */}
          <div className="flex items-end gap-2 px-3 py-2">
            <div className="flex flex-1 flex-col rounded-xl border border-white/15 focus-within:border-violet-500/50" style={{ backgroundColor: '#1e1e28' }}>
              {/* Active skill badge */}
              {activeMode !== 'no_skill' && (
                <div className="flex items-center gap-1.5 px-3 pt-2">
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

              {/* Textarea + / button */}
              <div className="flex items-end px-2 py-1.5">
                <button
                  type="button"
                  onClick={() => { setShowSelector(!showSelector); setOpenedViaButton(!showSelector) }}
                  className="mb-0.5 mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-white/15 bg-white/5 text-xs font-bold text-zinc-400 transition-colors hover:bg-white/10 hover:text-zinc-300"
                >
                  /
                </button>
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
                  className="flex-1 resize-none bg-transparent px-1 py-1 text-sm text-zinc-200 placeholder-zinc-500 outline-none disabled:opacity-50"
                  style={{ maxHeight: `${36 * 4}px` }}
                />
              </div>
            </div>

            {(sending || teamProcessing) ? (
              <button
                type="button"
                onClick={() => {
                  // Stop polling / cancel
                  if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null }
                  setTeamProcessing(false)
                  setSending(false)
                }}
                title="Stop"
                className="mb-0.5 flex h-9 w-9 items-center justify-center rounded-xl bg-violet-600 text-white transition-colors hover:bg-violet-500"
              >
                <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
                  <rect x="6" y="6" width="12" height="12" rx="2" />
                </svg>
              </button>
            ) : (
              <button
                type="submit"
                disabled={!input.trim() && attachments.length === 0}
                title="Send"
                className="mb-0.5 flex h-9 w-9 items-center justify-center rounded-xl bg-zinc-800 text-white transition-colors hover:bg-zinc-700 disabled:opacity-30"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 10.5L12 3m0 0l7.5 7.5M12 3v18" />
                </svg>
              </button>
            )}
          </div>

          {/* Context badges */}
          {contextPaths.length > 0 && (
            <div className="flex flex-wrap gap-1.5 border-t border-white/15 px-3 py-1.5">
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

          {/* Toolbar */}
          <div className="relative flex items-center gap-2 border-t border-white/15 px-3 py-1.5">
            <button
              type="button"
              onClick={() => setShowToolbarMenu(!showToolbarMenu)}
              title="More options"
              className="flex h-6 w-6 items-center justify-center rounded text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-600"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
            </button>

            {/* Toolbar popup menu */}
            {showToolbarMenu && (
              <div className="absolute bottom-full left-2 z-20 mb-1 w-48 rounded-lg border border-white/15 py-1 shadow-lg" style={{ backgroundColor: '#1e1e28' }}>
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
                <div className="my-1 border-t border-white/15" />
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
              className="rounded border border-white/15 bg-white/5 px-1.5 py-0.5 text-[10px] text-zinc-300 outline-none hover:bg-white/10"
            >
              <option value="haiku">Haiku 4.5</option>
              <option value="sonnet">Sonnet 4</option>
              <option value="opus">Opus 4</option>
            </select>

            {/* Thinking selector */}
            <select
              value={thinkingLevel}
              onChange={(e) => setThinkingLevel(e.target.value)}
              className="rounded border border-white/15 bg-white/5 px-1.5 py-0.5 text-[10px] text-zinc-300 outline-none hover:bg-white/10"
            >
              <option value="off">Thinking: Off</option>
              <option value="low">Thinking: Low</option>
              <option value="medium">Thinking: Medium</option>
              <option value="high">Thinking: High</option>
            </select>

            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,.txt,.md,.csv,.json,.ts,.tsx,.js,.jsx,.py,.html,.css,.yml,.yaml,.xml,.sql,.sh"
              onChange={(e) => { if (e.target.files) handleFiles(e.target.files); e.target.value = '' }}
              className="hidden"
            />
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
            <div className="w-full max-w-sm rounded-xl border border-white/10 p-6 shadow-xl" style={{ backgroundColor: '#1a1a22' }}>
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
        className="flex h-[85vh] w-[90vw] max-w-6xl flex-col overflow-hidden rounded-2xl border border-white/10 shadow-2xl"
        style={{ backgroundColor: '#1a1a22' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-5 py-3" style={{ backgroundColor: '#15151c' }}>
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
          <div className="w-56 shrink-0 overflow-y-auto border-r border-white/10" style={{ backgroundColor: '#15151c' }}>
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
              <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-4 py-2" style={{ backgroundColor: '#1e1e28' }}>
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
                    <div key={ci} className={ci > 0 ? 'border-t border-dashed border-white/10 mt-1 pt-1' : ''}>
                      {/* Chunk header */}
                      <div className="sticky top-0 z-10 flex items-center gap-2 px-3 py-1" style={{ backgroundColor: '#1e1e28' }}>
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
        className="w-full max-w-sm overflow-hidden rounded-xl border border-white/10 shadow-xl"
        style={{ backgroundColor: '#1a1a22' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-white/10 px-5 py-3" style={{ backgroundColor: '#15151c' }}>
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
                className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:border-violet-500/50 focus:outline-none"
              />
              <div className="mt-3 flex gap-2">
                <button
                  onClick={handleCreate}
                  disabled={!text.trim() || creating}
                  className="flex h-8 flex-1 items-center justify-center rounded-lg bg-violet-600 text-xs font-medium text-white transition-colors hover:bg-violet-500 disabled:opacity-30"
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
    <div className="flex w-72 shrink-0 flex-col border-l border-white/15" style={{ backgroundColor: '#1a1a22' }}>
      {/* ── Chat section (top) ── */}
      <div className={`flex flex-col ${hasRunningTask ? 'h-1/2 border-b border-white/15' : 'flex-1'}`}>
        <div className="border-b border-white/15 px-3 py-2">
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
                  'border-white/10 bg-white/[0.02]'
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
          <div className="flex items-center justify-between border-b border-white/15 px-3 py-2">
            <div className="flex items-center gap-1.5">
              <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" />
              <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-300">Task Running</span>
            </div>
            <a href="#" onClick={(e) => { e.preventDefault(); window.location.hash = '' }} className="text-[9px] text-violet-400 hover:text-violet-300">
              Expand →
            </a>
          </div>

          {/* Task info bar */}
          <div className="border-b border-white/10 px-3 py-2" style={{ backgroundColor: '#15151c' }}>
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
                  isActive ? 'border-violet-500/30 bg-violet-500/[0.06]' : 'border-white/5 bg-white/[0.02]'
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
        <div className="shrink-0 border-t border-white/10 px-3 py-2.5" style={{ backgroundColor: '#15151c' }}>
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
      <div className="flex items-center border-b border-white/15 px-3 py-2">
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
