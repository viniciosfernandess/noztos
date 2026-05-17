// POST /api/cloud/back-to-local
//
// User clicks the toggle on a cloud-active worktree to send execution
// back to their local daemon. The endpoint:
//   1. Validates the user owns the worktree and it's currently cloud.
//   2. Flips Worktree.activeContext='local' — companion immediately
//      starts receiving prompts for this worktree again.
//   3. Marks the SandboxSession destroyed and evicts router caches so
//      the next FS op routes to local.
//   4. Best-effort kill of the E2B sandbox so we stop being billed.
//
// We do NOT push any pending sandbox-side file changes back to the
// mirror here yet — that requires the sandbox to upload its state
// before we kill it, which is Phase 5 work (cloud→local sync). For
// MVP, the user should commit + push from the sandbox before switching
// if they want changes preserved. Documented in the UI.
//
// Body: { worktreeId: string }
// Reply: { ok: true }

import { NextRequest, NextResponse } from 'next/server'
import { Sandbox } from 'e2b'
import { verifyAuth } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { evictContextCache } from '@/lib/compute-router'
import { evictSandboxCache } from '@/lib/compute-e2b'

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
  console.log(`[cloud/back-to-local] user=${auth.userId.slice(0, 8)} worktree=${body.worktreeId.slice(0, 8)} REQUEST`)
  if (worktree.activeContext === 'local') {
    return NextResponse.json({ ok: true, alreadyLocal: true })
  }

  // Flip context first so subsequent prompts route to local immediately.
  await prisma.worktree.update({
    where: { id: body.worktreeId },
    data: { activeContext: 'local' },
  })
  evictContextCache(body.worktreeId)
  evictSandboxCache(body.worktreeId)

  // Mark all ready sandbox sessions for this worktree as destroyed,
  // then kill the E2B sandbox best-effort. If kill fails (network,
  // already gone), the row is still marked — E2B's idle timeout will
  // eventually GC anything we couldn't reach.
  const sessions = await prisma.sandboxSession.findMany({
    where: {
      worktreeId: body.worktreeId,
      status: { in: ['provisioning', 'materializing', 'ready'] },
      destroyedAt: null,
    },
  })
  await prisma.sandboxSession.updateMany({
    where: { id: { in: sessions.map((s) => s.id) } },
    data: { status: 'destroyed', destroyedAt: new Date() },
  })

  if (E2B_API_KEY) {
    for (const s of sessions) {
      if (!s.e2bSandboxId) continue
      try {
        const sandbox = await Sandbox.connect(s.e2bSandboxId, { apiKey: E2B_API_KEY })
        await sandbox.kill()
        console.log(`[cloud/back-to-local] killed sandbox=${s.e2bSandboxId.slice(0, 8)} session=${s.id.slice(0, 8)}`)
      } catch (err) {
        console.warn(`[cloud/back-to-local] sandbox kill failed (${s.e2bSandboxId.slice(0, 8)}):`, err)
      }
    }
  }
  console.log(`[cloud/back-to-local] worktree=${body.worktreeId.slice(0, 8)} DONE — back on local`)

  return NextResponse.json({ ok: true })
}
