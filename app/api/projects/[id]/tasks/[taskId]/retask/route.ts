import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'
import { callAnthropic } from '@/lib/anthropic'

interface RouteContext {
  params: Promise<{ id: string; taskId: string }>
}

// POST — create a new task from a completed task, carrying context
export async function POST(_request: NextRequest, context: RouteContext) {
  const { id, taskId } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) return NextResponse.json({ error: access.error }, { status: access.status })

  // Load parent task
  const parentTask = await prisma.task.findFirst({
    where: { id: taskId, projectId: id },
    include: { user: { select: { anthropicToken: true } } },
  })

  if (!parentTask) return NextResponse.json({ error: 'Task not found' }, { status: 404 })

  const parentContext = parentTask.context as Record<string, unknown>
  const parentAccumulated = parentTask.accumulatedContext as Record<string, unknown>
  const parentResult = parentAccumulated.result as { summary?: string; filesTouched?: string[]; completedAt?: string } | undefined

  // ── Compact the full context (before + after) ────────────────────
  // Takes everything: old context + what was done + conclusion → one dense summary
  let compactedPreviousContext = ''

  const contextParts: string[] = []

  // Before — what was the task about
  contextParts.push('=== BEFORE (Original Task) ===')
  if (parentTask.instruction) contextParts.push(`Instructions: ${parentTask.instruction}`)
  if (parentContext.conversationSummary) contextParts.push(`Conversation context: ${parentContext.conversationSummary}`)
  if (parentContext.report) {
    const report = parentContext.report as { question?: string; conclusion?: string }
    if (report.question) contextParts.push(`Original question: ${report.question}`)
    if (report.conclusion) contextParts.push(`Report conclusion: ${report.conclusion}`)
  }

  // After — what was done
  contextParts.push('\n=== AFTER (What was done) ===')
  if (parentResult?.summary) contextParts.push(`Task conclusion: ${parentResult.summary}`)
  if (parentResult?.filesTouched && parentResult.filesTouched.length > 0) {
    contextParts.push(`Files modified: ${parentResult.filesTouched.join(', ')}`)
  }
  if (parentResult?.completedAt) contextParts.push(`Completed at: ${parentResult.completedAt}`)
  if (parentAccumulated.intent) contextParts.push(`Task type: ${parentAccumulated.intent}`)

  if (contextParts.length > 2 && parentTask.user.anthropicToken) {
    try {
      const compactResult = await callAnthropic({
        encryptedToken: parentTask.user.anthropicToken,
        systemPrompt: `You are a context compactor. Summarize the full task lifecycle below (what was requested, what context existed, what was done, and what the outcome was) into a dense, focused summary.

Keep ALL: technical decisions, file paths, architecture choices, key findings, action items, what was built, what was changed.

This summary is the ONLY context a follow-up task will have about what happened before. Be thorough but concise. Structure clearly: what was the goal, what was done, what was the result.`,
        userMessage: contextParts.join('\n\n'),
        model: 'claude-haiku-4-5-20251001',
      })
      compactedPreviousContext = compactResult.text
    } catch {
      compactedPreviousContext = contextParts.join('\n\n').slice(0, 3000)
    }
  } else {
    compactedPreviousContext = contextParts.join('\n\n').slice(0, 3000)
  }

  // ── Build execution report for new task ────────────────────────
  // Load skill logs from parent task for the execution report
  const skillLogs = await prisma.taskSkillLog.findMany({
    where: { taskId },
    select: { collaboratorName: true, conclusion: true, approved: true, finishedAt: true },
    orderBy: { startedAt: 'asc' },
  })

  const buildLogs = await prisma.taskBuildLog.findMany({
    where: { taskId },
    select: { filesTouched: true },
  })

  const executionSteps = skillLogs.map((l) => ({
    employee: l.collaboratorName,
    output: (l.conclusion ?? '').slice(0, 1000),
    approved: l.approved,
  }))

  const allFiles = buildLogs.flatMap((b) => {
    const files = b.filesTouched as { path: string; action: string }[]
    return files.map((f) => f.path)
  })

  // Build the new execution report
  const executionReport = {
    parentTaskId: taskId,
    parentTaskName: parentTask.name,
    steps: executionSteps,
    filesTouched: [...new Set(allFiles)],
    conclusion: parentResult?.summary ?? '',
    completedAt: parentResult?.completedAt ?? new Date().toISOString(),
  }

  // ── Create new task ────────────────────────────────────────────
  const newTask = await prisma.task.create({
    data: {
      projectId: id,
      userId: access.userId,
      name: `Follow-up: ${parentTask.name}`,
      status: 'pending',
      context: JSON.parse(JSON.stringify({
        source: 'chained',
        parentTaskId: taskId,
        report: executionReport,
        conversationSummary: compactedPreviousContext || undefined,
      })),
    },
    select: { id: true, name: true, status: true, createdAt: true },
  })

  return NextResponse.json(newTask, { status: 201 })
}
