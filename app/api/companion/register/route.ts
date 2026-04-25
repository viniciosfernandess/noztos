import { NextRequest, NextResponse } from 'next/server'
import { verifyAuth } from '@/lib/auth'
import { getChannel } from '@/lib/companion-relay'

// POST — Companion daemon registers itself. Sends auth info (Claude
// version, email, plan) and project list. Server marks the user's
// relay channel as "companion connected" so the browser knows.
export async function POST(request: NextRequest) {
  const auth = await verifyAuth(request)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const { authInfo, projects, machineName } = body as {
    authInfo?: { email?: string; plan?: string; version?: string }
    projects?: Array<{ id: string; path: string; name: string }>
    machineName?: string
  }

  const channel = getChannel(auth.userId)
  const wasConnected = channel.isCompanionConnected()
  // Snapshot the prior authInfo so we can detect meaningful change
  // (e.g. user ran `claude login`, plan went from undefined → 'max').
  // Without this, plan-change events only propagate after a full
  // disconnect/reconnect cycle.
  const prior = wasConnected ? channel.companion?.authInfo : undefined
  channel.setCompanionConnected(authInfo, auth.tokenId, machineName ?? auth.tokenName)
  if (projects) {
    if (channel.companion) channel.companion.projects = projects
  }

  const authChanged = !wasConnected
    || prior?.email !== authInfo?.email
    || prior?.plan !== authInfo?.plan
    || prior?.version !== authInfo?.version

  // Only broadcast companion_status when something *actually changed*
  // — a heartbeat with identical authInfo doesn't warrant waking every
  // SSE listener. New browser tabs still get their initial status from
  // the SSE handshake in stream/route.ts regardless.
  if (authChanged) {
    console.log(`[register] broadcast status userId=${auth.userId.slice(0, 8)} wasConnected=${wasConnected} plan=${authInfo?.plan ?? '-'}`)
    channel.pushEvent({
      type: 'companion_status',
      connected: true,
      authInfo,
      projects: channel.companion?.projects,
      machineName: channel.companion?.machineName,
    }, auth.userId)
  }

  return NextResponse.json({
    ok: true,
    message: 'Companion registered',
    pendingCommands: channel.drainCommands().length,
  })
}

// DELETE — Companion disconnects gracefully. Broadcasts disconnected
// status + empty running list so open browser tabs flip to offline
// state without waiting for the heartbeat sweeper.
export async function DELETE(request: NextRequest) {
  const auth = await verifyAuth(request)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const channel = getChannel(auth.userId)
  channel.setCompanionDisconnected()
  channel.pushEvent({ type: 'companion_status', connected: false }, auth.userId)
  channel.pushEvent({ type: 'running_sessions', payload: { sessionIds: [] } }, auth.userId)
  console.log(`[register] companion graceful disconnect userId=${auth.userId.slice(0, 8)}`)
  return NextResponse.json({ ok: true })
}
