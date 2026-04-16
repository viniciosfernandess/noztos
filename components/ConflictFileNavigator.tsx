'use client'

// Per-file conflict navigator — replaces the old full-editor view.
// Shows numbered tabs, one per conflict block. Clicking a tab shows
// only that conflict with its two (or three, diff3) sides stacked.
// The user picks one option per conflict; the tab tint reflects the
// choice (green ours, blue theirs, purple both). When every tab has a
// choice, the file is considered resolved.
//
// Selection is local state here. On resolve, we build the final file
// content by walking the parsed blocks and replacing each with the
// selected side, then hand the string back to the parent via
// onContentChange. The raw marker-free result is what gets saved.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { parseConflicts, type ConflictBlock } from './ConflictEditor'
import { highlightLines, getLanguageFromFilename } from '@/lib/shiki'

export type ConflictChoice = 'ours' | 'theirs' | 'both' | null

export interface ConflictFileNavigatorProps {
  projectId: string
  worktreeId: string
  filePath: string
  // Called every time the resolved/unresolved state or the effective
  // file content changes. Parent persists via the existing save path.
  onChange?: (info: { resolved: boolean; content: string }) => void
  // Pre-loaded content so the parent (ConflictResolver) can control
  // caching / the mock path.
  initialContent: string
}

