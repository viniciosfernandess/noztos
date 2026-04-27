// ── Worktree cache ─────────────────────────────────────────────────────────
//
// Module-level RAM cache for the per-worktree state shown in the right
// panel. Mirrors the pattern `companion-store.ts` already uses for chat
// slices — read-from-cache on render (instant), revalidate in background,
// invalidate on a daemon-driven event.
//
// Keys: `worktreeId` for an active worktree, the literal string 'main'
// for the no-worktree view. The cache is browser-RAM only; closing the
// tab clears it. We don't persist to localStorage / IndexedDB — the
// payloads are tiny and the server hydrates on cold open.
//
// Eviction: LRU with MAX_KEYS entries. The active worktree is always
// kept hot; a user with 50 worktrees only blows ~MAX_KEYS × ~50KB of
// browser RAM, which is invisible vs. typical SPA memory.

import type { FileEntry } from './worktree-types'

const MAX_KEYS = 20

type Listener = () => void

interface CacheEntry<T> {
  value: T
  /**
   * ms timestamp of the most recent touch (read or write). Drives idle
   * eviction — entries past IDLE_EVICTION_MS without a touch get swept
   * unless their key is in the protected set when the sweeper runs.
   */
  lastAccessedAt: number
}

class LruCache<T> {
  private readonly map = new Map<string, CacheEntry<T>>()
  private readonly listeners = new Map<string, Set<Listener>>()

  get(key: string): T | undefined {
    const entry = this.map.get(key)
    if (!entry) return undefined
    // touch — re-insert moves the key to the end of the Map's iteration
    // order, which is how we get LRU semantics out of a plain Map. The
    // timestamp bump keeps the entry safe from idle eviction.
    entry.lastAccessedAt = Date.now()
    this.map.delete(key)
    this.map.set(key, entry)
    return entry.value
  }

  has(key: string): boolean {
    return this.map.has(key)
  }

  set(key: string, value: T): void {
    const existing = this.map.get(key)
    const entry: CacheEntry<T> = {
      value,
      lastAccessedAt: Date.now(),
    }
    // Re-insert (delete + set) ensures the key is at the freshest end of
    // the LRU iteration order even if it already existed.
    if (existing) this.map.delete(key)
    this.map.set(key, entry)
    let evicted: string | null = null
    if (this.map.size > MAX_KEYS) {
      // Drop the oldest key (first in iteration order). Listeners on the
      // dropped key are kept attached — if the worktree is re-visited,
      // they'll be notified again once it's repopulated. Returned to the
      // caller as a string so the wrapper functions can log it; without
      // a log here this eviction would be invisible during testing.
      const oldest = this.map.keys().next().value
      if (oldest !== undefined) {
        this.map.delete(oldest)
        evicted = oldest
      }
    }
    this.notify(key)
    if (evicted) {
      console.log(`[worktree-cache] LRU evict key=${evicted.slice(0, 8)} (capacity ${MAX_KEYS} hit, oldest dropped)`)
    }
  }

  /**
   * Drop entries older than `maxAgeMs` whose key is NOT in `protect`.
   * Returns the keys that were evicted (for logging / telemetry). Used
   * by the module-level idle sweeper.
   *
   * Protection covers idle eviction only — capacity eviction (LRU on
   * insert) still runs unconditionally, matching how the chat slice
   * cap behaves. Without that, a user with 30+ permanently-active
   * worktrees would grow the cache forever.
   */
  evictIdle(maxAgeMs: number, protect: ReadonlySet<string>): string[] {
    const now = Date.now()
    const dropped: string[] = []
    for (const [key, entry] of this.map) {
      if (protect.has(key)) continue
      if (now - entry.lastAccessedAt < maxAgeMs) continue
      this.map.delete(key)
      dropped.push(key)
    }
    return dropped
  }

  /**
   * Snapshot of currently-populated keys. Returned as a new array so
   * iterating callers can mutate the cache (set/evictIdle) without
   * tripping over Map's "modified during iteration" semantics.
   */
  keys(): string[] {
    return Array.from(this.map.keys())
  }

  subscribe(key: string, listener: Listener): () => void {
    let set = this.listeners.get(key)
    if (!set) {
      set = new Set()
      this.listeners.set(key, set)
    }
    set.add(listener)
    return () => {
      const s = this.listeners.get(key)
      if (!s) return
      s.delete(listener)
      if (s.size === 0) this.listeners.delete(key)
    }
  }

  private notify(key: string): void {
    const set = this.listeners.get(key)
    if (!set) return
    for (const l of set) l()
  }
}

// ── File listings ─────────────────────────────────────────────────────────

const filesCache = new LruCache<FileEntry[]>()

// ── Terminal state ────────────────────────────────────────────────────────
// Snapshot of everything the terminal needs to redraw without flashing
// "Connecting to sandbox..." or losing what the user already saw. Limited
// to TERMINAL_HISTORY_LIMIT lines per context — anything older drops off
// the top, preserving the UX of "you can scroll up to recent commands"
// without unbounded memory growth across many worktrees.

export type TerminalEntry = { type: 'input' | 'stdout' | 'stderr' | 'system'; text: string }
export type TerminalSandboxStatus = 'disconnected' | 'starting' | 'running'

export interface TerminalState {
  history: TerminalEntry[]
  input: string
  commandHistory: string[]
  sandboxStatus: TerminalSandboxStatus
}

