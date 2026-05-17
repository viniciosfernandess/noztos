// POST /api/cloud/admin/gc
//
// Light-weight garbage collection for Cloud Mirror state. Designed to
// be called from a cron / scheduled task in production (every hour or
// so). For dev / beta, calling it manually is fine — operations are
// idempotent and bounded.
//
// What it does:
//   1. Orphan blobs: deletes GitObject rows where refCount=0 AND the
//      row is older than 24h. The cool-down prevents racing with an
//      in-flight upload that hasn't yet had its commit-entries call
//      bump refCount.
//   2. Stale sandbox sessions: marks SandboxSession rows as 'destroyed'
//      when their lastActiveAt is older than 30 minutes AND status is
//      still 'ready'. Catches sessions that E2B GCd silently — our DB
//      didn't notice. Best-effort kill of the E2B sandbox happens here
//      too, in case it's still running but idle.
//   3. (No actual file deletion needed for blobs — Postgres handles row
//      removal directly. The encrypted bytea content goes with the row.)
//
// Auth: admin token via X-Admin-Token header matching BORNASTAR_ADMIN_TOKEN
// env var. Keeps the endpoint off the public surface — anyone curling it
// from the internet 401s.
//
// Reply: { gitObjectsDeleted, sandboxesDestroyed, sandboxesKilled, durationMs }

import { NextRequest, NextResponse } from 'next/server'
import { Sandbox } from 'e2b'
import { prisma } from '@/lib/db'

const ADMIN_TOKEN = process.env.BORNASTAR_ADMIN_TOKEN
const E2B_API_KEY = process.env.E2B_API_KEY
const BLOB_COOLDOWN_MS = 24 * 60 * 60 * 1000
const SANDBOX_IDLE_MS = 30 * 60 * 1000

export async function POST(request: NextRequest) {
  if (!ADMIN_TOKEN) {
    return NextResponse.json({ error: 'BORNASTAR_ADMIN_TOKEN not configured' }, { status: 503 })
  }
  if (request.headers.get('x-admin-token') !== ADMIN_TOKEN) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const startedAt = Date.now()

  // ── Orphan blob GC ─────────────────────────────────────────────────
  const blobCutoff = new Date(Date.now() - BLOB_COOLDOWN_MS)
  const gitObjectsDeletedRes = await prisma.gitObject.deleteMany({
    where: {
      refCount: { lte: 0 },
      createdAt: { lt: blobCutoff },
    },
  })

  // ── Stale sandbox session GC ───────────────────────────────────────
  const idleCutoff = new Date(Date.now() - SANDBOX_IDLE_MS)
  const staleSessions = await prisma.sandboxSession.findMany({
    where: {
      status: 'ready',
      destroyedAt: null,
      lastActiveAt: { lt: idleCutoff },
    },
    select: { id: true, e2bSandboxId: true },
  })

  let sandboxesKilled = 0
  if (E2B_API_KEY) {
    for (const s of staleSessions) {
      if (!s.e2bSandboxId) continue
      try {
        const sandbox = await Sandbox.connect(s.e2bSandboxId, { apiKey: E2B_API_KEY })
        await sandbox.kill()
        sandboxesKilled++
      } catch {
        // Sandbox already gone (E2B GC), or unreachable — fine.
      }
    }
  }

  const sandboxesDestroyedRes = staleSessions.length
    ? await prisma.sandboxSession.updateMany({
        where: { id: { in: staleSessions.map((s) => s.id) } },
        data: { status: 'destroyed', destroyedAt: new Date(), errorReason: 'idle GC' },
      })
    : { count: 0 }

  return NextResponse.json({
    gitObjectsDeleted: gitObjectsDeletedRes.count,
    sandboxesDestroyed: sandboxesDestroyedRes.count,
    sandboxesKilled,
    durationMs: Date.now() - startedAt,
  })
}
