'use client'

import { useState } from 'react'

interface Employee {
  id: string
  name: string
  description: string
  color: string
}

const AVAILABLE_EMPLOYEES: Employee[] = [
  {
    id: 'ceo',
    name: 'CEO',
    description: 'Questions if it\'s the right problem. Challenges scope, finds risks, gives go/no-go decisions.',
    color: 'from-violet-500 to-purple-600',
  },
  {
    id: 'architect',
    name: 'Architect',
    description: 'Defines architecture, data flow, component breakdown. Your technical blueprint before any code.',
    color: 'from-blue-500 to-cyan-600',
  },
  {
    id: 'designer',
    name: 'Designer',
    description: 'Reviews UI/UX, catches AI slop, ensures hierarchy and interaction states are solid.',
    color: 'from-pink-500 to-rose-600',
  },
  {
    id: 'security',
    name: 'Security',
    description: 'OWASP Top 10, STRIDE threat modeling. Finds vulnerabilities before they reach production.',
    color: 'from-red-500 to-orange-600',
  },
  {
    id: 'tester',
    name: 'Tester',
    description: 'Writes tests, runs them, validates coverage. Keeps regressions out before they ship.',
    color: 'from-emerald-500 to-green-600',
  },
  {
    id: 'reviewer',
    name: 'Reviewer',
    description: 'Code review, standards, quality. Reads diffs with the eye of the next maintainer.',
    color: 'from-amber-500 to-yellow-600',
  },
  {
    id: 'docs',
    name: 'Docs',
    description: 'Documentation, README, API docs. Turns shipped behaviour into something a stranger can read.',
    color: 'from-stone-500 to-stone-700',
  },
  {
    id: 'devops',
    name: 'DevOps',
    description: 'Deploy, CI/CD, infrastructure, incidents. Owns the path from main to production.',
    color: 'from-slate-500 to-slate-700',
  },
]

const BUILDER_EMPLOYEE: Employee = {
  id: 'builder',
  name: 'Builder',
  description: 'Writes the code. Executes the plan, edits files, creates features.',
  color: 'from-red-600 to-red-700',
}

function getEmployee(id: string): Employee | undefined {
  if (id === 'builder') return BUILDER_EMPLOYEE
  return AVAILABLE_EMPLOYEES.find((e) => e.id === id)
}

// ── Team type ──────────────────────────────────────────────────────────────

interface Team {
  name: string
  memberIds: string[]
  hasBuilder: boolean
  order: string[]
  canRecreateTasks: Record<string, string> // employeeId → redirectTo employeeId
}

// ── Main Panel ─────────────────────────────────────────────────────────────

export function MyTeamPanel() {
  const [showTeamModal, setShowTeamModal] = useState(false)
  const [teams, setTeams] = useState<Team[]>([])

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Left: Agents — 50% */}
      <div className="flex w-1/2 flex-col border-r border-white/10 p-6" style={{ backgroundColor: '#1F1F1F' }}>
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-zinc-200">Agents</h2>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <EmployeeCard employee={BUILDER_EMPLOYEE} isAutomatic />
          {AVAILABLE_EMPLOYEES.map((emp) => (
            <EmployeeCard key={emp.id} employee={emp} />
          ))}
        </div>
      </div>

      {/* Right: Workflows — 50% */}
      <div className="flex w-1/2 flex-col p-6" style={{ backgroundColor: '#1F1F1F' }}>
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-zinc-200">Workflows</h2>
          <button
            onClick={() => setShowTeamModal(true)}
            className="rounded-lg bg-violet-600 px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-violet-500"
          >
            + Create
          </button>
        </div>

        {teams.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4">
            <div className="rounded-full bg-white/5 p-4">
              <svg className="h-8 w-8 text-zinc-500" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 010 3.75H5.625a1.875 1.875 0 010-3.75z" />
              </svg>
            </div>
            <div className="text-center">
              <p className="text-sm font-medium text-zinc-300">Create your first workflow</p>
              <p className="mt-1 text-xs text-zinc-500">Organize agents into workflows with execution order</p>
            </div>
            <button
              onClick={() => setShowTeamModal(true)}
              className="rounded-full bg-violet-600 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-violet-500"
            >
              Create workflow
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {teams.map((team, i) => (
              <TeamCard key={i} team={team} />
            ))}
          </div>
        )}
      </div>

      {showTeamModal && (
        <TeamBuilderModal
          onConfirm={(team) => { setTeams((prev) => [...prev, team]); setShowTeamModal(false) }}
          onClose={() => setShowTeamModal(false)}
        />
      )}
    </div>
  )
}

// ── Employee Card ──────────────────────────────────────────────────────────