const TERMINAL_HISTORY_LIMIT = 500

const terminalCache = new LruCache<TerminalState>()

export function getCachedTerminal(key: string): TerminalState | undefined {
  return terminalCache.get(key)
}

export function setCachedTerminal(key: string, state: TerminalState): void {
  // Trim history at write time so the cap is enforced regardless of how
  // the caller built the array. Keeping the most recent N preserves the
  // useful tail (what just ran) and drops the cold prefix.
  const trimmed = state.history.length > TERMINAL_HISTORY_LIMIT
    ? state.history.slice(-TERMINAL_HISTORY_LIMIT)
    : state.history
  terminalCache.set(key, { ...state, history: trimmed })
}

export function getCachedFiles(key: string): FileEntry[] | undefined {
  return filesCache.get(key)
}

export function setCachedFiles(key: string, files: FileEntry[]): void {
  filesCache.set(key, files)
}

export function hasCachedFiles(key: string): boolean {
  return filesCache.has(key)
}

export function subscribeCachedFiles(key: string, listener: Listener): () => void {
  return filesCache.subscribe(key, listener)
}

export function getCachedFilesKeys(): string[] {
  return filesCache.keys()
}

/**
 * Map a daemon-emitted fs-change path list to the set of cache keys it
 * touches. Paths look like:
 *
 *   .bornastar-worktrees/<id>/src/foo.tsx   → cache key '<id>'
 *   README.md                                → cache key 'main'
 *
 * The `<id>` matches the Worktree row's primary key (cuid) — the same
 * value FileTree and ChangesList use as their cacheKey, so the mapping
 * is exact, not approximate. Used by the global fs-change refresher to
 * keep cached but unviewed worktrees in sync with the disk.
 */
const WORKTREE_PATH_RE = /^\.bornastar-worktrees\/([^/]+)\//

export function parseAffectedCacheKeys(paths: string[]): Set<string> {
  const keys = new Set<string>()
  for (const p of paths) {
    const m = WORKTREE_PATH_RE.exec(p)
    keys.add(m ? m[1] : 'main')
  }
  return keys
}

// ── Idle eviction sweeper ─────────────────────────────────────────────────
//
// Mirrors the pattern `companion-store.ts` uses for chat slices, but with
// its own constants (worktrees are heavier "context" than messages, so we
// keep them around longer). 100% isolated from the chat sweeper — separate
// timer, separate state, separate protector.
//
// The sweeper runs once a minute. For each cached key, if it hasn't been
// touched in IDLE_EVICTION_MS AND isn't in the current "protected" set
// (focused worktree + worktrees with running chats + always-on keys like
// 'main' and the projectId for the project terminal), it gets dropped
// from BOTH the files cache and the terminal cache. The next visit to
// that worktree pays a cold fetch — same as the very first time.
//
// Why pull-model protector: the worktree cache has no idea what's
// "running" or "focused" — that knowledge lives in WorkPanel React state
// and `companionStore.runningSessionIds`. Having WorkPanel register a
// callback (instead of importing from companion-store here) keeps the
// dependency graph one-way: UI → cache, never the reverse.

const IDLE_EVICTION_MS = 60 * 60 * 1000  // 1 hour — 2x the chat slice TTL
const SWEEP_INTERVAL_MS = 60 * 1000      // Same cadence as the chat sweeper

type ProtectorFn = () => Set<string>

let cacheProtector: ProtectorFn = () => new Set()
let sweeperHandle: ReturnType<typeof setInterval> | null = null

/**
 * Register a function the sweeper consults before each pass to learn
 * which keys are "active" right now (focused / has running chat / etc).
 * Pull-model so the answer is always fresh — the UI doesn't have to
 * push updates as state changes.
 */
export function setCacheProtector(fn: ProtectorFn): void {
  cacheProtector = fn
  // Lazily start the background sweeper on the first registration.
  // SSR doesn't have `setInterval` clearing semantics across renders,
  // so we gate strictly on `window`.
  if (typeof window === 'undefined') return
  if (sweeperHandle) return
  sweeperHandle = setInterval(sweepIdle, SWEEP_INTERVAL_MS)
}

function sweepIdle(): void {
  const protect = cacheProtector()
  const droppedFiles = filesCache.evictIdle(IDLE_EVICTION_MS, protect)
  const droppedTerminals = terminalCache.evictIdle(IDLE_EVICTION_MS, protect)
  if (droppedFiles.length > 0 || droppedTerminals.length > 0) {
    console.log(
      `[worktree-cache] idle sweep `
      + `files=${droppedFiles.length > 0 ? droppedFiles.map((k) => k.slice(0, 8)).join(',') : '-'} `
      + `terminals=${droppedTerminals.length > 0 ? droppedTerminals.map((k) => k.slice(0, 8)).join(',') : '-'} `
      + `protected=${protect.size}`,
    )
  }
}

/**
 * Test-only — run the sweep immediately, on demand. Production code
 * never calls this; the sweeper runs via `setInterval` started lazily
 * by `setCacheProtector`. Vitest's `environment: 'node'` has no
 * `window`, so the lazy start never fires there. This export gives
 * tests a deterministic way to assert eviction behavior without
 * pulling in jsdom or stubbing globalThis.
 */
export function _sweepIdleForTest(): void {
  sweepIdle()
}
