import { Prisma } from '@/generated/prisma/client'
import { prisma } from '@/lib/db'

// ── Chat message persistence helpers ─────────────────────────────────
//
// Shared between two entry points:
//   /api/companion/sync-messages → daemon's SQLite queue drain
//   /api/companion/response      → server-side write-through while
//                                  events are still flowing on SSE
//
// Both call persistRows() with the same PersistRow shape and the same
// stable ids; the underlying Prisma upsert guarantees idempotency so
// a row that arrives via both paths lands once.

export interface PersistRow {
  id: string
  role: 'user' | 'assistant' | 'thinking' | 'tool' | 'system'
  content?: string
  toolName?: string
  toolInput?: unknown
  toolResult?: unknown
  toolUseId?: string
  toolError?: boolean
  parentMessageId?: string
  editOfMessageId?: string
  wasInterrupted?: boolean
  wasRegenerated?: boolean
  costUsd?: number
  durationMs?: number
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreateTokens?: number
  model?: string
  permissionMode?: string
  claudeSessionId?: string
  createdAt?: number
}

interface SessionContext {
  sessionId: string
  projectId: string
  userId: string
  worktreeId: string | null
  priorClaudeSession: string | null
  // When the chat has been soft-deleted (user hit delete-forever, or
  // trash TTL expired), we keep accepting in-flight events from the
  // daemon queue so the audit/training dataset stays complete. The
  // rows created here are stamped with this timestamp so they land
  // hidden-from-UI, mirroring the other messages of the deleted chat.
  sessionDeletedAt: Date | null
}

// Look up the session + validate ownership. Returns null only when
// the session does not exist or belongs to someone else.
//
// projectId is NOT an input — we derive it from the DB row. The daemon
// tags relay frames with its own hex project id (from
// ~/.bornastar/config.json) which has no relationship to the DB cuid.
//
// A soft-deleted session is accepted: any event the daemon was still
// carrying at delete time is persisted with the session's deletedAt
// so it stays visible for training but hidden from the UI.
export async function loadSessionContext(
  sessionId: string,
  userId: string,
): Promise<SessionContext | null> {
  const session = await prisma.chatSession.findUnique({
    where: { id: sessionId },
    select: {
      projectId: true, userId: true, worktreeId: true,
      deletedAt: true, status: true, claudeSessionId: true,
    },
  })
  if (!session) return null
  if (session.userId !== userId) return null
  return {
    sessionId,
    projectId: session.projectId,
    userId,
    worktreeId: session.worktreeId ?? null,
    priorClaudeSession: session.claudeSessionId ?? null,
    sessionDeletedAt: session.deletedAt,
  }
}

// Run `op` retrying on Postgres serialization / deadlock errors. Under
// heavy concurrent write-through for the same chat we occasionally see
// 40P01 (deadlock detected) — the advisory lock trims most cycles but
// cannot cover every row-level lock race between concurrent upserts
// and rollup updates. Retries are cheap; the operation is idempotent.
async function withDeadlockRetry<T>(op: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await op()
    } catch (err) {
      lastErr = err
      const maybeCode = (err as { code?: string }).code
      const metaCode = (err as { meta?: { code?: string } }).meta?.code
      const msg = (err as Error)?.message ?? ''
      const isDeadlock = maybeCode === '40P01' || metaCode === '40P01' || msg.includes('deadlock detected')
      if (!isDeadlock || attempt === maxAttempts) throw err
      const backoffMs = 50 + Math.floor(Math.random() * 100 * attempt)
      console.warn(`[chat-persist] deadlock retry ${attempt}/${maxAttempts} in ${backoffMs}ms`)
      await new Promise((r) => setTimeout(r, backoffMs))
    }
  }
  throw lastErr
}