function EmployeeCard({ employee, isAutomatic }: { employee: Employee; isAutomatic?: boolean }) {
  return (
    <div className="relative overflow-hidden rounded-lg px-3 py-2.5 shadow-sm">
      {/* Muted gradient backdrop. Lives on its own layer so reducing
          opacity dims only the colour, leaving text/badge fully crisp. */}
      <div
        aria-hidden
        className={`absolute inset-0 bg-gradient-to-br ${employee.color} opacity-40`}
      />
      <div className="relative">
        {isAutomatic && (
          <span className="absolute right-0 top-0 rounded bg-white/20 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-white/80">
            auto
          </span>
        )}
        <p className="text-sm font-bold text-white">{employee.name}</p>
        <p className="mt-1 text-[11px] leading-relaxed text-white/80">{employee.description}</p>
      </div>
    </div>
  )
}

// ── Mini Employee Card (for small displays) ────────────────────────────────

function MiniCard({ employee, highlight }: { employee: Employee; highlight?: boolean }) {
  return (
    <div className={`rounded-lg bg-gradient-to-br ${employee.color} px-3 py-2 shadow-sm ${highlight ? 'ring-2 ring-white/50' : ''}`}>
      <p className="text-xs font-bold text-white">{employee.name}</p>
    </div>
  )
}

// ── Team Card (right side) ─────────────────────────────────────────────────

