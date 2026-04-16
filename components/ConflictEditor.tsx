'use client'

// Conflict resolver — CodeMirror editor that renders a file with git
// conflict markers and adds inline Accept Ours / Theirs / Both /
// Compare buttons above each conflict block. Writes edits straight
// back to the working tree via the existing PUT /repository/files
// endpoint, mirroring what the regular file editor does.
//
// Marker grammar handled:
//   diff2 (default):
//     <<<<<<< OURS
//     ours content
//     =======
//     theirs content
//     >>>>>>> THEIRS
//
//   diff3 (what /rebase/start uses via `merge.conflictStyle=diff3`):
//     <<<<<<< OURS
//     ours content
//     ||||||| BASE
//     base content
//     =======
//     theirs content
//     >>>>>>> THEIRS

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import {
  EditorView,
  Decoration,
  type DecorationSet,
  WidgetType,
  keymap,
} from '@codemirror/view'
import { StateField, StateEffect, Prec } from '@codemirror/state'
import { oneDark } from '@codemirror/theme-one-dark'
import { MOCK_CONFLICTS, MOCK_GIT_STATUS } from '@/lib/mocks/checks-demo'

// ── Parser ─────────────────────────────────────────────────────────────

export interface ConflictBlock {
  // 0-based line numbers in the source file, inclusive on both ends.
  startLine: number          // line with <<<<<<<
  oursEndLine: number        // line with ||||||| or ======= (exclusive of ours)
  baseEndLine: number | null // line with =======, if diff3; else null
  theirsEndLine: number      // line with >>>>>>>
  endLine: number            // == theirsEndLine, kept for symmetry
  // Raw text of each side (no markers, no trailing newline).
  ours: string
  base: string | null
  theirs: string
}

export function parseConflicts(source: string): ConflictBlock[] {
  const lines = source.split('\n')
  const blocks: ConflictBlock[] = []
  let i = 0
  while (i < lines.length) {
    const l = lines[i]
    if (!l.startsWith('<<<<<<< ') && l !== '<<<<<<<') { i++; continue }

    const startLine = i
    let oursEndLine = -1
    let baseEndLine: number | null = null
    let theirsEndLine = -1
    // Walk forward looking for the closing markers.
    for (let j = i + 1; j < lines.length; j++) {
      const lj = lines[j]
      if (lj.startsWith('||||||| ') || lj === '|||||||') {
        oursEndLine = j
        // Continue scanning for ======= after the base section.
        for (let k = j + 1; k < lines.length; k++) {
          if (lines[k] === '=======') { baseEndLine = k; break }
          if (lines[k].startsWith('<<<<<<<') || lines[k].startsWith('>>>>>>>')) break
        }
        if (baseEndLine != null) {
          for (let k = baseEndLine + 1; k < lines.length; k++) {
            if (lines[k].startsWith('>>>>>>> ') || lines[k] === '>>>>>>>') { theirsEndLine = k; break }
          }
        }
        break
      }
      if (lj === '=======') {
        oursEndLine = j
        for (let k = j + 1; k < lines.length; k++) {
          if (lines[k].startsWith('>>>>>>> ') || lines[k] === '>>>>>>>') { theirsEndLine = k; break }
        }
        break
      }
    }
    if (oursEndLine < 0 || theirsEndLine < 0) { i++; continue }

    const ours = lines.slice(startLine + 1, oursEndLine).join('\n')
    const base = baseEndLine != null ? lines.slice(oursEndLine + 1, baseEndLine).join('\n') : null
    const theirsStart = baseEndLine != null ? baseEndLine + 1 : oursEndLine + 1
    const theirs = lines.slice(theirsStart, theirsEndLine).join('\n')

    blocks.push({
      startLine, oursEndLine, baseEndLine, theirsEndLine,
      endLine: theirsEndLine, ours, base, theirs,
    })
    i = theirsEndLine + 1
  }
  return blocks
}

// Replace a block (by its line range) in the source with `replacement`.
function replaceBlock(source: string, block: ConflictBlock, replacement: string): string {
  const lines = source.split('\n')
  const before = lines.slice(0, block.startLine)
  const after = lines.slice(block.endLine + 1)
  const middle = replacement === '' ? [] : replacement.split('\n')
  return [...before, ...middle, ...after].join('\n')
}

// ── CodeMirror widget ──────────────────────────────────────────────────

