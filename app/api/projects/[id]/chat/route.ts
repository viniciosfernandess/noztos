import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'
import { processChat, processChatSync } from '@/lib/chat-engine'

interface RouteContext {
  params: Promise<{ id: string }>
}

// GET — list chat messages
export async function GET(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) {
    return NextResponse.json({ error: access.error }, { status: access.status })
  }

  const messages = await prisma.chatMessage.findMany({
    where: { projectId: id },
    select: {
      id: true,
      content: true,
      sender: true,
      mode: true,
      activeSkillId: true,
      report: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
    take: 100,
  })

  return NextResponse.json(messages)
}

// POST — send a message
export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) {
    return NextResponse.json({ error: access.error }, { status: access.status })
  }

  let body: {
    content?: string
    mode?: 'no_skill' | 'skill' | 'team'
    activeSkillId?: string
    activeTeamId?: string
    teamConfig?: {
      order: string[]
      canRecreateTasks: Record<string, string>
      hasBuilder: boolean
    }
    isBuild?: boolean
    sessionId?: string
    model?: string
    thinkingBudget?: number
  }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const content = body.content?.trim()
  if (!content) {
    return NextResponse.json({ error: 'Message content is required' }, { status: 400 })
  }

  if (content.length > 10000) {
    return NextResponse.json({ error: 'Message too long (max 10000 chars)' }, { status: 400 })
  }

  const chatReq = {
    projectId: id,
    userId: access.userId,
    content,
    mode: body.mode ?? 'no_skill' as const,
    activeSkillId: body.activeSkillId,
    activeTeamId: body.activeTeamId,
    teamConfig: body.teamConfig,
    isBuild: body.isBuild ?? false,
    sessionId: body.sessionId,
    model: body.model,
    thinkingBudget: body.thinkingBudget,
  }

  if (body.mode === 'team') {
    // Team mode: save user message, start processing in background, return immediately
    const userMessage = await prisma.chatMessage.create({
      data: {
        projectId: id,
        userId: access.userId,
        sessionId: body.sessionId ?? null,
        content,
        sender: 'user',
        mode: 'team',
        activeSkillId: body.activeSkillId ?? null,
      },
      select: { id: true, content: true, sender: true, mode: true, activeSkillId: true, report: true, createdAt: true },
    })

    // Fire and forget — process in background
    processChat(chatReq).catch((err) => {
      console.error('[chat-engine] Team processing error:', err)
    })

    return NextResponse.json({
      userMessage,
      processing: true,
      pollUrl: `/api/projects/${id}/chat/status?after=${new Date().toISOString()}`,
    }, { status: 202 })
  }

  // No-skill and skill mode: process synchronously
  const result = await processChatSync(chatReq)
  return NextResponse.json(result, { status: 201 })
}
