// Bridge IN — chat history → XML pro Planner.
//
// Estratégia: **cache primary com complemento do DB**.
//
// 1. Lê ring buffer (RAM, ~0ms).
// 2. Se ring atende o threshold mínimo de contexto → retorna direto,
//    sem tocar no DB. Chat ativo cai aqui — cache fast-path.
// 3. Se ring tem pouco ou nada → DB query (LIMIT MIN_CONTEXT_ROWS) pra
//    complementar. Dedupe por id estável evita repetir o que ring já tem.
// 4. Retorna o que tem (mesmo se vazio).
//
// Mantém o padrão do projeto: cache primary, DB durabilidade. Resolve
// o cenário "ring quase-vazio" (1 frame com a trigger msg) que antes
// fazia o Planner correr sem o histórico real do chat.
//
// Output: XML wrapped em <chat_context>...</chat_context>. Sem modelo
// na crítica, wait time = 0.
//
// Quem usa: APENAS o Planner (Phase 0). Outros agents não veem chat raw.

import { prisma } from '@/lib/db'
import { getSessionBuffer } from '@/lib/companion-relay'
import { fromRingEvents, fromDbRows, formatXml, type CanonicalRow } from '@/lib/chat-context-helpers'

// ── Cache primary with DB complement ───────────────────────────────

const MIN_CONTEXT_ROWS = 30

export async function buildBridgeInContext(sessionId: string, userId: string): Promise<string> {
  // ── Tier 1: ring buffer (cache primary, ~0ms) ────────────────────
  let ringRows: CanonicalRow[] = []
  let ringIds = new Set<string>()
  try {
    const events = getSessionBuffer(sessionId, userId)
    if (events && events.length > 0) {
      const parsed = fromRingEvents(events, sessionId)
      ringRows = parsed.rows
      ringIds = parsed.ids
    }
  } catch (err) {
    console.warn(`[bridge-in] sid=${sessionId.slice(0, 8)} ring error:`, (err as Error).message)
  }

  // Cache satisfies the threshold → return without touching DB. Active
  // chats with rich history hit this path and pay zero DB cost.
  if (ringRows.length >= MIN_CONTEXT_ROWS) {
    console.log(`[bridge-in] sid=${sessionId.slice(0, 8)} cache-hit rows=${ringRows.length} threshold=${MIN_CONTEXT_ROWS}`)
    return formatXml(ringRows)
  }

  // ── Tier 2: DB complement ────────────────────────────────────────
  // Ring had less than the threshold (or nothing). Pull up to
  // MIN_CONTEXT_ROWS from DB, skipping rows whose ids are already in the
  // ring. Dev-server restarts, gap >24h, and multi-instance all land here.
  let dbRows: CanonicalRow[] = []
  try {
    const rawDb = await prisma.chatMessage.findMany({
      where: {
        sessionId,
        deletedAt: null,
        ...(ringIds.size > 0 && { id: { notIn: [...ringIds] } }),
      },
      orderBy: { createdAt: 'desc' },
      take: MIN_CONTEXT_ROWS,
      select: {
        id: true,
        role: true,
        content: true,
        toolName: true,
        toolError: true,
        toolResult: true,
      },
    })
    rawDb.reverse()
    dbRows = fromDbRows(rawDb)
  } catch (err) {
    console.warn(`[bridge-in] sid=${sessionId.slice(0, 8)} DB error:`, (err as Error).message)
  }

  // DB rows are older (history); ring rows are fresher (live tip). Order
  // matters for chronology in the rendered XML.
  const merged = [...dbRows, ...ringRows]
  console.log(`[bridge-in] sid=${sessionId.slice(0, 8)} complemented ring=${ringRows.length} db=${dbRows.length} total=${merged.length} threshold=${MIN_CONTEXT_ROWS}`)
  return merged.length > 0 ? formatXml(merged) : ''
}