// Widget placed above each conflict block with inline action buttons.
class ConflictActionsWidget extends WidgetType {
  constructor(
    readonly onAcceptOurs: () => void,
    readonly onAcceptTheirs: () => void,
    readonly onAcceptBoth: () => void,
    readonly index: number,
    readonly total: number,
    readonly hasBase: boolean,
  ) { super() }
  eq() { return false } // always re-render — closures change
  toDOM() {
    const row = document.createElement('div')
    row.className = 'cm-conflict-actions'
    row.style.cssText = 'display:flex;gap:6px;padding:4px 12px;font-size:10px;background:rgba(255,255,255,0.03);border-top:1px solid #2B2B2B;border-bottom:1px solid #2B2B2B;'

    const label = document.createElement('span')
    label.style.cssText = 'color:#71717A;font-weight:500;margin-right:auto;'
    label.textContent = `Conflict ${this.index + 1}/${this.total}${this.hasBase ? ' · with base' : ''}`
    row.appendChild(label)

    const btn = (text: string, handler: () => void, color: string) => {
      const b = document.createElement('button')
      b.textContent = text
      b.style.cssText = `color:${color};font-weight:600;padding:2px 6px;border-radius:3px;border:1px solid ${color}40;background:${color}10;`
      b.onmouseenter = () => { b.style.background = `${color}20` }
      b.onmouseleave = () => { b.style.background = `${color}10` }
      b.onclick = (e) => { e.preventDefault(); handler() }
      return b
    }

    row.appendChild(btn('Keep yours', this.onAcceptOurs, '#34D399'))
    row.appendChild(btn('Keep theirs', this.onAcceptTheirs, '#60A5FA'))
    row.appendChild(btn('Keep both', this.onAcceptBoth, '#A78BFA'))
    return row
  }
  ignoreEvent() { return false }
}

// ── Component ──────────────────────────────────────────────────────────

export interface ConflictEditorHandle {
  isResolved: () => boolean
  save: () => Promise<boolean>
  reload: () => void
}

export interface ConflictEditorProps {
  projectId: string
  worktreeId: string
  filePath: string
  // Called when the file transitions from "has conflicts" → "fully
  // resolved" (no markers left). Parent uses this to enable
  // "Mark as resolved".
  onResolvedChange?: (resolved: boolean) => void
}

