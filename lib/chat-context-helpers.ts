// Shared parsers + formatter for chat context assembly.
//
// Two consumers today:
//   1. Bridge IN (workflow chat → workflow handoff) — reads the live
//      tip via ring buffer, complements with DB when ring is thin.
//   2. buildChatSnapshot (task creation from chat) — anchors on a
//      specific message id, reads ring first if anchor is there,
//      falls back to DB-by-anchor otherwise.
//
// Both turn raw daemon events / DB rows into a uniform CanonicalRow[]
// and serialize to the same `<chat_context>...</chat_context>` XML
// the downstream agents are prompted to read. Living in one module
// means the two flows stay byte-equivalent: workflow-from-chat and
// task-from-chat produce shape-identical context, so no downstream
// agent needs to care which caller assembled it.
//
// Adding a third consumer? Reuse fromRingEvents + fromDbRows + the
// formatter and you're done — don't reinvent the canonical shape.

export interface CanonicalRow {
  id?: string                   // stable id when known (used for anchor lookup + dedupe)
  role: 'user' | 'assistant' | 'tool' | 'thinking' | 'system'
  text: string
  toolName?: string
  toolError?: boolean
  toolResult?: string
}

// ── Ring buffer adapter ────────────────────────────────────────────

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

/**
 * Parse a stream of relay events for `sessionId` into canonical rows.
 *
 * Returns the rows in arrival order (oldest → newest) plus the set of
 * stable ids seen along the way. The id set is what the DB complement
 * uses to skip rows it already saw in the ring.
 */
export function fromRingEvents(events: unknown[], sessionId: string): { rows: CanonicalRow[]; ids: Set<string> } {
  const out: CanonicalRow[] = []
  const ids = new Set<string>()
  // tool_use → tool_result mapping within the stream so we can fill
  // the toolResult/toolError on the right row when it lands later.
  const toolByUseId = new Map<string, CanonicalRow>()

  for (const raw of events) {
    const env = raw as RingEventEnvelope
    if (env?.type !== 'claude_event') continue
    if (env.payload?.bornastarSessionId !== sessionId) continue

    // Path A: persistRows (daemon-stamped, structured) — preferred.
    // These carry stable ids, so they participate in anchor lookup
    // and DB dedupe.
    if (Array.isArray(env.payload?.persistRows) && env.payload.persistRows.length > 0) {
      for (const r of env.payload.persistRows) {
        if (!r?.role) continue
        if (r.id) ids.add(r.id)
        const role = r.role as CanonicalRow['role']
        if (role === 'tool') {
          out.push({
            id: r.id,
            role: 'tool',
            text: r.content ?? '',
            toolName: r.toolName,
            toolError: r.toolError,
            toolResult: typeof r.toolResult === 'string' ? r.toolResult : undefined,
          })
        } else if (role === 'thinking') {
          out.push({ id: r.id, role: 'thinking', text: r.content ?? '' })
        } else if (role === 'user' || role === 'assistant' || role === 'system') {
          out.push({ id: r.id, role, text: r.content ?? '' })
        }
      }
      continue
    }

    // Path B: parse the inner Claude event (no persistRows yet — the
    // daemon hasn't stamped its DB writes). These rows don't carry
    // stable ids; they'll dedupe against DB rows by content later if
    // needed, but for anchor lookup we rely on persistRows path.
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

// ── DB row adapter ──────────────────────────────────────────────────

export interface DbRow {
  id?: string
  role: string
  content: string | null
  toolName: string | null
  toolError: boolean
  toolResult: unknown
}

export function fromDbRows(rows: DbRow[]): CanonicalRow[] {
  return rows.map((r) => {
    const role = r.role as CanonicalRow['role']
    return {
      id: r.id,
      role,
      text: r.content ?? '',
      toolName: r.toolName ?? undefined,
      toolError: r.toolError ?? undefined,
      toolResult: typeof r.toolResult === 'string' ? r.toolResult : undefined,
    }
  })
}

// ── XML formatter ───────────────────────────────────────────────────

export function escapeXml(s: string): string {
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

export function formatXml(rows: CanonicalRow[]): string {
  if (rows.length === 0) return ''
  return `<chat_context>\n${rows.map(formatLine).join('\n')}\n</chat_context>`
}
