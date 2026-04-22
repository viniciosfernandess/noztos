'use client'

import { useState, useRef, useEffect } from 'react'
import type { ChatMessage } from '@/lib/hooks/useCompanionStream'

// ── Tool Card Icons ─────────────────────────────────────────────────

const TOOL_CONFIG: Record<string, {
  icon: string
  label: string
  color: string
  bgColor: string
  borderColor: string
}> = {
  Read:         { icon: '📄', label: 'Read',          color: 'text-blue-400',    bgColor: 'bg-blue-500/5',    borderColor: 'border-blue-500/20' },
  Write:        { icon: '📝', label: 'Write',         color: 'text-emerald-400', bgColor: 'bg-emerald-500/5', borderColor: 'border-emerald-500/20' },
  Edit:         { icon: '✏️',  label: 'Edit',          color: 'text-amber-400',   bgColor: 'bg-amber-500/5',   borderColor: 'border-amber-500/20' },
  MultiEdit:    { icon: '✏️',  label: 'Multi Edit',    color: 'text-amber-400',   bgColor: 'bg-amber-500/5',   borderColor: 'border-amber-500/20' },
  Bash:         { icon: '⚡',  label: 'Terminal',      color: 'text-violet-400',  bgColor: 'bg-violet-500/5',  borderColor: 'border-violet-500/20' },
  Grep:         { icon: '🔍', label: 'Search',        color: 'text-cyan-400',    bgColor: 'bg-cyan-500/5',    borderColor: 'border-cyan-500/20' },
  Glob:         { icon: '📂', label: 'Find Files',    color: 'text-cyan-400',    bgColor: 'bg-cyan-500/5',    borderColor: 'border-cyan-500/20' },
  LS:           { icon: '📁', label: 'List Dir',      color: 'text-zinc-400',    bgColor: 'bg-zinc-500/5',    borderColor: 'border-zinc-500/20' },
  Agent:        { icon: '🤖', label: 'Sub-agent',     color: 'text-pink-400',    bgColor: 'bg-pink-500/5',    borderColor: 'border-pink-500/20' },
  Task:         { icon: '🤖', label: 'Sub-agent',     color: 'text-pink-400',    bgColor: 'bg-pink-500/5',    borderColor: 'border-pink-500/20' },
  WebFetch:     { icon: '🌐', label: 'Fetch URL',     color: 'text-indigo-400',  bgColor: 'bg-indigo-500/5',  borderColor: 'border-indigo-500/20' },
  WebSearch:    { icon: '🔎', label: 'Web Search',    color: 'text-indigo-400',  bgColor: 'bg-indigo-500/5',  borderColor: 'border-indigo-500/20' },
  TodoWrite:    { icon: '✅', label: 'Tasks',         color: 'text-emerald-400', bgColor: 'bg-emerald-500/5', borderColor: 'border-emerald-500/20' },
  TodoRead:     { icon: '📋', label: 'Tasks',         color: 'text-zinc-400',    bgColor: 'bg-zinc-500/5',    borderColor: 'border-zinc-500/20' },
  NotebookEdit: { icon: '📓', label: 'Notebook',      color: 'text-orange-400',  bgColor: 'bg-orange-500/5',  borderColor: 'border-orange-500/20' },
  NotebookRead: { icon: '📓', label: 'Notebook',      color: 'text-orange-400',  bgColor: 'bg-orange-500/5',  borderColor: 'border-orange-500/20' },
}

const DEFAULT_CONFIG = { icon: '🔧', label: 'Tool', color: 'text-zinc-400', bgColor: 'bg-zinc-500/5', borderColor: 'border-zinc-500/20' }

// ── Main Component ──────────────────────────────────────────────────

