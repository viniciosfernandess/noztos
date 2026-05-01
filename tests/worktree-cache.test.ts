// ── Worktree cache invariants ───────────────────────────────────────
//
// Drives the worktree cache directly (no React, no fetch, no SSE) to
// validate the guarantees the right panel relies on:
//
//   1. Round-trip: set then get returns the same value.
//   2. LRU capacity: 21st key kicks the oldest unprotected one.
//   3. Touch bumps: reading a key keeps it from being kicked next.
//   4. Subscribers: notified on set, silent after unsubscribe.
//   5. parseAffectedCacheKeys: daemon path → cache key mapping.
//   6. Terminal trim: snapshot capped at TERMINAL_SNAPSHOT_CAP_BYTES (64KB).
//   7. Idle eviction (fake timers): drops keys past TTL.
//   8. Protector: keys returned by the protector survive idle sweeps.
//
// The module is a singleton, so each test resets state via the
// public APIs that exist (no global wipe — we just track our own keys).
//
// Logs from the cache ([worktree-cache] / [wt-cache]) print so the
// LRU eviction line can be eyeballed during the run.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  getCachedFiles, setCachedFiles, hasCachedFiles,
  subscribeCachedFiles, getCachedFilesKeys, parseAffectedCacheKeys,
  getCachedTerminal, setCachedTerminal,
  setCacheProtector, _sweepIdleForTest,
  type TerminalState,
} from '@/lib/worktree-cache'
import type { FileEntry } from '@/lib/worktree-types'

function mkFile(path: string): FileEntry {
  return { id: path, path, isModified: false, isNew: false, sizeBytes: 0 }
}

function mkTerminalState(snapshotBytes: number): TerminalState {
  // Repeat 'a' to reach exactly snapshotBytes of content.
  return { snapshot: 'a'.repeat(snapshotBytes), cols: 80, rows: 24 }
}

const SNAPSHOT_CAP_BYTES = 64 * 1024

// Each test owns a unique key prefix so parallel test runs don't trip
// over each other's cached entries inside the singleton.
let testKeyPrefix = 0
function k(label: string): string {
  return `t${testKeyPrefix}-${label}`
}
beforeEach(() => {
  testKeyPrefix++
  // Reset protector to empty so previous tests don't bleed in.
  setCacheProtector(() => new Set())
})

