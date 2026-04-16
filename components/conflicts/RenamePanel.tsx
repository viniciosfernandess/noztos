'use client'

// Rename + edit conflict panel. Shown when one side renamed the file
// (e.g. Header.tsx → NavigationHeader.tsx) and the other side edited
// it under the original name. User picks:
//   • Keep rename  — keep the new filename, discard the edits
//   • Keep edits   — keep the original filename + apply the edits
//   • Keep both    — use the rename AND apply the edits on top
//
// Shows the edit diff so the user can judge whether the edits are
// still relevant post-rename.

import { useMemo } from 'react'

export type RenameChoice = 'rename' | 'edits' | 'both' | null

export interface RenamePanelProps {
  newPath: string
  oldPath: string
  editedContent: string          // content of the modified file on the edit side
  originalContent: string        // base version before either change
  choice: RenameChoice
  onPick: (choice: RenameChoice) => void
}

export function RenamePanel({ newPath, oldPath, editedContent, originalContent, choice, onPick }: RenamePanelProps) {
  const lines = useMemo(() => {
    const before = originalContent.split('\n')
    const after = editedContent.split('\n')
    return { before, after }
  }, [originalContent, editedContent])

  const tint = (c: RenameChoice) => c === 'rename' ? 'emerald' : c === 'edits' ? 'blue' : 'purple'

  return (
    <div className="flex h-full flex-col overflow-y-auto p-4" style={{ backgroundColor: '#181818' }}>
      <div className="mb-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
        <div className="mb-0.5 font-medium">This file was renamed on one side and edited on the other.</div>
        <div className="text-amber-300/70">
          <span className="font-mono text-zinc-300">{oldPath}</span>
          <span className="mx-2">→</span>
          <span className="font-mono text-zinc-300">{newPath}</span>
        </div>
      </div>

      <div className="mb-3 rounded-md border border-emerald-500/40" style={{ backgroundColor: 'rgba(255,255,255,0.02)' }}>
        <div className="flex items-center justify-between bg-emerald-500/10 px-3 py-1.5">
          <div>
            <span className="text-[11px] font-semibold text-emerald-300">Keep the rename</span>
            <span className="ml-2 text-[10px] text-zinc-500">file becomes <span className="font-mono text-zinc-300">{newPath}</span>, edits discarded</span>
          </div>
          <PickButton accent="emerald" selected={choice === 'rename'} label="Keep rename" onClick={() => onPick('rename')} />
        </div>
      </div>

      <div className="mb-3 rounded-md border border-blue-500/40" style={{ backgroundColor: 'rgba(255,255,255,0.02)' }}>
        <div className="flex items-center justify-between bg-blue-500/10 px-3 py-1.5">
          <div>
            <span className="text-[11px] font-semibold text-blue-300">Keep the edits</span>
            <span className="ml-2 text-[10px] text-zinc-500">file stays as <span className="font-mono text-zinc-300">{oldPath}</span> with the edits applied</span>
          </div>
          <PickButton accent="blue" selected={choice === 'edits'} label="Keep edits" onClick={() => onPick('edits')} />
        </div>
        <DiffPreview before={lines.before} after={lines.after} />
      </div>

      <div className="mb-3 rounded-md border border-purple-500/40" style={{ backgroundColor: 'rgba(255,255,255,0.02)' }}>
        <div className="flex items-center justify-between bg-purple-500/10 px-3 py-1.5">
          <div>
            <span className="text-[11px] font-semibold text-purple-300">Keep both</span>
            <span className="ml-2 text-[10px] text-zinc-500">rename to <span className="font-mono text-zinc-300">{newPath}</span> AND apply the edits</span>
          </div>
          <PickButton accent="purple" selected={choice === 'both'} label="Keep both" onClick={() => onPick('both')} />
        </div>
      </div>

      {choice && (
        <button
          onClick={() => onPick(null)}
          className="self-end text-[11px] text-zinc-500 hover:text-zinc-300"
        >
          Clear choice
        </button>
      )}

      {/* silence unused warning from the tint helper reserved for future themes */}
      <span className="hidden">{tint(choice)}</span>
    </div>
  )
}

function PickButton({ accent, selected, label, onClick }: { accent: 'emerald' | 'blue' | 'purple'; selected: boolean; label: string; onClick: () => void }) {
  const classes = accent === 'emerald' ? 'border-emerald-500/60 bg-emerald-500/20 text-emerald-200 hover:bg-emerald-500/30'
    : accent === 'blue' ? 'border-blue-500/60 bg-blue-500/20 text-blue-200 hover:bg-blue-500/30'
    : 'border-purple-500/60 bg-purple-500/20 text-purple-200 hover:bg-purple-500/30'
  return (
    <button
      onClick={onClick}
      className={`rounded-md border px-2.5 py-0.5 text-[11px] font-semibold transition-colors ${classes} ${selected ? 'ring-1 ring-white/40' : ''}`}
    >
      {selected ? '✓ Selected' : label}
    </button>
  )
}

function DiffPreview({ before, after }: { before: string[]; after: string[] }) {
  // Simple line-by-line comparison — good enough as a preview.
  const max = Math.max(before.length, after.length)
  const rows: Array<{ old?: string; now?: string; kind: 'same' | 'change' | 'add' | 'remove' }> = []
  for (let i = 0; i < max; i++) {
    const oldLine = before[i]
    const newLine = after[i]
    if (oldLine === newLine) rows.push({ old: oldLine, now: newLine, kind: 'same' })
    else if (oldLine === undefined) rows.push({ now: newLine, kind: 'add' })
    else if (newLine === undefined) rows.push({ old: oldLine, kind: 'remove' })
    else rows.push({ old: oldLine, now: newLine, kind: 'change' })
  }
  return (
    <div className="overflow-x-auto border-t border-blue-500/20 text-[11px]" style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', backgroundColor: '#1F1F1F' }}>
      {rows.slice(0, 40).map((r, i) => (
        <div key={i} className={`flex items-start ${
          r.kind === 'add' ? 'bg-emerald-500/10'
          : r.kind === 'remove' ? 'bg-red-500/10'
          : r.kind === 'change' ? 'bg-blue-500/10'
          : ''
        }`}>
          <span className="w-10 shrink-0 select-none pr-2 text-right text-[10px] text-zinc-600 tabular-nums">{i + 1}</span>
          <span className="flex-1 whitespace-pre-wrap break-all text-zinc-200">{r.now ?? r.old ?? '\u00a0'}</span>
        </div>
      ))}
      {rows.length > 40 && (
        <div className="px-3 py-1 text-[10px] text-zinc-600">+ {rows.length - 40} more lines</div>
      )}
    </div>
  )
}
