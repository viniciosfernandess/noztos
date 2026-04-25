import type { SyncQueue, QueuedEvent } from './sync-queue.js'

// ── Sync worker ───────────────────────────────────────────────────────
//
// Drains the persistent queue into the Bornastar server. Event-driven:
// the daemon signals `wake()` after an enqueue and the worker schedules
// a flush after a short debounce so burst writes collapse into one
// HTTP round-trip. On success the rows are marked synced; on failure
// they stay pending with an exponential back-off.
//
// Design decisions:
//   • Debounce 250ms — catches Claude's token bursts.
//   • `flushNow()` skips the debounce (called at end-of-turn / shutdown).
//   • Batch size capped so a long-idle queue doesn't blow one request.
//   • Only ONE in-flight request at a time. If events arrive while a
//     flush is running the worker re-runs when it completes.
//   • Catches thrown errors and backs off the failed batch. Never
//     throws out of wake().

const DEBOUNCE_MS = 250
const BATCH_SIZE = 50
const VACUUM_EVERY_MS = 15 * 60_000  // prune synced rows every 15 min

export interface SyncWorkerOptions {
  queue: SyncQueue
  send: (events: QueuedEvent[]) => Promise<{ ok: boolean }>
}

export class SyncWorker {
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private pendingWake = false
  private stopped = false
  private vacuumTimer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly opts: SyncWorkerOptions) {}

  start(): void {
    this.stopped = false
    // Drain whatever was left by a previous daemon session.
    if (this.opts.queue.pendingCount() > 0) this.wake()
    this.vacuumTimer = setInterval(() => {
      try { this.opts.queue.vacuumSynced() } catch { /* ignore */ }
    }, VACUUM_EVERY_MS)
    this.vacuumTimer.unref?.()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    if (this.vacuumTimer) { clearInterval(this.vacuumTimer); this.vacuumTimer = null }
  }

  // Event-driven trigger. Call this whenever a new event is enqueued.
  // Schedules a flush after DEBOUNCE_MS (coalesces bursts).
  wake(): void {
    if (this.stopped) return
    if (this.running) { this.pendingWake = true; return }
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.drain().catch(() => { /* drain already swallows errors */ })
    }, DEBOUNCE_MS)
  }

  // Flush immediately, skipping debounce. Used at the end of a turn
  // (so the cloud catches up promptly) and on shutdown.
  async flushNow(): Promise<void> {
    if (this.stopped) return
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    await this.drain()
  }

  private async drain(): Promise<void> {
    if (this.running) { this.pendingWake = true; return }
    this.running = true
    const started = Date.now()
    let batchesOk = 0
    let batchesFail = 0
    try {
      // Drain in a loop so we don't leave ready rows sitting when a
      // single batch was bigger than BATCH_SIZE. Bail after a handful
      // of iterations to yield the event loop.
      for (let i = 0; i < 20; i++) {
        const batch = this.opts.queue.peek(BATCH_SIZE)
        if (batch.length === 0) break
        const pendingBefore = this.opts.queue.pendingCount()
        // Oldest row in the batch tells us how long it sat queued —
        // high values here mean the write-through is falling behind
        // and the queue is the real path to durability.
        const oldestAt = Math.min(...batch.map((e) => e.createdAt ?? Date.now()))
        const ageMs = Date.now() - oldestAt
        console.log(`[sync-worker] sending batch=${batch.length} pending=${pendingBefore} oldest=${ageMs}ms`)
        const tSend = Date.now()
        let result: { ok: boolean }
        try {
          result = await this.opts.send(batch)
        } catch (err) {
          console.warn('[sync-worker] send threw:', (err as Error).message)
          result = { ok: false }
        }
        const sendMs = Date.now() - tSend
        if (result.ok) {
          this.opts.queue.ack(batch.map((e) => e.id))
          batchesOk++
          console.log(`[sync-worker] ack batch=${batch.length} sendMs=${sendMs} pending=${this.opts.queue.pendingCount()}`)
        } else {
          this.opts.queue.nack(batch.map((e) => e.id))
          batchesFail++
          console.warn(`[sync-worker] nack batch=${batch.length} sendMs=${sendMs}, backing off`)
          // Stop draining on failure — further batches will hit the
          // same problem. The next `wake()` (by enqueue or backoff
          // re-trigger) will retry.
          break
        }
      }
    } finally {
      this.running = false
      const elapsed = Date.now() - started
      if (batchesOk + batchesFail > 0) {
        console.log(`[sync-worker] drain done ok=${batchesOk} fail=${batchesFail} elapsed=${elapsed}ms pendingLeft=${this.opts.queue.pendingCount()}`)
      }
      if (this.pendingWake) {
        this.pendingWake = false
        this.wake()
      }
    }
  }
}
