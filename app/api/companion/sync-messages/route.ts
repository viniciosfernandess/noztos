import { NextRequest, NextResponse } from 'next/server'
import { verifyAuth } from '@/lib/auth'
import { loadSessionContext, persistRows, type PersistRow } from '@/lib/chat-persist'
import { getChannel } from '@/lib/companion-relay'

// POST — Companion daemon flushes a batch of ChatMessage-shaped rows
// from its local SQLite queue into Supabase. Each row carries its
// sessionId + projectId from the queue; this handler resolves the
// authenticated user from the bearer token (cached in auth.ts), does a
// single round trip for all rows and updates the session rollup once.
//
// Idempotent: rows are upserted by id, so a retry landing twice is
// harmless. The daemon marks the batch synced on a 200; any non-2xx
// leaves the queue untouched for the next backoff attempt.
//
// Note: for events that are still flowing through the relay we also
// write-through from /api/companion/response so Supabase sees them
// within seconds. This endpoint remains the durable safety net — if
// write-through fails (network flake, dead server, Realtime fan-out
// lag), the daemon's periodic flush covers it. Upsert by stable id
// guarantees the two paths never duplicate rows.
export async function POST(request: NextRequest) {
  const auth = await verifyAuth(request)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { events?: IncomingEvent[] }
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Bad JSON' }, { status: 400 }) }

  const events = body.events ?? []
  if (events.length === 0) return NextResponse.json({ ok: true, saved: 0 })

  // Group by sessionId so the session-level rollup update runs once
  // per session, not once per row. The daemon tags each event with its
  // own hex projectId which is unrelated to the DB cuid — we ignore it
  // here and let loadSessionContext derive the real projectId from the
  // ChatSession row.
  const bySession = new Map<string, IncomingEvent[]>()
  for (const e of events) {
    if (!e.sessionId) continue
    const bucket = bySession.get(e.sessionId)
    if (bucket) bucket.push(e)
    else bySession.set(e.sessionId, [e])
  }

  try {
    const channel = getChannel(auth.userId)
    for (const [sessionId, group] of bySession) {
      const ctx = await loadSessionContext(sessionId, auth.userId)
      if (!ctx) continue
      const rows: PersistRow[] = group.map(toPersistRow)
      await persistRows(rows, ctx)

      // Symmetry with the live /response path: the daemon's drain is
      // catching us up on rows generated during a network gap. Without
      // this push the rows live ONLY in Supabase — ring buffer and SSE
      // never see them, so any browser tab that's still showing a
      // spinner from before the gap stays stuck. Wrapping each row as
      // a persist-only claude_event lets the relay treat them like any
      // other late frame: ring captures, SSE fans out, store dedups by
      // id. The daemon's original timestamps preserve chronological
      // order in the visible chat.
      channel.pushEvent({
        type: 'claude_event',
        payload: {
          bornastarSessionId: sessionId,
          persistRows: rows,
        },
      }, auth.userId)
      console.log(`[sync-messages] replayed ${rows.length} row(s) into ring + SSE for sessionId=${sessionId.slice(0, 8)}`)
    }
    return NextResponse.json({ ok: true, saved: events.length })
  } catch (err) {
    console.error('[sync-messages] error:', err)
    return NextResponse.json({ error: 'Persist failed' }, { status: 500 })
  }
}

// The daemon spreads row fields across the top level of each event in
// the batch body. Normalise to PersistRow shape before handing off.
interface IncomingEvent extends PersistRow {
  sessionId: string
  projectId?: string
}

function toPersistRow(e: IncomingEvent): PersistRow {
  // Strip the routing keys; rest is already PersistRow-shaped because
  // the daemon serialises the row payload at the top level of each
  // batch entry.
  const rest = { ...e } as Partial<IncomingEvent>
  delete rest.sessionId
  delete rest.projectId
  return rest as PersistRow
}
