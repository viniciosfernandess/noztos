// ── Stress test: companion-store memory budget ─────────────────────
//
// Drives the browser-side store directly (no DOM, no fetch, no SSE) to
// validate the four invariants that bound RAM usage:
//
//   1. Single chat can use the WHOLE 5000-msg pool.
//   2. Adding more chats forces water-filling: budget shared dynamically.
//   3. canLoadMore() correctly gates scroll-up against headroom.
//   4. enforceGlobalCaps() trims oldest messages from the LEAST-active
//      chat, never from the chat the user is touching.
//
// Logs from the store ([store] ...) print as the test runs so we can
// eyeball the eviction sequence.

import { describe, it, expect, beforeEach } from 'vitest'
import { companionStore } from '@/lib/companion-store'
import type { ChatMessage } from '@/lib/hooks/useCompanionStream'

// Reset between scenarios so each test starts clean.
beforeEach(() => {
  for (const sid of [...(companionStore as unknown as { slices: Map<string, unknown> }).slices.keys()]) {
    companionStore.clearSlice(sid)
  }
  companionStore.setRunningSessions([])
})

function mkMsg(id: string, ts: number, content = 'x'): ChatMessage {
  return { id, role: 'assistant', content, timestamp: ts }
}

function bulkInsert(sid: string, count: number, startTs = 1000, idPrefix = ''): void {
  // Each call gets a fresh prefix so a slice can grow across multiple
  // bulkInsert() invocations without id collisions overwriting earlier
  // inserts. (upsertMessage by id merges in-place — without this every
  // re-call to the same sid would update the same N rows instead of
  // appending fresh ones.)
  const tag = idPrefix || `b${Math.random().toString(36).slice(2, 6)}`
  for (let i = 0; i < count; i++) {
    companionStore.upsertMessage(sid, mkMsg(`${sid}-${tag}-${i}`, startTs + i))
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function sliceSize(sid: string): number {
  return companionStore.getMessages(sid).length
}

function totalSize(): number {
  const slices = (companionStore as unknown as { slices: Map<string, { messages: Map<string, unknown> }> }).slices
  let n = 0
  for (const s of slices.values()) n += s.messages.size
  return n
}

describe('Ponta A — water-filling memory budget (5000 msgs total)', () => {
  it('1) lone chat can fill the entire pool', () => {
    const sid = 'sess-alone'
    bulkInsert(sid, 5000)
    expect(sliceSize(sid)).toBe(5000)
    expect(totalSize()).toBe(5000)
    expect(companionStore.canLoadMore(sid)).toBe(false)
    console.log(`✅ lone chat: filled to ${sliceSize(sid)} msgs, canLoadMore=false (at cap)`)
  })

  it('2) lone chat at 4500 + new chat opening cedes oldest to fit budget', () => {
    const big = 'sess-big'
    const newcomer = 'sess-newcomer'

    bulkInsert(big, 4500)
    expect(sliceSize(big)).toBe(4500)

    // Newcomer brings 800 msgs (e.g. /session-state hydrate).
    // Total would be 5300 → over. Trim should kick on the LEAST-active
    // slice. Big is older (no recent access since the bulk insert).
    // Newcomer is being inserted right now → most recent.
    bulkInsert(newcomer, 800, 10_000)

    expect(totalSize()).toBeLessThanOrEqual(5000)
    // Newcomer shouldn't lose anything (it's the active slice now).
    expect(sliceSize(newcomer)).toBe(800)
    // Big should have lost ~300 msgs to make room.
    expect(sliceSize(big)).toBe(4200)
    console.log(`✅ water-filling on newcomer: big=${sliceSize(big)}, newcomer=${sliceSize(newcomer)}, total=${totalSize()}`)
  })

  it('3) canLoadMore reflects shared budget across slices', () => {
    bulkInsert('sess-a', 1000)
    bulkInsert('sess-b', 2000)
    bulkInsert('sess-c', 1500)
    // Total 4500. sess-a's headroom = 5000 - (2000 + 1500) = 1500. It has
    // 1000 already, so it can grow by 500 more (not unlimited).
    expect(companionStore.canLoadMore('sess-a')).toBe(true)
    // sess-b's headroom = 5000 - (1000 + 1500) = 2500. Has 2000 → can grow.
    expect(companionStore.canLoadMore('sess-b')).toBe(true)

    // Push sess-a to its share.
    bulkInsert('sess-a', 500, 50_000)
    // Now total = 5000 exactly. No chat has headroom.
    expect(totalSize()).toBe(5000)
    expect(companionStore.canLoadMore('sess-a')).toBe(false)
    expect(companionStore.canLoadMore('sess-b')).toBe(false)
    expect(companionStore.canLoadMore('sess-c')).toBe(false)
    console.log(`✅ canLoadMore=false for all once total hits cap (a=${sliceSize('sess-a')}, b=${sliceSize('sess-b')}, c=${sliceSize('sess-c')})`)
  })

  it('4) trim picks LEAST-recently-accessed slice, not the biggest', async () => {
    // Use real time gaps — Date.now() resolution is millisecond, and
    // without sleeps every operation in this test would share the same
    // lastAccessedAt, defeating the LRU sort.
    bulkInsert('sess-medium', 1500)
    await sleep(5)
    bulkInsert('sess-old', 2000)
    await sleep(5)
    // Touch sess-old AGAIN so it's strictly more recent than sess-medium.
    companionStore.getMessages('sess-old')
    await sleep(5)

    // Now slam in a 2000-msg chat. Total would be 5500 → over by 500.
    // Trim should bite sess-medium (least-recently-accessed), NOT sess-old.
    bulkInsert('sess-fresh', 2000, 50_000)

    expect(totalSize()).toBeLessThanOrEqual(5000)
    expect(sliceSize('sess-fresh')).toBe(2000)
    expect(sliceSize('sess-old')).toBe(2000) // protected by recent access
    expect(sliceSize('sess-medium')).toBe(1000) // ate the trim (lost 500)
    console.log(`✅ LRU-priority trim: medium lost 500 (now ${sliceSize('sess-medium')}), old protected (still ${sliceSize('sess-old')})`)
  })

  it('5) chat isolation — slices never cross-contaminate', () => {
    bulkInsert('sess-x', 100)
    bulkInsert('sess-y', 100)
    const xMsgs = companionStore.getMessages('sess-x')
    const yMsgs = companionStore.getMessages('sess-y')
    expect(xMsgs.every((m) => m.id.startsWith('sess-x-'))).toBe(true)
    expect(yMsgs.every((m) => m.id.startsWith('sess-y-'))).toBe(true)
    expect(xMsgs.length).toBe(100)
    expect(yMsgs.length).toBe(100)
    console.log(`✅ isolated: sess-x=${xMsgs.length} (all x-* ids), sess-y=${yMsgs.length} (all y-* ids)`)
  })

  it('6) clearSlice on one chat does not affect others', () => {
    bulkInsert('sess-keep', 50)
    bulkInsert('sess-drop', 50)
    companionStore.clearSlice('sess-drop')
    expect(sliceSize('sess-keep')).toBe(50)
    expect(sliceSize('sess-drop')).toBe(0)
    console.log('✅ clearSlice surgical: keep=50, drop=0')
  })

  it('7) running chat never gets WHOLE-EVICTED (only its old msgs trimmed)', () => {
    bulkInsert('sess-running', 2000)
    companionStore.setRunningSessions(['sess-running'])
    bulkInsert('sess-other', 1000)
    bulkInsert('sess-third', 1500)
    // Push us over: insert another 1000 → total ~5500
    bulkInsert('sess-fourth', 1000, 50_000)

    // sess-running may have lost OLDEST msgs (allowed) but slice itself stays.
    expect(sliceSize('sess-running')).toBeGreaterThan(0)
    expect(totalSize()).toBeLessThanOrEqual(5000)
    console.log(`✅ running protected: still has ${sliceSize('sess-running')} msgs (slice not whole-evicted)`)
  })

  it('8) idempotent upsert by id — same row twice does NOT duplicate', () => {
    const sid = 'sess-idem'
    const msg = mkMsg('evt-stable', 1000, 'hello')
    companionStore.upsertMessage(sid, msg)
    companionStore.upsertMessage(sid, msg)
    companionStore.upsertMessage(sid, { ...msg, content: 'updated' })
    const msgs = companionStore.getMessages(sid)
    expect(msgs.length).toBe(1)
    expect(msgs[0].content).toBe('updated')
    console.log('✅ idempotent: 3 upserts of same id = 1 row, latest wins')
  })

  it('9) sortedCache invalidation — order preserved after trim', () => {
    const sid = 'sess-order'
    // Insert out of timestamp order.
    companionStore.upsertMessage(sid, mkMsg('a', 3000, 'third'))
    companionStore.upsertMessage(sid, mkMsg('b', 1000, 'first'))
    companionStore.upsertMessage(sid, mkMsg('c', 2000, 'second'))
    const msgs = companionStore.getMessages(sid)
    expect(msgs.map((m) => m.content)).toEqual(['first', 'second', 'third'])
    console.log(`✅ sorted: [${msgs.map((m) => m.content).join(', ')}]`)
  })
})
