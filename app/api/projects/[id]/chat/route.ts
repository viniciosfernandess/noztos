import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'
import { callChat } from '@/lib/anthropic'

interface RouteContext {
  params: Promise<{ id: string }>
}

// GET /api/projects/[id]/chat — list chat messages
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
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
    take: 100,
  })

  return NextResponse.json(messages)
}

// POST /api/projects/[id]/chat — send a message
export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) {
    return NextResponse.json({ error: access.error }, { status: access.status })
  }

  let body: { content?: string }
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

  // Save user message
  const userMessage = await prisma.chatMessage.create({
    data: {
      projectId: id,
      userId: access.userId,
      content,
      sender: 'user',
      mode: 'no_skill',
    },
    select: { id: true, content: true, sender: true, mode: true, createdAt: true },
  })

  // Get user's Anthropic token for the API call
  const user = await prisma.user.findUnique({
    where: { id: access.userId },
    select: { anthropicToken: true },
  })

  let aiContent: string
  if (user?.anthropicToken) {
    try {
      aiContent = await callChat(user.anthropicToken, content)
    } catch {
      aiContent = 'Sorry, I encountered an error processing your message. Please try again.'
    }
  } else {
    aiContent = 'Please connect your Anthropic account first to chat with AI.'
  }

  const aiMessage = await prisma.chatMessage.create({
    data: {
      projectId: id,
      userId: access.userId,
      content: aiContent,
      sender: 'claude',
      mode: 'no_skill',
    },
    select: { id: true, content: true, sender: true, mode: true, createdAt: true },
  })

  return NextResponse.json({ userMessage, aiMessage }, { status: 201 })
}
