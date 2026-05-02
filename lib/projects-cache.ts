// Browser-side cache for the user's project list — just `[{id, name}]` pairs
// powering the "switch" dropdown at the top-left of every project page.
//
// Why module-level (not React state)
//   The switcher unmounts on every navigation between projects, so a per-
//   component cache is wasted exactly when it would help most. Keeping the
//   cache in module scope means navigating Project A → switch → Project B
//   reuses the same snapshot.
//
// Why no localStorage
//   Adds invalidation complexity (cross-tab sync, stale on first load) for
//   little gain — the in-memory cache survives every navigation a user does
//   inside one session, and a full reload pays at most one ~30-80ms fetch
//   while the rest of the page loads in parallel.
//
// Sizing
//   Per entry: ~50 bytes (cuid + name). 100 projects = ~5KB. Negligible.

export interface CachedProject {
  id: string
  name: string
}

interface CacheSlot {
  items: CachedProject[]
  fetchedAt: number
}

let slot: CacheSlot | null = null

// Tunable: 5min balances "don't show stale list after creating a project in
// another tab" against "don't refetch on every dropdown open". Project create /
// delete from this tab also call `invalidateProjects()` so those don't have to
// wait on the TTL.
const STALE_AFTER_MS = 5 * 60 * 1000

export function getCachedProjects(): CachedProject[] | null {
  return slot?.items ?? null
}

export function setCachedProjects(items: CachedProject[]): void {
  // Defensive copy — caller mutating its own array (e.g. push) shouldn't
  // bleed into the cached snapshot.
  slot = { items: items.slice(), fetchedAt: Date.now() }
}

export function isProjectsCacheStale(): boolean {
  if (!slot) return true
  return Date.now() - slot.fetchedAt > STALE_AFTER_MS
}

export function invalidateProjects(): void {
  slot = null
}
