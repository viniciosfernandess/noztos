'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { CreateProjectButton } from './CreateProjectForm'
import { invalidateProjects } from '@/lib/projects-cache'

interface Project {
  id: string
  name: string
  createdAt: Date
}

interface ProjectListProps {
  projects: Project[]
}

export function ProjectList({ projects }: ProjectListProps) {
  const [deleteModal, setDeleteModal] = useState<{ id: string; name: string } | null>(null)
  const [warnings, setWarnings] = useState<{ uncommittedChanges: number; pendingTasks: number } | null>(null)
  const [loadingWarnings, setLoadingWarnings] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const router = useRouter()

  async function handleDeleteClick(e: React.MouseEvent, project: { id: string; name: string }) {
    e.preventDefault()
    e.stopPropagation()
    setDeleteModal(project)
    setLoadingWarnings(true)
    try {
      const res = await fetch(`/api/projects/${project.id}`)
      if (res.ok) {
        const data = await res.json()
        setWarnings(data.warnings)
      }
    } catch {}
    setLoadingWarnings(false)
  }

  async function handleConfirmDelete() {
    if (!deleteModal || deleting) return
    setDeleting(true)
    try {
      const res = await fetch(`/api/projects/${deleteModal.id}`, { method: 'DELETE' })
      if (res.ok || res.status === 204) {
        // Drop the cached switcher list — it still includes the deleted
        // project. The next dropdown open or page mount refetches.
        invalidateProjects()
        setDeleteModal(null)
        router.refresh()
      }
    } catch {}
    setDeleting(false)
  }

  if (projects.length === 0) {
    return (
      <div className="flex h-full flex-1 flex-col items-center justify-center gap-5 text-center">
        <style>{`
          @keyframes terminal-blink { 0%,49% { opacity: 1 } 50%,100% { opacity: 0 } }
          @keyframes type-msg { 0% { width: 0 } 20% { width: 100% } 100% { width: 100% } }
          @keyframes fade-in-3 { 0%,28% { opacity: 0 } 32% { opacity: 1 } }
          @keyframes fade-in-4 { 0%,42% { opacity: 0 } 46% { opacity: 1 } }
          @keyframes fade-in-5 { 0%,56% { opacity: 0 } 60% { opacity: 1 } }
          @keyframes fade-in-6 { 0%,70% { opacity: 0 } 74% { opacity: 1 } }
          @keyframes pulse-glow { 0%,100% { opacity: 0.3 } 50% { opacity: 0.8 } }
          .t-blink { animation: terminal-blink 1s step-end infinite; }
          .t-type { animation: type-msg 10s steps(30, end) infinite; overflow: hidden; white-space: nowrap; }
          .t-fade-3 { animation: fade-in-3 10s ease-out infinite; }
          .t-fade-4 { animation: fade-in-4 10s ease-out infinite; }
          .t-fade-5 { animation: fade-in-5 10s ease-out infinite; }
          .t-fade-6 { animation: fade-in-6 10s ease-out infinite; }
          .glow { animation: pulse-glow 4s ease-in-out infinite; }
        `}</style>

        {/* Mini terminal animation */}
        <div className="relative">
          <div className="glow absolute -inset-6 rounded-2xl" style={{ background: 'radial-gradient(ellipse at center, rgba(0,120,212,0.06) 0%, transparent 70%)' }} />

          <div className="relative w-72 overflow-hidden rounded-lg border border-[#2B2B2B]" style={{ backgroundColor: '#181818' }}>
            <div className="flex items-center gap-1.5 border-b border-[#2B2B2B] px-3 py-1.5">
              <div className="h-2 w-2 rounded-full bg-[#FF5F57]" />
              <div className="h-2 w-2 rounded-full bg-[#FFBD2E]" />
              <div className="h-2 w-2 rounded-full bg-[#28C840]" />
              <span className="ml-2 text-[9px] text-zinc-600">bornastar</span>
            </div>

            <div className="space-y-2 px-3 py-3 font-mono text-[10px] leading-relaxed">
              <div className="flex justify-end">
                <div className="t-type rounded-md bg-[#313131] px-2 py-1 text-zinc-300">
                  start my next project
                </div>
              </div>

              <div className="t-fade-3">
                <span className="italic text-zinc-600">cloning repo...</span>
              </div>

              <div className="t-fade-4 flex items-center gap-1">
                <span className="text-zinc-400">workspace ready.</span>
                <span className="font-semibold text-white">let&apos;s build.</span>
              </div>

              <div className="t-fade-5 flex items-center gap-1">
                <span className="text-[#28C840]">✓</span>
                <span className="text-zinc-400">agents standing by.</span>
              </div>

              <div className="t-fade-6">
                <span className="t-blink text-zinc-500">_</span>
              </div>
            </div>
          </div>
        </div>

        <div>
          <p className="text-sm font-medium text-zinc-300">No projects yet</p>
          <p className="mt-1 text-[12px] text-zinc-500">Select a repository to get started.</p>
        </div>
        <div>
          <CreateProjectButton label="Let's start" />
        </div>
      </div>
    )
  }

  return (
    <div data-tour="project-list" className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-zinc-200">Your Projects</h2>
        <CreateProjectButton />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {projects.map((project) => (
          <div key={project.id} className="group relative">
            <Link
              href={`/projects/${project.id}`}
              className="block rounded-xl border border-white/10 p-5 transition-all hover:border-violet-500/30 hover:bg-violet-500/[0.04]"
              style={{ backgroundColor: '#1e1e28' }}
            >
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500 to-indigo-600 shadow-sm shadow-violet-500/20">
                  <svg className="h-4 w-4 text-white" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
                  </svg>
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="font-medium text-zinc-200 group-hover:text-violet-300 transition-colors">{project.name}</h3>
                  <p className="text-[11px] text-zinc-500">
                    Created {new Date(project.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  </p>
                </div>
              </div>
            </Link>
            {/* Delete button — hover */}
            <button
              onClick={(e) => handleDeleteClick(e, { id: project.id, name: project.name })}
              className="absolute right-3 top-3 hidden h-7 w-7 items-center justify-center rounded-lg text-zinc-600 transition-all hover:bg-red-500/10 hover:text-red-400 group-hover:flex"
              title="Delete project"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
              </svg>
            </button>
          </div>
        ))}
      </div>

      {/* Delete confirmation modal */}
      {deleteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={() => setDeleteModal(null)}>
          <div className="w-full max-w-xs sm:max-w-sm overflow-hidden rounded-2xl border border-white/10 shadow-2xl" style={{ backgroundColor: '#1a1a22' }} onClick={(e) => e.stopPropagation()}>
            <div className="border-b border-white/10 px-6 py-4" style={{ backgroundColor: '#15151c' }}>
              <h3 className="text-sm font-semibold text-zinc-100">Delete Project</h3>
              <p className="text-[11px] text-zinc-500 mt-0.5">{deleteModal.name}</p>
            </div>
            <div className="p-6 space-y-3">
              <p className="text-xs text-zinc-400">This will remove the project from noztos. Your GitHub repository will not be affected.</p>

              {loadingWarnings && (
                <div className="flex items-center gap-2 text-[11px] text-zinc-500">
                  <svg className="h-3 w-3 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                  Checking project status...
                </div>
              )}

              {warnings && warnings.uncommittedChanges > 0 && (
                <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.06] p-3">
                  <div className="flex items-start gap-2">
                    <svg className="h-4 w-4 shrink-0 text-amber-400 mt-0.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                    </svg>
                    <p className="text-[11px] text-amber-300">{warnings.uncommittedChanges} uncommitted change{warnings.uncommittedChanges !== 1 ? 's' : ''} will be lost. Push to GitHub first if you want to keep them.</p>
                  </div>
                </div>
              )}

              {warnings && warnings.pendingTasks > 0 && (
                <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.06] p-3">
                  <div className="flex items-start gap-2">
                    <svg className="h-4 w-4 shrink-0 text-amber-400 mt-0.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                    </svg>
                    <p className="text-[11px] text-amber-300">{warnings.pendingTasks} active task{warnings.pendingTasks !== 1 ? 's' : ''} (pending, queued, or running) will be deleted.</p>
                  </div>
                </div>
              )}

              <button
                onClick={handleConfirmDelete}
                disabled={deleting || loadingWarnings}
                className="flex w-full h-10 items-center justify-center gap-2 rounded-lg bg-red-600 text-xs font-medium text-white transition-colors hover:bg-red-500 disabled:opacity-50"
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                </svg>
                {deleting ? 'Deleting...' : 'Delete Project'}
              </button>
              <button onClick={() => { setDeleteModal(null); setWarnings(null) }} className="w-full text-center text-xs text-zinc-500 hover:text-zinc-300">Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
