'use client'

// Editable diff view — replaces the old read-only FullFileDiffView when the
// user opens a file from a change. Keeps the Cursor-style "hybrid" feel:
//   • context (gray) + add (green) lines are part of the live editor doc and
//     can be typed into normally
//   • remove (red) lines are rendered as non-editable block widgets between
//     editor lines, purely as visual reference for what the diff removed
//
// The file on disk only contains the doc content (context + add). When the
// user saves, we PUT that — the remove widgets never touch disk. Once the
// branch is committed/merged, the red widgets simply disappear because the
// diff vs the base ref becomes empty.

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import CodeMirror from '@uiw/react-codemirror'
import {
  EditorView,
  Decoration,
  type DecorationSet,
  WidgetType,
  keymap,
  GutterMarker,
  gutter,
} from '@codemirror/view'
import { StateField, StateEffect, Prec, RangeSetBuilder } from '@codemirror/state'
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

export type DiffLineType = 'context' | 'add' | 'remove'
export interface DiffLine {
  type: DiffLineType
  content: string
  oldLine?: number
  newLine?: number
}

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

// Planning step: given the raw diff lines, decide what goes into the editor
// doc (context + add) and what becomes a read-only red widget. We also
// remember which doc-line each add maps to, so we can paint a green bg, and
// the original old/new line numbers to render a custom gutter.
interface DiffPlan {
  // Lines that live in the editor document, top-to-bottom.
  docLines: Array<{ content: string; type: 'context' | 'add'; oldLine?: number; newLine?: number }>
  // Red widgets that sit between doc lines. `afterDocLine` = -1 means it
  // appears before the very first doc line (top of file).
  removeBlocks: Array<{ afterDocLine: number; lines: Array<{ content: string; oldLine?: number }> }>
}

function planDiff(lines: DiffLine[]): DiffPlan {
  const docLines: DiffPlan['docLines'] = []
  const removeBlocks: DiffPlan['removeBlocks'] = []
  let currentRemoveRun: Array<{ content: string; oldLine?: number }> | null = null

  const flushRemoveRun = () => {
    if (!currentRemoveRun || currentRemoveRun.length === 0) { currentRemoveRun = null; return }
    removeBlocks.push({ afterDocLine: docLines.length - 1, lines: currentRemoveRun })
    currentRemoveRun = null
  }

  for (const l of lines) {
    if (l.type === 'remove') {
      if (!currentRemoveRun) currentRemoveRun = []
      currentRemoveRun.push({ content: l.content, oldLine: l.oldLine })
    } else {
      flushRemoveRun()
      docLines.push({ content: l.content, type: l.type, oldLine: l.oldLine, newLine: l.newLine })
    }
  }
  flushRemoveRun()

  return { docLines, removeBlocks }
}

// ── Widget: a single removed line ───────────────────────────────────────────
// Widgets are block-level and non-editable by default, which is exactly what
// we want — the user's cursor can't land inside one.
class RemoveLineWidget extends WidgetType {
  constructor(readonly content: string, readonly oldLine?: number) { super() }
  eq(other: RemoveLineWidget) {
    return other.content === this.content && other.oldLine === this.oldLine
  }
  toDOM() {
    const row = document.createElement('div')
    row.className = 'cm-diff-remove-row'
    row.setAttribute('aria-hidden', 'false')
    row.setAttribute('role', 'presentation')

    const num = document.createElement('span')
    num.className = 'cm-diff-remove-num'
    num.textContent = this.oldLine != null ? String(this.oldLine) : ''
    row.appendChild(num)

    const marker = document.createElement('span')
    marker.className = 'cm-diff-remove-marker'
    marker.textContent = '−'
    row.appendChild(marker)

    const content = document.createElement('span')
    content.className = 'cm-diff-remove-content'
    // Preserve whitespace but don't wrap shrink — the container handles wrap.
    content.style.whiteSpace = 'pre-wrap'
    content.textContent = this.content === '' ? ' ' : this.content
    row.appendChild(content)

    return row
  }
  ignoreEvent() { return false }
}

// ── Gutter markers for add/context ──────────────────────────────────────────
// We still want the +/space marker column and the old/new line numbers to
// read like the old hand-rolled view. A single combined gutter keeps it
// compact and matches the remove widgets' layout.
class DiffLineNumMarker extends GutterMarker {
  constructor(readonly display: string, readonly kind: 'add' | 'context') { super() }
  toDOM() {
    const el = document.createElement('span')
    el.className = `cm-diff-gutter cm-diff-gutter-${this.kind}`
    el.textContent = this.display
    return el
  }
}

class DiffMarkerMarker extends GutterMarker {
  constructor(readonly kind: 'add' | 'context') { super() }
  toDOM() {
    const el = document.createElement('span')
    el.className = `cm-diff-marker cm-diff-marker-${this.kind}`
    el.textContent = this.kind === 'add' ? '+' : ' '
    return el
  }
}

