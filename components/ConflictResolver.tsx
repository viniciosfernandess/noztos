'use client'

// Orchestrator for the manual conflict-resolve flow. The resolver
// handles multiple conflict kinds (text, rename, delete, binary) by
// dispatching each file to its specialized panel.
//
// Layout: stacked — file navbar at the top, active file path strip,
// then the kind-specific panel fills the rest of the width.

import { useCallback, useEffect, useState } from 'react'
import { ConflictFileNavigator } from './ConflictFileNavigator'
import { RenamePanel, type RenameChoice } from './conflicts/RenamePanel'
import { DeletePanel, type DeleteChoice } from './conflicts/DeletePanel'
import type { ConflictFile } from './conflicts/types'
import { MOCK_CONFLICTS, MOCK_GIT_STATUS } from '@/lib/mocks/checks-demo'

export interface ConflictResolverProps {
  projectId: string
  worktreeId: string
  initialFiles: ConflictFile[]
  onClose: () => void
  onDone: () => void
}

// Each file tracks a lightweight "choice" state. For text files, the
// choice is encoded as "resolved | not" (the navigator handles the
// per-conflict-block picks internally). For rename/delete it's the
// top-level pick from the panel.
interface FileState {
  content: string | null
  resolved: boolean
  // For rename/delete, the explicit choice the user made so we can
  // show the right CTA state in the sidebar tab.
  choice?: RenameChoice | DeleteChoice | null
  // For rename conflicts: original file content (base) for diff preview.
  originalContent?: string
  resolvedContent?: string
}

