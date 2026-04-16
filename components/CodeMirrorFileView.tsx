'use client'

// Editable file view — replaces the old read-only ShikiFileView inside the
// Explorer tab. CodeMirror 6 gives us a real editor (cursor, selection,
// multi-cursor, undo, keyboard shortcuts) while matching the VS Code /
// Cursor look via the one-dark theme.
//
// Saving strategy:
//  - Debounced auto-save 800ms after the user stops typing.
//  - Explicit Ctrl/Cmd+S saves immediately (bypassing the debounce).
//  - Saves are PUT to /api/projects/[id]/repository/files/[path] with the
//    same ?worktree= / ?session= query params used to read the file, so the
//    write lands in the correct working directory (main or a worktree).

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { EditorView, keymap } from '@codemirror/view'
import { Prec } from '@codemirror/state'
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
}, ref) {
  const [value, setValue] = useState(initialContent)
  // "Last saved" content is what's on disk — used to decide dirty state and
  // to revert on discard. Starts equal to initialContent (just loaded).
  const [savedContent, setSavedContent] = useState(initialContent)
  const [status, setStatus] = useState<'idle' | 'dirty' | 'saving' | 'saved' | 'error'>('idle')

  // Keep value in sync if the user opens a different file in the same mount.
  useEffect(() => {
    setValue(initialContent)
    setSavedContent(initialContent)
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
      EditorView.theme({
        '&': { fontSize: '13px', backgroundColor: '#1F1F1F' },
        '.cm-gutters': { backgroundColor: '#1F1F1F', borderRight: '1px solid #2B2B2B' },
        '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.03)' },
        '.cm-activeLineGutter': { backgroundColor: 'rgba(255,255,255,0.04)' },
      }),
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
  }, [projectId, filePath, worktreeId, sessionId, onSaved])

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

  return (
    <div className="flex h-full flex-col">
      {/* Status strip — unobtrusive indicator of save state. Hidden
          in read-only mode since saving is disabled there. */}
      {!readOnly && (
        <div className="flex items-center justify-end px-3 py-1 text-[10px]" style={{ backgroundColor: '#1F1F1F', borderBottom: '1px solid #2B2B2B' }}>
          <span className={
            status === 'saving' ? 'text-zinc-400'
            : status === 'saved' ? 'text-emerald-500'
            : status === 'dirty' ? 'text-amber-500'
            : status === 'error' ? 'text-red-500'
            : 'text-zinc-600'
          }>
            {status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved' : status === 'dirty' ? 'Modified' : status === 'error' ? 'Save failed' : ''}
          </span>
        </div>
      )}
      <div className="flex-1 overflow-y-auto overflow-x-hidden" style={{ backgroundColor: '#1F1F1F' }}>
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
    </div>
  )
})
CodeMirrorFileView.displayName = 'CodeMirrorFileView'