// ── Decoration state ────────────────────────────────────────────────────────
// A single StateField holds:
//   • line decorations (green bg) for add lines
//   • block widgets (red rows) for remove runs
// Computed from the plan once at mount; doesn't change with user edits
// because edits don't change which line was originally an "add".
const setDecorationsEffect = StateEffect.define<DecorationSet>()

const diffDecorationsField = StateField.define<DecorationSet>({
  create() { return Decoration.none },
  update(deco, tr) {
    for (const e of tr.effects) {
      if (e.is(setDecorationsEffect)) return e.value
    }
    return deco.map(tr.changes)
  },
  provide: (f) => EditorView.decorations.from(f),
})

function buildDecorations(view: EditorView, plan: DiffPlan): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const doc = view.state.doc

  // Top-of-file remove block (anchored before doc line 0)
  for (const block of plan.removeBlocks) {
    if (block.afterDocLine !== -1) continue
    for (const rl of block.lines) {
      const w = Decoration.widget({
        widget: new RemoveLineWidget(rl.content, rl.oldLine),
        block: true,
        side: -1,
      })
      builder.add(0, 0, w)
    }
  }

  // Per-doc-line: line decoration for add, then any remove widgets that
  // belong after this line.
  for (let i = 0; i < plan.docLines.length; i++) {
    if (i >= doc.lines) break
    const line = doc.line(i + 1) // CM lines are 1-based
    const info = plan.docLines[i]
    if (info.type === 'add') {
      builder.add(
        line.from,
        line.from,
        Decoration.line({ class: 'cm-diff-add-line' }),
      )
    }
  }

  for (const block of plan.removeBlocks) {
    if (block.afterDocLine < 0 || block.afterDocLine >= plan.docLines.length) continue
    if (block.afterDocLine >= doc.lines) continue
    const line = doc.line(block.afterDocLine + 1)
    for (const rl of block.lines) {
      const w = Decoration.widget({
        widget: new RemoveLineWidget(rl.content, rl.oldLine),
        block: true,
        side: 1,
      })
      builder.add(line.to, line.to, w)
    }
  }

  return builder.finish()
}

// ── Gutters (line numbers + +/space marker) ─────────────────────────────────
function buildGutters(plan: DiffPlan) {
  const lineNumByDocLine: Array<number | undefined> = plan.docLines.map((d) => d.type === 'add' ? d.newLine : (d.newLine ?? d.oldLine))
  const kindByDocLine: Array<'add' | 'context'> = plan.docLines.map((d) => d.type)

  return [
    // Line number (right-aligned)
    gutter({
      class: 'cm-diff-num-gutter',
      lineMarker(_view, line) {
        const idx = _view.state.doc.lineAt(line.from).number - 1
        const n = lineNumByDocLine[idx]
        const k = kindByDocLine[idx] ?? 'context'
        return new DiffLineNumMarker(n != null ? String(n) : '', k)
      },
      initialSpacer: () => new DiffLineNumMarker('000', 'context'),
    }),
    // +/space marker column
    gutter({
      class: 'cm-diff-marker-gutter',
      lineMarker(_view, line) {
        const idx = _view.state.doc.lineAt(line.from).number - 1
        return new DiffMarkerMarker(kindByDocLine[idx] ?? 'context')
      },
      initialSpacer: () => new DiffMarkerMarker('context'),
    }),
  ]
}