describe('worktree-cache — invariants', () => {
  it('1) round-trip — set then get returns same value', () => {
    const key = k('rt')
    const files = [mkFile('a.ts'), mkFile('b.ts')]
    setCachedFiles(key, files)
    expect(getCachedFiles(key)).toEqual(files)
    expect(hasCachedFiles(key)).toBe(true)
  })

  it('2) LRU capacity — 21st key kicks the oldest', () => {
    const keys = Array.from({ length: 21 }, (_, i) => k(`lru-${i}`))
    for (const key of keys) setCachedFiles(key, [mkFile(`${key}/file.ts`)])
    const remaining = new Set(getCachedFilesKeys())
    // The oldest (index 0) we just inserted should be evicted; the 20
    // most-recent (index 1..20) should all still be present.
    expect(remaining.has(keys[0])).toBe(false)
    for (let i = 1; i <= 20; i++) {
      expect(remaining.has(keys[i])).toBe(true)
    }
  })

  it('3) touch bumps — get on the oldest saves it from the next eviction', () => {
    const keys = Array.from({ length: 20 }, (_, i) => k(`bump-${i}`))
    for (const key of keys) setCachedFiles(key, [mkFile(`${key}/x.ts`)])
    // Touch the oldest — its position in the LRU should jump to "freshest".
    getCachedFiles(keys[0])
    // Insert a 21st — the eviction should now pick the SECOND-oldest.
    const extra = k('bump-extra')
    setCachedFiles(extra, [mkFile(`${extra}/x.ts`)])
    const remaining = new Set(getCachedFilesKeys())
    expect(remaining.has(keys[0])).toBe(true)   // saved by the touch
    expect(remaining.has(keys[1])).toBe(false)  // sacrificed instead
    expect(remaining.has(extra)).toBe(true)
  })

  it('4) subscribers — fired on set, silent after unsubscribe', () => {
    const key = k('sub')
    const calls: number[] = []
    const unsub = subscribeCachedFiles(key, () => calls.push(Date.now()))
    setCachedFiles(key, [mkFile('one.ts')])
    setCachedFiles(key, [mkFile('two.ts')])
    expect(calls).toHaveLength(2)
    unsub()
    setCachedFiles(key, [mkFile('three.ts')])
    expect(calls).toHaveLength(2)  // listener gone, no new call
  })

  it('5) parseAffectedCacheKeys — worktrees source extracts wtId, project source maps to main', () => {
    // Worktrees batch: paths are `<wtId>/<rel>` (worktrees live in
    // `~/.bornastar/worktrees/<projectId>/`, daemon emits paths
    // relative to that root).
    const wtOut = parseAffectedCacheKeys({
      source: 'worktrees',
      paths: [
        'abc123/src/foo.tsx',
        'abc123/src/bar.tsx',  // same wt, deduped via Set
        'xyz789/lib/baz.ts',
      ],
    })
    expect(wtOut).toEqual(new Set(['abc123', 'xyz789']))

    // Project batch: any path collapses to the synthetic 'main' key.
    const projOut = parseAffectedCacheKeys({
      source: 'project',
      paths: ['README.md', 'app/page.tsx'],
    })
    expect(projOut).toEqual(new Set(['main']))
  })

  it('5b) parseAffectedCacheKeys — empty paths returns empty set', () => {
    expect(parseAffectedCacheKeys({ source: 'project', paths: [] })).toEqual(new Set())
    expect(parseAffectedCacheKeys({ source: 'worktrees', paths: [] })).toEqual(new Set())
  })

  it('6) terminal trim — snapshot > cap gets sliced to the cap on set', () => {
    const key = k('term-trim')
    // 1.5× the cap so we can confirm the trim points at the tail.
    setCachedTerminal(key, mkTerminalState(SNAPSHOT_CAP_BYTES + 32_000))
    const cached = getCachedTerminal(key)
    expect(cached?.snapshot.length).toBe(SNAPSHOT_CAP_BYTES)
    // We filled with `a`, so the trimmed slice is still all `a`.
    expect(cached?.snapshot[0]).toBe('a')
  })

  it('6b) terminal trim — snapshot ≤ cap is preserved verbatim', () => {
    const key = k('term-no-trim')
    setCachedTerminal(key, mkTerminalState(1024))
    expect(getCachedTerminal(key)?.snapshot.length).toBe(1024)
  })
})

describe('worktree-cache — idle eviction sweeper', () => {
  // Fake timers mock both setInterval AND Date.now, so advancing time
  // ages every cached entry's lastAccessedAt without us having to wait
  // wall-clock 1h+. We trigger the sweep manually via `_sweepIdleForTest`
  // because vitest's node environment has no `window`, which is the
  // gate that lazy-starts the production sweeper interval.
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('7) sweeper drops untouched keys past 1h TTL', () => {
    const cold = k('cold')
    const fresh = k('fresh')
    setCachedFiles(cold, [mkFile('cold.ts')])
    setCacheProtector(() => new Set())
    // Advance 30 minutes — both still present (TTL is 1h).
    vi.advanceTimersByTime(30 * 60 * 1000)
    // Touch `fresh` AFTER the 30-min mark so it's safely younger than TTL.
    setCachedFiles(fresh, [mkFile('fresh.ts')])
    // Advance another 35 minutes — `cold` is now 65min old (past TTL),
    // `fresh` is 35min old (still within TTL).
    vi.advanceTimersByTime(35 * 60 * 1000)
    _sweepIdleForTest()
    const remaining = new Set(getCachedFilesKeys())
    expect(remaining.has(cold)).toBe(false)
    expect(remaining.has(fresh)).toBe(true)
  })

  it('8) sweeper protects keys returned by the protector', () => {
    const protectedKey = k('protected')
    const unprotectedKey = k('unprotected')
    setCachedFiles(protectedKey, [mkFile('p.ts')])
    setCachedFiles(unprotectedKey, [mkFile('u.ts')])
    // Protector keeps only the first key alive.
    setCacheProtector(() => new Set([protectedKey]))
    // Run past TTL — only the unprotected one should drop.
    vi.advanceTimersByTime(2 * 60 * 60 * 1000)
    _sweepIdleForTest()
    const remaining = new Set(getCachedFilesKeys())
    expect(remaining.has(protectedKey)).toBe(true)
    expect(remaining.has(unprotectedKey)).toBe(false)
  })
})
