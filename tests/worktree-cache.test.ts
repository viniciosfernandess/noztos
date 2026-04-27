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
//   6. Terminal trim: history capped at TERMINAL_HISTORY_LIMIT (500).
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

function mkTerminalState(historyLines: number): TerminalState {
  const history = Array.from({ length: historyLines }, (_, i) => ({
    type: 'stdout' as const,
    text: `line-${i}`,
  }))
  return { history, input: '', commandHistory: [], sandboxStatus: 'running' }
}

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

  it('5) parseAffectedCacheKeys — worktree paths map to id, others to main', () => {
    const out = parseAffectedCacheKeys([
      '.bornastar-worktrees/abc123/src/foo.tsx',
      '.bornastar-worktrees/abc123/src/bar.tsx',  // same wt, deduped
      '.bornastar-worktrees/xyz789/lib/baz.ts',
      'README.md',                                  // main
      'app/page.tsx',                                // main
    ])
    expect(out).toEqual(new Set(['abc123', 'xyz789', 'main']))
  })

  it('5b) parseAffectedCacheKeys — empty paths returns empty set', () => {
    expect(parseAffectedCacheKeys([])).toEqual(new Set())
  })

  it('6) terminal trim — history > 500 gets sliced to last 500 on set', () => {
    const key = k('term-trim')
    setCachedTerminal(key, mkTerminalState(750))
    const cached = getCachedTerminal(key)
    expect(cached?.history).toHaveLength(500)
    // Trim keeps the TAIL (most recent), so first cached line is line-250.
    expect(cached?.history[0].text).toBe('line-250')
    expect(cached?.history[499].text).toBe('line-749')
  })

  it('6b) terminal trim — history ≤ 500 is preserved verbatim', () => {
    const key = k('term-no-trim')
    setCachedTerminal(key, mkTerminalState(100))
    expect(getCachedTerminal(key)?.history).toHaveLength(100)
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
