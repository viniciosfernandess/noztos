import Database from 'better-sqlite3'
import type { Database as DB } from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

// ── Persistent sync queue ─────────────────────────────────────────────
//
// A SQLite queue on disk (~/.bornastar/queue.db) that holds every
// ChatMessage-shaped event the daemon needs to mirror into Supabase.
// The queue survives daemon restarts, browser closes, network outages
// and Mac sleep — as long as the Mac is on, a sync worker drains it.
//
// Rows progress through three states:
//   status='pending'  → not yet sent
//   status='synced'   → acked by the server (kept briefly for debug,
//                       trimmed by the vacuum sweep below)
// Retries stay `pending` with an incremented `retryCount` and a later
// `retryAt` so the worker respects exponential backoff.

const DB_PATH = join(homedir(), '.bornastar', 'queue.db')
const SCHEMA = `
CREATE TABLE IF NOT EXISTS pending_events (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  project_id    TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  payload       TEXT NOT NULL,           -- JSON-serialised event body
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending | synced
  created_at    INTEGER NOT NULL,        -- unix ms, producer timestamp
  retry_at      INTEGER NOT NULL DEFAULT 0,
  retry_count   INTEGER NOT NULL DEFAULT 0,
  synced_at     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_pending_ready
  ON pending_events (status, retry_at);

CREATE INDEX IF NOT EXISTS idx_pending_session
  ON pending_events (session_id, created_at);

CREATE TABLE IF NOT EXISTS queue_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`

// Row shape that reaches the worker + the server endpoint.
export interface QueuedEvent {
  id: string
  sessionId: string
  projectId: string
  userId: string
  payload: Record<string, unknown>
  createdAt: number
}

export class SyncQueue {
  private db: DB

  constructor(path = DB_PATH) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path)
    // WAL gives us async-style durability with cheap writes — readers
    // never block writers, perfect for the "stream events in, flush in
    // the background" pattern.
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.db.exec(SCHEMA)
  }

  // Insert an event. Idempotent — a second call with the same id does
  // an upsert so a retry or race doesn't duplicate the row.
  enqueue(event: QueuedEvent): void {
    const stmt = this.db.prepare(`
      INSERT INTO pending_events
        (id, session_id, project_id, user_id, payload, status, created_at, retry_at, retry_count)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, 0, 0)
      ON CONFLICT(id) DO UPDATE SET
        payload = excluded.payload,
        status = CASE WHEN status = 'synced' THEN 'synced' ELSE 'pending' END,
        created_at = excluded.created_at
    `)
    stmt.run(
      event.id,
      event.sessionId,
      event.projectId,
      event.userId,
      JSON.stringify(event.payload),
      event.createdAt,
    )
  }

  // Pull a batch of events that are ready to send (pending and not
  // back-off'd). Ordered by `created_at` so the remote sees the same
  // chronology the user saw locally.
  peek(limit: number): QueuedEvent[] {
    const now = Date.now()
    const rows = this.db.prepare(`
      SELECT id, session_id AS sessionId, project_id AS projectId,
             user_id AS userId, payload, created_at AS createdAt
      FROM pending_events
      WHERE status = 'pending' AND retry_at <= ?
      ORDER BY created_at ASC
      LIMIT ?
    `).all(now, limit) as Array<Omit<QueuedEvent, 'payload'> & { payload: string }>
    return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) }))
  }

  // Server acknowledged this batch — mark the rows synced. We keep the
  // row around for an hour so we can audit / replay; the vacuum call
  // trims older ones.
  ack(ids: string[]): void {
    if (ids.length === 0) return
    const now = Date.now()
    const placeholders = ids.map(() => '?').join(',')
    this.db.prepare(`
      UPDATE pending_events
      SET status = 'synced', synced_at = ?
      WHERE id IN (${placeholders})
    `).run(now, ...ids)
  }

  // Server rejected or network failed — bump retry count + schedule a
  // back-off. After MAX_RETRIES we park the row but still leave it
  // pending so a human can investigate.
  nack(ids: string[]): void {
    if (ids.length === 0) return
    const now = Date.now()
    const placeholders = ids.map(() => '?').join(',')
    // Backoff: 0.5s, 1s, 2s, 4s, 8s … capped at 60s.
    this.db.prepare(`
      UPDATE pending_events
      SET retry_count = retry_count + 1,
          retry_at = ? + MIN(60000, (1 << MIN(retry_count, 7)) * 500)
      WHERE id IN (${placeholders})
    `).run(now, ...ids)
  }

  // How many events are still waiting (pending + currently eligible or
  // backed-off). Used by the worker to decide whether to sleep or loop.
  pendingCount(): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) as c FROM pending_events WHERE status = 'pending'
    `).get() as { c: number }
    return row.c
  }

  // Remove old synced rows so the DB doesn't grow forever. Called
  // periodically from the worker.
  vacuumSynced(olderThanMs: number = 60 * 60_000): void {
    const cutoff = Date.now() - olderThanMs
    this.db.prepare(`
      DELETE FROM pending_events
      WHERE status = 'synced' AND synced_at < ?
    `).run(cutoff)
  }

  close(): void {
    this.db.close()
  }
}
