'use client'

// Cursor-style "Add to Chat" selection helper.
//
// Strict design choices, learned from a previous iteration:
//
//   1. We only commit selection state on `mouseup`, never on every
//      `selectionchange` during drag. Committing mid-drag would mount
//      the floating button over the editor and intercept mousemove —
//      the user would see no native selection highlight at all because
//      the drag never reaches the editor's surface. Keyboard selections
//      (Shift+arrows) still work because we listen to `selectionchange`
//      only when the mouse is up.
//
//   2. Mousedown on a `[data-selection-button]` element is ignored —
//      otherwise clicking "Add to Chat" would tear down the selection
//      before the click handler runs.
//
//   3. The committed `range` is held verbatim. Position computations
//      should call `range.getBoundingClientRect()` at render time so
//      scrolling the container updates the rect without us having to
//      rebuild state. Pair this hook with a scroll listener that just
//      forces a re-render.
//
//   4. Both endpoints must sit inside the supplied container — partial
//      selections that started outside (e.g. user dragged from header
//      into editor body) shouldn't activate the button.

import { useCallback, useEffect, useState } from 'react'

export interface DOMTextSelection {
  range: Range
  text: string
}

export function useDOMTextSelection(
  containerRef: React.RefObject<HTMLElement | null>,
): { selection: DOMTextSelection | null; clear: () => void } {
  const [selection, setSelection] = useState<DOMTextSelection | null>(null)

  useEffect(() => {
    let mouseDown = false

    function commit() {
      const container = containerRef.current
      if (!container) { setSelection(null); return }
      const sel = window.getSelection()
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) { setSelection(null); return }
      const range = sel.getRangeAt(0)
      if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) {
        setSelection(null); return
      }
      const text = sel.toString()
      if (!text.trim()) { setSelection(null); return }
      setSelection({ range, text })
    }

    function isOnButton(target: EventTarget | null): boolean {
      const el = target as HTMLElement | null
      return !!el?.closest?.('[data-selection-button]')
    }

    function onMouseDown(e: MouseEvent) {
      // Click on the button itself — let the click handler run; do NOT
      // tear down the selection prematurely.
      if (isOnButton(e.target)) return
      mouseDown = true
      // Any other mousedown (inside editor → starting a new drag, or
      // outside editor → "click outside") immediately retires the
      // current button. Even before mouseup the user gets feedback.
      setSelection(null)
    }

    function onMouseUp(e: MouseEvent) {
      if (isOnButton(e.target)) return
      mouseDown = false
      // Defer one tick so the final `selectionchange` settles first.
      queueMicrotask(commit)
    }

    function onSelectionChange() {
      // Keyboard-driven (Shift+arrows). Drag is handled by mouseup.
      if (!mouseDown) commit()
    }

    document.addEventListener('mousedown', onMouseDown, true)
    document.addEventListener('mouseup', onMouseUp, true)
    document.addEventListener('selectionchange', onSelectionChange)

    return () => {
      document.removeEventListener('mousedown', onMouseDown, true)
      document.removeEventListener('mouseup', onMouseUp, true)
      document.removeEventListener('selectionchange', onSelectionChange)
    }
  }, [containerRef])

  const clear = useCallback(() => {
    setSelection(null)
    window.getSelection()?.removeAllRanges()
  }, [])

  return { selection, clear }
}
