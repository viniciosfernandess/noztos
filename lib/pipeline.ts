import { prisma } from '@/lib/db'
import { callAnthropic, callAnthropicWithTools } from '@/lib/anthropic'
import { REPO_TOOLS, executeTool } from '@/lib/tools'
import type { ContentBlock, ToolCallMessage } from '@/lib/anthropic'
import { acquireRepoLock, releaseRepoLock } from '@/lib/repo-lock'

// Team Pipeline Engine
//
// Manages the state machine for executing a task through a team's
// collaborator pipeline. Each collaborator processes the task in order,
// passing their output forward to the next.
//
// When a repository is connected, collaborators get file tools
// (read_file, write_file, list_dir, search_files, delete_file)
// and run in an agentic tool loop — just like Claude Code.

interface CollaboratorOrder {
  collaboratorIds: string[]
}

interface PipelineResult {
  status: 'advanced' | 'completed' | 'rejected' | 'error'
  message: string
  skillLogId?: string
}

const MAX_TOOL_ITERATIONS = 30

/**
 * Start a new pipeline run for a task.
 */
export async function startPipeline(taskId: string): Promise<PipelineResult> {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: {
      team: true,
      user: { select: { anthropicToken: true } },
    },
  })

  if (!task) return { status: 'error', message: 'Task not found' }
  if (!task.team) return { status: 'error', message: 'Task has no team assigned' }
  if (task.status !== 'pending' && task.status !== 'queue') {
    return { status: 'error', message: `Task is in ${task.status} status, cannot start` }
  }
  if (!task.user.anthropicToken) {
    return { status: 'error', message: 'User has no Anthropic token. Connect your API key first.' }
  }

  // Acquire repo lock for this task
  const lockAcquired = await acquireRepoLock(task.projectId, 'task', taskId)
  if (!lockAcquired) {
    return { status: 'error', message: 'Repository is currently in use. Cannot start task.' }
  }

  const order = task.team.collaboratorOrder as unknown as CollaboratorOrder
  if (!order.collaboratorIds || order.collaboratorIds.length === 0) {
    return { status: 'error', message: 'Team has no collaborators in pipeline' }
  }

  const iterationCount = await prisma.taskIteration.count({ where: { taskId } })

  const iteration = await prisma.taskIteration.create({
    data: { taskId, iterationNumber: iterationCount + 1 },
  })

  await prisma.task.update({
    where: { id: taskId },
    data: {
      status: 'progress',
      pausedAtEmployee: order.collaboratorIds[0],
      pausedAtIteration: iteration.iterationNumber,
    },
  })

  return advancePipeline(taskId, iteration.id, 0, task.user.anthropicToken)
}

/**
 * Advance the pipeline to the next collaborator.
 */
export async function advancePipeline(
  taskId: string,
  iterationId: string,
  collaboratorIndex: number,
  encryptedToken: string
): Promise<PipelineResult> {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: {
      team: true,
      project: { include: { repository: true } },
    },
  })

  if (!task || !task.team) {
    return { status: 'error', message: 'Task or team not found' }
  }

  const order = task.team.collaboratorOrder as unknown as CollaboratorOrder
  const collaboratorIds = order.collaboratorIds

  if (collaboratorIndex >= collaboratorIds.length) {
    await prisma.task.update({
      where: { id: taskId },
      data: { status: 'completed', pausedAtEmployee: null },
    })
    await releaseRepoLock(task.projectId, 'task')
    return { status: 'completed', message: 'Pipeline complete' }
  }

  const collaboratorId = collaboratorIds[collaboratorIndex]
  const collaborator = await prisma.collaborator.findUnique({
    where: { id: collaboratorId },
    select: { id: true, name: true, phase: true, skillMd: true },
  })

  if (!collaborator) {
    return { status: 'error', message: `Collaborator ${collaboratorId} not found` }
  }

  // Get previous output as input
  let inputReceived: string | null = null
  if (collaboratorIndex > 0) {
    const prevLog = await prisma.taskSkillLog.findFirst({
      where: { taskId, iterationId, collaboratorId: collaboratorIds[collaboratorIndex - 1] },
      select: { passedForward: true },
      orderBy: { startedAt: 'desc' },
    })
    inputReceived = prevLog?.passedForward ?? null
  } else {
    inputReceived = task.instruction
  }

  const userMessage = inputReceived ?? task.instruction ?? task.name
  const systemPrompt = collaborator.skillMd ||
    `You are ${collaborator.name}. ${collaborator.phase === 'reviewer' ? 'Review the work and either approve or reject with specific feedback.' : 'Complete the assigned task thoroughly.'}`

  const hasRepo = !!task.project.repository
  const useTools = hasRepo && task.canModifyRepo

  let thoughts = ''
  let conclusion = ''
  let passedForward = ''
  let approved: boolean | null = null
  const filesTouched: string[] = []

  try {
    if (useTools) {
      // Agentic tool loop — collaborator can read/write files
      const result = await runToolLoop({
        encryptedToken,
        systemPrompt,
        userMessage,
        repositoryId: task.project.repository!.id,
        projectId: task.projectId,
      })
      thoughts = result.thoughts
      conclusion = result.conclusion
      passedForward = result.conclusion
      filesTouched.push(...result.filesTouched)
    } else {
      // Simple text call — no file access
      const result = await callAnthropic({ encryptedToken, systemPrompt, userMessage })
      thoughts = result.text
      conclusion = result.text
      passedForward = result.text
    }

    // For reviewers, check approval/rejection
    if (collaborator.phase === 'reviewer') {
      const lowerText = conclusion.toLowerCase()
      const hasReject = lowerText.includes('reject') || lowerText.includes('revision needed') || lowerText.includes('needs work')
      const hasApprove = lowerText.includes('approve') || lowerText.includes('approved') || lowerText.includes('looks good')
      approved = hasApprove && !hasReject
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error'
    thoughts = `Error: ${errorMsg}`
    conclusion = thoughts
    passedForward = inputReceived ?? ''
  }

  // Create skill log
  const skillLog = await prisma.taskSkillLog.create({
    data: {
      taskId,
      iterationId,
      collaboratorId: collaborator.id,
      collaboratorName: collaborator.name,
      inputReceived,
      thoughts,
      conclusion,
      passedForward,
      approved,
      finishedAt: new Date(),
    },
  })

  // Create build log if files were touched
  if (filesTouched.length > 0) {
    await prisma.taskBuildLog.create({
      data: {
        taskId,
        iterationId,
        filesTouched: filesTouched.map((p) => ({ path: p, linesAdded: 0, linesRemoved: 0 })),
      },
    })
  }

  await prisma.task.update({
    where: { id: taskId },
    data: { pausedAtEmployee: collaboratorId },
  })

  // Handle rejection
  if (collaborator.phase === 'reviewer' && approved === false) {
    return rejectPipeline(taskId, collaboratorId, conclusion)
  }

  return advancePipeline(taskId, iterationId, collaboratorIndex + 1, encryptedToken)
}

