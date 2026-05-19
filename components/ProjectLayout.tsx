'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import {
  getCachedProjects,
  setCachedProjects,
  isProjectsCacheStale,
  type CachedProject,
} from '@/lib/projects-cache'
import { PhoneAccessButton } from './PhoneAccessButton'

// Module-level guard so concurrent ProjectLayout mounts (rare but possible
// during fast navigation) don't fire two background revalidates against
// /api/projects. The fetch result lands in the shared cache regardless.
let revalidateInFlight = false

async function revalidateProjects(): Promise<void> {
  if (revalidateInFlight) return
  revalidateInFlight = true
  try {
    const r = await fetch('/api/projects')
    if (!r.ok) return
    const data = await r.json() as { projects?: CachedProject[] }
    setCachedProjects(data.projects ?? [])
  } catch {
    // Network blip — next mount or next dropdown open retries automatically
    // via the same isStale gate.
  } finally {
    revalidateInFlight = false
  }
}

type Tab = 'overview' | 'work' | 'tasks' | 'team' | 'config'

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'overview', label: 'Overview', icon: 'M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z' },
  { id: 'work', label: 'Work', icon: 'M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5' },
  { id: 'tasks', label: 'Tasks', icon: 'M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z' },
  { id: 'team', label: 'Agents', icon: 'M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198l.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.94-3.197a5.971 5.971 0 00-.94 3.197M15 6.75a3 3 0 11-6 0 3 3 0 016 0zm6 3a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0zm-13.5 0a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z' },
  { id: 'config', label: 'Config', icon: 'M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.212-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28z' },
]

interface ProjectLayoutProps {
  projectName: string
  projectId: string
  activeTab?: Tab
  onTabChange: (tab: Tab) => void
  children: React.ReactNode
  sidebarOpen?: boolean
  onToggleSidebar?: () => void
}

