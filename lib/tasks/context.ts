// Chat-history snapshot helper for task creation.
//
// When the user clicks the "take context to task" button under an
// assistant message, we freeze the chat conversation FROM that message
// backwards as the task's preamble. Same sizing budget as Bridge IN
// (MIN_CONTEXT_ROWS) so what the task's downstream agents see is
// shape-compatible with what a workflow would see if invoked from the
// same point in the chat.
//
// Strategy: ring buffer first (just like Bridge IN), DB complement if
// the ring is short or doesn't contain the anchor.
//
//   1. Read ring → CanonicalRow[] + idsInRing set.
//   2. If anchor (cutoffMessageId) is in idsInRing:
//        a. Take ring rows from the start up to and including the anchor.
//        b. If we already have >= MIN_CONTEXT_ROWS, return — cache fast-path.
//        c. Else fall through to DB complement (only older messages,
//           dedupe by id).
//   3. If anchor is NOT in the ring (older history outside the ring
//      window), fall through to DB-anchor lookup (the legacy path):
//      resolve anchor's createdAt, then back-fetch.
//   4. Anchor not in ring AND not in DB → bad anchor, return empty.
//
// Output is the same `<chat_context>...</chat_context>` XML shape Bridge
// IN produces, so the task runner can splice it as the preamble of any
// downstream agent's system prompt with no transformation.

import { prisma } from '@/lib/db'
import { getSessionBuffer } from '@/lib/companion-relay'
import { fromRingEvents, fromDbRows, formatXml, type CanonicalRow } from '@/lib/chat-context-helpers'

const MIN_CONTEXT_ROWS = 30

export interface ChatSnapshot {
  /** XML string ready to be embedded in the task's contextSnapshot. */
  xml: string
  /** Number of messages captured (for telemetry / source metadata). */
  rowCount: number
  /** The message id we anchored to — null only if not provided. */
  cutoffMessageId: string | null
  /** The createdAt of the cutoff message — useful for source metadata. */
  cutoffAt: Date | null
}

/**
 * Capture a chat snapshot ending at `cutoffMessageId` (inclusive) going
 * backwards up to MIN_CONTEXT_ROWS messages.
 *
 * If `cutoffMessageId` is null/missing, the snapshot is the tail of the
 * chat (latest MIN_CONTEXT_ROWS) — used by callers that want "current
 * state" rather than a historical anchor.
 *
 * Returns empty xml + rowCount 0 when the session has no eligible
 * messages. Doesn't throw on bad input; the caller decides whether to
 * accept an empty snapshot.
 */
