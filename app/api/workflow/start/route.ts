// POST /api/workflow/start
//
// Dispatches a Workflow run. Body:
//   {
//     sessionId: string         // chat session
//     userMessage: string       // task (parte depois do trigger)
//     workflowType?: 'builder' | 'debug'  // default: 'builder' (legacy)
//     mode?: 'ask' | 'agent'    // default: 'agent'
//   }
//
// Resolve projectPath via session.worktree (ou main project path).
// Retorna { runId } imediatamente; orquestrador roda fire-and-forget.
// UI faz poll em /api/workflow/[runId] pra acompanhar.

import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { getSessionUserId } from '@/lib/session'
import { prisma } from '@/lib/db'
import { startBuilderWorkflow } from '@/lib/workflows/builder/runner'
import { startDebugWorkflow } from '@/lib/workflows/debug/runner'
import type { WorkflowType } from '@/lib/workflows/shared/types'
import { promises as fs } from 'node:fs'

export const maxDuration = 30  // só pra resposta inicial — orquestrador roda fire-and-forget

export async function POST(request: NextRequest) {
  const cookieStore = await cookies()
  const userId = getSessionUserId(cookieStore.get('session')?.value)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { sessionId?: string; userMessage?: string; workflowType?: WorkflowType; mode?: 'ask' | 'agent'; userMsgId?: string }
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  if (!body.sessionId || !body.userMessage) {
    return NextResponse.json({ error: 'sessionId and userMessage required' }, { status: 400 })
  }
  const userMessage = body.userMessage.trim()
  if (userMessage.length === 0) {
    return NextResponse.json({ error: 'userMessage cannot be empty' }, { status: 400 })
  }
  const workflowType: WorkflowType = body.workflowType ?? 'builder'
  if (workflowType !== 'builder' && workflowType !== 'debug') {
    return NextResponse.json({ error: `Unknown workflowType: ${workflowType}` }, { status: 400 })
  }

  // Resolve session + worktree
  const session = await prisma.chatSession.findFirst({
    where: { id: body.sessionId, userId, deletedAt: null },
    select: {
      id: true,
      projectId: true,
      project: { select: { id: true, name: true } },
      worktree: { select: { id: true, worktreePath: true } },
    },
  })
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 })

  // Resolve projectPath:
  //   - If session has worktree: use worktreePath (já é absoluto)
  //   - Else: workflow precisa rodar em alguma lugar; em V1 reject (main-state chats não suportam workflow)
  let projectPath: string
  if (session.worktree?.worktreePath) {
    projectPath = session.worktree.worktreePath
  } else {
    return NextResponse.json({
      error: 'Workflows require a worktree-scoped chat. Crie um worktree pra esta tarefa.',
    }, { status: 400 })
  }

  // Sanity check
  try {
    await fs.stat(projectPath)
  } catch {
    return NextResponse.json({
      error: `Project path not accessible: ${projectPath}`,
    }, { status: 400 })
  }

  console.log(`[api/workflow/start] session=${session.id.slice(0, 8)} type=${workflowType} mode=${body.mode ?? 'agent'} userMsgBytes=${userMessage.length} projectPath=${projectPath}`)

  try {
    const dispatcherInput = {
      sessionId: session.id,
      userId,
      projectId: session.projectId,
      workflowType,
      userMessage,
      mode: body.mode ?? 'agent',
      projectPath,
      userMsgId: body.userMsgId,
    }
    const { runId } = workflowType === 'debug'
      ? await startDebugWorkflow(dispatcherInput)
      : await startBuilderWorkflow(dispatcherInput)
    return NextResponse.json({ ok: true, runId })
  } catch (err) {
    console.error(`[api/workflow/start] failed:`, (err as Error).message)
    return NextResponse.json({ error: (err as Error).message }, { status: 400 })
  }
}