export function ProjectLayout({
  projectName,
  projectId,
  activeTab = 'work',
  onTabChange,
  children,
  sidebarOpen = true,
  onToggleSidebar,
}: ProjectLayoutProps) {
  const [showProjectSwitcher, setShowProjectSwitcher] = useState(false)
  // Seed render-state from the shared module cache so a deep-link mount
  // shows the dropdown content instantly if a previous mount already
  // populated it. Cold cache returns null → falls through to a fetch on
  // the first dropdown open.
  const [userProjects, setUserProjects] = useState<CachedProject[] | null>(() => getCachedProjects())

  // Background revalidate on mount: fires only when the cache is stale
  // (TTL or never populated) and never blocks the render path. The user
  // sees the project page mount at full speed; the dropdown becomes hot
  // a few dozen ms later.
  useEffect(() => {
    if (!isProjectsCacheStale()) return
    void revalidateProjects().then(() => {
      const fresh = getCachedProjects()
      if (fresh) setUserProjects(fresh)
    })
  }, [])

  const showSidebarSection = activeTab === 'work'

  return (
    <div className="flex h-screen flex-col" style={{ backgroundColor: '#181818' }}>
      <header className="flex h-11 shrink-0 items-center border-b border-white/10" style={{ backgroundColor: 'rgba(255, 255, 255, 0.08)' }}>

        {/* Left section — aligned with sidebar width, has right border to continue the sidebar line */}
        {showSidebarSection && (
          <div
            className={`relative flex shrink-0 items-center gap-2 border-r border-white/10 px-3 py-1.5 transition-all ${
              sidebarOpen ? 'w-72' : 'w-auto'
            }`}
            style={{ backgroundColor: '#1F1F1F' }}
          >
            {/* Back arrow — far left */}
            <Link
              href="/"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-500 transition-all hover:bg-white/5 hover:text-zinc-300"
              title="Back to home"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
              </svg>
            </Link>

            {/* Project name block — clickable for fast switch */}
            <button
              onClick={async () => {
                // Cold-cache fallback: deep-link mounts that beat the
                // background revalidate would otherwise show "Loading…"
                // forever (the GET endpoint didn't even exist before this
                // wiring). Block briefly here so the dropdown opens with
                // content. Hot-cache mounts skip this entirely.
                if (!showProjectSwitcher && (userProjects === null || userProjects.length === 0)) {
                  await revalidateProjects()
                  setUserProjects(getCachedProjects())
                }
                setShowProjectSwitcher(!showProjectSwitcher)
              }}
              className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-0.5 transition-all hover:bg-white/5"
            >
              <span className="truncate text-left text-[13px] font-semibold text-zinc-100">{projectName}</span>
              <span className="text-[9px] text-zinc-600">switch</span>
            </button>

            {/* Sidebar toggle — Conductor-style panel icon */}
            {onToggleSidebar && (
              <button
                onClick={onToggleSidebar}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-500 transition-all hover:bg-white/5 hover:text-zinc-300"
                title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <path d="M9 3v18" />
                </svg>
              </button>
            )}

            {/* Project switcher dropdown */}
            {showProjectSwitcher && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowProjectSwitcher(false)} />
                <div
                  className="absolute left-2 right-2 top-full z-50 mt-1 max-h-64 overflow-y-auto rounded-xl border border-white/15 py-1 shadow-2xl shadow-black/50"
                  style={{ backgroundColor: '#252526' }}
                >
                  {!userProjects || userProjects.length === 0 ? (
                    <p className="px-3 py-2 text-[11px] text-zinc-500">Loading...</p>
                  ) : (
                    userProjects.map((p) => (
                      <a
                        key={p.id}
                        href={`/projects/${p.id}`}
                        className={`flex items-center gap-2 px-3 py-2 text-[12px] transition-colors hover:bg-white/5 ${
                          p.id === projectId ? 'text-zinc-100' : 'text-zinc-400'
                        }`}
                        onClick={() => setShowProjectSwitcher(false)}
                      >
                        <span className="truncate">{p.name}</span>
                        {p.id === projectId && (
                          <svg className="ml-auto h-3 w-3 shrink-0 text-violet-400" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                          </svg>
                        )}
                      </a>
                    ))
                  )}
                  <div className="my-1 border-t border-white/10" />
                  <a
                    href="/projects/new"
                    className="flex items-center gap-2 px-3 py-2 text-[12px] text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-200"
                    onClick={() => setShowProjectSwitcher(false)}
                  >
                    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                    </svg>
                    New project
                  </a>
                </div>
              </>
            )}
          </div>
        )}

        {/* Non-work tabs: simpler left section */}
        {!showSidebarSection && (
          <div className="flex items-center gap-3 px-5 py-1.5">
            <Link
              href="/"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 transition-all hover:bg-white/5 hover:text-zinc-300"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
              </svg>
            </Link>
            <h1 className="text-sm font-semibold text-zinc-100">{projectName}</h1>
          </div>
        )}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Phone access toggle — gated by .env config. Renders its own
            popover with QR code + URL when the user is signed in. */}
        <div className="mr-2 hidden md:flex">
          <PhoneAccessButton />
        </div>

        {/* Right side: tabs.
            Labels collapse to icons-only on mobile (<md) so all 5 tabs
            fit in a 375px viewport without horizontal overflow. The
            label re-appears on md+ where there's room. */}
        <nav className="flex items-center gap-1 px-2 md:gap-2 md:px-5">
          {TABS.map((tab) => {
            const isActive = activeTab === tab.id
            return (
              <button
                key={tab.id}
                onClick={() => onTabChange(tab.id)}
                aria-label={tab.label}
                className={`relative flex items-center gap-1.5 rounded-lg px-2 py-2 text-xs font-medium transition-all md:px-3.5 ${
                  isActive
                    ? 'bg-white/10 text-white'
                    : 'text-zinc-300 hover:bg-white/5 hover:text-white'
                }`}
              >
                <svg className={`h-3.5 w-3.5 ${isActive ? 'text-violet-300' : 'text-zinc-500'}`} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d={tab.icon} />
                </svg>
                <span className="hidden md:inline">{tab.label}</span>
                {isActive && (
                  <span className="absolute bottom-0 left-2 right-2 h-0.5 rounded-full bg-gradient-to-r from-violet-500 to-indigo-500" />
                )}
              </button>
            )
          })}
        </nav>
      </header>

      <div className="flex flex-1 flex-col overflow-hidden">
        {children}
      </div>
    </div>
  )
}

export type { Tab }
