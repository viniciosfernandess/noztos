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
  const { authInfo, projects } = body as {
    authInfo?: { email?: string; plan?: string; version?: string }
    projects?: Array<{ id: string; path: string; name: string }>
  }

  const channel = getChannel(auth.userId)
  channel.setCompanionConnected(authInfo)
  if (projects) {
    if (channel.companion) channel.companion.projects = projects
  }

  return NextResponse.json({
    ok: true,
    message: 'Companion registered',
    pendingCommands: channel.drainCommands().length,
  })
}

// DELETE — Companion disconnects gracefully.
export async function DELETE(request: NextRequest) {
  const auth = await verifyAuth(request)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  getChannel(auth.userId).setCompanionDisconnected()
  return NextResponse.json({ ok: true })
}
