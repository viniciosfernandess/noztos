'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ProjectLayout } from './ProjectLayout'
import { WorkPanel } from './WorkPanel'
import { MyTeamPanel } from './MyTeamPanel'
import { TasksPanel } from './TasksPanel'
import { SourceControl } from './SourceControl'
import { CompanionUpdateBanner } from './CompanionUpdateBanner'
import type { Tab } from './ProjectLayout'

// Employee color map — must match MyTeamPanel
const EMPLOYEE_COLORS: Record<string, string> = {
  ceo: 'from-violet-500 to-purple-600',
  architect: 'from-blue-500 to-cyan-600',
  designer: 'from-pink-500 to-rose-600',
  security: 'from-red-500 to-orange-600',
  tester: 'from-emerald-500 to-green-600',
  reviewer: 'from-amber-500 to-yellow-600',
  docs: 'from-stone-500 to-stone-700',
  devops: 'from-slate-500 to-slate-700',
  builder: 'from-red-600 to-red-700',
}

const EMPLOYEE_NAMES: Record<string, string> = {
  ceo: 'CEO',
  architect: 'Architect',
  designer: 'Designer',
  security: 'Security',
  tester: 'Tester',
  reviewer: 'Reviewer',
  docs: 'Docs',
  devops: 'DevOps',
  builder: 'Builder',
}

interface Project { id: string; name: string }
interface Team { id: string; name: string; collaboratorOrder: { collaboratorIds: string[] } }
interface Task { id: string; name: string; status: string }

interface Props {
  project: Project
  teams: Team[]
  tasks: Task[]
}

// Every project ships with the same fixed roster of agents — there is no
// hiring step. Listed in the order they appear in MyTeamPanel and feed
// the chat slash-command picker via WorkPanel.
const AGENT_IDS = ['ceo', 'architect', 'designer', 'security', 'tester', 'reviewer', 'docs', 'devops'] as const

export function ProjectDashboardClient({ project, teams, tasks }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>('work')
  // Default closed on mobile (chat takes full width) and open on
  // desktop. The initial render uses `true` (the server-side default)
  // and the useEffect below corrects it on the client when we can
  // measure viewport width. matchMedia avoids re-render churn on
  // resize during desktop sessions.
  const [sidebarOpen, setSidebarOpen] = useState(true)
  useEffect(() => {
    if (typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches) {
      setSidebarOpen(false)
    }
  }, [])
  const [localTeams, setLocalTeams] = useState<{ name: string; memberIds: string[]; hasBuilder: boolean; order: string[]; canRecreateTasks: Record<string, string> }[]>([])

  const hiredEmployees = AGENT_IDS.map((id) => ({
    id,
    name: EMPLOYEE_NAMES[id] ?? id,
    color: EMPLOYEE_COLORS[id] ?? 'from-zinc-500 to-zinc-600',
  }))

  // Build team infos for WorkPanel
  const teamInfos = localTeams.map((t, i) => ({
    id: `local-team-${i}`,
    name: t.name,
    memberIds: t.memberIds,
    hasBuilder: t.hasBuilder,
    order: t.order,
    canRecreateTasks: t.canRecreateTasks,
  }))



  return (
    <ProjectLayout
      projectName={project.name}
      projectId={project.id}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      sidebarOpen={sidebarOpen}
      onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
    >
      {/* Companion update prompt — owns its own padding when visible,
          and renders nothing (no wrapper) when there's no update to
          show, so the column layout doesn't leave a strip above the
          tab content. */}
      <CompanionUpdateBanner />

      {/* Keep-alive tabs: all panels stay mounted from first render so
          switching between Overview/Work/Tasks/Team/Config is an instant
          CSS swap instead of a remount. Component state, scroll positions,
          SSE subscriptions, and any in-memory caches persist across the
          entire session inside this project. Inactive panels are hidden
          with the `hidden` attribute (display: none) which keeps them in
          the React tree without rendering pixels. */}
      <div className={activeTab === 'overview' ? 'contents' : 'hidden'}>
        <div className="flex-1 overflow-y-auto p-6" style={{ backgroundColor: '#1e1e28' }}>
          <div className="mx-auto max-w-3xl space-y-6">
            <h2 className="text-lg font-semibold text-zinc-200">Overview</h2>
            <div className="grid grid-cols-3 gap-4">
              <StatCard label="Files" value="-" icon="file" />
              <StatCard label="Tasks" value={String(tasks.length)} icon="task" />
              <StatCard label="Agents" value={String(AGENT_IDS.length)} icon="team" />
            </div>
            <SourceControl projectId={project.id} />
          </div>
        </div>
      </div>

      <div className={activeTab === 'work' ? 'contents' : 'hidden'}>
        <WorkPanel
          projectId={project.id}
          hiredEmployees={hiredEmployees}
          teams={teamInfos}
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => setSidebarOpen((v) => !v)}
        />
      </div>

      <div className={activeTab === 'tasks' ? 'contents' : 'hidden'}>
        <TasksPanel projectId={project.id} />
      </div>

      <div className={activeTab === 'team' ? 'contents' : 'hidden'}>
        <MyTeamPanel />
      </div>

      <div className={activeTab === 'config' ? 'contents' : 'hidden'}>
        <div className="flex-1 overflow-y-auto p-6" style={{ backgroundColor: '#1e1e28' }}>
          <div className="mx-auto max-w-3xl space-y-8">
            <div>
              <h2 className="text-lg font-semibold text-zinc-200">Configuration</h2>
              <p className="mt-2 text-sm text-zinc-500">Project settings will appear here.</p>
            </div>

            {/* Danger zone */}
            <div className="rounded-xl border border-red-500/20 p-6">
              <h3 className="text-sm font-semibold text-red-400">Danger Zone</h3>
              <p className="mt-1 text-xs text-zinc-500">Deleting this project will remove all data from noztos — tasks, chat history, files. Your GitHub repository will not be affected.</p>
              <DeleteProjectButton projectId={project.id} projectName={project.name} />
            </div>
          </div>
        </div>
      </div>
    </ProjectLayout>
  )
}