function TeamCard({ team }: { team: Team }) {
  return (
    <div className="overflow-hidden rounded-xl bg-gradient-to-br from-zinc-800 to-zinc-900 p-4 shadow-lg">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm font-bold text-white">{team.name}</p>
        <span className="rounded bg-white/10 px-2 py-0.5 text-[10px] font-medium text-zinc-400">{team.order.length} members</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {team.order.map((id, i) => {
          const emp = getEmployee(id)
          if (!emp) return null
          return (
            <div key={id} className="flex items-center gap-1">
              <span className={`rounded-md bg-gradient-to-br ${emp.color} px-2 py-1 text-[10px] font-semibold text-white shadow-sm`}>
                {emp.name}
              </span>
              {i < team.order.length - 1 && (
                <svg className="h-3 w-3 text-zinc-600" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                </svg>
              )}
            </div>
          )
        })}
      </div>
      {Object.keys(team.canRecreateTasks).length > 0 && (
        <div className="mt-3 border-t border-white/10 pt-2">
          {Object.entries(team.canRecreateTasks).map(([fromId, toId]) => {
            const from = getEmployee(fromId)
            const to = getEmployee(toId)
            return (
              <p key={fromId} className="text-[10px] text-zinc-500">
                {from?.name} can reject → restarts from {to?.name}
              </p>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Team Builder Modal ─────────────────────────────────────────────────────

type TeamStep = 'select' | 'no-builder-warning' | 'order' | 'recreate'

function TeamBuilderModal({
  onConfirm,
  onClose,
}: {
  onConfirm: (team: Team) => void
  onClose: () => void
}) {
  const [step, setStep] = useState<TeamStep>('select')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [order, setOrder] = useState<string[]>([])
  const [canRecreateTasks, setCanRecreateTasks] = useState<Record<string, string>>({})
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [teamName, setTeamName] = useState('')

  // The full agent roster is always available — hiring was removed.
  const selectableEmployees = [...AVAILABLE_EMPLOYEES, BUILDER_EMPLOYEE]

  const hasBuilder = selectedIds.has('builder')

  function toggleSelect(id: string) {
    const next = new Set(selectedIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelectedIds(next)
  }

  function handleContinueFromSelect() {
    if (selectedIds.size === 0 || !teamName.trim()) return
    if (!hasBuilder) {
      setStep('no-builder-warning')
    } else {
      setOrder([...selectedIds])
      setStep('order')
    }
  }

  function handleConfirmNoBuilder() {
    setOrder([...selectedIds])
    setStep('order')
  }

  function handleDragStart(index: number) {
    setDragIndex(index)
  }

  function handleDragOver(e: React.DragEvent, index: number) {
    e.preventDefault()
    if (dragIndex === null || dragIndex === index) return
    const newOrder = [...order]
    const [dragged] = newOrder.splice(dragIndex, 1)
    newOrder.splice(index, 0, dragged)
    setOrder(newOrder)
    setDragIndex(index)
  }

  function handleDragEnd() {
    setDragIndex(null)
  }

  function toggleRecreate(id: string) {
    const next = { ...canRecreateTasks }
    if (next[id]) {
      delete next[id]
    } else {
      const first = order.find((o) => o !== id && o !== 'builder')
      next[id] = first ?? order[0]
    }
    setCanRecreateTasks(next)
  }

  function setRedirectTarget(fromId: string, toId: string) {
    setCanRecreateTasks((prev) => ({ ...prev, [fromId]: toId }))
  }

  function handleConfirm() {
    onConfirm({
      name: teamName || `Workflow ${Date.now().toString(36)}`,
      memberIds: [...selectedIds].filter((id) => id !== 'builder'),
      hasBuilder,
      order,
      canRecreateTasks,
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-full max-w-lg rounded-2xl border border-white/10 p-8 shadow-xl" style={{ backgroundColor: '#1F1F1F' }}>

        {/* Step 1: Select members (including Builder) */}
        {step === 'select' && (
          <>
            <h2 className="mb-1 text-xl font-semibold text-zinc-100">Create Workflow</h2>
            <p className="mb-4 text-sm text-zinc-400">Select agents for this workflow.</p>

            <input
              type="text"
              value={teamName}
              onChange={(e) => setTeamName(e.target.value)}
              placeholder="Workflow name *"
              className="mb-4 block w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-500 focus:border-violet-500/50 focus:outline-none"
            />

            <div className="space-y-2">
              {selectableEmployees.map((emp) => {
                const isSelected = selectedIds.has(emp.id)
                return (
                  <button
                    key={emp.id}
                    onClick={() => toggleSelect(emp.id)}
                    className={`flex w-full items-center gap-3 rounded-xl bg-gradient-to-br ${emp.color} p-3 text-left transition-all ${
                      isSelected ? 'shadow-lg ring-2 ring-white/30' : 'opacity-60 hover:opacity-80'
                    }`}
                  >
                    <div className="flex-1">
                      <p className="text-sm font-semibold text-white">{emp.name}</p>
                      <p className="text-[10px] text-white/70">{emp.description}</p>
                    </div>
                    <div className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border-2 ${
                      isSelected ? 'border-white bg-white/30' : 'border-white/40'
                    }`}>
                      {isSelected && (
                        <svg className="h-3 w-3 text-white" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                        </svg>
                      )}
                    </div>
                  </button>
                )
              })}
            </div>

            <div className="mt-6 flex gap-3">
              <button
                onClick={handleContinueFromSelect}
                disabled={selectedIds.size === 0 || !teamName.trim()}
                className="flex h-10 flex-1 items-center justify-center rounded-full bg-violet-600 text-sm font-medium text-white transition-colors hover:bg-violet-500 disabled:opacity-30"
              >
                Continue
              </button>
              <button onClick={onClose} className="flex h-10 items-center justify-center rounded-full px-5 text-sm text-zinc-400 hover:text-zinc-200">
                Cancel
              </button>
            </div>
          </>
        )}

        {/* No Builder Warning */}
        {step === 'no-builder-warning' && (
          <>
            <h2 className="mb-4 text-xl font-semibold text-zinc-100">No Builder selected</h2>

            <div className="mb-6 rounded-xl border border-amber-500/30 bg-amber-500/10 px-5 py-4">
              <p className="text-sm font-medium text-amber-300">This workflow won&apos;t be able to build.</p>
              <p className="mt-1 text-xs text-amber-400/80">Without a Builder, this workflow can only make decisions, have discussions, and review code — it cannot write or edit files.</p>
            </div>

            <div className="flex gap-3">
              <button
                onClick={handleConfirmNoBuilder}
                className="flex h-10 flex-1 items-center justify-center rounded-full border border-white/10 text-sm font-medium text-zinc-300 transition-colors hover:bg-white/5"
              >
                Continue without Builder
              </button>
              <button
                onClick={() => setStep('select')}
                className="flex h-10 flex-1 items-center justify-center rounded-full bg-violet-600 text-sm font-medium text-white transition-colors hover:bg-violet-500"
              >
                Go back and add Builder
              </button>
            </div>

            <button onClick={onClose} className="mt-3 w-full text-center text-sm text-zinc-500 hover:text-zinc-300">
              Cancel
            </button>
          </>
        )}

        {/* Step 2: Execution Order (drag) */}
        {step === 'order' && (
          <>
            <h2 className="mb-1 text-xl font-semibold text-zinc-100">Execution Order</h2>
            <p className="mb-4 text-sm text-zinc-400">Drag to set the order your workflow runs in. First to last.</p>

            <div className="space-y-2">
              {order.map((id, index) => {
                const emp = getEmployee(id)
                if (!emp) return null
                return (
                  <div
                    key={id}
                    draggable
                    onDragStart={() => handleDragStart(index)}
                    onDragOver={(e) => handleDragOver(e, index)}
                    onDragEnd={handleDragEnd}
                    className={`flex cursor-grab items-center gap-3 rounded-xl bg-gradient-to-br ${emp.color} p-3 shadow-sm transition-transform active:cursor-grabbing ${
                      dragIndex === index ? 'scale-105 shadow-lg' : ''
                    }`}
                  >
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white/20 text-xs font-bold text-white">
                      {index + 1}
                    </span>
                    <div>
                      <p className="text-sm font-semibold text-white">{emp.name}</p>
                    </div>
                    <svg className="ml-auto h-4 w-4 text-white/40" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 9h16.5m-16.5 6.75h16.5" />
                    </svg>
                  </div>
                )
              })}
            </div>

            <div className="mt-6 flex gap-3">
              <button
                onClick={() => setStep('recreate')}
                className="flex h-10 flex-1 items-center justify-center rounded-full bg-violet-600 text-sm font-medium text-white transition-colors hover:bg-violet-500"
              >
                Continue
              </button>
              <button onClick={() => setStep('select')} className="flex h-10 items-center justify-center rounded-full px-5 text-sm text-zinc-400 hover:text-zinc-200">
                Back
              </button>
            </div>

            <button onClick={onClose} className="mt-2 w-full text-center text-sm text-zinc-500 hover:text-zinc-300">
              Cancel
            </button>
          </>
        )}

        {/* Step 3: Who can recreate tasks */}
        {step === 'recreate' && (
          <>
            <h2 className="mb-1 text-xl font-semibold text-zinc-100">Task Recreation</h2>
            <p className="mb-4 text-sm text-zinc-400">Select who can reject and recreate tasks, and who the task redirects to.</p>

            <div className="space-y-3">
              {order.map((id, index) => {
                const emp = getEmployee(id)
                if (!emp) return null
                const isBuilder = id === 'builder'
                const isEnabled = !isBuilder && !!canRecreateTasks[id]

                return (
                  <div key={id} className={`rounded-xl border p-3 ${isBuilder ? 'border-white/5 bg-white/3' : 'border-white/10 bg-white/5'}`}>
                    <div className="flex items-center gap-3">
                      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-white/10 text-[10px] font-bold text-zinc-400">
                        {index + 1}
                      </span>
                      {isBuilder ? (
                        <div className={`flex items-center gap-2 rounded-lg bg-gradient-to-br ${emp.color} px-3 py-1.5 opacity-40`}>
                          <span className="text-xs font-semibold text-white">{emp.name}</span>
                        </div>
                      ) : (
                        <button
                          onClick={() => toggleRecreate(id)}
                          className={`flex items-center gap-2 rounded-lg bg-gradient-to-br ${emp.color} px-3 py-1.5 transition-all ${
                            isEnabled ? 'shadow-sm' : 'opacity-50'
                          }`}
                        >
                          <div className={`flex h-4 w-4 items-center justify-center rounded border ${
                            isEnabled ? 'border-white bg-white/30' : 'border-white/40'
                          }`}>
                            {isEnabled && (
                              <svg className="h-2.5 w-2.5 text-white" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                              </svg>
                            )}
                          </div>
                          <span className="text-xs font-semibold text-white">{emp.name}</span>
                        </button>
                      )}
                      <span className="text-xs text-zinc-500">
                        {isBuilder ? 'cannot recreate' : 'can recreate tasks'}
                      </span>
                    </div>

                    {isEnabled && !isBuilder && (
                      <div className="mt-2 flex items-center gap-2 pl-8">
                        <span className="text-xs text-zinc-400">Redirects to:</span>
                        <select
                          value={canRecreateTasks[id] ?? ''}
                          onChange={(e) => setRedirectTarget(id, e.target.value)}
                          className="rounded border border-white/10 bg-white/5 px-2 py-1 text-xs text-zinc-300 focus:border-violet-500/50 focus:outline-none"
                        >
                          {order.filter((o) => o !== id).map((o) => {
                            const target = getEmployee(o)
                            return target ? <option key={o} value={o}>{target.name}</option> : null
                          })}
                        </select>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            <div className="mt-6 flex gap-3">
              <button
                onClick={handleConfirm}
                className="flex h-10 flex-1 items-center justify-center rounded-full bg-violet-600 text-sm font-medium text-white transition-colors hover:bg-violet-500"
              >
                Create Workflow
              </button>
              <button onClick={() => setStep('order')} className="flex h-10 items-center justify-center rounded-full px-5 text-sm text-zinc-400 hover:text-zinc-200">
                Back
              </button>
            </div>

            <button onClick={onClose} className="mt-2 w-full text-center text-sm text-zinc-500 hover:text-zinc-300">
              Cancel
            </button>
          </>
        )}
      </div>
    </div>
  )
}
