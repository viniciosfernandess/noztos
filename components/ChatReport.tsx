'use client'

import { useState } from 'react'
import type { ChatReport, ReportEtapa, ReportBuildDetails, ReportToolCall } from '@/lib/report-types'

// ── Badge (inline in chat message) ────────────────────────────────────────

interface ReportBadgeProps {
  report: ChatReport
  projectId: string
  sessionId?: string
}

export function ReportBadge({ report, projectId, sessionId }: ReportBadgeProps) {
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState(false)

  const label = report.type === 'team_discussion'
    ? 'Team Report'
    : report.type === 'team_build'
      ? 'Team Build Report'
      : 'Build Report'

  const icon = report.build
    ? 'M11.42 15.17L17.25 21A2.652 2.652 0 0021 17.25l-5.877-5.877M11.42 15.17l2.496-3.03c.317-.384.74-.626 1.208-.766M11.42 15.17l-4.655 5.653a2.548 2.548 0 11-3.586-3.586l6.837-5.63m5.108-.233c.55-.164 1.163-.188 1.743-.14a4.5 4.5 0 004.486-6.336l-3.276 3.277a3.004 3.004 0 01-2.25-2.25l3.276-3.276a4.5 4.5 0 00-6.336 4.486c.091 1.076-.071 2.264-.904 2.95l-.102.085'
    : 'M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z'

  async function handleCreateTask() {
    if (creating || created) return
    setCreating(true)
    try {
      const res = await fetch(`/api/projects/${projectId}/tasks/from-report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ report, sessionId }),
      })
      if (res.ok || res.status === 409) setCreated(true)
    } catch { /* ignore */ }
    setCreating(false)
  }

  return (
    <>
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-violet-500/30 bg-violet-500/10 px-3 py-1.5 text-[11px] font-medium text-violet-300 transition-all hover:border-violet-500/50 hover:bg-violet-500/20"
        >
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d={icon} />
          </svg>
          {label}
          {report.build && (
            <span className="rounded bg-violet-500/20 px-1 py-0.5 text-[9px]">
              {report.build.filesChanged.length} files
            </span>
          )}
          {report.etapas && (
            <span className="rounded bg-violet-500/20 px-1 py-0.5 text-[9px]">
              {report.etapas.length} stages
            </span>
          )}
        </button>

        {created ? (
          <span className="inline-flex items-center gap-1 text-[11px] text-emerald-400">
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
            </svg>
            Task created — manage in Tasks
          </span>
        ) : (
          <button
            onClick={handleCreateTask}
            disabled={creating}
            className="inline-flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-[11px] font-medium text-zinc-400 transition-all hover:border-white/20 hover:bg-white/10 hover:text-zinc-300 disabled:opacity-50"
          >
            {creating ? (
              <svg className="h-3 w-3 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            ) : (
              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
            )}
            {creating ? 'Creating...' : '+ Task'}
          </button>
        )}
      </div>

      {open && <ReportModal report={report} onClose={() => setOpen(false)} />}
    </>
  )
}

// ── Modal ─────────────────────────────────────────────────────────────────

function ReportModal({ report, onClose }: { report: ChatReport; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="relative max-h-[85vh] w-full max-w-3xl overflow-hidden rounded-2xl border border-white/10 shadow-2xl"
        style={{ backgroundColor: '#1a1a22' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 px-6 py-4" style={{ backgroundColor: '#15151c' }}>
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-500/20">
              <svg className="h-4 w-4 text-violet-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
              </svg>
            </div>
            <div>
              <h2 className="text-sm font-semibold text-zinc-100">
                {report.type === 'team_discussion' ? 'Team Discussion Report' : report.type === 'team_build' ? 'Team Build Report' : 'Build Report'}
              </h2>
              <p className="text-[11px] text-zinc-500">
                {new Date(report.timestamp).toLocaleString()} · {report.model ?? 'sonnet'} · {report.totalDurationMs ? `${(report.totalDurationMs / 1000).toFixed(1)}s` : ''}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 hover:bg-white/5 hover:text-zinc-300">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Scrollable body */}
        <div className="overflow-y-auto p-6" style={{ maxHeight: 'calc(85vh - 72px)' }}>
          {/* Original question */}
          <Section title="Request">
            <p className="text-sm text-zinc-300">{report.question}</p>
          </Section>

          {/* Etapas (team discussions + team builds) */}
          {report.etapas && report.etapas.length > 0 && (
            <Section title="Pipeline Stages">
              {report.etapas.map((etapa, i) => (
                <EtapaBlock key={i} etapa={etapa} index={i} />
              ))}
            </Section>
          )}

          {/* Build details */}
          {report.build && (
            <Section title="Build Details">
              <BuildBlock build={report.build} />
            </Section>
          )}

          {/* Conclusion */}
          <Section title="Conclusion">
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-300">{report.conclusion}</p>
          </Section>
        </div>
      </div>
    </div>
  )
}

// ── Section wrapper ───────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-5">
      <h3 className="mb-2.5 text-xs font-semibold uppercase tracking-wider text-zinc-500">{title}</h3>
      {children}
    </div>
  )
}

// ── Etapa block ───────────────────────────────────────────────────────────

const EMPLOYEE_COLORS: Record<string, string> = {
  CEO: 'from-violet-500 to-purple-600',
  Architect: 'from-blue-500 to-cyan-600',
  Designer: 'from-pink-500 to-rose-600',
  Security: 'from-red-500 to-orange-600',
  Builder: 'from-red-600 to-red-700',
}

function EtapaBlock({ etapa, index }: { etapa: ReportEtapa; index: number }) {
  const [expanded, setExpanded] = useState(index === 0)

  return (
    <div className="mb-3 overflow-hidden rounded-xl border border-white/10" style={{ backgroundColor: '#111116' }}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
      >
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/10 text-[10px] font-bold text-zinc-400">
          {index + 1}
        </span>
        <div className="flex-1">
          <span className="text-xs font-semibold text-zinc-200">{etapa.name}</span>
          <span className="ml-2 text-[10px] text-zinc-500">{etapa.objective.length > 80 ? etapa.objective.slice(0, 80) + '...' : etapa.objective}</span>
        </div>
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
          etapa.status === 'completed' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'
        }`}>
          {etapa.status}
        </span>
        <svg className={`h-3.5 w-3.5 text-zinc-500 transition-transform ${expanded ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
        </svg>
      </button>

      {expanded && (
        <div className="border-t border-white/5 px-4 pb-4 pt-3">
          {etapa.steps.map((step, si) => (
            <div key={si} className="mb-3 last:mb-0">
              <div className="mb-1.5 flex items-center gap-2">
                <span className={`rounded-md bg-gradient-to-br ${EMPLOYEE_COLORS[step.employee] ?? 'from-zinc-500 to-zinc-600'} px-2 py-0.5 text-[10px] font-semibold text-white`}>
                  {step.employee}
                </span>
                <span className="text-[10px] text-zinc-600">{step.role}</span>
                {step.decision && (
                  <span className={`rounded px-1 py-0.5 text-[9px] font-medium ${
                    step.decision === 'approved' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'
                  }`}>
                    {step.decision}
                  </span>
                )}
                {step.redirectedTo && (
                  <span className="text-[10px] text-amber-400">→ {step.redirectedTo}</span>
                )}
              </div>
              <div className="rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2">
                <p className="whitespace-pre-wrap text-[11px] leading-relaxed text-zinc-400">
                  {step.output}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Build block ───────────────────────────────────────────────────────────

function BuildBlock({ build }: { build: ReportBuildDetails }) {
  const [showTools, setShowTools] = useState(false)

  return (
    <div className="space-y-3">
      {/* Executor + stats */}
      <div className="flex items-center gap-3">
        <span className={`rounded-md bg-gradient-to-br ${EMPLOYEE_COLORS[build.executor] ?? 'from-zinc-500 to-zinc-600'} px-2.5 py-1 text-xs font-semibold text-white`}>
          {build.executor}
        </span>
        <span className="text-[11px] text-zinc-500">{build.iterationCount} iterations</span>
        <span className="text-[11px] text-zinc-500">{build.filesChanged.length} files changed</span>
      </div>

      {/* Files changed */}
      {build.filesChanged.length > 0 && (
        <div className="rounded-lg border border-white/10 p-3" style={{ backgroundColor: '#111116' }}>
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Files Changed</p>
          <div className="space-y-1">
            {build.filesChanged.map((f, i) => (
              <div key={i} className="flex items-center gap-2 text-[11px]">
                <span className={`font-mono ${f.action === 'delete' ? 'text-red-400' : 'text-emerald-400'}`}>
                  {f.action === 'delete' ? 'D' : 'M'}
                </span>
                <span className="text-zinc-300">{f.path}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tool calls (collapsible) */}
      {build.toolCalls.length > 0 && (
        <div>
          <button
            onClick={() => setShowTools(!showTools)}
            className="flex items-center gap-1.5 text-[11px] text-zinc-500 hover:text-zinc-300"
          >
            <svg className={`h-3 w-3 transition-transform ${showTools ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
            </svg>
            {build.toolCalls.length} tool calls
          </button>
          {showTools && (
            <div className="mt-2 space-y-1 rounded-lg border border-white/5 bg-white/[0.02] p-3">
              {build.toolCalls.map((tc, i) => (
                <ToolCallRow key={i} tc={tc} index={i} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Summary */}
      <div className="rounded-lg border border-white/10 p-3" style={{ backgroundColor: '#111116' }}>
        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Build Summary</p>
        <p className="whitespace-pre-wrap text-[11px] leading-relaxed text-zinc-300">{build.summary}</p>
      </div>
    </div>
  )
}

function ToolCallRow({ tc, index }: { tc: ReportToolCall; index: number }) {
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="w-5 text-right text-zinc-600">{index + 1}</span>
      <span className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">{tc.tool}</span>
      <span className="text-zinc-500">{tc.action}</span>
    </div>
  )
}
