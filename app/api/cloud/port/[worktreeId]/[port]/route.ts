// GET /api/cloud/port/[worktreeId]/[port]
//
// Returns the public URL E2B exposes for a given port inside the
// sandbox. Used by the UI to surface dev-server previews — when the
// user's `npm run dev` binds to port 3000 inside the cloud sandbox,
// we render a clickable preview link pointing to E2B's public host.
//
// E2B's sandbox.getHost(port) is synchronous once you've connected,
// no network call needed on the sandbox side. We just need to find
// the right sandbox for this worktree and call it.
//
// Reply: { url: string, port: number } or 404 if no live sandbox.

import { NextRequest, NextResponse } from 'next/server'
import { Sandbox } from 'e2b'
import { verifyAuth } from '@/lib/auth'
import { prisma } from '@/lib/db'

const E2B_API_KEY = process.env.E2B_API_KEY

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ worktreeId: string; port: string }> },
) {
  const auth = await verifyAuth(request)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  if (!E2B_API_KEY) {
    return NextResponse.json({ error: 'E2B not configured' }, { status: 503 })
  }

  const { worktreeId, port } = await params
  const portNum = parseInt(port, 10)
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    return NextResponse.json({ error: 'invalid port' }, { status: 400 })
  }

  // Ownership check.
  const wt = await prisma.worktree.findFirst({
    where: { id: worktreeId, userId: auth.userId },
    select: { id: true },
  })
  if (!wt) return NextResponse.json({ error: 'worktree not found' }, { status: 404 })

  const session = await prisma.sandboxSession.findFirst({
    where: {
      worktreeId,
      status: 'ready',
      destroyedAt: null,
    },
    orderBy: { createdAt: 'desc' },
  })
  if (!session?.e2bSandboxId) {
    return NextResponse.json({ error: 'no live sandbox' }, { status: 404 })
  }

  try {
    const sandbox = await Sandbox.connect(session.e2bSandboxId, { apiKey: E2B_API_KEY })
    const host = sandbox.getHost(portNum)
    return NextResponse.json({
      url: `https://${host}`,
      port: portNum,
    })
  } catch (err) {
    console.warn(`[cloud/port] connect failed for ${session.e2bSandboxId.slice(0, 8)}:`, err)
    return NextResponse.json({ error: 'sandbox unreachable' }, { status: 502 })
  }
}