export function ConflictFileNavigator({ filePath, initialContent, onChange }: ConflictFileNavigatorProps) {
  const blocks = useMemo(() => parseConflicts(initialContent), [initialContent])
  // One slot per block, remembering the user's pick.
  const [choices, setChoices] = useState<ConflictChoice[]>(() => blocks.map(() => null))
  const [activeIdx, setActiveIdx] = useState(0)

  // Reset when the file (or its parsed blocks) changes.
  useEffect(() => {
    setChoices(blocks.map(() => null))
    setActiveIdx(0)
  }, [initialContent, blocks])

  const resolved = choices.length > 0 && choices.every((c) => c !== null)

  // Build the final file content by replacing each conflict with the
  // user's pick. Unselected blocks keep their markers (file will still
  // fail to compile / be flagged as conflicted on save).
  const resolvedContent = useMemo(() => {
    const lines = initialContent.split('\n')
    const out: string[] = []
    let cursor = 0
    blocks.forEach((b, idx) => {
      // Copy lines up to (not including) the <<<<<<< of this block.
      while (cursor < b.startLine) { out.push(lines[cursor]); cursor++ }
      const choice = choices[idx]
      const replacement = choice === 'ours' ? b.ours
        : choice === 'theirs' ? b.theirs
        : choice === 'both' ? (b.ours + '\n' + b.theirs)
        : lines.slice(b.startLine, b.endLine + 1).join('\n') // keep raw markers for unresolved
      if (replacement.length > 0) out.push(...replacement.split('\n'))
      cursor = b.endLine + 1
    })
    // Remaining tail.
    while (cursor < lines.length) { out.push(lines[cursor]); cursor++ }
    return out.join('\n')
  }, [blocks, choices, initialContent])

  // Propagate on every change so the parent can auto-save when done.
  useEffect(() => {
    onChange?.({ resolved, content: resolvedContent })
  }, [resolved, resolvedContent, onChange])

  const applyChoice = useCallback((choice: ConflictChoice) => {
    setChoices((prev) => {
      const next = [...prev]
      next[activeIdx] = choice
      return next
    })
    // Auto-advance to the next pending tab for flow speed.
    const nextPending = choices.findIndex((c, i) => i > activeIdx && c === null)
    if (nextPending !== -1) setActiveIdx(nextPending)
  }, [activeIdx, choices])

  if (blocks.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-[11px] text-zinc-500">
        {filePath} has no conflict markers.
      </div>
    )
  }

  const activeBlock = blocks[activeIdx]
  const activeChoice = choices[activeIdx]

  return (
    <div className="flex h-full flex-col">
      {/* Tab bar — one tab per conflict, colored by the user's pick */}
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-[#2B2B2B] px-3 py-2" style={{ backgroundColor: '#1F1F1F' }}>
        <span className="mr-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Conflicts</span>
        {blocks.map((_, idx) => {
          const c = choices[idx]
          const active = idx === activeIdx
          const tint = c === 'ours' ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
            : c === 'theirs' ? 'bg-blue-500/20 text-blue-300 border-blue-500/40'
            : c === 'both' ? 'bg-purple-500/20 text-purple-300 border-purple-500/40'
            : 'bg-transparent text-zinc-400 border-[#2B2B2B]'
          return (
            <button
              key={idx}
              onClick={() => setActiveIdx(idx)}
              className={`rounded-md border px-2.5 py-1 text-[11px] font-semibold transition-colors ${tint} ${active ? 'ring-1 ring-white/30' : ''}`}
            >
              {idx + 1}
              {c && (
                <svg className="ml-1 inline-block h-2.5 w-2.5" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              )}
            </button>
          )
        })}
        <div className="ml-auto text-[10px] text-zinc-500 tabular-nums">
          {choices.filter((c) => c !== null).length} / {blocks.length} resolved
        </div>
      </div>

      {/* Side panels — stacked versions of the selected conflict */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4" style={{ backgroundColor: '#181818' }}>
        <ConflictVersionBlock
          label="Your version"
          sublabel="the commits on this branch"
          accent="emerald"
          content={activeBlock.ours}
          filename={filePath}
          selected={activeChoice === 'ours'}
          onPick={() => applyChoice('ours')}
          pickLabel="Keep yours"
        />
        {activeBlock.base != null && (
          <ConflictVersionBlock
            label="Base"
            sublabel="common ancestor, for reference"
            accent="zinc"
            content={activeBlock.base}
            filename={filePath}
            readOnly
          />
        )}
        <ConflictVersionBlock
          label="Their version"
          sublabel="what's now on main"
          accent="blue"
          content={activeBlock.theirs}
          filename={filePath}
          selected={activeChoice === 'theirs'}
          onPick={() => applyChoice('theirs')}
          pickLabel="Keep theirs"
        />

        <div className="mt-3 flex items-center justify-end gap-2">
          <button
            onClick={() => applyChoice('both')}
            className={`rounded-md border px-3 py-1 text-[11px] font-semibold transition-colors ${activeChoice === 'both' ? 'border-purple-500/60 bg-purple-500/20 text-purple-200' : 'border-[#2B2B2B] text-zinc-300 hover:border-purple-500/40 hover:bg-purple-500/10'}`}
          >
            Keep both
          </button>
          {activeChoice && (
            <button
              onClick={() => {
                setChoices((prev) => { const n = [...prev]; n[activeIdx] = null; return n })
              }}
              className="rounded-md border border-[#2B2B2B] px-3 py-1 text-[11px] font-medium text-zinc-400 hover:bg-white/5"
            >
              Clear choice
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function ConflictVersionBlock({
  label, sublabel, accent, content, filename, selected, onPick, pickLabel, readOnly,
}: {
  label: string
  sublabel: string
  accent: 'emerald' | 'blue' | 'zinc'
  content: string
  filename: string
  selected?: boolean
  onPick?: () => void
  pickLabel?: string
  readOnly?: boolean
}) {
  const accentClasses = accent === 'emerald' ? { border: 'border-emerald-500/40', bg: 'bg-emerald-500/10', text: 'text-emerald-300', button: 'border-emerald-500/60 bg-emerald-500/20 text-emerald-200 hover:bg-emerald-500/30' }
    : accent === 'blue' ? { border: 'border-blue-500/40', bg: 'bg-blue-500/10', text: 'text-blue-300', button: 'border-blue-500/60 bg-blue-500/20 text-blue-200 hover:bg-blue-500/30' }
    : { border: 'border-zinc-600/40', bg: 'bg-zinc-500/5', text: 'text-zinc-400', button: '' }

  const [htmlLines, setHtmlLines] = useState<string[] | null>(null)
  useEffect(() => {
    let cancelled = false
    const lang = getLanguageFromFilename(filename)
    highlightLines(content, lang).then((lines) => { if (!cancelled) setHtmlLines(lines) })
    return () => { cancelled = true }
  }, [content, filename])

  const plainLines = content === '' ? [''] : content.split('\n')
  const display = htmlLines ?? plainLines

  return (
    <div className={`mb-3 rounded-md border ${selected ? 'ring-1 ring-white/40' : ''} ${accentClasses.border}`} style={{ backgroundColor: 'rgba(255,255,255,0.02)' }}>
      <div className={`flex items-center justify-between px-3 py-1.5 ${accentClasses.bg}`}>
        <div>
          <span className={`text-[11px] font-semibold ${accentClasses.text}`}>{label}</span>
          <span className="ml-2 text-[10px] text-zinc-500">{sublabel}</span>
        </div>
        {!readOnly && onPick && (
          <button
            onClick={onPick}
            className={`rounded-md border px-2.5 py-0.5 text-[11px] font-semibold transition-colors ${selected ? accentClasses.button : `${accentClasses.border} ${accentClasses.text} hover:${accentClasses.bg}`}`}
          >
            {selected ? '✓ Selected' : pickLabel}
          </button>
        )}
      </div>
      <div className="overflow-x-auto text-[12px] leading-[1.5]" style={{ backgroundColor: '#1F1F1F', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
        {content === '' ? (
          <div className="px-3 py-2 text-[11px] italic text-zinc-600">(empty)</div>
        ) : display.map((line, i) => (
          <div key={i} className="flex items-start">
            <span className="w-10 shrink-0 select-none pr-3 pt-px text-right text-[10px] text-zinc-600 tabular-nums">
              {i + 1}
            </span>
            <span className="flex-1 pr-3" dangerouslySetInnerHTML={{ __html: htmlLines ? (line || '&nbsp;') : escapeHtml(line) || '&nbsp;' }} />
          </div>
        ))}
      </div>
    </div>
  )
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