export function ConflictResolver({ projectId, worktreeId, initialFiles, onClose, onDone }: ConflictResolverProps) {
  const [files] = useState<ConflictFile[]>(initialFiles)
  const [activePath, setActivePath] = useState<string>(initialFiles[0]?.path ?? '')
  const [entries, setEntries] = useState<Record<string, FileState>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const getFile = (path: string) => files.find((f) => f.path === path)

  // ── Content loader (mock-aware) ────────────────────────────────────
  const loadFile = useCallback(async (path: string) => {
    if (MOCK_GIT_STATUS && MOCK_CONFLICTS && MOCK_CONFLICTS.contents[path] != null) {
      const c = MOCK_CONFLICTS.contents[path]
      const base = MOCK_CONFLICTS.original?.[path] ?? ''
      setEntries((prev) => ({ ...prev, [path]: { content: c, resolvedContent: c, originalContent: base, resolved: false } }))
      return
    }
    try {
      const res = await fetch(`/api/projects/${projectId}/repository/files/${encodeURIComponent(path)}?worktree=${worktreeId}`)
      if (res.ok) {
        const data = await res.json()
        const c = data.content ?? ''
        setEntries((prev) => ({ ...prev, [path]: { content: c, resolvedContent: c, originalContent: data.originalContent ?? '', resolved: false } }))
      }
    } catch {}
  }, [projectId, worktreeId])

  useEffect(() => { files.forEach((f) => loadFile(f.path)) }, [files, loadFile])

  // ── Save helper ────────────────────────────────────────────────────
  const saveFile = useCallback(async (path: string, content: string) => {
    if (MOCK_GIT_STATUS && MOCK_CONFLICTS && MOCK_CONFLICTS.contents[path] != null) return true
    try {
      const res = await fetch(`/api/projects/${projectId}/repository/files/${encodeURIComponent(path)}?worktree=${worktreeId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      })
      return res.ok
    } catch { return false }
  }, [projectId, worktreeId])

  // ── Per-kind handlers ─────────────────────────────────────────────
  function handleTextChange(path: string, info: { resolved: boolean; content: string }) {
    setEntries((prev) => {
      const existing = prev[path]
      if (!existing) return prev
      if (existing.resolvedContent === info.content && existing.resolved === info.resolved) return prev
      return { ...prev, [path]: { ...existing, resolvedContent: info.content, resolved: info.resolved } }
    })
    const wasResolved = entries[path]?.resolved ?? false
    if (!wasResolved && info.resolved) {
      void saveFile(path, info.content).then((ok) => { if (!ok) setError(`Failed to save ${path}`) })
      advanceToNext(path)
    }
  }

  function handleRenameChoice(path: string, choice: RenameChoice) {
    setEntries((prev) => {
      const existing = prev[path]
      if (!existing) return prev
      const resolved = choice !== null
      return { ...prev, [path]: { ...existing, choice, resolved } }
    })
    if (choice) advanceToNext(path)
  }

  function handleDeleteChoice(path: string, choice: DeleteChoice) {
    setEntries((prev) => {
      const existing = prev[path]
      if (!existing) return prev
      const resolved = choice !== null
      return { ...prev, [path]: { ...existing, choice, resolved } }
    })
    if (choice) advanceToNext(path)
  }

  function advanceToNext(fromPath: string) {
    const nextPending = files.find((f) => f.path !== fromPath && !entries[f.path]?.resolved)
    if (nextPending) setTimeout(() => setActivePath(nextPending.path), 150)
  }

  const allResolved = files.length > 0 && files.every((f) => entries[f.path]?.resolved)

  async function continueRebase() {
    setBusy('continue')
    if (MOCK_GIT_STATUS) { setTimeout(() => { setBusy(null); onDone() }, 400); return }
    try {
      const res = await fetch(`/api/projects/${projectId}/worktrees/${worktreeId}/rebase/continue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: files.map((f) => f.path) }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok && res.status !== 200) throw new Error(data.error ?? 'continue failed')
      if (data.status === 'clean') { onDone(); return }
      setError('More conflicts surfaced — keep resolving.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to continue rebase')
    }
    setBusy(null)
  }

  async function abortRebase() {
    setBusy('abort')
    if (MOCK_GIT_STATUS) { setTimeout(() => { setBusy(null); onClose() }, 200); return }
    try {
      await fetch(`/api/projects/${projectId}/worktrees/${worktreeId}/rebase/abort`, { method: 'POST' })
      onClose()
    } catch {}
    setBusy(null)
  }

  const activeFile = activePath ? getFile(activePath) : null
  const activeEntry = activePath ? entries[activePath] : null

  const kindLabel: Record<ConflictFile['kind'], string> = {
    text: 'Text',
    rename: 'Rename',
    delete: 'Delete',
    binary: 'Binary',
  }

  return (
    <div className="absolute inset-0 z-30 flex flex-col" style={{ backgroundColor: '#181818' }}>
      <div className="flex shrink-0 items-center justify-between border-b border-[#2B2B2B] px-4 py-2" style={{ backgroundColor: '#1B1B1B' }}>
        <div className="flex items-center gap-3">
          <span className="rounded bg-amber-500/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300">Conflicts</span>
          <span className="text-[12px] text-zinc-300">
            {files.filter((f) => entries[f.path]?.resolved).length} of {files.length} files resolved
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={abortRebase}
            disabled={busy !== null}
            className="rounded border border-[#2B2B2B] px-3 py-1 text-[11px] font-medium text-zinc-300 hover:border-[#3A3A3A] hover:bg-white/5 disabled:opacity-40"
          >
            Abort
          </button>
          <button
            onClick={continueRebase}
            disabled={!allResolved || busy !== null}
            className="rounded bg-emerald-500 px-3 py-1 text-[11px] font-semibold text-white hover:bg-emerald-400 disabled:opacity-40"
          >
            Continue rebase
          </button>
        </div>
      </div>

      {error && (
        <div className="shrink-0 border-b border-red-500/30 bg-red-500/10 px-4 py-1.5 text-[11px] text-red-300">
          {error}
          <button onClick={() => setError(null)} className="ml-2 text-red-200 hover:text-red-100">Dismiss</button>
        </div>
      )}

      {/* Files navbar */}
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-[#2B2B2B] px-3 py-2" style={{ backgroundColor: '#1F1F1F' }}>
        <span className="mr-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Files</span>
        {files.length === 0 && <span className="text-[11px] text-zinc-600">No conflicts remaining.</span>}
        {files.map((f) => {
          const e = entries[f.path]
          const active = f.path === activePath
          const resolved = !!e?.resolved
          const className = resolved
            ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
            : 'bg-transparent text-zinc-300 border-[#2B2B2B] hover:border-[#3A3A3A]'
          return (
            <button
              key={f.path}
              onClick={() => setActivePath(f.path)}
              className={`flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors ${className} ${active ? 'ring-1 ring-white/30' : ''}`}
            >
              {resolved && (
                <svg className="h-2.5 w-2.5" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              )}
              <span className="font-mono">{f.path.split('/').pop()}</span>
              <span className="text-[9px] text-zinc-500">({kindLabel[f.kind]})</span>
            </button>
          )
        })}
      </div>

      {activePath && (
        <div className="flex shrink-0 items-center justify-between border-b border-[#2B2B2B] px-3 py-1.5" style={{ backgroundColor: '#313131' }}>
          <span className="font-mono text-[11px] text-zinc-300">{activePath}</span>
          {activeEntry?.resolved && (
            <span className="flex items-center gap-1.5 rounded bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">
              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
              Resolved
            </span>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1">
        {activePath && activeEntry?.content == null && (
          <div className="flex h-full items-center justify-center text-[11px] text-zinc-500">Loading {activePath}…</div>
        )}
        {activePath && activeFile && activeEntry?.content != null && (
          activeFile.kind === 'text' ? (
            <ConflictFileNavigator
              key={activePath}
              projectId={projectId}
              worktreeId={worktreeId}
              filePath={activePath}
              initialContent={activeEntry.content}
              onChange={(info) => handleTextChange(activePath, info)}
            />
          ) : activeFile.kind === 'rename' ? (
            <RenamePanel
              newPath={activeFile.path}
              oldPath={(activeFile.meta?.oldPath as string) ?? activeFile.path}
              editedContent={activeEntry.content}
              originalContent={activeEntry.originalContent ?? ''}
              choice={(activeEntry.choice as RenameChoice) ?? null}
              onPick={(c) => handleRenameChoice(activePath, c)}
            />
          ) : activeFile.kind === 'delete' ? (
            <DeletePanel
              path={activeFile.path}
              content={activeEntry.content}
              deletedBy={(activeFile.meta?.deletedBy as 'ours' | 'theirs') ?? 'theirs'}
              choice={(activeEntry.choice as DeleteChoice) ?? null}
              onPick={(c) => handleDeleteChoice(activePath, c)}
            />
          ) : (
            // Binary / submodule / anything else we don't have a
            // dedicated panel for. Mirror the "Unsupported" pattern:
            // tell the user what to do on GitHub, and let them
            // manually mark as resolved so Continue rebase can proceed
            // once they handle it externally.
            <div className="flex h-full items-center justify-center p-8">
              <div className="max-w-md rounded-md border border-zinc-700 bg-zinc-800/50 p-5 text-[12px] text-zinc-300">
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                  {activeFile.kind.charAt(0).toUpperCase() + activeFile.kind.slice(1)} conflict
                </div>
                <div className="mb-3 text-zinc-200">
                  <span className="font-mono text-zinc-300">{activeFile.path}</span>
                </div>
                <div className="mb-4 text-[11px] leading-relaxed text-zinc-400">
                  This kind of conflict can&apos;t be resolved in-app. Open the PR on GitHub,
                  fix it there, then mark as resolved below. Polling will flip the bar back
                  to green/amber on the next push.
                </div>
                <div className="flex justify-end">
                  <button
                    onClick={() => {
                      setEntries((prev) => {
                        const existing = prev[activePath]
                        if (!existing) return prev
                        return { ...prev, [activePath]: { ...existing, resolved: !existing.resolved } }
                      })
                      if (!entries[activePath]?.resolved) advanceToNext(activePath)
                    }}
                    className="rounded-md border border-emerald-500/60 bg-emerald-500/10 px-3 py-1 text-[11px] font-semibold text-emerald-300 hover:bg-emerald-500/20"
                  >
                    {entries[activePath]?.resolved ? '✓ Resolved' : 'Mark as resolved'}
                  </button>
                </div>
              </div>
            </div>
          )
        )}
      </div>
    </div>
  )
}
