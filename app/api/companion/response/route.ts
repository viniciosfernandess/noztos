import { after, NextRequest, NextResponse } from 'next/server'
import { verifyAuth } from '@/lib/auth'
import { getChannel } from '@/lib/companion-relay'
import { setTunnelState, type TunnelState } from '@/lib/tunnel-state'
import { loadSessionContext, persistRows, type PersistRow } from '@/lib/chat-persist'

// POST — Companion sends Claude Code stream-json events back to the
// server. These get queued in the relay and pushed to the browser via
// the SSE stream at /api/companion/stream.
//
// Body: { events: ClaudeStreamEvent[] } (batched for efficiency) or
//       { event: ClaudeStreamEvent } (single event for low-latency).
//
// Write-through to Supabase:
//   When an event carries `payload.persistRows` (added by the daemon
//   with stable ids), we fire an upsert in the background — browsers
//   get the SSE frame first, Supabase catches up within a few hundred
//   milliseconds. The daemon's own SQLite queue is the durable retry
//   path; this write-through is the fast one for Realtime fan-out.
export async function POST(request: NextRequest) {
  const auth = await verifyAuth(request)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { events?: unknown[]; event?: unknown; type?: string }
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'Bad JSON' }, { status: 400 })
  }
  const channel = getChannel(auth.userId)

  const frames: unknown[] = []
  if (body.events && Array.isArray(body.events)) {
    frames.push(...body.events)
  } else if (body.event) {
    frames.push(body.event)
  } else if (body.type) {
    // Entire body IS the event (compact format).
    frames.push(body)
  }

  const bodyShape = body.events ? 'events[]' : body.event ? 'event' : body.type ? 'inline' : 'unknown'
  console.log(`[response] received shape=${bodyShape} frames=${frames.length}`)

  for (const frame of frames) {
    // Mirror daemon's tunnel state into the server-side cache so
    // GET /api/tunnel can respond synchronously. The frame still
    // gets relayed to the browser (so SSE listeners update live)
    // — we just record an extra copy here.
    const f = frame as { type?: string; payload?: TunnelState }
    if (f?.type === 'tunnel_status' && f.payload) {
      setTunnelState(f.payload)
    }
    channel.pushEvent(frame, auth.userId)
  }

  // Heartbeat update comes first so connection status stays fresh even
  // if the write-through pipeline queues up.
  channel.heartbeat()

  // after() keeps the background writes alive past the response in
  // serverless runtimes. In long-running Node it's equivalent to firing
  // a Promise; either way the daemon gets its 200 immediately and the
  // stream SSE relay (synchronous above) never waits on Supabase.
  after(async () => {
    const tAfter = Date.now()
    console.log(`[response] after() running, frames=${frames.length}`)
    // Parallel write-through: fire all frames at once. Each upsert
    // takes a Postgres advisory lock keyed on its own sessionId, so
    // frames belonging to the same chat still serialise inside the DB
    // (preserving order + dedup) while frames from different chats
    // truly parallelise. With a single frame this is identical to the
    // old sequential await; with N frames it cuts wall-clock to the
    // slowest single write instead of the sum.
    await Promise.all(frames.map((frame) => writeThrough(frame, auth.userId)))
    console.log(`[response] after() done elapsed=${Date.now() - tAfter}ms frames=${frames.length}`)
  })

  return NextResponse.json({ ok: true })
}

interface RelayFrame {
  type?: string
  payload?: {
    bornastarSessionId?: string
    persistRows?: PersistRow[]
  }
}

async function writeThrough(frame: unknown, userId: string): Promise<void> {
  const f = frame as RelayFrame | null
  if (!f || f.type !== 'claude_event') {
    console.log(`[write-through] skip: type=${f?.type ?? 'null'}`)
    return
  }
  const rows = f.payload?.persistRows
  if (!rows || rows.length === 0) {
    console.log('[write-through] skip: no persistRows in payload')
    return
  }
  const sessionId = f.payload?.bornastarSessionId
  if (!sessionId) {
    console.log('[write-through] skip: missing bornastarSessionId')
    return
  }

  const tStart = Date.now()
  try {
    const tCtx = Date.now()
    const ctx = await loadSessionContext(sessionId, userId)
    const ctxMs = Date.now() - tCtx
    if (!ctx) {
      console.warn(`[write-through] skip: loadSessionContext returned null for sessionId=${sessionId.slice(0, 8)} ctxMs=${ctxMs}`)
      return
    }
    const tPersist = Date.now()
    await persistRows(rows, ctx)
    const persistMs = Date.now() - tPersist
    const totalMs = Date.now() - tStart
    console.log(
      `[write-through] ok sessionId=${sessionId.slice(0, 8)} rows=${rows.length} `
      + `ctx=${ctxMs}ms persist=${persistMs}ms total=${totalMs}ms`,
    )
  } catch (err) {
    const totalMs = Date.now() - tStart
    // Non-fatal — the daemon queue will cover us. Log for observability.
    console.warn(
      `[write-through] failed sessionId=${sessionId.slice(0, 8)} elapsed=${totalMs}ms:`,
      (err as Error).message,
    )
  }
}
