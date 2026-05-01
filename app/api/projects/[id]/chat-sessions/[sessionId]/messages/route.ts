import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'

// ── Chat conversation read ───────────────────────────────────────────
//
// Writes live in the companion daemon: it queues stream events in a
// local SQLite WAL, the server drains them via /companion/sync-messages
// and also write-throughs live frames from /companion/response. All
// this endpoint does is serve paginated history as the cold fallback
// behind /api/companion/session-state (ring buffer).

interface RouteContext {
  params: Promise<{ id: string; sessionId: string }>
}

// Reads are generous since tab focus / initial mount issues GETs in
// rapid succession.
const readLimiter = rateLimit({ tokensPerInterval: 300, intervalMs: 60_000 }, 'chat-messages-read')

// GET — replay the conversation. Paginated: newest first, cursor-based.
//   ?limit=N            — how many to return (default 100, max 500)
//   ?before=<messageId> — fetch the page older than this message
// Response is in ASCENDING order within the page so the UI can append
// without re-sorting.
export async function GET(request: NextRequest, context: RouteContext) {
  const { id, sessionId } = await context.params
  const auth = await verifyProjectAccess(id)
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  if (!readLimiter.take(auth.userId)) {
    return NextResponse.json({ error: 'Rate limited' }, { status: 429 })
  }

  const session = await prisma.chatSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true, projectId: true, userId: true, status: true, deletedAt: true,
      claudeSessionId: true,
      totalCostUsd: true, totalTokens: true, numTurns: true,
    },
  })
  // Block access when the session is anywhere other than 'open' — an
  // archived chat must be restored before its messages become readable
  // again, and a deleted chat is gone for good. Covers both the
  // `status` flag and the soft-deleted-at timestamp.
  if (!session || session.projectId !== id || session.userId !== auth.userId
    || session.deletedAt || session.status !== 'open') {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  }

  const rawLimit = parseInt(request.nextUrl.searchParams.get('limit') ?? '100', 10)
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(500, rawLimit)) : 100
  const before = request.nextUrl.searchParams.get('before')

  // Anchor the "before" cursor on the reference message's createdAt so
  // pagination survives id shuffles and stays deterministic.
  let beforeCreatedAt: Date | undefined
  if (before) {
    const anchor = await prisma.chatMessage.findUnique({
      where: { id: before },
      select: { createdAt: true, sessionId: true },
    })
    if (anchor && anchor.sessionId === sessionId) beforeCreatedAt = anchor.createdAt
  }

  const page = await prisma.chatMessage.findMany({
    where: {
      sessionId,
      userId: auth.userId,
      deletedAt: null,
      ...(beforeCreatedAt && { createdAt: { lt: beforeCreatedAt } }),
    },
    orderBy: { createdAt: 'desc' },
    take: limit + 1,  // +1 to know if there's another page after this one
  })
  const hasMore = page.length > limit
  const slice = hasMore ? page.slice(0, limit) : page
  // Return in ascending order for simpler UI consumption.
  slice.reverse()

  return NextResponse.json({
    claudeSessionId: session.claudeSessionId,
    totalCostUsd: session.totalCostUsd,
    totalTokens: session.totalTokens,
    numTurns: session.numTurns,
    messages: slice,
    hasMore,
    nextCursor: hasMore ? slice[0]?.id ?? null : null,
  })
}
