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
//   { source: 'stale', session: { status } }  — archived / deleted; fetch /messages
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
  // hasMore tells the client whether to surface scroll-up pagination.
  // The old logic ("ring is at its 200-frame cap") was wrong: a server
  // restart, a fresh user opening an old chat, or a 24h-quiet chat all
  // produce a small ring AND have older rows in Supabase. The honest
  // signal is "is the oldest row in the ring also the oldest row in
  // the DB?". If yes, ring covers the whole history. If not, DB has
  // older rows that pagination needs to fetch.
  const oldestInRingTs = messages.reduce(
    (acc, m) => Math.min(acc, new Date(m.createdAt).getTime()),
    Number.POSITIVE_INFINITY,
  )
  const tHasMore = Date.now()
  const oldestInDb = await prisma.chatMessage.findFirst({
    where: { sessionId, deletedAt: null },
    orderBy: { createdAt: 'asc' },
    select: { createdAt: true },
  })
  const hasMoreMs = Date.now() - tHasMore
  const hasMore = !!oldestInDb && oldestInDb.createdAt.getTime() < oldestInRingTs
  console.log(
    `[session-state] served from Ponta B (ring) sessionId=${sessionId.slice(0, 8)} messages=${messages.length} `
    + `frames=${frames.length} hasMore=${hasMore} oldestRing=${oldestInRingTs} oldestDb=${oldestInDb?.createdAt.getTime() ?? 'none'} `
    + `dbLookup=${dbLookupMs}ms hasMoreCheck=${hasMoreMs}ms total=${Date.now() - tStart}ms`,
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
