import { after, NextRequest, NextResponse } from 'next/server'
import { verifyAuth } from '@/lib/auth'
import { getChannel } from '@/lib/companion-relay'
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

  for (const frame of frames) {
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
    for (const frame of frames) {
      await writeThrough(frame, auth.userId)
    }
  })

  return NextResponse.json({ ok: true })
}

interface RelayFrame {
  type?: string
  payload?: {
    bornastarSessionId?: string
    projectId?: string
    persistRows?: PersistRow[]
  }
}

async function writeThrough(frame: unknown, userId: string): Promise<void> {
  const f = frame as RelayFrame | null
  if (!f || f.type !== 'claude_event') return
  const rows = f.payload?.persistRows
  if (!rows || rows.length === 0) return
  const sessionId = f.payload?.bornastarSessionId
  const projectId = f.payload?.projectId
  if (!sessionId || !projectId) return

  try {
    const ctx = await loadSessionContext(sessionId, projectId, userId)
    if (!ctx) return
    await persistRows(rows, ctx)
  } catch (err) {
    // Non-fatal — the daemon queue will cover us. Log for observability.
    console.warn('[write-through] failed:', (err as Error).message)
  }
}