export function ClaudeToolCard({ message }: { message: ChatMessage }) {
  const [expanded, setExpanded] = useState(false)
  const config = TOOL_CONFIG[message.toolName ?? ''] ?? DEFAULT_CONFIG
  const hasResult = message.toolResult !== undefined
  const isLoading = !hasResult
  const isError = message.toolError

  return (
    <div className={`my-1.5 overflow-hidden rounded-lg border ${config.borderColor} ${config.bgColor}`}>
      {/* Header — always visible, click to expand */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-white/5"
      >
        {/* Icon */}
        <span className="text-[13px]">{config.icon}</span>

        {/* Tool name + file/command */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className={`text-[11px] font-semibold ${config.color}`}>
              {config.label}
            </span>
            {message.filePath && (
              <span className="truncate text-[11px] text-zinc-500 font-mono">
                {message.filePath}
              </span>
            )}
            {message.command && (
              <span className="truncate text-[11px] text-zinc-500 font-mono">
                {message.command.length > 60
                  ? message.command.slice(0, 60) + '…'
                  : message.command}
              </span>
            )}
            {message.searchPattern && (
              <span className="truncate text-[11px] text-zinc-500 font-mono">
                &quot;{message.searchPattern}&quot;
              </span>
            )}
          </div>
        </div>

        {/* Status indicator */}
        {isLoading && (
          <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-amber-400" />
        )}
        {hasResult && !isError && (
          <svg className="h-3 w-3 shrink-0 text-emerald-400" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
          </svg>
        )}
        {isError && (
          <svg className="h-3 w-3 shrink-0 text-red-400" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        )}

        {/* Expand chevron */}
        {hasResult && (
          <svg
            className={`h-3 w-3 shrink-0 text-zinc-600 transition-transform ${expanded ? 'rotate-180' : ''}`}
            fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
          </svg>
        )}
      </button>

      {/* Expanded content — tool-specific rendering */}
      {expanded && hasResult && (
        <div className="border-t border-white/5">
          <ToolResultContent message={message} />
        </div>
      )}
    </div>
  )
}

// ── Tool-specific result renderers ──────────────────────────────────

function ToolResultContent({ message }: { message: ChatMessage }) {
  const { toolName } = message

  switch (toolName) {
    case 'Edit':
    case 'MultiEdit':
      return <EditResult message={message} />
    case 'Bash':
      return <BashResult message={message} />
    case 'Read':
      return <FileContentResult message={message} />
    case 'Grep':
    case 'Glob':
      return <SearchResult message={message} />
    default:
      return <GenericResult message={message} />
  }
}

// ── Edit diff view ──────────────────────────────────────────────────

function EditResult({ message }: { message: ChatMessage }) {
  if (!message.oldString && !message.newString) {
    return <GenericResult message={message} />
  }

  return (
    <div className="max-h-64 overflow-y-auto font-mono text-[11px] leading-[1.6]">
      {message.oldString && (
        <div className="bg-red-500/10 px-3 py-0.5">
          {message.oldString.split('\n').map((line, i) => (
            <div key={`old-${i}`} className="flex">
              <span className="mr-2 select-none text-red-500/60">-</span>
              <span className="text-red-300">{line || '\u00A0'}</span>
            </div>
          ))}
        </div>
      )}
      {message.newString && (
        <div className="bg-emerald-500/10 px-3 py-0.5">
          {message.newString.split('\n').map((line, i) => (
            <div key={`new-${i}`} className="flex">
              <span className="mr-2 select-none text-emerald-500/60">+</span>
              <span className="text-emerald-300">{line || '\u00A0'}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Bash command output ─────────────────────────────────────────────

function BashResult({ message }: { message: ChatMessage }) {
  const output = message.bashOutput ?? message.toolResult ?? ''
  const lines = output.split('\n')
  const truncated = lines.length > 30

  return (
    <div className="max-h-64 overflow-y-auto">
      {message.command && (
        <div className="border-b border-white/5 bg-black/20 px-3 py-1.5">
          <span className="font-mono text-[11px] text-violet-300">$ {message.command}</span>
        </div>
      )}
      <pre className="whitespace-pre-wrap px-3 py-2 font-mono text-[11px] leading-[1.5] text-zinc-400">
        {truncated ? lines.slice(0, 30).join('\n') + `\n... (${lines.length - 30} more lines)` : output}
      </pre>
    </div>
  )
}

// ── File content preview ────────────────────────────────────────────

function FileContentResult({ message }: { message: ChatMessage }) {
  const content = message.toolResult ?? ''
  const lines = content.split('\n')
  const truncated = lines.length > 40

  return (
    <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap px-3 py-2 font-mono text-[11px] leading-[1.5] text-zinc-400">
      {truncated ? lines.slice(0, 40).join('\n') + `\n... (${lines.length - 40} more lines)` : content}
    </pre>
  )
}

// ── Search results (Grep/Glob) ──────────────────────────────────────

function SearchResult({ message }: { message: ChatMessage }) {
  const results = (message.toolResult ?? '').split('\n').filter(Boolean)
  const count = results.length

  return (
    <div className="max-h-48 overflow-y-auto px-3 py-2">
      <div className="mb-1 text-[10px] text-zinc-500">{count} result{count !== 1 ? 's' : ''}</div>
      {results.slice(0, 20).map((line, i) => (
        <div key={i} className="truncate font-mono text-[11px] text-zinc-400 hover:text-zinc-200">
          {line}
        </div>
      ))}
      {count > 20 && (
        <div className="mt-1 text-[10px] text-zinc-600">... and {count - 20} more</div>
      )}
    </div>
  )
}

// ── Generic fallback ────────────────────────────────────────────────

function GenericResult({ message }: { message: ChatMessage }) {
  const content = message.toolResult ?? ''
  if (!content) return null

  return (
    <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap px-3 py-2 font-mono text-[11px] leading-[1.5] text-zinc-400">
      {content.length > 2000 ? content.slice(0, 2000) + '\n... (truncated)' : content}
    </pre>
  )
}

// ── Session Result Footer ───────────────────────────────────────────

export function SessionResultCard({ message }: { message: ChatMessage }) {
  return (
    <div className="my-2 flex items-center gap-3 rounded-lg border border-[#2B2B2B] bg-[#1B1B1B] px-3 py-2 text-[10px]">
      {message.costUsd !== undefined && (
        <span className="text-zinc-500">
          Cost: <span className="font-mono text-zinc-300">${message.costUsd.toFixed(4)}</span>
        </span>
      )}
      {message.durationMs !== undefined && (
        <span className="text-zinc-500">
          Duration: <span className="font-mono text-zinc-300">{(message.durationMs / 1000).toFixed(1)}s</span>
        </span>
      )}
      {message.numTurns !== undefined && (
        <span className="text-zinc-500">
          Turns: <span className="font-mono text-zinc-300">{message.numTurns}</span>
        </span>
      )}
    </div>
  )
}

// ── Mode Selector ───────────────────────────────────────────────────

type ModeId = 'plan' | 'edit' | 'auto' | 'agent'

const MODE_ICONS: Record<ModeId, (props: { className?: string }) => React.ReactElement> = {
  plan: ({ className }) => (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2" />
      <rect x="9" y="3" width="6" height="4" rx="1" />
      <path d="M9 12h6M9 16h4" />
    </svg>
  ),
  edit: ({ className }) => (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z" />
    </svg>
  ),
  auto: ({ className }) => (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z" />
    </svg>
  ),
  agent: ({ className }) => (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4" />
    </svg>
  ),
}

const MODES: { id: ModeId; label: string; desc: string }[] = [
  { id: 'plan', label: 'Plan', desc: 'Research only, no edits' },
  { id: 'edit', label: 'Edit', desc: 'Edit files, confirm commands' },
  { id: 'auto', label: 'Auto', desc: 'Smart — classifier decides safety' },
  { id: 'agent', label: 'Agent', desc: 'Full autonomy, no prompts' },
]

export function ModeSelector({
  mode,
  onChange,
}: {
  mode: ModeId
  onChange: (mode: ModeId) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const current = MODES.find((m) => m.id === mode) ?? MODES[2]
  const CurrentIcon = MODE_ICONS[current.id]

  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={`Mode: ${current.label} — ${current.desc}`}
        className="flex items-center gap-1 rounded border border-[#2B2B2B] bg-white/5 px-1.5 py-0.5 text-[10px] text-zinc-300 outline-none transition-colors hover:bg-white/10"
      >
        <CurrentIcon className="h-3 w-3" />
        {current.label}
        <svg className={`h-2.5 w-2.5 transition-transform ${open ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="absolute bottom-full right-0 mb-1 z-50 min-w-[200px] overflow-hidden rounded-lg border border-[#2B2B2B] bg-[#1B1B1B] shadow-xl shadow-black/40">
          {MODES.map((m) => {
            const Icon = MODE_ICONS[m.id]
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => { onChange(m.id); setOpen(false) }}
                className={`flex w-full items-start gap-2 px-2.5 py-2 text-left text-[11px] transition-colors hover:bg-white/5 ${
                  mode === m.id ? 'bg-white/5 text-zinc-100' : 'text-zinc-400'
                }`}
              >
                <Icon className="mt-[1px] h-3.5 w-3.5 text-zinc-400" />
                <span className="flex-1">
                  <span className="block font-medium text-zinc-200">{m.label}</span>
                  <span className="block text-[10px] text-zinc-500">{m.desc}</span>
                </span>
                {mode === m.id && (
                  <svg className="mt-[2px] h-3 w-3 text-zinc-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                    <path d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Model Selector ──────────────────────────────────────────────────

type ModelId = 'haiku' | 'sonnet' | 'opus'

const MODEL_ICONS: Record<ModelId, (props: { className?: string }) => React.ReactElement> = {
  haiku: ({ className }) => (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 3L4 14h7l-1 7 9-11h-7l1-7z" />
    </svg>
  ),
  sonnet: ({ className }) => (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="8" />
      <path d="M8 12h8M12 8v8" />
    </svg>
  ),
  opus: ({ className }) => (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2l2.39 7.36H22l-6.2 4.51L18.18 22 12 17.27 5.82 22l2.38-8.13L2 9.36h7.61L12 2z" />
    </svg>
  ),
}

const MODELS: { id: ModelId; label: string; desc: string }[] = [
  { id: 'haiku', label: 'Haiku 4.5', desc: 'Fast, cheap, short answers' },
  { id: 'sonnet', label: 'Sonnet 4.6', desc: 'Balanced default' },
  { id: 'opus', label: 'Opus 4.7', desc: 'Deepest reasoning, costs more' },
]

export function ModelSelector({
  model,
  onChange,
}: {
  model: ModelId
  onChange: (model: ModelId) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const current = MODELS.find((m) => m.id === model) ?? MODELS[1]
  const CurrentIcon = MODEL_ICONS[current.id]

  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={`Model: ${current.label} — ${current.desc}`}
        className="flex items-center gap-1 rounded border border-[#2B2B2B] bg-white/5 px-1.5 py-0.5 text-[10px] text-zinc-300 outline-none transition-colors hover:bg-white/10"
      >
        <CurrentIcon className="h-3 w-3" />
        {current.label}
        <svg className={`h-2.5 w-2.5 transition-transform ${open ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="absolute bottom-full right-0 mb-1 z-50 min-w-[200px] overflow-hidden rounded-lg border border-[#2B2B2B] bg-[#1B1B1B] shadow-xl shadow-black/40">
          {MODELS.map((m) => {
            const Icon = MODEL_ICONS[m.id]
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => { onChange(m.id); setOpen(false) }}
                className={`flex w-full items-start gap-2 px-2.5 py-2 text-left text-[11px] transition-colors hover:bg-white/5 ${
                  model === m.id ? 'bg-white/5 text-zinc-100' : 'text-zinc-400'
                }`}
              >
                <Icon className="mt-[1px] h-3.5 w-3.5 text-zinc-400" />
                <span className="flex-1">
                  <span className="block font-medium text-zinc-200">{m.label}</span>
                  <span className="block text-[10px] text-zinc-500">{m.desc}</span>
                </span>
                {model === m.id && (
                  <svg className="mt-[2px] h-3 w-3 text-zinc-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                    <path d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Thinking Selector ───────────────────────────────────────────────

type ThinkingId = 'off' | 'low' | 'medium' | 'high'

const THINKING_ICONS: Record<ThinkingId, (props: { className?: string }) => React.ReactElement> = {
  off: ({ className }) => (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M4.93 4.93l14.14 14.14" />
    </svg>
  ),
  low: ({ className }) => (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21h6M12 3a7 7 0 00-4 12.7V18h8v-2.3A7 7 0 0012 3z" />
    </svg>
  ),
  medium: ({ className }) => (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.64 5.64l2.12 2.12M16.24 16.24l2.12 2.12M5.64 18.36l2.12-2.12M16.24 7.76l2.12-2.12" />
    </svg>
  ),
  high: ({ className }) => (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2C9 5 9 8 12 12s3 7 0 10M8 6c-2 2-2 4 0 6s2 4 0 6M16 6c2 2 2 4 0 6s-2 4 0 6" />
    </svg>
  ),
}

const THINKINGS: { id: ThinkingId; label: string; desc: string }[] = [
  { id: 'off',    label: 'No thinking',   desc: 'Respond directly, no reasoning budget' },
  { id: 'low',    label: 'Think',         desc: '~4k tokens of reasoning' },
  { id: 'medium', label: 'Think hard',    desc: '~10k tokens of reasoning' },
  { id: 'high',   label: 'Ultrathink',    desc: '~32k tokens (max budget)' },
]

export function ThinkingSelector({
  thinking,
  onChange,
}: {
  thinking: ThinkingId
  onChange: (thinking: ThinkingId) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const current = THINKINGS.find((t) => t.id === thinking) ?? THINKINGS[0]
  const CurrentIcon = THINKING_ICONS[current.id]

  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={`Thinking: ${current.label} — ${current.desc}`}
        className="flex items-center gap-1 rounded border border-[#2B2B2B] bg-white/5 px-1.5 py-0.5 text-[10px] text-zinc-300 outline-none transition-colors hover:bg-white/10"
      >
        <CurrentIcon className="h-3 w-3" />
        {current.label}
        <svg className={`h-2.5 w-2.5 transition-transform ${open ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="absolute bottom-full right-0 mb-1 z-50 min-w-[220px] overflow-hidden rounded-lg border border-[#2B2B2B] bg-[#1B1B1B] shadow-xl shadow-black/40">
          {THINKINGS.map((t) => {
            const Icon = THINKING_ICONS[t.id]
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => { onChange(t.id); setOpen(false) }}
                className={`flex w-full items-start gap-2 px-2.5 py-2 text-left text-[11px] transition-colors hover:bg-white/5 ${
                  thinking === t.id ? 'bg-white/5 text-zinc-100' : 'text-zinc-400'
                }`}
              >
                <Icon className="mt-[1px] h-3.5 w-3.5 text-zinc-400" />
                <span className="flex-1">
                  <span className="block font-medium text-zinc-200">{t.label}</span>
                  <span className="block text-[10px] text-zinc-500">{t.desc}</span>
                </span>
                {thinking === t.id && (
                  <svg className="mt-[2px] h-3 w-3 text-zinc-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                    <path d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Cost Tracker ────────────────────────────────────────────────────

export function CostTracker({
  costUsd,
  sessionId,
}: {
  costUsd: number
  sessionId: string | null
}) {
  if (costUsd === 0 && !sessionId) return null

  return (
    <div className="flex items-center gap-2 text-[10px] text-zinc-600">
      {sessionId && (
        <span className="font-mono">Session: {sessionId.slice(0, 8)}…</span>
      )}
      {costUsd > 0 && (
        <span className="font-mono text-zinc-400">${costUsd.toFixed(4)}</span>
      )}
    </div>
  )
}

// ── Companion Status Badge ──────────────────────────────────────────

export function CompanionStatusBadge({
  status,
  info,
}: {
  status: 'disconnected' | 'connecting' | 'connected' | 'error'
  info?: { email?: string; plan?: string; version?: string } | null
}) {
  const configs = {
    connected: { dot: 'bg-emerald-400', text: 'text-emerald-400', label: 'Connected' },
    connecting: { dot: 'bg-amber-400 animate-pulse', text: 'text-amber-400', label: 'Connecting…' },
    disconnected: { dot: 'bg-zinc-600', text: 'text-zinc-500', label: 'Offline' },
    error: { dot: 'bg-red-400', text: 'text-red-400', label: 'Error' },
  }
  const cfg = configs[status]

  return (
    <div className="flex items-center gap-1.5">
      <span className={`h-1.5 w-1.5 rounded-full ${cfg.dot}`} />
      <span className={`text-[10px] font-medium ${cfg.text}`}>{cfg.label}</span>
      {status === 'connected' && info?.plan && (
        <span className="text-[10px] text-zinc-600">
          · Claude {info.plan} {info.version ? `(${info.version.split(' ')[0]})` : ''}
        </span>
      )}
    </div>
  )
}
