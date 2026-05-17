// POST /api/cloud/resume
//
// Called by the UI when a worktree with activeContext='cloud' is
// reopened (browser tab focus, navigation into worktree, etc).
//
// Returns the current sandbox session status:
//   - 'live'         : ready session exists, sandbox is up — UI just
//                      reconnects SSE, nothing to do
//   - 'provisioning' : a session is mid-creation — UI shows progress
//   - 'reprovisioning' : prior session was destroyed by E2B's idle GC
//                        but activeContext='cloud' so we kicked off a
//                        fresh provision — UI shows progress
//   - 'local'        : worktree isn't actually in cloud mode (race) —
//                      UI ignores
//
// Body: { worktreeId }
// Reply: { status, sandboxSessionId?, error? }
//
// The actual re-provisioning path is the same as /api/cloud/switch
// (which we delegate to by re-posting internally). Splitting them
// keeps the user-initiated "switch" call separate from the implicit
// "resume" call in the audit log.

import { NextRequest, NextResponse } from 'next/server'
import { Sandbox } from 'e2b'
import { verifyAuth } from '@/lib/auth'
import { prisma } from '@/lib/db'

const E2B_API_KEY = process.env.E2B_API_KEY

export async function POST(request: NextRequest) {
  const auth = await verifyAuth(request)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { worktreeId?: unknown }
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'Bad JSON' }, { status: 400 })
  }
  if (typeof body.worktreeId !== 'string') {
    return NextResponse.json({ error: 'worktreeId required' }, { status: 400 })
  }

  const worktree = await prisma.worktree.findFirst({
    where: { id: body.worktreeId, userId: auth.userId },
    select: { id: true, activeContext: true },
  })
  if (!worktree) {
    return NextResponse.json({ error: 'worktree not found' }, { status: 404 })
  }
  if (worktree.activeContext !== 'cloud') {
    return NextResponse.json({ status: 'local' })
  }

  // Look for the most recent session that's still alive in our DB.
  const session = await prisma.sandboxSession.findFirst({
    where: {
      worktreeId: body.worktreeId,
      status: { in: ['provisioning', 'materializing', 'ready'] },
      destroyedAt: null,
    },
    orderBy: { createdAt: 'desc' },
  })

  if (session) {
    if (session.status !== 'ready') {
      return NextResponse.json({ status: 'provisioning', sandboxSessionId: session.id })
    }
    // Ready in our DB — verify the E2B sandbox actually still exists.
    // E2B GCs sandboxes after their timeoutMs; our DB doesn't know
    // about that. A quick connect() probes it.
    if (E2B_API_KEY && session.e2bSandboxId) {
      try {
        await Sandbox.connect(session.e2bSandboxId, { apiKey: E2B_API_KEY })
        return NextResponse.json({ status: 'live', sandboxSessionId: session.id })
      } catch {
        // Sandbox dead — mark destroyed and fall through to re-provision.
        await prisma.sandboxSession.update({
          where: { id: session.id },
          data: { status: 'destroyed', destroyedAt: new Date(), errorReason: 'e2b sandbox gone (idle GC)' },
        })
      }
    } else {
      return NextResponse.json({ status: 'live', sandboxSessionId: session.id })
    }
  }

  // No live session — re-provision by delegating to /api/cloud/switch.
  // Internal POST keeps the provisioning logic in one place rather
  // than duplicating sandbox.create + scripts upload here.
  const switchRes = await fetch(new URL('/api/cloud/switch', request.url), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(request.headers.get('cookie') ? { cookie: request.headers.get('cookie')! } : {}),
      ...(request.headers.get('authorization') ? { authorization: request.headers.get('authorization')! } : {}),
    },
    body: JSON.stringify({ worktreeId: body.worktreeId }),
  })
  if (!switchRes.ok) {
    const err = await switchRes.json().catch(() => ({ error: 'switch failed' }))
    return NextResponse.json({ status: 'error', error: err.error ?? 'switch failed' }, { status: 500 })
  }
  const switchBody = (await switchRes.json()) as { sandboxSessionId: string }
  return NextResponse.json({ status: 'reprovisioning', sandboxSessionId: switchBody.sandboxSessionId })
}
