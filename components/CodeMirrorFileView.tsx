'use client'

// Editable file view — replaces the old read-only ShikiFileView inside the
// Explorer tab. CodeMirror 6 gives us a real editor (cursor, selection,
// multi-cursor, undo, keyboard shortcuts) while matching the VS Code /
// Cursor look via the one-dark theme.
//
// Saving strategy: explicit only — Ctrl/Cmd+S inside the editor or the
// "Save" button in the close-confirm modal when leaving with unsaved edits.
// PUT goes to /api/projects/[id]/repository/files/[path] with the same
// ?worktree= / ?session= query params used to read, so the write lands in
// the correct working dir (main or a worktree).

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useReducer, useRef, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { EditorView, keymap } from '@codemirror/view'
import { Prec } from '@codemirror/state'
import { useDOMTextSelection } from '@/lib/hooks/useTextSelection'
import { SelectionAddButton } from './SelectionAddButton'
import { oneDark } from '@codemirror/theme-one-dark'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { json } from '@codemirror/lang-json'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { markdown } from '@codemirror/lang-markdown'
import { sql } from '@codemirror/lang-sql'
import { rust } from '@codemirror/lang-rust'
import { go } from '@codemirror/lang-go'
import { yaml } from '@codemirror/lang-yaml'

function languageForFile(filename: string) {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  switch (ext) {
    case 'ts': case 'tsx': return javascript({ typescript: true, jsx: ext === 'tsx' })
    case 'js': case 'jsx': case 'mjs': case 'cjs': return javascript({ jsx: ext === 'jsx' })
    case 'py': return python()
    case 'json': return json()
    case 'css': case 'scss': return css()
    case 'html': case 'htm': case 'xml': return html()
    case 'md': case 'mdx': return markdown()
    case 'sql': return sql()
    case 'rs': return rust()
    case 'go': return go()
    case 'yml': case 'yaml': return yaml()
    default: return null
  }
}

export interface CodeMirrorFileViewProps {
  projectId: string
  filePath: string
  initialContent: string
  // One of these routes the write into the correct working dir.
  worktreeId?: string | null
  sessionId?: string | null
  // Called on each save attempt result, so parent can refresh diff stats etc.
  onSaved?: (ok: boolean) => void
  // Fires whenever the in-memory buffer diverges from the last saved content.
  // Parent uses this to decide whether to show a save/discard modal on close.
  onDirtyChange?: (dirty: boolean) => void
  // When true, disable editing and skip the save path. Used in main-
  // state (no active workspace) so reads of the repo don't risk
  // writing to /home/user/project (which gets reset --hard every 5 min
  // by the main refresh worker).
  readOnly?: boolean
  // True while any chat session attached to this worktree is streaming.
  // Surfaces a subtle "Agent editing..." banner so the user knows their
  // open file may change underneath them.
  agentBusy?: boolean
  // Set by the parent when the daemon's fs-watcher reports a change to
  // the file the user has open AND the editor is dirty. Renders a yellow
  // "Reload" banner and blocks save (saving stale content would clobber
  // whatever the agent just wrote).
  diskChanged?: boolean
  // Callback for the banner's Reload button.
  onReload?: () => void
  // Cursor-style "Add to Chat" — fired when the user selects text and
  // clicks the floating pill. All lines from a plain editor are reported
  // as 'context' (no diff markers to interpret here).
  onAddSelection?: (
    filePath: string,
    startLine: number,
    endLine: number,
    lines: Array<{ type: 'add' | 'remove' | 'context'; content: string }>,
  ) => void
}

// Imperative handle so the parent (which owns the back/close button) can ask
// the editor to save or discard from outside — used by the confirm modal.
export interface CodeMirrorFileViewHandle {
  save: () => Promise<boolean>
  discard: () => void
  isDirty: () => boolean
}

