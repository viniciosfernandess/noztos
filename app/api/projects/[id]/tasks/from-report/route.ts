import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) return NextResponse.json({ error: access.error }, { status: access.status })

  const body = await request.json() as { report: Record<string, unknown>; sessionId?: string }

  if (!body.report) {
    return NextResponse.json({ error: 'Report is required' }, { status: 400 })
  }

  const report = body.report
  const question = (report.question as string) ?? 'Untitled task'
  const timestamp = (report.timestamp as string) ?? ''
  const taskName = question.length > 80 ? question.slice(0, 80) + '...' : question

  // Prevent duplicate: check if a task with the same report timestamp already exists
  if (timestamp) {
    const existing = await prisma.task.findFirst({
      where: { projectId: id, context: { path: ['report', 'timestamp'], equals: timestamp } },
      select: { id: true },
    })
    if (existing) {
      return NextResponse.json({ error: 'Task already created from this report', taskId: existing.id }, { status: 409 })
    }
  }

  // Get compact summary from session if available (context is copied into task, fully isolated)
  let conversationSummary: string | null = null
  if (body.sessionId) {
    // Validate session belongs to this project
    const session = await prisma.chatSession.findFirst({
      where: { id: body.sessionId, projectId: id },
      select: { id: true },
    })
    if (!session) {
      return NextResponse.json({ error: 'Session not found in this project' }, { status: 400 })
    }

    const compactMsg = await prisma.chatMessage.findFirst({
      where: { sessionId: body.sessionId, sender: 'compact' },
      select: { content: true },
      orderBy: { createdAt: 'desc' },
    })
    if (compactMsg) {
      conversationSummary = compactMsg.content
    } else {
      // No compact summary — grab last 10 messages as mini context
      const recentMsgs = await prisma.chatMessage.findMany({
        where: {
          sessionId: body.sessionId,
          sender: { notIn: ['plan', 'step', 'compact'] },
        },
        select: { sender: true, content: true },
        orderBy: { createdAt: 'desc' },
        take: 10,
      })
      if (recentMsgs.length > 0) {
        conversationSummary = recentMsgs
          .reverse()
          .map((m) => `${m.sender}: ${m.content.length > 500 ? m.content.slice(0, 500) + '...' : m.content}`)
          .join('\n\n')
      }
    }
  }

  const task = await prisma.task.create({
    data: {
      projectId: id,
      userId: access.userId,
      name: taskName,
      status: 'pending',
      context: JSON.parse(JSON.stringify({
        report,
        conversationSummary,
      })),
    },
    select: { id: true, name: true, status: true, createdAt: true },
  })

  return NextResponse.json(task, { status: 201 })
}
