import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@/generated/prisma/client'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'

// ── Claude Code conversation persistence ──────────────────────────────
//
// Each stream-json event Claude Code emits during a chat turn (user
// prompt, assistant text, tool_use, tool_result, final result) lands
// here as a single ChatMessage row. GET replays them so the UI can
// restore state after a refresh; POST appends new events as they arrive.

interface RouteContext {
  params: Promise<{ id: string; sessionId: string }>
}

// Writes can burst during streaming (dozens of events per turn). 600/min
// ≈ 10/sec gives plenty of headroom for a legitimate session while
// cutting off a runaway client. Reads are generous since tab focus /
// initial mount issues GETs in rapid succession.
const writeLimiter = rateLimit({ tokensPerInterval: 600, intervalMs: 60_000 }, 'chat-messages-write')
const readLimiter  = rateLimit({ tokensPerInterval: 300, intervalMs: 60_000 }, 'chat-messages-read')

// Tool inputs/outputs can contain file contents legitimately — allow 50MB
// bodies so a Write/Edit of a big file still persists. Individual payloads
// larger than this are rejected outright (malicious or ballooning bug).
const MAX_BODY_BYTES = 50 * 1024 * 1024

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
  // archived, trashed, or deleted chat must be restored before its
  // messages become readable again. Covers both the `status` flag and
  // the hard-deleted-at timestamp.
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

// POST — append one or more events.
export async function POST(request: NextRequest, context: RouteContext) {
  const { id, sessionId } = await context.params
  const auth = await verifyProjectAccess(id)
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  if (!writeLimiter.take(auth.userId)) {
    return NextResponse.json({ error: 'Rate limited' }, { status: 429 })
  }

  // Reject huge payloads early — avoids pulling 200MB of JSON into
  // memory just to 500 on validation.
  const contentLength = parseInt(request.headers.get('content-length') ?? '0', 10)
  if (contentLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: `Payload too large (max ${MAX_BODY_BYTES} bytes)` }, { status: 413 })
  }

  const session = await prisma.chatSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true, projectId: true, userId: true, status: true,
      worktreeId: true, deletedAt: true, claudeSessionId: true,
    },
  })
  // Only accept writes on an open chat. Trying to append to an archived
  // / trashed / deleted session is always a stale client — reject so we
  // don't corrupt the audit trail.
  if (!session || session.projectId !== id || session.userId !== auth.userId
    || session.deletedAt || session.status !== 'open') {
    return NextResponse.json({ error: 'Session not found or closed' }, { status: 404 })
  }

  type Incoming = {
    id?: string
    clientCreatedAt?: number
    role: 'user' | 'assistant' | 'tool' | 'system'
    content: string
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
  }

  const body = await request.json() as { event?: Incoming; events?: Incoming[] }
  const events: Incoming[] = body.events ?? (body.event ? [body.event] : [])
  if (events.length === 0) {
    return NextResponse.json({ error: 'No events provided' }, { status: 400 })
  }

  const savedIds: string[] = []
  let rolledCost = 0
  let rolledTokens = 0
  let turnsDelta = 0
  let latestClaudeSessionId: string | undefined
  // Track first-time claude session change so we can flag compaction
  // boundaries. If an event claims a NEW session id that doesn't match
  // what the chat had before, the prior context was discarded — useful
  // for training data filters.
  const priorClaudeSession = session.claudeSessionId
  let compactionDetected = false

  for (const e of events) {
    const createdAt = e.clientCreatedAt
      ? new Date(e.clientCreatedAt)
      : undefined

    if (e.claudeSessionId && priorClaudeSession && e.claudeSessionId !== priorClaudeSession) {
      compactionDetected = true
    }

    const updateData: Prisma.ChatMessageUncheckedUpdateInput = {
      role: e.role,
      content: e.content,
      toolName: e.toolName ?? undefined,
      toolInput: e.toolInput === undefined ? undefined : (e.toolInput as Prisma.InputJsonValue),
      toolResult: e.toolResult === undefined ? undefined : (e.toolResult as Prisma.InputJsonValue),
      toolUseId: e.toolUseId ?? undefined,
      toolError: e.toolError === undefined ? undefined : e.toolError,
      parentMessageId: e.parentMessageId ?? undefined,
      editOfMessageId: e.editOfMessageId ?? undefined,
      wasInterrupted: e.wasInterrupted === undefined ? undefined : e.wasInterrupted,
      wasRegenerated: e.wasRegenerated === undefined ? undefined : e.wasRegenerated,
      wasCompacted: compactionDetected ? true : undefined,
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
    const createData: Prisma.ChatMessageUncheckedCreateInput = {
      sessionId,
      projectId: id,
      userId: auth.userId,
      worktreeId: session.worktreeId,
      role: e.role,
      content: e.content,
      ...(createdAt && { createdAt }),
      toolName: e.toolName ?? undefined,
      toolInput: e.toolInput === undefined ? undefined : (e.toolInput as Prisma.InputJsonValue),
      toolResult: e.toolResult === undefined ? undefined : (e.toolResult as Prisma.InputJsonValue),
      toolUseId: e.toolUseId ?? undefined,
      toolError: e.toolError ?? undefined,
      parentMessageId: e.parentMessageId ?? undefined,
      editOfMessageId: e.editOfMessageId ?? undefined,
      wasInterrupted: e.wasInterrupted ?? undefined,
      wasRegenerated: e.wasRegenerated ?? undefined,
      wasCompacted: compactionDetected,
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

    let saved
    if (e.id) {
      saved = await prisma.chatMessage.upsert({
        where: { id: e.id },
        create: { id: e.id, ...createData },
        update: updateData,
      })
    } else {
      saved = await prisma.chatMessage.create({ data: createData })
    }
    savedIds.push(saved.id)

    if (typeof e.costUsd === 'number') rolledCost += e.costUsd
    const turnTokens = (e.inputTokens ?? 0) + (e.outputTokens ?? 0)
    if (turnTokens) rolledTokens += turnTokens
    if (e.role === 'system' && typeof e.costUsd === 'number') turnsDelta += 1
    if (e.claudeSessionId) latestClaudeSessionId = e.claudeSessionId
  }

  // Roll-up on the session for cheap sidebar rendering.
  await prisma.chatSession.update({
    where: { id: sessionId },
    data: {
      ...(rolledCost > 0 && { totalCostUsd: { increment: rolledCost } }),
      ...(rolledTokens > 0 && { totalTokens: { increment: rolledTokens } }),
      ...(turnsDelta > 0 && { numTurns: { increment: turnsDelta } }),
      ...(latestClaudeSessionId && { claudeSessionId: latestClaudeSessionId }),
      lastMessageAt: new Date(),
    },
  })

  return NextResponse.json({ ok: true, ids: savedIds, compactionDetected })
}

// DELETE — soft delete every message in the session. Keeps the audit
// trail intact; only flips deletedAt so future GETs ignore them.
export async function DELETE(_request: NextRequest, context: RouteContext) {
  const { id, sessionId } = await context.params
  const auth = await verifyProjectAccess(id)
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const session = await prisma.chatSession.findUnique({
    where: { id: sessionId },
    select: { projectId: true, userId: true },
  })
  if (!session || session.projectId !== id || session.userId !== auth.userId) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  }

  const now = new Date()
  await prisma.chatMessage.updateMany({
    where: { sessionId, userId: auth.userId, deletedAt: null },
    data: { deletedAt: now },
  })
  return NextResponse.json({ ok: true })
}
