import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'
import { getChannel, getCompanionStatus } from '@/lib/companion-relay'

interface RouteContext {
  params: Promise<{ id: string }>
}

// POST — Browser PTY control plane. The four actions map 1:1 to the
// PtyManager methods on the daemon (see companion/src/pty-manager.ts):
//
//   attach  → spawn or reattach a shell PTY for `contextKey`. Server
//             resolves `cwd` + `displayName` from the worktreeId so
//             the browser doesn't have to know on-disk paths.
//   input   → forward keystrokes / paste data to the PTY's stdin.
//   resize  → propagate cols/rows when the user resizes the panel.
//   detach  → soft close. Daemon starts the post-detach TTL countdown;
//             a reattach within the window picks up the same bash
//             session, otherwise the PTY is killed (unless a child
//             process is still running, in which case the TTL extends).
//
// Output flows the other direction: shell bytes → daemon `pty_data`
// event → /api/companion/response → relay → /api/companion/stream
// SSE → browser xterm.write(). No round trip per byte from the
// server's perspective; this endpoint is the input control plane only.
export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) return NextResponse.json({ error: access.error }, { status: access.status })

  // Companion has to be online for any of this to work — the PTY
  // lives in the daemon, not the server. 503 lets the browser flip
  // to the offline UI without a confusing error.
  const status = getCompanionStatus(access.userId)
  if (!status.connected) {
    return NextResponse.json({ error: 'Companion not connected' }, { status: 503 })
  }

  const body = await request.json() as {
    action: 'attach' | 'input' | 'resize' | 'detach'
    // Cache key the browser uses (worktreeId — terminal exists only
    // inside worktrees today). Same value flows back on every
    // pty_data event so the right XTermPanel ingests the bytes.
    contextKey: string
    // attach
    worktreeId?: string
    cols?: number
    rows?: number
    // input
    data?: string
  }

  if (!body.action || !body.contextKey) {
    return NextResponse.json({ error: 'Missing action or contextKey' }, { status: 400 })
  }

  const channel = getChannel(access.userId)

  if (body.action === 'attach') {
    if (body.cols == null || body.rows == null) {
      return NextResponse.json({ error: 'attach requires cols + rows' }, { status: 400 })
    }
    if (!body.worktreeId) {
      return NextResponse.json({ error: 'attach requires worktreeId' }, { status: 400 })
    }
    // Strict resolve: rejects worktree rows that don't exist or are
    // still placeholders (`worktreePath: '_pending_'` from the
    // optimistic-create flow). Falling through to a project root
    // fallback would spawn bash in the WRONG directory — this is the
    // defense-in-depth half of the race protection (the browser-side
    // gate in TerminalBody already prevents most of this).
    const resolved = await resolveContext(id, access.userId, body.worktreeId)
    if (!resolved) {
      return NextResponse.json({ error: 'Worktree not ready' }, { status: 400 })
    }
    console.log(`[pty] route attach ctx=${body.contextKey.slice(0, 8)} cwd=${resolved.cwd} branch="${resolved.displayName}" cols=${body.cols}x${body.rows}`)
    channel.pushCommand({
      type: 'pty_attach',
      contextKey: body.contextKey,
      cwd: resolved.cwd,
      cols: body.cols,
      rows: body.rows,
      displayName: resolved.displayName,
      timestamp: Date.now(),
    })
    return NextResponse.json({ ok: true })
  }

  if (body.action === 'input') {
    if (body.data == null) {
      return NextResponse.json({ error: 'input requires data' }, { status: 400 })
    }
    channel.pushCommand({
      type: 'pty_input',
      contextKey: body.contextKey,
      data: body.data,
      timestamp: Date.now(),
    })
    return NextResponse.json({ ok: true })
  }

  if (body.action === 'resize') {
    if (body.cols == null || body.rows == null) {
      return NextResponse.json({ error: 'resize requires cols + rows' }, { status: 400 })
    }
    channel.pushCommand({
      type: 'pty_resize',
      contextKey: body.contextKey,
      cols: body.cols,
      rows: body.rows,
      timestamp: Date.now(),
    })
    return NextResponse.json({ ok: true })
  }

  if (body.action === 'detach') {
    console.log(`[pty] route detach ctx=${body.contextKey.slice(0, 8)}`)
    channel.pushCommand({
      type: 'pty_detach',
      contextKey: body.contextKey,
      timestamp: Date.now(),
    })
    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}

// Resolve cwd + displayName for the PTY spawn from the worktreeId.
// Strict mode: caller must pass a worktreeId, the row must exist,
// belong to this project, and have a real `worktreePath` (not the
// `_pending_` placeholder the optimistic-create flow upserts before
// `provisionWorktree` finishes). Returns null on any failure → the
// caller surfaces a 400 so the browser can retry once provisioning
// lands.
//
// `displayName` for the prompt: we use `branchName` (e.g.
// "belgrade-v1"), NOT the worktree's display name. The display name
// gets renamed by auto-rename when the user sends their first chat
// message — turning the codename into something like "bora meu amigo".
// The branch name stays stable and matches what `git branch` shows;
// that's the right identifier in a terminal context.
async function resolveContext(
  projectId: string,
  userId: string,
  worktreeId: string,
): Promise<{ cwd: string; displayName: string } | null> {
  const wt = await prisma.worktree.findUnique({
    where: { id: worktreeId },
    select: { projectId: true, userId: true, worktreePath: true, branchName: true },
  })
  if (!wt) return null
  if (wt.projectId !== projectId) return null
  if (wt.userId !== userId) return null
  if (!wt.worktreePath || wt.worktreePath === '_pending_') return null
  return { cwd: wt.worktreePath, displayName: wt.branchName || 'worktree' }
}
