import { NextRequest, NextResponse } from 'next/server'
import { verifyProjectAccess } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { getSessionBuffer } from '@/lib/companion-relay'
import type { PersistRow } from '@/lib/chat-persist'

// GET — Fast-path hydration for a chat session.
//
// The browser calls this the instant it mounts a chat. If we have a hot
// ring buffer for the session (last 24h of activity in RAM), we reply
// instantly — no Supabase round-trip. Otherwise we signal the caller to
// fall back to the paginated /messages endpoint which reads from cold
// storage.
//
// Buffer frames carry `persistRows` (stable ids, added by the daemon
// before relay). We extract and return them in the same shape the
// /messages endpoint does, so the client hydrate() path is identical
// whether the source is RAM or Supabase.
//
// Response:
//   { source: 'buffer', messages, claudeSessionId, … }
//   { source: 'empty' }                       — no buffer, client fetches /messages
//   { source: 'stale', session: { status } }  — archived / trashed; fetch /messages
export async function GET(request: NextRequest) {
  const tStart = Date.now()
  const url = request.nextUrl
  const projectId = url.searchParams.get('projectId')
  const sessionId = url.searchParams.get('sessionId')
  if (!projectId || !sessionId) {
    return NextResponse.json({ error: 'projectId and sessionId required' }, { status: 400 })
  }

  const auth = await verifyProjectAccess(projectId)
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }

  const tDb = Date.now()
  const session = await prisma.chatSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true, projectId: true, userId: true, status: true, deletedAt: true,
      claudeSessionId: true,
      totalCostUsd: true, totalTokens: true, numTurns: true,
    },
  })
  const dbLookupMs = Date.now() - tDb
  if (!session || session.projectId !== projectId || session.userId !== auth.userId) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  }

  if (session.deletedAt || session.status !== 'open') {
    console.log(`[session-state] stale sessionId=${sessionId.slice(0, 8)} status=${session.status} total=${Date.now() - tStart}ms`)
    return NextResponse.json({
      source: 'stale',
      session: { status: session.status, claudeSessionId: session.claudeSessionId },
    })
  }

  const frames = getSessionBuffer(sessionId, auth.userId)
  if (!frames || frames.length === 0) {
    console.log(`[session-state] miss sessionId=${sessionId.slice(0, 8)} dbLookup=${dbLookupMs}ms total=${Date.now() - tStart}ms → client falls back to /messages (Ponta C)`)
    return NextResponse.json({ source: 'empty' })
  }

  // Walk the ring buffer, collect every persistRow attached to each
  // claude_event. Same frame may relay the same row more than once
  // (e.g. tool_use and its later tool_result update share an id), so we
  // merge-by-id with the later entry winning — matches the Supabase
  // upsert semantics.
  const byId = new Map<string, PersistRow>()
  for (const frame of frames) {
    const rows = (frame as { payload?: { persistRows?: PersistRow[] } })?.payload?.persistRows
    if (!Array.isArray(rows)) continue
    for (const r of rows) {
      if (!r?.id) continue
      byId.set(r.id, { ...(byId.get(r.id) ?? {}), ...r })
    }
  }
  if (byId.size === 0) {
    console.log(`[session-state] miss sessionId=${sessionId.slice(0, 8)} (frames had no persistRows) total=${Date.now() - tStart}ms`)
    return NextResponse.json({ source: 'empty' })
  }

  const messages = Array.from(byId.values()).map(toMessage)
  // If the buffer is already at its per-session cap (200 frames), older
  // rows have been FIFO'd out → tell the client there's more history in
  // Supabase. If we're under the cap we have every row this chat ever
  // produced — no point teasing the "Scroll up for earlier messages"
  // marker to an empty chat.
  const BUFFER_CAP = 200
  const hasMore = frames.length >= BUFFER_CAP
  console.log(
    `[session-state] served from Ponta B (ring) sessionId=${sessionId.slice(0, 8)} messages=${messages.length} `
    + `frames=${frames.length} hasMore=${hasMore} dbLookup=${dbLookupMs}ms total=${Date.now() - tStart}ms`,
  )

  return NextResponse.json({
    source: 'buffer',
    messages,
    hasMore,
    claudeSessionId: session.claudeSessionId,
    totalCostUsd: session.totalCostUsd,
    totalTokens: session.totalTokens,
    numTurns: session.numTurns,
  })
}

// Shape a PersistRow into the same envelope the /messages endpoint
// returns so the client hydrate() path is source-agnostic.
function toMessage(r: PersistRow) {
  const created = typeof r.createdAt === 'number' ? new Date(r.createdAt) : new Date()
  return {
    id: r.id,
    role: r.role,
    content: r.content ?? '',
    createdAt: created.toISOString(),
    toolName: r.toolName ?? null,
    toolInput: r.toolInput,
    toolResult: r.toolResult,
    toolUseId: r.toolUseId ?? null,
    toolError: r.toolError ?? null,
    costUsd: r.costUsd ?? null,
    durationMs: r.durationMs ?? null,
  }
}