// Upsert a batch of rows for a single session and update the session
// rollup (cost / tokens / turn count / lastMessageAt / claudeSessionId).
// Caller is responsible for bucketing rows by session and validating
// ownership via loadSessionContext() first.
export async function persistRows(
  rows: PersistRow[],
  ctx: SessionContext,
): Promise<{ persisted: number }> {
  if (rows.length === 0) return { persisted: 0 }

  // A single row can reach Supabase from two lanes concurrently:
  //   - server write-through (hot path, within a few ms of the stream)
  //   - daemon sync-messages (durable, retried)
  // Upserts-by-id are already idempotent. The rollup is NOT — two
  // concurrent calls for the same new row would both see it missing
  // in the existence check and both increment totalCostUsd. We
  // serialise per-session with a Postgres advisory lock: cheap, no
  // schema change, bounded to the session so cross-session traffic is
  // unaffected. `hashtextextended` gives us a 64-bit key space so
  // collisions between unrelated session ids are effectively zero.
  return await withDeadlockRetry(() => prisma.$transaction(async (tx) => {
    // $executeRaw (not $queryRaw) because pg_advisory_xact_lock returns
    // void — $queryRaw fails to deserialize the void column, tanking the
    // whole transaction and every downstream upsert along with it.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.sessionId}, 0))`

    const existing = await tx.chatMessage.findMany({
      where: { id: { in: rows.map((r) => r.id) } },
      select: { id: true },
    })
    const alreadyPersisted = new Set(existing.map((e) => e.id))

    let rolledCost = 0
    let rolledTokens = 0
    let turnsDelta = 0
    let latestClaudeSession: string | undefined
    let compactionSeen = false

    for (const e of rows) {
      // Claude rotates its session id on auto-compact — every time the
      // server-side CLI drops context, a new id shows up. Mark surviving
      // rows so the UI can draw a divider before them.
      if (e.claudeSessionId && ctx.priorClaudeSession && e.claudeSessionId !== ctx.priorClaudeSession) {
        compactionSeen = true
      }

      const updateData: Prisma.ChatMessageUncheckedUpdateInput = buildUpdate(e, compactionSeen)
      const createData: Prisma.ChatMessageUncheckedCreateInput = {
        id: e.id,
        sessionId: ctx.sessionId,
        projectId: ctx.projectId,
        userId: ctx.userId,
        worktreeId: ctx.worktreeId,
        role: e.role,
        content: e.content ?? '',
        ...(e.createdAt && { createdAt: new Date(e.createdAt) }),
        // Inherit the session's deletedAt so late-arriving events from
        // a chat the user already deleted land hidden (not in the UI,
        // still in the training dataset).
        ...(ctx.sessionDeletedAt && { deletedAt: ctx.sessionDeletedAt }),
        ...buildCreate(e, compactionSeen),
      }

      await tx.chatMessage.upsert({
        where: { id: e.id },
        create: createData,
        update: updateData,
      })

      // Only newly-inserted rows contribute to the rollup — the
      // advisory lock makes this observation race-free.
      if (!alreadyPersisted.has(e.id)) {
        if (typeof e.costUsd === 'number') rolledCost += e.costUsd
        const turnTokens = (e.inputTokens ?? 0) + (e.outputTokens ?? 0)
        if (turnTokens) rolledTokens += turnTokens
        if (e.role === 'system' && typeof e.costUsd === 'number') turnsDelta += 1
      }
      if (e.claudeSessionId) latestClaudeSession = e.claudeSessionId
    }

    await tx.chatSession.update({
      where: { id: ctx.sessionId },
      data: {
        ...(rolledCost > 0 && { totalCostUsd: { increment: rolledCost } }),
        ...(rolledTokens > 0 && { totalTokens: { increment: rolledTokens } }),
        ...(turnsDelta > 0 && { numTurns: { increment: turnsDelta } }),
        ...(latestClaudeSession && { claudeSessionId: latestClaudeSession }),
        lastMessageAt: new Date(),
      },
    })

    return { persisted: rows.length }
  }, {
    // Default is 5s, too tight for a 50-row batch over cross-region
    // Supabase + the advisory lock + the up-front findMany. 30s gives
    // enough slack without hiding genuine deadlocks.
    timeout: 30_000,
    // Wait up to 10s for the transaction to start (matters under
    // backlog when multiple retries compete for connection pool slots).
    maxWait: 10_000,
  }))
}

function buildUpdate(e: PersistRow, compactionSeen: boolean): Prisma.ChatMessageUncheckedUpdateInput {
  return {
    role: e.role,
    // Only overwrite content when the incoming row actually carries it.
    // Tool-result updates arrive with no content so they shouldn't clobber
    // the "Using <tool>" label the tool_use row set when it was created.
    ...(e.content !== undefined && e.content !== '' && { content: e.content }),
    toolName: e.toolName ?? undefined,
    toolInput: e.toolInput === undefined ? undefined : (e.toolInput as Prisma.InputJsonValue),
    toolResult: e.toolResult === undefined ? undefined : (e.toolResult as Prisma.InputJsonValue),
    toolUseId: e.toolUseId ?? undefined,
    toolError: e.toolError === undefined ? undefined : e.toolError,
    parentMessageId: e.parentMessageId ?? undefined,
    editOfMessageId: e.editOfMessageId ?? undefined,
    wasInterrupted: e.wasInterrupted === undefined ? undefined : e.wasInterrupted,
    wasRegenerated: e.wasRegenerated === undefined ? undefined : e.wasRegenerated,
    wasCompacted: compactionSeen ? true : undefined,
    costUsd: e.costUsd ?? undefined,
    durationMs: e.durationMs ?? undefined,
    inputTokens: e.inputTokens ?? undefined,
    outputTokens: e.outputTokens ?? undefined,
    cacheReadTokens: e.cacheReadTokens ?? undefined,
    cacheCreateTokens: e.cacheCreateTokens ?? undefined,
    model: e.model ?? undefined,
    permissionMode: e.permissionMode ?? undefined,
    claudeSessionId: e.claudeSessionId ?? undefined,
  }
}

function buildCreate(e: PersistRow, compactionSeen: boolean): Partial<Prisma.ChatMessageUncheckedCreateInput> {
  return {
    toolName: e.toolName ?? undefined,
    toolInput: e.toolInput === undefined ? undefined : (e.toolInput as Prisma.InputJsonValue),
    toolResult: e.toolResult === undefined ? undefined : (e.toolResult as Prisma.InputJsonValue),
    toolUseId: e.toolUseId ?? undefined,
    toolError: e.toolError ?? undefined,
    parentMessageId: e.parentMessageId ?? undefined,
    editOfMessageId: e.editOfMessageId ?? undefined,
    wasInterrupted: e.wasInterrupted ?? undefined,
    wasRegenerated: e.wasRegenerated ?? undefined,
    wasCompacted: compactionSeen,
    costUsd: e.costUsd ?? undefined,
    durationMs: e.durationMs ?? undefined,
    inputTokens: e.inputTokens ?? undefined,
    outputTokens: e.outputTokens ?? undefined,
    cacheReadTokens: e.cacheReadTokens ?? undefined,
    cacheCreateTokens: e.cacheCreateTokens ?? undefined,
    model: e.model ?? undefined,
    permissionMode: e.permissionMode ?? undefined,
    claudeSessionId: e.claudeSessionId ?? undefined,
  }
}