// ── Themed CSS ──────────────────────────────────────────────────────────────
const diffTheme = EditorView.theme({
  '&': { fontSize: '13px', backgroundColor: '#1F1F1F' },
  '.cm-scroller': { overflow: 'auto' },
  '.cm-content': { padding: '0' },
  '.cm-gutters': { backgroundColor: '#1F1F1F', borderRight: 'none', color: '#71717A' },
  '.cm-diff-num-gutter': { minWidth: '2.5rem', padding: '0 0.5rem 0 0.25rem', textAlign: 'right' },
  '.cm-diff-marker-gutter': { width: '1rem', padding: '0', textAlign: 'center' },
  '.cm-diff-gutter': { fontFamily: 'inherit', fontSize: '11px' },
  '.cm-diff-gutter-add': { color: 'rgba(134, 239, 172, 0.8)' }, // emerald-300/80
  '.cm-diff-gutter-context': { color: '#52525B' },              // zinc-600
  '.cm-diff-marker': { fontFamily: 'inherit', fontSize: '12px', fontWeight: '600' },
  '.cm-diff-marker-add': { color: 'rgb(134, 239, 172)' },
  '.cm-diff-marker-context': { color: 'transparent' },
  // Green bg for added lines — matches our non-editable diff view (/25 alpha)
  '.cm-diff-add-line': { backgroundColor: 'rgba(16, 185, 129, 0.25)' },
  // Remove-line widget styling
  '.cm-diff-remove-row': {
    display: 'flex',
    alignItems: 'flex-start',
    backgroundColor: 'rgba(239, 68, 68, 0.25)',
    color: 'rgb(252, 165, 165)', // red-300
    fontFamily: 'inherit',
    fontSize: '13px',
    lineHeight: '1.5',
    cursor: 'default',
    userSelect: 'text',
  },
  '.cm-diff-remove-num': {
    display: 'inline-block',
    minWidth: '2.5rem',
    padding: '0 0.5rem 0 0.25rem',
    textAlign: 'right',
    color: 'rgba(252, 165, 165, 0.8)',
    fontSize: '11px',
    flexShrink: '0',
  },
  '.cm-diff-remove-marker': {
    display: 'inline-block',
    width: '1rem',
    textAlign: 'center',
    color: 'rgb(252, 165, 165)',
    fontWeight: '600',
    flexShrink: '0',
  },
  '.cm-diff-remove-content': {
    flex: '1 1 auto',
    minWidth: '0',
    paddingRight: '1rem',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
  },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent' },
})

// ── Component ───────────────────────────────────────────────────────────────
export interface InlineDiffEditorHandle {
  save: () => Promise<boolean>
  discard: () => void
  isDirty: () => boolean
}

export interface InlineDiffEditorProps {
  projectId: string
  filePath: string
  lines: DiffLine[]
  worktreeId?: string | null
  sessionId?: string | null
  onSaved?: (ok: boolean) => void
  onDirtyChange?: (dirty: boolean) => void
}

export const InlineDiffEditor = forwardRef<InlineDiffEditorHandle, InlineDiffEditorProps>(
  function InlineDiffEditor({ projectId, filePath, lines, worktreeId, sessionId, onSaved, onDirtyChange }, ref) {
    const plan = useMemo(() => planDiff(lines), [lines])
    const initialDoc = useMemo(() => plan.docLines.map((d) => d.content).join('\n'), [plan])

    const [value, setValue] = useState(initialDoc)
    const [savedContent, setSavedContent] = useState(initialDoc)
    const [status, setStatus] = useState<'idle' | 'dirty' | 'saving' | 'saved' | 'error'>('idle')

    useEffect(() => {
      setValue(initialDoc)
      setSavedContent(initialDoc)
      setStatus('idle')
    }, [initialDoc, filePath])

    useEffect(() => { onDirtyChange?.(value !== savedContent) }, [value, savedContent, onDirtyChange])

    const lang = useMemo(() => languageForFile(filePath), [filePath])

    // Attach decorations after the editor mounts.
    const viewRef = useRef<EditorView | null>(null)
    const applyDecorations = useCallback((view: EditorView) => {
      viewRef.current = view
      view.dispatch({ effects: setDecorationsEffect.of(buildDecorations(view, plan)) })
    }, [plan])

    // Re-apply decorations whenever the plan changes (new file opened).
    useEffect(() => {
      if (viewRef.current) {
        viewRef.current.dispatch({ effects: setDecorationsEffect.of(buildDecorations(viewRef.current, plan)) })
      }
    }, [plan])

    const extensions = useMemo(() => {
      const exts = [
        EditorView.lineWrapping,
        diffTheme,
        diffDecorationsField,
        ...buildGutters(plan),
      ]
      if (lang) exts.push(lang)
      return exts
    }, [lang, plan])

    const valueRef = useRef(value)
    valueRef.current = value

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

    const saveKeymap = useMemo(() => Prec.highest(keymap.of([
      { key: 'Mod-s', preventDefault: true, run: () => { void save(); return true } },
    ])), [save])

    const allExtensions = useMemo(() => [saveKeymap, ...extensions], [saveKeymap, extensions])

    useImperativeHandle(ref, () => ({
      save: async () => save(),
      discard: () => { setValue(savedContent); setStatus('idle') },
      isDirty: () => valueRef.current !== savedContent,
    }), [save, savedContent])

    return (
      <div className="flex h-full flex-col">
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
        <div className="flex-1 overflow-y-auto overflow-x-hidden" style={{ backgroundColor: '#1F1F1F' }}>
          <CodeMirror
            value={value}
            height="100%"
            theme={oneDark}
            extensions={allExtensions}
            onChange={handleChange}
            onCreateEditor={applyDecorations}
            basicSetup={{
              lineNumbers: false, // we render our own diff-aware line numbers
              highlightActiveLine: false,
              highlightActiveLineGutter: false,
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
  },
)
InlineDiffEditor.displayName = 'InlineDiffEditor'
