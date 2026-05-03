'use client'

// Floating "Add to Chat" pill — appears next to a text selection inside
// the worktree explorer's editable viewers (CodeMirrorFileView and
// InlineDiffEditor). Position is recomputed on every render so the caller
// can re-render on scroll and keep the pill anchored to the selection.
//
// The `data-selection-button` attribute lets useDOMTextSelection ignore
// mousedown events on the pill — without that, clicking the pill would
// tear down the selection before the click handler runs.

import { useEffect } from 'react'

const MAX_LINES = 1000

export interface SelectionAddButtonProps {
  // Viewport-space anchor (the selection's bounding rect). Caller passes
  // the rect every render — recomputing during a scroll re-render keeps
  // the pill glued to the highlighted text.
  anchor: { top: number; right: number }
  lineCount: number
  onAdd: () => void
  // Caller's "dismiss this selection" hook. The hook layer ALSO clears
  // on outside mousedown — this is just for Esc and the click handler.
  onDismiss: () => void
}

export function SelectionAddButton({ anchor, lineCount, onAdd, onDismiss }: SelectionAddButtonProps) {
  const overCap = lineCount > MAX_LINES

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onDismiss()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onDismiss])

  // Anchor just above the selection. Clamp into viewport so the pill
  // doesn't escape off the top edge or off the right edge on long lines.
  const top = Math.max(8, anchor.top - 36)
  const left = Math.max(8, Math.min(window.innerWidth - 200, anchor.right - 160))

  return (
    <div
      data-selection-button
      onMouseDown={(e) => e.preventDefault() /* keep the underlying selection alive */}
      className="fixed z-50 flex items-center gap-1.5 rounded-md border border-white/10 px-2 py-1 text-[11px] shadow-lg"
      style={{ top, left, backgroundColor: '#252526' }}
    >
      <button
        type="button"
        onClick={onAdd}
        disabled={overCap}
        className={
          overCap
            ? 'flex items-center gap-1.5 cursor-not-allowed text-zinc-500'
            : 'flex items-center gap-1.5 text-zinc-200 hover:text-white'
        }
        title={overCap ? `Selection too large (${lineCount} lines, max ${MAX_LINES})` : 'Add selection to chat'}
      >
        <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={1.75} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
        </svg>
        <span>Add to Chat</span>
        <span className="text-[10px] text-zinc-500">{lineCount} line{lineCount === 1 ? '' : 's'}</span>
      </button>
    </div>
  )
}

export const SELECTION_MAX_LINES = MAX_LINES
