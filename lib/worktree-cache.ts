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

import type { FileEntry, FileDiff, WorktreeMeta } from './worktree-types'

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

  // Drop a single key. Notifies subscribers so they refetch on the next
  // render — we use this for "the underlying baseline shifted, your data
  // is no longer correct" events (e.g. post-merge baseCommit advance).
  delete(key: string): boolean {
    const existed = this.map.delete(key)
    if (existed) this.notify(key)
    return existed
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
// Browser-side snapshot of the terminal panel for a given context. The
// authoritative live state lives in the daemon-side PTY (see
// companion/src/pty-manager.ts) — this slice only exists to give the
// remount path something to paint before the daemon's ring-buffer
// replay catches up. xterm owns scrollback, the shell owns its own
// command history, and PTY status is binary (attached or not, and
// that's the daemon's concern).
//
// `snapshot` is plain text trimmed to the last
// TERMINAL_SNAPSHOT_CAP_BYTES of buffer content. `cols`/`rows` let
// us initialise xterm to the user's last-known size on a fresh
// mount, reducing the visual jump FitAddon would otherwise cause.

export interface TerminalState {
  snapshot: string
  cols: number
  rows: number
}

const TERMINAL_SNAPSHOT_CAP_BYTES = 64 * 1024  // ~500 lines of typical output

const terminalCache = new LruCache<TerminalState>()

export function getCachedTerminal(key: string): TerminalState | undefined {
  return terminalCache.get(key)
}

export function setCachedTerminal(key: string, state: TerminalState): void {
  // Cap the snapshot at the byte limit. Keeping the tail preserves
  // "what the user just saw"; the head drops because the daemon-side
  // PTY ring buffer holds the longer scrollback for live reattach
  // within the TTL window.
  const trimmed = state.snapshot.length > TERMINAL_SNAPSHOT_CAP_BYTES
    ? state.snapshot.slice(-TERMINAL_SNAPSHOT_CAP_BYTES)
    : state.snapshot
  terminalCache.set(key, { ...state, snapshot: trimmed })
}

// ── PTY active contexts ──────────────────────────────────────────────────
// Browser-side mirror of which contexts have a live PTY in the
// daemon. XTermPanel.attach flips a key on; the SSE pty_exit event
// (handled in CompanionProvider) flips it off. cacheProtector reads
// this set so a worktree with a long-running build keeps its files /
// hunks / meta / git-status caches warm even if the user moved focus
// to another worktree or closed the right panel. Same pattern as
// `runningSessionIds` in companionStore — a Set that drives the
// uniform "this worktree is still in use" signal across all 5 pontas.

const ptyActiveContexts = new Set<string>()

export function markPtyAttached(contextKey: string): void {
  if (ptyActiveContexts.has(contextKey)) return
  ptyActiveContexts.add(contextKey)
  console.log(`[pty] markPtyAttached ctx=${contextKey.slice(0, 8)} activeCount=${ptyActiveContexts.size}`)
}

export function markPtyExited(contextKey: string): void {
  if (!ptyActiveContexts.has(contextKey)) return
  ptyActiveContexts.delete(contextKey)
  console.log(`[pty] markPtyExited ctx=${contextKey.slice(0, 8)} activeCount=${ptyActiveContexts.size}`)
}

export function isPtyActive(contextKey: string): boolean {
  return ptyActiveContexts.has(contextKey)
}

// ── Per-worktree right-panel metadata ─────────────────────────────────────
// PR draft (title/body the user is composing), live "Current changes"
// summary (regenerated server-side when a PR is open), todos array.
// All three are <3 KB combined and share a single LRU slice keyed by
// worktreeId — they hydrate together when a worktree becomes active and
// expire together when it goes idle.

const worktreeMetaCache = new LruCache<WorktreeMeta>()

export function getCachedMeta(key: string): WorktreeMeta | undefined {
  return worktreeMetaCache.get(key)
}

// Merge-by-default: callers pass only the fields they're populating
// (e.g. just `prDraft` after the GET resolves) and the cache preserves
// every other field already there. Without this every fetch race would
// clobber whichever sibling fetch landed last. Returns the merged value
// for callers that want to inspect the result.
export function setCachedMeta(key: string, partial: Partial<WorktreeMeta>): WorktreeMeta {
  const prev = worktreeMetaCache.get(key) ?? {}
  const next: WorktreeMeta = { ...prev, ...partial }
  worktreeMetaCache.set(key, next)
  return next
}

export function subscribeCachedMeta(key: string, listener: Listener): () => void {
  return worktreeMetaCache.subscribe(key, listener)
}

// ── Per-context git-status cache ──────────────────────────────────────────
// Shared by both useGitStatus consumers (WorkPanel header badge +
// ChecksPanel). When the WorkPanel hook fetches first (it mounts when
// the worktree opens), the result lands here; ChecksPanel's hook seeds
// from the cache on mount and renders the badge / commit buttons in
// the current frame instead of waiting for its own initial fetch to
// resolve. Key follows the same `worktreeId ?? sessionId ?? 'main'`
// shape useGitStatus already encodes into the URL — collisions are
// avoided by the cuid prefix scheme (`wt-…` vs `chat-…`).
//
// `unknown` value type at this layer because the GitStatus shape lives
// in lib/hooks/useGitStatus.ts and importing it here would create a
// hooks→cache→hooks cycle. The hook casts on read.

const gitStatusCache = new LruCache<unknown>()

export function getCachedGitStatus<T>(key: string): T | undefined {
  return gitStatusCache.get(key) as T | undefined
}

export function setCachedGitStatus<T>(key: string, value: T): void {
  // ── DIAG (temp): trace status writes during the "phantom uncommitted"
  // bug. Logs uncommitted count + branch so we can spot suspicious
  // jumps. Remove once the bug is pinned.
  const v = value as unknown as { uncommitted?: number; branch?: string }
  const uncommitted = typeof v?.uncommitted === 'number' ? v.uncommitted : '?'
  console.log(`[cache-diag] setCachedGitStatus key=${key.slice(0, 8)} uncommitted=${uncommitted} branch=${v?.branch ?? '?'}`)
  gitStatusCache.set(key, value as unknown)
}

export function subscribeCachedGitStatus(key: string, listener: Listener): () => void {
  return gitStatusCache.subscribe(key, listener)
}

// ── Per-worktree file-diff hunks cache ────────────────────────────────────
// One slice per worktreeId; inside each slice a Record<filePath, FileDiff>.
// Stores raw content + originalContent (NOT pre-computed hunks) — hunks
// are derived client-side via buildHunksFromContents() at render time so
// the cache stays small and the diff settings (context lines, ignore
// whitespace) can change without invalidating the cache. Heavier than
// the meta cache (1-50 KB per file) but bounded by changed-file count
// per worktree.

const hunksCache = new LruCache<Record<string, FileDiff>>()

export function getCachedHunk(worktreeId: string, filePath: string): FileDiff | undefined {
  const slice = hunksCache.get(worktreeId)
  return slice?.[filePath]
}

export function setCachedHunk(worktreeId: string, filePath: string, diff: FileDiff): void {
  const slice = hunksCache.get(worktreeId) ?? {}
  hunksCache.set(worktreeId, { ...slice, [filePath]: diff })
}

export function subscribeCachedHunks(worktreeId: string, listener: Listener): () => void {
  return hunksCache.subscribe(worktreeId, listener)
}

// Drop hunk entries whose paths landed in a daemon fs-change batch — the
// on-disk content moved, so the cached `content`/`originalContent` is
// stale. Invoked from `markPathsDirty` so a single fs-change event
// invalidates the file-list flag AND the diff cache in one pass. Empty
// slice: leave it (it'll be repopulated by the next prefetch).
//
// Only worktree batches matter here — main has no per-file diff cache
// (it's the read-only base view). For 'project' batches the function
// returns immediately.
function invalidateHunksFromBatch(batch: FsChangeBatch): void {
  if (batch.source !== 'worktrees' || batch.paths.length === 0) return
  // Group affected paths by worktreeId. Each path is `<wtId>/<rel>`.
  const byKey = new Map<string, Set<string>>()
  for (const p of batch.paths) {
    const slash = p.indexOf('/')
    if (slash <= 0) continue
    const key = p.slice(0, slash)
    const rel = p.slice(slash + 1)
    let set = byKey.get(key)
    if (!set) { set = new Set(); byKey.set(key, set) }
    set.add(rel)
  }
  for (const [key, dirtyRel] of byKey) {
    const slice = hunksCache.get(key)
    if (!slice) continue
    let touched = false
    const next: Record<string, FileDiff> = {}
    for (const [path, diff] of Object.entries(slice)) {
      if (dirtyRel.has(path)) { touched = true; continue }
      next[path] = diff
    }
    if (touched) hunksCache.set(key, next)
  }
}

export function getCachedFiles(key: string): FileEntry[] | undefined {
  return filesCache.get(key)
}

export function setCachedFiles(key: string, files: FileEntry[]): void {
  // ── DIAG (temp): logs every files-cache write so we can trace the
  // "all yellow / phantom uncommitted" bug. Look for entries where
  // modified === total or where total spikes suddenly during a
  // workflow. Remove once the bug is pinned.
  const total = files.length
  const modified = files.reduce((n, f) => n + (f.isModified ? 1 : 0), 0)
  console.log(`[cache-diag] setCachedFiles key=${key.slice(0, 8)} total=${total} modified=${modified} suspicious=${total > 0 && modified === total}`)
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
 * Drop every cache slice tied to a worktree id. Used when the worktree's
 * diff baseline shifts (post-merge advance-base): cached file listings,
 * per-file hunks, git status, and meta were computed against the OLD
 * baseCommit and are now stale. Subscribers get notified so the next
 * render refetches with the new baseline.
 */
export function clearWorktreeCache(worktreeId: string): void {
  filesCache.delete(worktreeId)
  hunksCache.delete(worktreeId)
  gitStatusCache.delete(worktreeId)
  worktreeMetaCache.delete(worktreeId)
}

/**
 * Shape of a daemon fs-change batch as it lands on the browser. Mirrors
 * the daemon-side `FsChangeBatch` (see `companion/src/fs-watcher.ts`).
 *
 *   source='project'   → paths are relative to project root
 *                          ex: ['src/foo.tsx', 'README.md']  → cache key 'main'
 *   source='worktrees' → paths are `<worktreeId>/<rel>` (worktrees live
 *                          in `~/.bornastar/worktrees/<projectId>/`)
 *                          ex: ['<wtId>/src/bar.tsx']  → cache key '<wtId>'
 */
export interface FsChangeBatch {
  source: 'project' | 'worktrees'
  paths: string[]
}

/**
 * Map a daemon-emitted batch to the set of cache keys it touches. Used
 * by the global fs-change refresher to keep cached but unviewed
 * worktrees in sync with the disk.
 */
export function parseAffectedCacheKeys(batch: FsChangeBatch): Set<string> {
  if (batch.paths.length === 0) return new Set()
  if (batch.source === 'project') return new Set(['main'])
  const keys = new Set<string>()
  for (const p of batch.paths) {
    const slash = p.indexOf('/')
    if (slash > 0) keys.add(p.slice(0, slash))
  }
  return keys
}

/**
 * Optimistic local update for a daemon fs-change batch. For each input
 * path, find the matching FileEntry inside its cache slice (worktree
 * id or 'main') and flip `isModified: true` if it isn't already. This
 * makes the FileTree yellow badge / Changes-list inclusion appear in
 * the current frame — no network round-trip required. The bg refetch
 * that follows (parseAffectedCacheKeys → /repository/files) reconciles
 * added/removed counts and any add/delete the local guess can't
 * resolve. Files not yet in the cache are skipped: they appear when
 * the bg refetch lands. A path that was actually deleted on disk stays
 * incorrectly flagged here until the refetch removes it from the
 * listing — harmless since the entry vanishes a few hundred ms later.
 *
 * Returns the cache keys that actually changed (caller logs / metrics).
 */
export function markPathsDirty(batch: FsChangeBatch): Set<string> {
  if (batch.paths.length === 0) return new Set()

  // Group input paths by the cache slice they belong to. For 'project'
  // every path lands under 'main'. For 'worktrees' the first segment of
  // each path is the worktreeId; the rest is the path inside that
  // slice's file listing.
  const byKey = new Map<string, Set<string>>()
  if (batch.source === 'project') {
    byKey.set('main', new Set(batch.paths))
  } else {
    for (const p of batch.paths) {
      const slash = p.indexOf('/')
      if (slash <= 0) continue
      const key = p.slice(0, slash)
      const rel = p.slice(slash + 1)
      let set = byKey.get(key)
      if (!set) { set = new Set(); byKey.set(key, set) }
      set.add(rel)
    }
  }

  const changed = new Set<string>()
  for (const [key, dirtyRel] of byKey) {
    const entry = filesCache.get(key)
    if (!entry) continue
    let touched = false
    const next: FileEntry[] = entry.map((f) => {
      if (dirtyRel.has(f.path) && !f.isModified) {
        touched = true
        return { ...f, isModified: true }
      }
      return f
    })
    if (touched) {
      // ── DIAG (temp): log every markPathsDirty write that actually
      // flipped flags. Compare with setCachedFiles modified count
      // right after to see if dirty is escalating beyond the batch.
      const total = next.length
      const modified = next.reduce((n, f) => n + (f.isModified ? 1 : 0), 0)
      console.log(`[cache-diag] markPathsDirty wrote key=${key.slice(0, 8)} batchPaths=${dirtyRel.size} total=${total} modifiedAfter=${modified}`)
      filesCache.set(key, next)
      changed.add(key)
    }
  }
  // Same fs-change batch that flips file-list dirty flags also stales
  // any cached per-file diff — drop them so the next view refetches
  // from disk. Cheap: most batches affect <10 paths.
  invalidateHunksFromBatch(batch)
  return changed
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
  const droppedMeta = worktreeMetaCache.evictIdle(IDLE_EVICTION_MS, protect)
  const droppedHunks = hunksCache.evictIdle(IDLE_EVICTION_MS, protect)
  const droppedStatus = gitStatusCache.evictIdle(IDLE_EVICTION_MS, protect)
  if (droppedFiles.length > 0 || droppedTerminals.length > 0 || droppedMeta.length > 0 || droppedHunks.length > 0 || droppedStatus.length > 0) {
    console.log(
      `[worktree-cache] idle sweep `
      + `files=${droppedFiles.length > 0 ? droppedFiles.map((k) => k.slice(0, 8)).join(',') : '-'} `
      + `terminals=${droppedTerminals.length > 0 ? droppedTerminals.map((k) => k.slice(0, 8)).join(',') : '-'} `
      + `meta=${droppedMeta.length > 0 ? droppedMeta.map((k) => k.slice(0, 8)).join(',') : '-'} `
      + `hunks=${droppedHunks.length > 0 ? droppedHunks.map((k) => k.slice(0, 8)).join(',') : '-'} `
      + `status=${droppedStatus.length > 0 ? droppedStatus.map((k) => k.slice(0, 8)).join(',') : '-'} `
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
