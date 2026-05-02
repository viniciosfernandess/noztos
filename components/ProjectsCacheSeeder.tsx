'use client'

import { useEffect } from 'react'
import { setCachedProjects, type CachedProject } from '@/lib/projects-cache'

// Bridges the home page's server-rendered project list into the client-
// side cache used by the project switcher. The home page already pulls
// the list via Prisma to render its tile grid — we'd be doing a wasted
// fetch on the next project-page mount otherwise. Single useEffect, no
// render output. Re-runs only if the list actually changes (length +
// joined ids), so a same-list re-render doesn't churn the cache stamp.
export function ProjectsCacheSeeder({ projects }: { projects: CachedProject[] }) {
  const signature = `${projects.length}:${projects.map((p) => p.id).join(',')}`
  useEffect(() => {
    setCachedProjects(projects)
    // signature in deps; projects is stable per-render but we want a value-
    // based dependency so identical lists don't trigger setCachedProjects
    // (which would bump fetchedAt and shift the staleness window).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature])
  return null
}
