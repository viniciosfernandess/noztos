// POST /api/cloud/switch
//
// Browser triggers this when the user clicks "Continuar na nuvem" on a
// worktree whose local daemon has gone offline (or proactively, before
// closing the laptop). The endpoint:
//
//   1. Verifies the user owns the worktree AND has cloud access
//      (MVP: User.cloudEnabled boolean; post-billing: credit/plan check).
//   2. Confirms WorktreeMirror.status === 'ready' — otherwise the
//      sandbox would boot with an incomplete tree.
//   3. Generates a SandboxSession token (256-bit url-safe) and creates
//      the row with status='provisioning'.
//   4. Provisions an E2B sandbox in the background, uploads the init
//      script + bridge.mjs, sets required env vars, and runs init.sh.
//   5. Updates SandboxSession.status as it progresses
//      (provisioning → materializing → ready). On failure, status='failed'
//      with errorReason populated; the row stays for diagnostics.
//
// Returns immediately with the SandboxSession id; the browser polls /api/cloud/session/[id]
// (a tiny endpoint we'll add in Phase 4) to track readiness, then flips
// the chat UI to the cloud connection.
//
// Body: { worktreeId: string }
// Reply: { sandboxSessionId: string }

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { Sandbox } from 'e2b'
import { verifyAuth } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { evictContextCache } from '@/lib/compute-router'

const E2B_TEMPLATE = process.env.BORNASTAR_E2B_TEMPLATE ?? 'base'
const E2B_API_KEY = process.env.E2B_API_KEY
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
const SERVER_URL = process.env.BORNASTAR_PUBLIC_URL ?? 'http://localhost:3000'

export async function POST(request: NextRequest) {
  const auth = await verifyAuth(request)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  if (!E2B_API_KEY) {
    return NextResponse.json(
      { error: 'E2B_API_KEY not configured on server' },
      { status: 503 },
    )
  }
  if (!ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: 'ANTHROPIC_API_KEY not configured on server' },
      { status: 503 },
    )
  }

  let body: { worktreeId?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Bad JSON' }, { status: 400 })
  }
  if (typeof body.worktreeId !== 'string') {
    return NextResponse.json({ error: 'worktreeId required' }, { status: 400 })
  }
  console.log(`[cloud/switch] user=${auth.userId.slice(0, 8)} worktree=${body.worktreeId.slice(0, 8)} REQUEST`)

  // Ownership + mirror-ready check first (worktree has no direct
  // `user` relation declared, so the cloud-gate User.cloudEnabled
  // comes from a separate query keyed on the auth.userId).
  const worktree = await prisma.worktree.findFirst({
    where: { id: body.worktreeId, userId: auth.userId },
    select: {
      id: true,
      mirror: { select: { status: true } },
    },
  })
  if (!worktree) {
    return NextResponse.json({ error: 'worktree not found' }, { status: 404 })
  }
  const user = await prisma.user.findUnique({
    where: { id: auth.userId },
    select: { cloudEnabled: true },
  })
  if (!user?.cloudEnabled) {
    return NextResponse.json(
      { error: 'cloud access not enabled for this user' },
      { status: 403 },
    )
  }
  if (!worktree.mirror) {
    return NextResponse.json(
      { error: 'mirror not initialized — daemon must finish initial walk first' },
      { status: 409 },
    )
  }
  if (worktree.mirror.status !== 'ready') {
    return NextResponse.json(
      { error: `mirror status=${worktree.mirror.status} (need 'ready')` },
      { status: 409 },
    )
  }

  // Guard against accidentally provisioning two sandboxes for the same
  // worktree. If one is already active (provisioning/materializing/ready),
  // return that one rather than starting a fresh one — the UI handles
  // showing progress.
  const existing = await prisma.sandboxSession.findFirst({
    where: {
      worktreeId: body.worktreeId,
      status: { in: ['provisioning', 'materializing', 'ready'] },
      destroyedAt: null,
    },
  })
  if (existing) {
    return NextResponse.json({ sandboxSessionId: existing.id, reused: true })
  }

  const token = randomBytes(32).toString('base64url')
  const session = await prisma.sandboxSession.create({
    data: {
      worktreeId: body.worktreeId,
      userId: auth.userId,
      token,
      status: 'provisioning',
    },
  })
  console.log(`[cloud/switch] created session=${session.id} status=provisioning — kicking off E2B`)

  // Flip the worktree's activeContext now so the relay routing filter
  // immediately starts sending prompts to the (about-to-be-ready)
  // sandbox bridge instead of the companion. Even if the user types
  // mid-provision, the message ends up queued for cloud.
  await prisma.worktree.update({
    where: { id: body.worktreeId },
    data: { activeContext: 'cloud' },
  })
  evictContextCache(body.worktreeId)

  // Provisioning is async — return the id immediately, do the slow work
  // in the background. The browser polls the session row to track
  // status transitions.
  void provisionSandbox({
    sessionId: session.id,
    worktreeId: body.worktreeId,
    token,
  }).catch(async (err) => {
    console.error(`[cloud/switch] provision failed session=${session.id}:`, err)
    await prisma.sandboxSession
      .update({
        where: { id: session.id },
        data: { status: 'failed', errorReason: String(err?.message ?? err) },
      })
      .catch(() => {})
  })

  return NextResponse.json({ sandboxSessionId: session.id, reused: false })
}

