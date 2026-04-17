import { NextRequest, NextResponse } from 'next/server'
import { verifyAuth } from '@/lib/auth'
import { getChannel } from '@/lib/companion-relay'

// POST — Companion sends Claude Code stream-json events back to the
// server. These get queued in the relay and pushed to the browser via
// the SSE stream at /api/companion/stream.
//
// Body: { events: ClaudeStreamEvent[] } (batched for efficiency) or
//       { event: ClaudeStreamEvent } (single event for low-latency)
export async function POST(request: NextRequest) {
  const auth = await verifyAuth(request)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const channel = getChannel(auth.userId)

  // Accept both single event and batch
  if (body.events && Array.isArray(body.events)) {
    for (const event of body.events) {
      channel.pushEvent(event)
    }
  } else if (body.event) {
    channel.pushEvent(body.event)
  } else if (body.type) {
    // Entire body IS the event (compact format)
    channel.pushEvent(body)
  }

  // Also update heartbeat
  channel.heartbeat()

  return NextResponse.json({ ok: true })
}
