// GET /api/cloud/session/[sessionId]
//
// UI polls this to track sandbox provisioning progress (every ~1s
// during switch). Returns the current session row's lifecycle state
// + minimal context for the UI's progress display.
//
// Used by the modal/toast that appears after /api/cloud/switch fires,
// so the user sees a smooth transition from "preparing" → "ready"
// → chat re-attaches.

import { NextRequest, NextResponse } from 'next/server'
import { verifyAuth } from '@/lib/auth'
import { prisma } from '@/lib/db'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const auth = await verifyAuth(request)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { sessionId } = await params
  const session = await prisma.sandboxSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      userId: true,
      worktreeId: true,
      status: true,
      e2bSandboxId: true,
      createdAt: true,
      lastActiveAt: true,
      destroyedAt: true,
      errorReason: true,
    },
  })
  if (!session) {
    return NextResponse.json({ error: 'session not found' }, { status: 404 })
  }
  if (session.userId !== auth.userId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  return NextResponse.json({
    id: session.id,
    worktreeId: session.worktreeId,
    status: session.status,
    e2bSandboxId: session.e2bSandboxId,
    createdAt: session.createdAt,
    lastActiveAt: session.lastActiveAt,
    destroyedAt: session.destroyedAt,
    errorReason: session.errorReason,
  })
}