const STAT_ICONS: Record<string, { icon: string; color: string; bg: string }> = {
  file: {
    icon: 'M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z',
    color: 'text-violet-400',
    bg: 'bg-violet-500/10 border-violet-500/20',
  },
  task: {
    icon: 'M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
    color: 'text-sky-400',
    bg: 'bg-sky-500/10 border-sky-500/20',
  },
  team: {
    icon: 'M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198l.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.94-3.197a5.971 5.971 0 00-.94 3.197M15 6.75a3 3 0 11-6 0 3 3 0 016 0zm6 3a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0zm-13.5 0a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z',
    color: 'text-emerald-400',
    bg: 'bg-emerald-500/10 border-emerald-500/20',
  },
}

function StatCard({ label, value, icon }: { label: string; value: string; icon?: string }) {
  const st = icon ? STAT_ICONS[icon] : null
  return (
    <div className={`rounded-xl border p-4 ${st ? st.bg : 'border-white/10 bg-white/5'}`}>
      <div className="flex items-center justify-between">
        <p className={`text-2xl font-bold ${st ? st.color : 'text-zinc-200'}`}>{value}</p>
        {st && (
          <svg className={`h-5 w-5 ${st.color} opacity-60`} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d={st.icon} />
          </svg>
        )}
      </div>
      <p className="mt-1 text-xs text-zinc-500">{label}</p>
    </div>
  )
}

function DeleteProjectButton({ projectId, projectName }: { projectId: string; projectName: string }) {
  const [showConfirm, setShowConfirm] = useState(false)
  const [warnings, setWarnings] = useState<{ uncommittedChanges: number; pendingTasks: number } | null>(null)
  const [deleting, setDeleting] = useState(false)
  const router = useRouter()

  async function handleClick() {
    setShowConfirm(true)
    try {
      const res = await fetch(`/api/projects/${projectId}`)
      if (res.ok) {
        const data = await res.json()
        setWarnings(data.warnings)
      }
    } catch {}
  }

  async function handleDelete() {
    setDeleting(true)
    try {
      const res = await fetch(`/api/projects/${projectId}`, { method: 'DELETE' })
      if (res.ok || res.status === 204) router.push('/')
    } catch {}
    setDeleting(false)
  }

  return (
    <>
      <button onClick={handleClick} className="mt-3 flex h-9 items-center gap-2 rounded-lg bg-red-600 px-4 text-xs font-medium text-white transition-colors hover:bg-red-500">
        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
        </svg>
        Delete Project
      </button>

      {showConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowConfirm(false)}>
          <div className="w-full max-w-sm overflow-hidden rounded-2xl border border-white/10 shadow-2xl" style={{ backgroundColor: '#1a1a22' }} onClick={(e) => e.stopPropagation()}>
            <div className="border-b border-white/10 px-6 py-4" style={{ backgroundColor: '#15151c' }}>
              <h3 className="text-sm font-semibold text-zinc-100">Delete Project</h3>
              <p className="text-[11px] text-zinc-500 mt-0.5">{projectName}</p>
            </div>
            <div className="p-6 space-y-3">
              <p className="text-xs text-zinc-400">This will permanently remove the project from noztos. Your GitHub repository will not be affected.</p>

              {warnings && warnings.uncommittedChanges > 0 && (
                <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.06] p-3">
                  <p className="text-[11px] text-amber-300">{warnings.uncommittedChanges} uncommitted change{warnings.uncommittedChanges !== 1 ? 's' : ''} will be lost.</p>
                </div>
              )}

              {warnings && warnings.pendingTasks > 0 && (
                <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.06] p-3">
                  <p className="text-[11px] text-amber-300">{warnings.pendingTasks} active task{warnings.pendingTasks !== 1 ? 's' : ''} will be deleted.</p>
                </div>
              )}

              <button onClick={handleDelete} disabled={deleting} className="flex w-full h-10 items-center justify-center gap-2 rounded-lg bg-red-600 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-50">
                {deleting ? 'Deleting...' : 'Delete Project'}
              </button>
              <button onClick={() => setShowConfirm(false)} className="w-full text-center text-xs text-zinc-500 hover:text-zinc-300">Cancel</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
