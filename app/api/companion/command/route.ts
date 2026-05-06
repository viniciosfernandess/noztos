import { NextRequest, NextResponse } from 'next/server'
import { verifyAuth } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { getChannel, getCompanionStatus } from '@/lib/companion-relay'

// POST — Browser sends a command to the companion daemon. Supported
// commands: prompt, interrupt, status, clone, create_project.
//
// The command gets queued in the relay and delivered to the companion
// via the SSE stream at /api/companion/events.
//
// If the companion is not connected, returns an error so the browser
// can surface the offline state. The send button + banner already
// convey this visually; the response message is a fallback for
// callers that don't subscribe to the store (curl tests, etc).
export async function POST(request: NextRequest) {
  const auth = await verifyAuth(request)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const status = getCompanionStatus(auth.userId)
  if (!status.connected) {
    return NextResponse.json({
      error: 'Companion not connected',
      message: 'Local offline. Reconnect to continue.',
    }, { status: 503 })
  }

  const body = await request.json()
  const {
    type, projectId, prompt, sessionId, repoUrl, targetPath, template,
    bornastarSessionId, claudeSessionId, mode, model, thinking, userMsgId, skillId,
  } = body as {
    type: string
    projectId?: string
    prompt?: string
    sessionId?: string
    repoUrl?: string
    targetPath?: string
    template?: string
    bornastarSessionId?: string
    claudeSessionId?: string
    mode?: 'plan' | 'ask' | 'agent'
    model?: string
    thinking?: 'off' | 'low' | 'medium' | 'high'
    // Stable id the browser minted for the user's own message. The
    // daemon will use it as the persistRow id so the optimistic render,
    // the ring buffer, and the DB all share one id.
    userMsgId?: string
    // Active agent skill name (e.g. 'ceo', 'tester'). Forwarded to the
    // daemon so it can prepend that agent's skillMd to the system
    // prompt during spawn. null = regular chat without an agent persona.
    skillId?: string | null
  }

  if (!type) {
    return NextResponse.json({ error: 'Missing command type' }, { status: 400 })
  }

  // Resolve worktreePath from the Bornastar chat session, when present. The
  // companion daemon only knows about projects (roots); we enrich the
  // command here so it can spawn Claude Code in the correct worktree dir.
  let worktreePath: string | undefined
  if (bornastarSessionId) {
    const session = await prisma.chatSession.findUnique({
      where: { id: bornastarSessionId },
      select: {
        userId: true,
        worktree: { select: { worktreePath: true } },
      },
    })
    if (session && session.userId === auth.userId && session.worktree?.worktreePath) {
      worktreePath = session.worktree.worktreePath
    }
  }

  if (type === 'prompt') {
    console.log(`[isolation] command type=prompt session=${bornastarSessionId?.slice(0, 8) ?? '-'} worktreePath=${worktreePath ?? '(main)'} mode=${mode ?? '-'} skill=${skillId ?? '-'}`)
  } else if (type === 'interrupt') {
    console.log(`[isolation] command type=interrupt session=${bornastarSessionId?.slice(0, 8) ?? '-'}`)
  }

  const channel = getChannel(auth.userId)
  channel.pushCommand({
    type,
    projectId,
    prompt,
    // Use the explicit claudeSessionId field when the browser provides one;
    // fall back to legacy `sessionId` so older call sites keep working.
    sessionId: claudeSessionId ?? sessionId,
    mode,
    model,
    thinking,
    skillId: skillId ?? null,
    worktreePath,
    bornastarSessionId,
    userMsgId,
    repoUrl,
    targetPath,
    template,
    timestamp: Date.now(),
  })

  return NextResponse.json({ ok: true, queued: true })
}