async function provisionSandbox(args: {
  sessionId: string
  worktreeId: string
  token: string
}): Promise<void> {
  // Load the init scripts from disk. These ship with the repo under
  // sandbox/init/ — keeping them as separate files (vs embedded
  // strings) means they show up in editor + diff cleanly.
  const initScriptPath = join(process.cwd(), 'sandbox', 'init', 'init.sh')
  const bridgeScriptPath = join(process.cwd(), 'sandbox', 'init', 'bridge.mjs')
  const [initScript, bridgeScript] = await Promise.all([
    readFile(initScriptPath, 'utf-8'),
    readFile(bridgeScriptPath, 'utf-8'),
  ])

  console.log(`[cloud/switch] session=${args.sessionId} Sandbox.create template=${E2B_TEMPLATE}...`)
  const t0 = Date.now()
  const sandbox = await Sandbox.create(E2B_TEMPLATE, {
    apiKey: E2B_API_KEY!,
    timeoutMs: 30 * 60 * 1000, // 30 min idle timeout — sandbox auto-destroys
    envs: {
      BORNASTAR_SERVER_URL: SERVER_URL,
      BORNASTAR_SANDBOX_TOKEN: args.token,
      BORNASTAR_WORKTREE_ID: args.worktreeId,
      ANTHROPIC_API_KEY: ANTHROPIC_API_KEY!,
    },
  })
  console.log(`[cloud/switch] session=${args.sessionId} sandbox=${sandbox.sandboxId} created in ${Date.now() - t0}ms`)

  await prisma.sandboxSession.update({
    where: { id: args.sessionId },
    data: { e2bSandboxId: sandbox.sandboxId, status: 'materializing' },
  })

  // Upload init scripts into the sandbox filesystem.
  await sandbox.files.write('/sandbox/init.sh', initScript)
  await sandbox.files.write('/sandbox/bridge.mjs', bridgeScript)
  await sandbox.commands.run('chmod +x /sandbox/init.sh')
  console.log(`[cloud/switch] session=${args.sessionId} scripts uploaded — launching init.sh`)

  // Run init.sh in the background — it materialises the worktree and
  // then exec's into the bridge (which never returns). The stdout/
  // stderr is redirected to /tmp/init.log inside the sandbox so we
  // can fetch it for diagnostics on failure.
  void sandbox.commands.run('/sandbox/init.sh > /tmp/init.log 2>&1', {
    background: true,
    envs: {
      BORNASTAR_SERVER_URL: SERVER_URL,
      BORNASTAR_SANDBOX_TOKEN: args.token,
      BORNASTAR_WORKTREE_ID: args.worktreeId,
      ANTHROPIC_API_KEY: ANTHROPIC_API_KEY!,
    },
  })

  // Poll the marker file init.sh touches when materialization finishes
  // (step 5 done, about to exec the bridge). Without this we'd flip to
  // 'ready' optimistically and the user's first prompt would queue
  // against a bridge that never started.
  //
  // Budget: 120s. First-run installs jq + claude-cli (~20s), then
  // materializes blobs (~5s for 132 files), so 90s of headroom is
  // plenty. If we hit the timeout, fetch the init log for diagnostics
  // and mark the session 'failed' with the captured tail.
  const READY_MARKER = '/tmp/bornastar-init-ready'
  const POLL_INTERVAL_MS = 1500
  const POLL_DEADLINE_MS = 120_000
  const deadline = Date.now() + POLL_DEADLINE_MS
  let ready = false
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    try {
      const probe = await sandbox.commands.run(`test -f ${READY_MARKER} && echo READY || echo PENDING`)
      if (probe.stdout.includes('READY')) {
        ready = true
        break
      }
    } catch {
      // Sandbox connection blip — keep polling. The init script is
      // independent of these probe calls.
    }
  }
  if (!ready) {
    let logTail = ''
    try {
      const dump = await sandbox.commands.run('tail -50 /tmp/init.log 2>/dev/null || echo "(no log)"')
      logTail = dump.stdout
    } catch {}
    console.error(`[cloud/switch] session=${args.sessionId} init timed out after ${POLL_DEADLINE_MS}ms — init.log tail:\n${logTail}`)
    throw new Error(`Sandbox init timed out. Tail:\n${logTail.slice(-1500)}`)
  }

  await prisma.sandboxSession.update({
    where: { id: args.sessionId },
    data: { status: 'ready' },
  })
  console.log(`[cloud/switch] session=${args.sessionId} sandbox=${sandbox.sandboxId} READY (init marker observed)`)
}
