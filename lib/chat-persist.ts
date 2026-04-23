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
}

// Look up the session + validate ownership in a single round trip.
// Returns null if the session is missing, foreign, or soft-deleted.
export async function loadSessionContext(
  sessionId: string,
  projectId: string,
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
  if (session.userId !== userId || session.projectId !== projectId) return null
  if (session.deletedAt) return null
  return {
    sessionId,
    projectId,
    userId,
    worktreeId: session.worktreeId ?? null,
    priorClaudeSession: session.claudeSessionId ?? null,
  }
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
  return await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.sessionId}, 0))`

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
  })
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
