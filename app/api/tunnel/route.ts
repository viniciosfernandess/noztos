import { NextRequest, NextResponse } from 'next/server'
import { verifyAuth } from '@/lib/auth'
import { getChannel, getCompanionStatus } from '@/lib/companion-relay'
import { getTunnelState } from '@/lib/tunnel-state'

// ── Cloudflare quick-tunnel control plane ──────────────────────────
//
// Powers the "Phone access" button in the navbar. Zero setup — no
// Cloudflare account, domain, or token. The daemon spawns
// `cloudflared tunnel --url http://localhost:3000` and reports the
// resulting random *.trycloudflare.com URL via SSE.
//
// Endpoints:
//   GET  → returns the cached tunnel state (mirrored from daemon
//          broadcasts in /api/companion/response).
//   POST { action: 'start' | 'stop' } → forwards a tunnel_start /
//          tunnel_stop command to the daemon.

export async function GET(request: NextRequest) {
  const auth = await verifyAuth(request)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  return NextResponse.json({
    status: getTunnelState(),
  })
}

export async function POST(request: NextRequest) {
  const auth = await verifyAuth(request)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const status = getCompanionStatus(auth.userId)
  if (!status.connected) {
    return NextResponse.json({ error: 'Companion not connected' }, { status: 503 })
  }

  const body = await request.json().catch(() => ({})) as { action?: string }
  if (body.action !== 'start' && body.action !== 'stop') {
    return NextResponse.json({ error: 'action must be "start" or "stop"' }, { status: 400 })
  }

  const channel = getChannel(auth.userId)

  if (body.action === 'start') {
    // Always tunnel against the local Next.js dev server. If someone
    // ever runs noztos behind a different port, this is the only line
    // to touch — env-driven override would be a one-liner.
    channel.pushCommand({
      type: 'tunnel_start',
      localUrl: 'http://localhost:3000',
      timestamp: Date.now(),
    })
  } else {
    channel.pushCommand({
      type: 'tunnel_stop',
      timestamp: Date.now(),
    })
  }

  return NextResponse.json({ ok: true })
}