export const ConflictEditor = forwardRef<ConflictEditorHandle, ConflictEditorProps>(
  function ConflictEditor({ projectId, worktreeId, filePath, onResolvedChange }, ref) {
    const [content, setContent] = useState<string>('')
    const [originalContent, setOriginalContent] = useState<string>('')
    const [loading, setLoading] = useState(true)
    const contentRef = useRef('')
    contentRef.current = content

    // ── Load file content ──────────────────────────────────────────────
    const load = useCallback(async () => {
      setLoading(true)
      // Mock short-circuit: serve the pre-fab conflict content so the
      // demo loads instantly without a sandbox.
      if (MOCK_GIT_STATUS && MOCK_CONFLICTS && MOCK_CONFLICTS.contents[filePath] != null) {
        const mockContent = MOCK_CONFLICTS.contents[filePath]
        setContent(mockContent)
        setOriginalContent(mockContent)
        setLoading(false)
        return
      }
      try {
        const res = await fetch(`/api/projects/${projectId}/repository/files/${encodeURIComponent(filePath)}?worktree=${worktreeId}`)
        if (res.ok) {
          const data = await res.json()
          setContent(data.content ?? '')
          setOriginalContent(data.content ?? '')
        }
      } catch {}
      setLoading(false)
    }, [projectId, worktreeId, filePath])

    useEffect(() => { load() }, [load])

    // ── Decorations ────────────────────────────────────────────────────
    const blocks = useMemo(() => parseConflicts(content), [content])
    const isResolved = blocks.length === 0

    useEffect(() => { onResolvedChange?.(isResolved) }, [isResolved, onResolvedChange])

    // Build a StateField that emits decorations for every conflict in
    // the current doc. We rebuild on each content change by dispatching
    // a setEffects effect — simpler than tracking edits.
    const setDecosEffect = useMemo(() => StateEffect.define<DecorationSet>(), [])
    const decoField = useMemo(() => StateField.define<DecorationSet>({
      create: () => Decoration.none,
      update: (deco, tr) => {
        for (const e of tr.effects) if (e.is(setDecosEffect)) return e.value
        return deco.map(tr.changes)
      },
      provide: (f) => EditorView.decorations.from(f),
    }), [setDecosEffect])

    const viewRef = useRef<EditorView | null>(null)

    const rebuildDecorations = useCallback(() => {
      const view = viewRef.current
      if (!view) return
      const doc = view.state.doc
      const decos: Array<{ from: number; to: number; deco: Decoration }> = []

      blocks.forEach((b, idx) => {
        // Line numbers in CodeMirror are 1-based.
        const startLinePos = doc.line(b.startLine + 1).from

        // Action widget sits ABOVE the <<<<<<< line.
        decos.push({
          from: startLinePos,
          to: startLinePos,
          deco: Decoration.widget({
            widget: new ConflictActionsWidget(
              () => acceptBlock(b, b.ours),
              () => acceptBlock(b, b.theirs),
              () => acceptBlock(b, `${b.ours}\n${b.theirs}`),
              idx,
              blocks.length,
              b.base != null,
            ),
            block: true,
            side: -1,
          }),
        })

        // Line-bg tints: ours (emerald), base (zinc), theirs (blue),
        // marker lines (red-ish) so the marker rows themselves are
        // visually muted.
        const tint = (lineNum: number, cls: string) => {
          if (lineNum >= doc.lines) return
          const l = doc.line(lineNum + 1)
          decos.push({ from: l.from, to: l.from, deco: Decoration.line({ class: cls }) })
        }
        tint(b.startLine, 'cm-conflict-marker')
        tint(b.endLine, 'cm-conflict-marker')
        if (b.baseEndLine != null) {
          tint(b.oursEndLine, 'cm-conflict-marker')
          tint(b.baseEndLine, 'cm-conflict-marker')
          for (let n = b.startLine + 1; n < b.oursEndLine; n++) tint(n, 'cm-conflict-ours')
          for (let n = b.oursEndLine + 1; n < b.baseEndLine; n++) tint(n, 'cm-conflict-base')
          for (let n = b.baseEndLine + 1; n < b.endLine; n++) tint(n, 'cm-conflict-theirs')
        } else {
          tint(b.oursEndLine, 'cm-conflict-marker')
          for (let n = b.startLine + 1; n < b.oursEndLine; n++) tint(n, 'cm-conflict-ours')
          for (let n = b.oursEndLine + 1; n < b.endLine; n++) tint(n, 'cm-conflict-theirs')
        }
      })

      // Sort by (from) then rebuild a RangeSet via Decoration.set.
      decos.sort((a, b) => a.from - b.from || (a.to - a.from) - (b.to - b.from))
      const set = Decoration.set(decos.map((d) => d.deco.range(d.from, d.to)), true)
      view.dispatch({ effects: setDecosEffect.of(set) })
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [blocks, setDecosEffect])

    useEffect(() => { rebuildDecorations() }, [rebuildDecorations])

    function acceptBlock(block: ConflictBlock, replacement: string) {
      setContent((prev) => replaceBlock(prev, block, replacement))
    }

    const save = useCallback(async (): Promise<boolean> => {
      if (MOCK_GIT_STATUS && MOCK_CONFLICTS && MOCK_CONFLICTS.contents[filePath] != null) {
        // In mock mode we just accept the "save" locally.
        setOriginalContent(contentRef.current)
        return true
      }
      try {
        const res = await fetch(`/api/projects/${projectId}/repository/files/${encodeURIComponent(filePath)}?worktree=${worktreeId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: contentRef.current }),
        })
        if (!res.ok) return false
        setOriginalContent(contentRef.current)
        return true
      } catch { return false }
    }, [projectId, worktreeId, filePath])

    useImperativeHandle(ref, () => ({
      isResolved: () => parseConflicts(contentRef.current).length === 0,
      save,
      reload: load,
    }), [save, load])

    const extensions = useMemo(() => [
      EditorView.lineWrapping,
      decoField,
      Prec.highest(keymap.of([
        { key: 'Mod-s', preventDefault: true, run: () => { void save(); return true } },
      ])),
      EditorView.theme({
        '.cm-conflict-marker': { backgroundColor: 'rgba(113, 113, 122, 0.18)', color: '#a1a1aa' },
        '.cm-conflict-ours': { backgroundColor: 'rgba(16, 185, 129, 0.18)' },
        '.cm-conflict-base': { backgroundColor: 'rgba(113, 113, 122, 0.22)' },
        '.cm-conflict-theirs': { backgroundColor: 'rgba(59, 130, 246, 0.18)' },
      }),
    ], [decoField, save])

    if (loading) {
      return <div className="flex h-full items-center justify-center text-[11px] text-zinc-500">Loading {filePath}…</div>
    }

    // Note: unused warning — keeping the originalContent comparison for
    // "discard changes" in a later pass.
    void originalContent

    return (
      <CodeMirror
        value={content}
        height="100%"
        theme={oneDark}
        extensions={extensions}
        onCreateEditor={(view) => { viewRef.current = view; rebuildDecorations() }}
        onChange={(v) => setContent(v)}
        basicSetup={{
          lineNumbers: true,
          highlightActiveLine: false,
          foldGutter: false,
          autocompletion: false,
          bracketMatching: false,
          closeBrackets: false,
          indentOnInput: false,
        }}
      />
    )
  },
)
ConflictEditor.displayName = 'ConflictEditor'