export async function buildChatSnapshot(
  sessionId: string,
  cutoffMessageId?: string | null,
  userId?: string,
): Promise<ChatSnapshot> {
  // ── Tier 1: ring buffer (cache primary, ~0ms) ────────────────────
  //
  // Same fast-path as Bridge IN: if the chat is live and the anchor
  // we want is still in the ring, we can answer without touching DB.
  // Bonus: closes the race window where a message was just persisted
  // to the ring but the daemon's write-behind hasn't reached DB yet.
  let ringRows: CanonicalRow[] = []
  let ringIds = new Set<string>()
  if (userId) {
    try {
      const events = getSessionBuffer(sessionId, userId)
      if (events && events.length > 0) {
        const parsed = fromRingEvents(events, sessionId)
        ringRows = parsed.rows
        ringIds = parsed.ids
      }
    } catch (err) {
      console.warn(`[chat-snapshot] sid=${sessionId.slice(0, 8)} ring error:`, (err as Error).message)
    }
  }

  let cutoffAt: Date | null = null

  // ── Anchor in ring? Slice up to anchor, return / complement ──────
  if (cutoffMessageId && ringIds.has(cutoffMessageId)) {
    const anchorIdx = ringRows.findIndex((r) => r.id === cutoffMessageId)
    // Drop everything after the anchor — the snapshot is a historical
    // point in time, anything later than the click belongs to the chat
    // not the task.
    const ringUpToAnchor = anchorIdx >= 0 ? ringRows.slice(0, anchorIdx + 1) : ringRows
    if (ringUpToAnchor.length >= MIN_CONTEXT_ROWS) {
      console.log(`[chat-snapshot] sid=${sessionId.slice(0, 8)} cache-hit rows=${ringUpToAnchor.length} anchor=${cutoffMessageId.slice(0, 12)}`)
      return {
        xml: formatXml(ringUpToAnchor),
        rowCount: ringUpToAnchor.length,
        cutoffMessageId,
        cutoffAt: null, // not needed when ring satisfies — caller's only consumer is metadata
      }
    }
    // Ring has the anchor but not enough rows yet. We need older
    // messages from DB. Resolve the anchor's createdAt to scope the
    // DB query, then fetch older rows (excluding ids already in ring).
    const anchorRow = await prisma.chatMessage.findFirst({
      where: { id: cutoffMessageId, sessionId, deletedAt: null },
      select: { createdAt: true },
    })
    cutoffAt = anchorRow?.createdAt ?? null

    let dbRows: CanonicalRow[] = []
    if (cutoffAt) {
      try {
        const rawDb = await prisma.chatMessage.findMany({
          where: {
            sessionId,
            deletedAt: null,
            createdAt: { lt: cutoffAt }, // strictly older — anchor itself is in ring
            ...(ringIds.size > 0 && { id: { notIn: [...ringIds] } }),
          },
          orderBy: { createdAt: 'desc' },
          take: MIN_CONTEXT_ROWS,
          select: { id: true, role: true, content: true, toolName: true, toolError: true, toolResult: true },
        })
        rawDb.reverse()
        dbRows = fromDbRows(rawDb)
      } catch (err) {
        console.warn(`[chat-snapshot] sid=${sessionId.slice(0, 8)} DB complement error:`, (err as Error).message)
      }
    }

    const merged = [...dbRows, ...ringUpToAnchor]
    console.log(`[chat-snapshot] sid=${sessionId.slice(0, 8)} complemented ring=${ringUpToAnchor.length} db=${dbRows.length} total=${merged.length} anchor=${cutoffMessageId.slice(0, 12)}`)
    return {
      xml: formatXml(merged),
      rowCount: merged.length,
      cutoffMessageId,
      cutoffAt,
    }
  }

  // ── Tier 2: anchor not in ring → DB-anchor lookup (legacy path) ──
  //
  // Either the anchor is older than the ring's eviction window, or no
  // anchor was given (caller wants the tail). Resolve the anchor's
  // createdAt first (if given), then back-fetch MIN_CONTEXT_ROWS.
  if (cutoffMessageId) {
    const anchor = await prisma.chatMessage.findFirst({
      where: { id: cutoffMessageId, sessionId, deletedAt: null },
      select: { createdAt: true },
    })
    if (!anchor) {
      // Bad anchor in both ring and DB — caller decides whether to
      // accept an empty snapshot or surface an error.
      console.warn(`[chat-snapshot] sid=${sessionId.slice(0, 8)} bad anchor=${cutoffMessageId.slice(0, 12)} (not in ring or DB)`)
      return { xml: '', rowCount: 0, cutoffMessageId, cutoffAt: null }
    }
    cutoffAt = anchor.createdAt
  }

  // No ring rows applicable (anchor wasn't in ring). Pure DB read.
  const rows = await prisma.chatMessage.findMany({
    where: {
      sessionId,
      deletedAt: null,
      ...(cutoffAt ? { createdAt: { lte: cutoffAt } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: MIN_CONTEXT_ROWS,
    select: { id: true, role: true, content: true, toolName: true, toolError: true, toolResult: true },
  })
  rows.reverse()
  const canonical = fromDbRows(rows)
  console.log(`[chat-snapshot] sid=${sessionId.slice(0, 8)} db-only rows=${canonical.length} anchor=${cutoffMessageId?.slice(0, 12) ?? 'none'}`)

  return {
    xml: formatXml(canonical),
    rowCount: canonical.length,
    cutoffMessageId: cutoffMessageId ?? null,
    cutoffAt,
  }
}
