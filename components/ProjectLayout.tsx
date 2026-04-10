'use client'

import Link from 'next/link'
import { useState } from 'react'

type Tab = 'overview' | 'work' | 'tasks' | 'team' | 'config'

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'overview', label: 'Overview', icon: 'M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z' },
  { id: 'work', label: 'Work', icon: 'M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5' },
  { id: 'tasks', label: 'Tasks', icon: 'M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z' },
  { id: 'team', label: 'My Team', icon: 'M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198l.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.94-3.197a5.971 5.971 0 00-.94 3.197M15 6.75a3 3 0 11-6 0 3 3 0 016 0zm6 3a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0zm-13.5 0a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z' },
  { id: 'config', label: 'Config', icon: 'M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.212-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28z' },
]

interface ProjectLayoutProps {
  projectName: string
  activeTab?: Tab
  onTabChange: (tab: Tab) => void
  children: React.ReactNode
  // When true, the navbar floats on top and only reveals on hover at the
  // top edge of the screen — used in the Work tab where every pixel matters.
  // Other tabs keep the navbar always visible.
  floatingNav?: boolean
}

export function ProjectLayout({
  projectName,
  activeTab = 'work',
  onTabChange,
  children,
  floatingNav = false,
}: ProjectLayoutProps) {
  const [navHovered, setNavHovered] = useState(false)

  // Inner navbar markup, shared between fixed and floating modes
  const navbarInner = (
    <>
      {/* Left: back + project name */}
      <div className="flex items-center gap-3 pr-6">
        <Link
          href="/"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 transition-all hover:bg-white/5 hover:text-zinc-300"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
          </svg>
        </Link>
        <div className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500 to-indigo-600 shadow-sm shadow-violet-500/20">
            <svg className="h-3.5 w-3.5 text-white" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
            </svg>
          </div>
          <h1 className="text-sm font-semibold text-zinc-100">{projectName}</h1>
        </div>
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Right side: tabs */}
      <nav className="flex items-center gap-2">
        {TABS.map((tab) => {
          const isActive = activeTab === tab.id
          return (
            <button
              key={tab.id}
              onClick={() => onTabChange(tab.id)}
              className={`relative flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-medium transition-all ${
                isActive
                  ? 'bg-white/10 text-white'
                  : 'text-zinc-300 hover:bg-white/5 hover:text-white'
              }`}
            >
              <svg className={`h-3.5 w-3.5 ${isActive ? 'text-violet-300' : 'text-zinc-500'}`} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d={tab.icon} />
              </svg>
              {tab.label}
              {isActive && (
                <span className="absolute bottom-0 left-2 right-2 h-0.5 rounded-full bg-gradient-to-r from-violet-500 to-indigo-500" />
              )}
            </button>
          )
        })}
      </nav>
    </>
  )

  return (
    <div className="flex h-screen flex-col" style={{ backgroundColor: '#1a1a22' }}>
      {floatingNav ? (
        <>
          {/* Handle — visible "drawer pull" tab sticking out from the top
              edge with 3 horizontal lines. Hover triggers the navbar to
              slide down. Sits behind the navbar (z-40 < z-50) so when the
              navbar is open, the handle is naturally hidden under it. The
              ONLY way to open the navbar is hovering this handle. */}
          <div
            className={`fixed left-1/2 top-0 z-40 -translate-x-1/2 cursor-pointer transition-opacity duration-200 ${
              navHovered ? 'pointer-events-none opacity-0' : 'opacity-100'
            }`}
            onMouseEnter={() => setNavHovered(true)}
          >
            <div
              className="flex flex-col items-center gap-[3px] rounded-b-xl border-x border-b border-white/20 px-5 py-2 shadow-lg shadow-black/40 transition-colors hover:bg-white/[0.08] hover:border-white/30"
              style={{ backgroundColor: '#1e1e28' }}
            >
              <div className="h-[2px] w-6 rounded-full bg-zinc-400" />
              <div className="h-[2px] w-6 rounded-full bg-zinc-400" />
              <div className="h-[2px] w-6 rounded-full bg-zinc-400" />
            </div>
          </div>
          {/* Floating navbar — fixed at top, hidden by default, slides in on
              hover. Stays visible while the mouse is over it; slides back up
              when the mouse leaves. Overlays the content (doesn't push). */}
          <header
            className={`fixed left-0 right-0 top-0 z-50 flex items-center border-b border-white/15 px-5 py-1.5 shadow-2xl shadow-black/40 transition-transform duration-200 ease-out ${
              navHovered ? 'translate-y-0' : '-translate-y-full'
            }`}
            style={{ backgroundColor: '#1e1e28' }}
            onMouseEnter={() => setNavHovered(true)}
            onMouseLeave={() => setNavHovered(false)}
          >
            {navbarInner}
          </header>
        </>
      ) : (
        <header
          className="flex shrink-0 items-center border-b border-white/15 px-5 py-1.5"
          style={{ backgroundColor: '#1e1e28' }}
        >
          {navbarInner}
        </header>
      )}

      {/* Content — when navbar floats, content takes full height */}
      <div className="flex flex-1 overflow-hidden">
        {children}
      </div>
    </div>
  )
}

export type { Tab }
