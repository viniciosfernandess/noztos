'use client'

import { useState } from 'react'
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

export function ModeSelector({
  mode,
  onChange,
}: {
  mode: 'plan' | 'edit' | 'auto' | 'agent'
  onChange: (mode: 'plan' | 'edit' | 'auto' | 'agent') => void
}) {
  const modes = [
    { id: 'plan' as const, label: 'Plan', desc: 'Research only, no edits', icon: '📋' },
    { id: 'edit' as const, label: 'Edit', desc: 'Edit files, confirm commands', icon: '✏️' },
    { id: 'auto' as const, label: 'Auto', desc: 'Smart — classifier decides safety', icon: '⚡' },
    { id: 'agent' as const, label: 'Agent', desc: 'Full autonomy, no prompts', icon: '🤖' },
  ]

  return (
    <div className="flex gap-1 rounded-lg border border-[#2B2B2B] bg-[#1B1B1B] p-1">
      {modes.map((m) => (
        <button
          key={m.id}
          onClick={() => onChange(m.id)}
          title={m.desc}
          className={`flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
            mode === m.id
              ? 'bg-white/10 text-zinc-100'
              : 'text-zinc-500 hover:text-zinc-300'
          }`}
        >
          <span className="text-[12px]">{m.icon}</span>
          {m.label}
        </button>
      ))}
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
