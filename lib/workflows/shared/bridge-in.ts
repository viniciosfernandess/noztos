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

interface CanonicalRow {
  role: 'user' | 'assistant' | 'tool' | 'thinking' | 'system'
  text: string
  toolName?: string
  toolError?: boolean
  toolResult?: string
}

// ── Adapter 1: ring buffer raw events → CanonicalRow[] ─────────────

interface RingEventEnvelope {
  type?: string
  payload?: {
    bornastarSessionId?: string
    event?: {
      type?: string
      message?: {
        content?: Array<{
          type?: string
          text?: string
          thinking?: string
          name?: string
          id?: string
          tool_use_id?: string
          content?: string | Array<{ type: string; text: string }>
          is_error?: boolean
        }>
      }
    }
    persistRows?: Array<{
      id: string
      role: string
      content?: string
      toolName?: string
      toolInput?: unknown
      toolResult?: string
      toolError?: boolean
    }>
  }
}

// Returns parsed canonical rows + the set of stable ids those rows came
// from. The id set is what the DB query uses to skip duplicates when we
// fall through to complement.
function fromRingEvents(events: unknown[], sessionId: string): { rows: CanonicalRow[]; ids: Set<string> } {
  const out: CanonicalRow[] = []
  const ids = new Set<string>()
  // Track tool_use → tool_result mapping by id within the stream.
  const toolByUseId = new Map<string, CanonicalRow>()

  for (const raw of events) {
    const env = raw as RingEventEnvelope
    if (env?.type !== 'claude_event') continue
    if (env.payload?.bornastarSessionId !== sessionId) continue

    // Path A: persistRows (daemon-stamped, structured) — preferred
    if (Array.isArray(env.payload?.persistRows) && env.payload.persistRows.length > 0) {
      for (const r of env.payload.persistRows) {
        if (!r?.role) continue
        if (r.id) ids.add(r.id)
        const role = r.role as CanonicalRow['role']
        if (role === 'tool') {
          out.push({
            role: 'tool',
            text: r.content ?? '',
            toolName: r.toolName,
            toolError: r.toolError,
            toolResult: typeof r.toolResult === 'string' ? r.toolResult : undefined,
          })
        } else if (role === 'thinking') {
          out.push({ role: 'thinking', text: r.content ?? '' })
        } else if (role === 'user' || role === 'assistant' || role === 'system') {
          out.push({ role, text: r.content ?? '' })
        }
      }
      continue
    }

    // Path B: parse the inner Claude event (when persistRows is absent)
    const inner = env.payload?.event
    if (!inner) continue
    if (inner.type === 'assistant' && inner.message?.content) {
      for (const block of inner.message.content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          out.push({ role: 'assistant', text: block.text })
        } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
          out.push({ role: 'thinking', text: block.thinking })
        } else if (block.type === 'tool_use' && block.id && block.name) {
          const row: CanonicalRow = { role: 'tool', text: '', toolName: block.name }
          out.push(row)
          toolByUseId.set(block.id, row)
        }
      }
    }
    if (inner.type === 'user' && inner.message?.content) {
      for (const block of inner.message.content) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          const row = toolByUseId.get(block.tool_use_id)
          if (row) {
            const text = typeof block.content === 'string'
              ? block.content
              : Array.isArray(block.content)
                ? block.content.map((c) => c.text).join('\n')
                : ''
            row.toolResult = text
            row.toolError = block.is_error ?? false
          }
        }
      }
    }
  }
  return { rows: out, ids }
}

// ── Adapter 2: DB rows → CanonicalRow[] ─────────────────────────────

interface DbRow {
  role: string
  content: string
  toolName: string | null
  toolError: boolean
  toolResult: unknown
}

function fromDbRows(rows: DbRow[]): CanonicalRow[] {
  return rows.map((r) => {
    const role = r.role as CanonicalRow['role']
    return {
      role,
      text: r.content ?? '',
      toolName: r.toolName ?? undefined,
      toolError: r.toolError ?? undefined,
      toolResult: typeof r.toolResult === 'string' ? r.toolResult : undefined,
    }
  })
}

// ── Single formatter (XML output) ──────────────────────────────────

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function formatLine(row: CanonicalRow): string {
  if (row.role === 'tool') {
    const status = row.toolError ? ' status="error"' : ''
    const inner: string[] = []
    if (row.text) inner.push(`    <label>${escapeXml(row.text)}</label>`)
    if (row.toolResult) inner.push(`    <result>${escapeXml(row.toolResult)}</result>`)
    return `  <tool name="${escapeXml(row.toolName ?? 'unknown')}"${status}>\n${inner.join('\n')}\n  </tool>`
  }
  if (row.role === 'thinking') return `  <thinking>${escapeXml(row.text)}</thinking>`
  if (row.role === 'system')   return `  <system>${escapeXml(row.text)}</system>`
  return `  <${row.role}>${escapeXml(row.text)}</${row.role}>`
}

function formatXml(rows: CanonicalRow[]): string {
  if (rows.length === 0) return ''
  return `<chat_context>\n${rows.map(formatLine).join('\n')}\n</chat_context>`
}

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
