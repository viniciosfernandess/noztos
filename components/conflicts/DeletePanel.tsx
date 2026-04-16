'use client'

// Delete + edit conflict panel. Shown when one side deleted the file
// and the other side edited it. User picks:
//   • Delete the file — mirrors the deletion
//   • Keep it alive  — keeps the edited version
// No "both" here because the action is binary (file exists or it doesn't).

import { useMemo } from 'react'

export type DeleteChoice = 'delete' | 'keep' | null

export interface DeletePanelProps {
  path: string
  content: string                       // the edited version (what would be kept)
  deletedBy: 'ours' | 'theirs'
  choice: DeleteChoice
  onPick: (choice: DeleteChoice) => void
}

export function DeletePanel({ path, content, deletedBy, choice, onPick }: DeletePanelProps) {
  const lines = useMemo(() => content.split('\n'), [content])
  const deleteLabel = deletedBy === 'ours' ? 'You (this branch) deleted the file' : 'The main branch deleted the file'
  const editedLabel = deletedBy === 'ours' ? 'The main branch still has edits' : 'This branch still has edits'

  return (
    <div className="flex h-full flex-col overflow-y-auto p-4" style={{ backgroundColor: '#181818' }}>
      <div className="mb-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
        <div className="mb-0.5 font-medium">Delete vs. edit conflict</div>
        <div className="text-amber-300/70">
          <div><span className="font-mono text-zinc-300">{path}</span></div>
          <div className="mt-1">{deleteLabel}. {editedLabel}.</div>
        </div>
      </div>

      <div className="mb-3 rounded-md border border-red-500/40" style={{ backgroundColor: 'rgba(255,255,255,0.02)' }}>
        <div className="flex items-center justify-between bg-red-500/10 px-3 py-1.5">
          <div>
            <span className="text-[11px] font-semibold text-red-300">Delete the file</span>
            <span className="ml-2 text-[10px] text-zinc-500">discards the edits, removes the file</span>
          </div>
          <PickButton accent="red" selected={choice === 'delete'} label="Delete" onClick={() => onPick('delete')} />
        </div>
      </div>

      <div className="mb-3 rounded-md border border-emerald-500/40" style={{ backgroundColor: 'rgba(255,255,255,0.02)' }}>
        <div className="flex items-center justify-between bg-emerald-500/10 px-3 py-1.5">
          <div>
            <span className="text-[11px] font-semibold text-emerald-300">Keep it alive</span>
            <span className="ml-2 text-[10px] text-zinc-500">restores the file with the edits below</span>
          </div>
          <PickButton accent="emerald" selected={choice === 'keep'} label="Keep edits" onClick={() => onPick('keep')} />
        </div>
        <div className="overflow-x-auto border-t border-emerald-500/20 text-[11px]" style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', backgroundColor: '#1F1F1F' }}>
          {lines.slice(0, 40).map((l, i) => (
            <div key={i} className="flex items-start">
              <span className="w-10 shrink-0 select-none pr-2 text-right text-[10px] text-zinc-600 tabular-nums">{i + 1}</span>
              <span className="flex-1 whitespace-pre-wrap break-all text-zinc-200">{l || '\u00a0'}</span>
            </div>
          ))}
          {lines.length > 40 && <div className="px-3 py-1 text-[10px] text-zinc-600">+ {lines.length - 40} more lines</div>}
        </div>
      </div>

      {choice && (
        <button onClick={() => onPick(null)} className="self-end text-[11px] text-zinc-500 hover:text-zinc-300">
          Clear choice
        </button>
      )}
    </div>
  )
}

function PickButton({ accent, selected, label, onClick }: { accent: 'red' | 'emerald'; selected: boolean; label: string; onClick: () => void }) {
  const classes = accent === 'red' ? 'border-red-500/60 bg-red-500/20 text-red-200 hover:bg-red-500/30'
    : 'border-emerald-500/60 bg-emerald-500/20 text-emerald-200 hover:bg-emerald-500/30'
  return (
    <button
      onClick={onClick}
      className={`rounded-md border px-2.5 py-0.5 text-[11px] font-semibold transition-colors ${classes} ${selected ? 'ring-1 ring-white/40' : ''}`}
    >
      {selected ? '✓ Selected' : label}
    </button>
  )
}
