'use client'

import { useState, useEffect, useRef } from 'react'

interface ChatSession {
  id: string
  name: string
}

interface ChatTabsProps {
  projectId: string
  activeSessionId: string | null
  sessions: ChatSession[]
  onSelectSession: (id: string) => void
  onNewSession: () => void
  onCloseSession: (id: string) => void
  onRenameSession: (id: string, name: string) => void
  isWorking: boolean
}

export function ChatTabs({
  projectId,
  activeSessionId,
  sessions,
  onSelectSession,
  onNewSession,
  onCloseSession,
  onRenameSession,
  isWorking,
}: ChatTabsProps) {
  const [showCloseConfirm, setShowCloseConfirm] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null)
  const editRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editingId && editRef.current) editRef.current.focus()
  }, [editingId])

  useEffect(() => {
    if (!menuOpenId) return
    function handleClick() { setMenuOpenId(null) }
    document.addEventListener('click', handleClick)
    return () => document.removeEventListener('click', handleClick)
  }, [menuOpenId])

  function handleStartRename(session: ChatSession) {
    setEditingId(session.id)
    setEditName(session.name)
  }

  function handleFinishRename(id: string) {
    if (editName.trim()) onRenameSession(id, editName.trim())
    setEditingId(null)
  }

  return (
    <>
      <div className="flex items-center border-b border-[#2B2B2B]" style={{ backgroundColor: '#181818' }}>
        {sessions.map((session) => (
          <div
            key={session.id}
            className={`group flex items-center gap-1 border-r border-[#2B2B2B] px-3 py-1.5 text-xs cursor-pointer ${
              activeSessionId === session.id
                ? 'bg-[#1F1F1F] text-zinc-200 border-t border-t-white/20'
                : 'text-zinc-500 hover:bg-white/5 hover:text-zinc-300'
            }`}
            onClick={() => onSelectSession(session.id)}
          >
            <img src="/claude-logo.png" alt="" className="h-3.5 w-3.5 rounded-full" />
            {editingId === session.id ? (
              <input
                ref={editRef}
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onBlur={() => handleFinishRename(session.id)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleFinishRename(session.id); if (e.key === 'Escape') setEditingId(null) }}
                className="w-24 border-none bg-transparent text-xs outline-none"
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span
                className="max-w-[120px] truncate"
                onDoubleClick={(e) => { e.stopPropagation(); handleStartRename(session) }}
              >
                {session.name}
              </span>
            )}

            <button
              onClick={(e) => { e.stopPropagation(); setShowCloseConfirm(session.id) }}
              className="ml-1 text-zinc-600 hover:text-zinc-300"
            >
              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>

            <div className="relative">
              <button
                onClick={(e) => { e.stopPropagation(); setMenuOpenId(menuOpenId === session.id ? null : session.id) }}
                className="hidden text-zinc-500 hover:text-zinc-300 group-hover:block"
              >
                <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 24 24">
                  <circle cx="12" cy="5" r="2" />
                  <circle cx="12" cy="12" r="2" />
                  <circle cx="12" cy="19" r="2" />
                </svg>
              </button>

              {menuOpenId === session.id && (
                <div className="absolute left-0 top-full z-20 mt-1 w-32 rounded-lg border border-[#2B2B2B] py-1 shadow-lg" style={{ backgroundColor: '#313131' }}>
                  <button
                    onClick={(e) => { e.stopPropagation(); setMenuOpenId(null); handleStartRename(session) }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-300 hover:bg-white/10"
                  >
                    <svg className="h-3 w-3 text-zinc-400" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L6.832 19.82a4.5 4.5 0 01-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 011.13-1.897L16.863 4.487z" />
                    </svg>
                    Rename
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}

        <button
          onClick={onNewSession}
          className="flex items-center justify-center px-2 py-1.5 text-zinc-500 hover:text-zinc-300"
        >
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
        </button>
      </div>

      {showCloseConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-sm rounded-xl border border-[#2B2B2B] p-6 shadow-xl" style={{ backgroundColor: '#181818' }}>
            <h3 className="text-sm font-semibold text-zinc-100">Close this chat?</h3>
            <p className="mt-1 text-xs text-zinc-400">The conversation history will be preserved but the tab will be closed.</p>
            {isWorking && (
              <div className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
                <p className="text-xs text-amber-300">A task is currently running. Closing won&apos;t stop it.</p>
              </div>
            )}
            <div className="mt-4 flex gap-2">
              <button
                onClick={() => { onCloseSession(showCloseConfirm); setShowCloseConfirm(null) }}
                className="flex h-8 flex-1 items-center justify-center rounded-lg bg-white text-xs font-medium text-zinc-900 hover:bg-zinc-200"
              >
                Close
              </button>
              <button
                onClick={() => setShowCloseConfirm(null)}
                className="flex h-8 flex-1 items-center justify-center rounded-lg border border-[#2B2B2B] text-xs text-zinc-400 hover:text-zinc-200"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