/**
 * Agentic tool loop — Claude calls tools to read/write files until done.
 */
async function runToolLoop(options: {
  encryptedToken: string
  systemPrompt: string
  userMessage: string
  repositoryId: string
  projectId: string
}): Promise<{ thoughts: string; conclusion: string; filesTouched: string[] }> {
  const messages: ToolCallMessage[] = [
    { role: 'user', content: options.userMessage },
  ]
  const allText: string[] = []
  const filesTouched = new Set<string>()

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const response = await callAnthropicWithTools({
      encryptedToken: options.encryptedToken,
      systemPrompt: options.systemPrompt,
      messages,
      tools: REPO_TOOLS,
      maxTokens: 8192,
    })

    // Collect text from response
    for (const block of response.content) {
      if (block.type === 'text') {
        allText.push(block.text)
      }
    }

    // If Claude is done (no more tool calls)
    if (response.stopReason === 'end_turn' || response.stopReason === 'max_tokens') {
      break
    }

    // Process tool calls
    const toolUseBlocks = response.content.filter(
      (b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use'
    )

    if (toolUseBlocks.length === 0) break

    // Add assistant message with tool calls
    messages.push({ role: 'assistant', content: response.content })

    // Execute tools and build results
    const toolResults: { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }[] = []

    for (const toolCall of toolUseBlocks) {
      const result = await executeTool(options.repositoryId, toolCall.name, toolCall.input, options.projectId)
      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolCall.id,
        content: result.result,
        is_error: result.isError || undefined,
      })

      // Track files touched by write/delete
      if (toolCall.name === 'write_file' || toolCall.name === 'delete_file') {
        filesTouched.add(toolCall.input.path as string)
      }
    }

    // Add tool results as user message
    messages.push({
      role: 'user',
      content: toolResults as unknown as ContentBlock[],
    })
  }

  const fullText = allText.join('\n\n')
  return {
    thoughts: fullText,
    conclusion: fullText,
    filesTouched: [...filesTouched],
  }
}

/**
 * Handle rejection — create new iteration and restart.
 */
export async function rejectPipeline(
  taskId: string,
  rejectedByCollaboratorId: string,
  rejectionReason: string
): Promise<PipelineResult> {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: { team: true },
  })

  if (!task || !task.team) {
    return { status: 'error', message: 'Task or team not found' }
  }

  const iterationCount = await prisma.taskIteration.count({ where: { taskId } })

  await prisma.taskIteration.create({
    data: {
      taskId,
      iterationNumber: iterationCount + 1,
      rejectionReason,
      rejectedByCollaboratorId,
    },
  })

  const order = task.team.collaboratorOrder as unknown as CollaboratorOrder
  const restartFromId = task.team.restartFromCollaboratorId
  let restartIndex = 0

  if (restartFromId) {
    const idx = order.collaboratorIds.indexOf(restartFromId)
    if (idx !== -1) restartIndex = idx
  }

  await prisma.task.update({
    where: { id: taskId },
    data: {
      status: 'progress',
      pausedAtEmployee: order.collaboratorIds[restartIndex],
      pausedAtIteration: iterationCount + 1,
    },
  })

  return {
    status: 'rejected',
    message: `Rejected by ${rejectedByCollaboratorId}. Restarting from index ${restartIndex}.`,
  }
}
