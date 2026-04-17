import { NextRequest, NextResponse } from 'next/server'
import { verifyAuth } from '@/lib/auth'
import { getChannel, getCompanionStatus } from '@/lib/companion-relay'

// POST — Browser sends a command to the companion daemon. Supported
// commands: prompt, interrupt, status, clone, create_project.
//
// The command gets queued in the relay and delivered to the companion
// via the SSE stream at /api/companion/events.
//
// If the companion is not connected, returns an error so the browser
// can show "Companion offline — start it with `bornastar start`".
export async function POST(request: NextRequest) {
  const auth = await verifyAuth(request)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const status = getCompanionStatus(auth.userId)
  if (!status.connected) {
    return NextResponse.json({
      error: 'Companion not connected',
      message: 'Start the Bornastar companion on your machine: `bornastar start`',
    }, { status: 503 })
  }

  const body = await request.json()
  const { type, projectId, prompt, sessionId, repoUrl, targetPath, template } = body as {
    type: string
    projectId?: string
    prompt?: string
    sessionId?: string
    repoUrl?: string
    targetPath?: string
    template?: string
  }

  if (!type) {
    return NextResponse.json({ error: 'Missing command type' }, { status: 400 })
  }

  const channel = getChannel(auth.userId)
  channel.pushCommand({
    type,
    projectId,
    prompt,
    sessionId,
    repoUrl,
    targetPath,
    template,
    timestamp: Date.now(),
  })

  return NextResponse.json({ ok: true, queued: true })
}