export const CodeMirrorFileView = forwardRef<CodeMirrorFileViewHandle, CodeMirrorFileViewProps>(function CodeMirrorFileView({
  projectId,
  filePath,
  initialContent,
  readOnly,
  worktreeId,
  sessionId,
  onSaved,
  onDirtyChange,
  agentBusy,
  diskChanged,
  onReload,
  onAddSelection,
}, ref) {
  // Normalize to a trailing newline so CodeMirror renders one numbered
  // empty line below the last content line — VS Code-style "click here
  // to extend" affordance. Files saved POSIX-style already have one;
  // adding it on the fly makes orphan files behave the same way and
  // brings them in line with the convention on save.
  const normalize = (s: string) => (s.endsWith('\n') ? s : s + '\n')

  const [value, setValue] = useState(() => normalize(initialContent))
  // "Last saved" content is what's on disk — used to decide dirty state and
  // to revert on discard. Starts equal to initialContent (just loaded).
  const [savedContent, setSavedContent] = useState(() => normalize(initialContent))
  const [status, setStatus] = useState<'idle' | 'dirty' | 'saving' | 'saved' | 'error'>('idle')

  // Keep value in sync if the user opens a different file in the same mount.
  useEffect(() => {
    const normalized = normalize(initialContent)
    setValue(normalized)
    setSavedContent(normalized)
    setStatus('idle')
  }, [initialContent, filePath])

  // Notify parent of dirty transitions so it can gate the back button.
  useEffect(() => {
    onDirtyChange?.(value !== savedContent)
  }, [value, savedContent, onDirtyChange])

  const lang = useMemo(() => languageForFile(filePath), [filePath])
  const extensions = useMemo(() => {
    const exts = [
      EditorView.lineWrapping, // never horizontal-scroll
      // Highest precedence so our background override beats oneDark's #282c34
      // (which has a blue cast and bleeds through .cm-scroller/.cm-content).
      Prec.highest(EditorView.theme({
        '&': { fontSize: '13px', backgroundColor: '#1F1F1F' },
        '.cm-scroller': { backgroundColor: '#1F1F1F' },
        // .cm-content MUST stay transparent. drawSelection paints the
        // selection layer at z-index: -1 (behind the content layer); a
        // solid background here would block the yellow highlight from
        // ever showing through. The visible #1F1F1F comes from .cm-scroller.
        '.cm-content': { paddingBottom: '200px' },
        '.cm-gutters': { backgroundColor: '#1F1F1F', borderRight: '1px solid #2B2B2B' },
        '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.03)' },
        '.cm-activeLineGutter': { backgroundColor: 'rgba(255,255,255,0.04)' },
      })),
    ]
    if (lang) exts.push(lang)
    if (readOnly) exts.push(EditorView.editable.of(false))
    return exts
  }, [lang, readOnly])

  // Latest value in a ref so the save function can always read fresh content.
  const valueRef = useRef(value)
  valueRef.current = value

  // Explicit save — only runs on Ctrl/Cmd+S or imperative parent call.
  // Returns true on success so callers can sequence (e.g., save-then-close).
  const save = useCallback(async (): Promise<boolean> => {
    // ReadOnly path: never PUT. Main-state file viewing uses readOnly to
    // protect the project root from accidental writes (the main worker
    // resets it every 5 min). Without this guard a stray Ctrl+S would
    // still fire a no-op HTTP request to the bare repository endpoint.
    if (readOnly) return false
    // Disk diverged underneath us (agent edited the file). Abort PUT —
    // pushing our buffer would clobber the agent's changes silently.
    // Caller (close-confirm modal / parent) sees `false` and surfaces
    // the reload banner instead.
    if (diskChanged) {
      setStatus('error')
      onSaved?.(false)
      return false
    }
    setStatus('saving')
    const qs = new URLSearchParams()
    if (worktreeId) qs.set('worktree', worktreeId)
    else if (sessionId) qs.set('session', sessionId)
    const url = `/api/projects/${projectId}/repository/files/${encodeURIComponent(filePath)}${qs.toString() ? `?${qs}` : ''}`
    const snapshot = valueRef.current
    try {
      const res = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: snapshot }),
      })
      const ok = res.ok
      if (ok) setSavedContent(snapshot)
      setStatus(ok ? 'saved' : 'error')
      onSaved?.(ok)
      return ok
    } catch {
      setStatus('error')
      onSaved?.(false)
      return false
    }
  }, [projectId, filePath, worktreeId, sessionId, onSaved, diskChanged, readOnly])

  const handleChange = useCallback((next: string) => {
    setValue(next)
    setStatus(next === savedContent ? 'idle' : 'dirty')
  }, [savedContent])

  // Ctrl/Cmd+S → save.
  const saveKeymap = useMemo(() => Prec.highest(keymap.of([
    {
      key: 'Mod-s',
      preventDefault: true,
      run: () => { void save(); return true },
    },
  ])), [save])

  const allExtensions = useMemo(() => [saveKeymap, ...extensions], [saveKeymap, extensions])

  // Imperative API for the parent's save/discard modal.
  useImperativeHandle(ref, () => ({
    save: async () => save(),
    discard: () => { setValue(savedContent); setStatus('idle') },
    isDirty: () => valueRef.current !== savedContent,
  }), [save, savedContent])

  // ── "Add to Chat" selection capture ─────────────────────────────────
  // The hook commits state only on mouseup so the user's drag never
  // gets contested by a floating button mid-stroke. We then re-read
  // `range.getBoundingClientRect()` on every render so the pill sticks
  // to the highlighted text — a scroll listener forces a render so the
  // pill follows when the user scrolls inside .cm-scroller.
  const editorBodyRef = useRef<HTMLDivElement | null>(null)
  const { selection: domSelection, clear: clearDomSelection } = useDOMTextSelection(editorBodyRef)
  const [, bumpScroll] = useReducer((x: number) => x + 1, 0)
  useEffect(() => {
    if (!domSelection) return
    const scroller = editorBodyRef.current?.querySelector('.cm-scroller')
    if (!scroller) return
    scroller.addEventListener('scroll', bumpScroll, { passive: true })
    window.addEventListener('resize', bumpScroll)
    return () => {
      scroller.removeEventListener('scroll', bumpScroll)
      window.removeEventListener('resize', bumpScroll)
    }
  }, [domSelection])

  const selectionInfo = useMemo(() => {
    if (!domSelection || !onAddSelection) return null
    const root = editorBodyRef.current?.querySelector('.cm-content')
    if (!root) return null
    const lineEls = Array.from(root.querySelectorAll('.cm-line')) as HTMLElement[]
    let firstIdx = -1
    let lastIdx = -1
    const picked: HTMLElement[] = []
    for (let i = 0; i < lineEls.length; i++) {
      if (domSelection.range.intersectsNode(lineEls[i])) {
        if (firstIdx === -1) firstIdx = i
        lastIdx = i
        picked.push(lineEls[i])
      }
    }
    if (firstIdx === -1) return null
    return {
      startLine: firstIdx + 1,
      endLine: lastIdx + 1,
      lines: picked.map((el) => ({ type: 'context' as const, content: el.textContent ?? '' })),
      lineCount: picked.length,
    }
  }, [domSelection, onAddSelection])

  // Live rect — recomputed every render. When `bumpScroll` fires we
  // re-render and this picks up the new viewport coords automatically.
  const liveRect = domSelection ? domSelection.range.getBoundingClientRect() : null

  return (
    <div className="flex h-full flex-col">
      {/* Status strip — unobtrusive indicator of save state. Only renders
          when there's actually something to say; idle/clean files don't
          get a stray empty bar above the editor body. */}
      {!readOnly && status !== 'idle' && (
        <div className="flex items-center justify-end px-3 py-1 text-[10px]" style={{ backgroundColor: '#1F1F1F', borderBottom: '1px solid #2B2B2B' }}>
          <span className={
            status === 'saving' ? 'text-zinc-400'
            : status === 'saved' ? 'text-emerald-500'
            : status === 'dirty' ? 'text-amber-500'
            : 'text-red-500'
          }>
            {status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved' : status === 'dirty' ? 'Modified' : 'Save failed'}
          </span>
        </div>
      )}
      {/* Disk-changed banner — agent edited the file underneath. Reload
          is the only path forward; saving here would clobber. */}
      {diskChanged ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-amber-500/30 px-3 py-1.5 text-[11px]" style={{ backgroundColor: 'rgba(245, 158, 11, 0.08)' }}>
          <span className="text-amber-300">🔄</span>
          <span className="flex-1 text-amber-200">Agent edited this file. Save is disabled until you reload.</span>
          <button
            type="button"
            onClick={() => onReload?.()}
            className="rounded border border-amber-500/40 px-2 py-0.5 text-[11px] font-medium text-amber-200 hover:bg-amber-500/10"
          >
            Reload
          </button>
        </div>
      ) : agentBusy ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-sky-500/20 px-3 py-1 text-[11px]" style={{ backgroundColor: 'rgba(14, 165, 233, 0.06)' }}>
          <span className="text-sky-300">🤖</span>
          <span className="text-sky-300/80">Agent editing in this branch…</span>
        </div>
      ) : null}
      <div ref={editorBodyRef} className="flex-1 overflow-y-auto overflow-x-hidden" style={{ backgroundColor: '#1F1F1F' }}>
        <CodeMirror
          value={value}
          height="100%"
          theme={oneDark}
          extensions={allExtensions}
          onChange={handleChange}
          basicSetup={{
            lineNumbers: true,
            // Active-line highlighting is distracting in read-only
            // because the cursor is frozen on line 1 and its background
            // leaks through the one-dark theme. Disable it entirely
            // when there's nothing for the user to interact with.
            highlightActiveLine: !readOnly,
            highlightActiveLineGutter: !readOnly,
            foldGutter: false,
            autocompletion: false,
            bracketMatching: true,
            closeBrackets: true,
            indentOnInput: true,
          }}
        />
      </div>
      {onAddSelection && selectionInfo && liveRect && (
        <SelectionAddButton
          anchor={{ top: liveRect.top, right: liveRect.right }}
          lineCount={selectionInfo.lineCount}
          onAdd={() => {
            onAddSelection(filePath, selectionInfo.startLine, selectionInfo.endLine, selectionInfo.lines)
            clearDomSelection()
          }}
          onDismiss={clearDomSelection}
        />
      )}
    </div>
  )
})
CodeMirrorFileView.displayName = 'CodeMirrorFileView'
