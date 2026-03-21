import { prisma } from '@/lib/db'
import { callAnthropic } from '@/lib/anthropic'

// Team Pipeline Engine
//
// Manages the state machine for executing a task through a team's
// collaborator pipeline. Each collaborator processes the task in order,
// passing their output forward to the next.
//
// State transitions:
//   pending → queue → progress → completed → done
//
// Pipeline flow (per iteration):
//   ┌──────────┐    ┌──────────┐    ┌──────────┐
//   │ Collab 1 │ →  │ Collab 2 │ →  │ Collab N │ → done
//   └──────────┘    └──────────┘    └──────────┘
//        ↓               ↓               ↓
//   TaskSkillLog    TaskSkillLog    TaskSkillLog
//
// On rejection by a reviewer:
//   → create new TaskIteration
//   → restart from restartFromCollaboratorId (or beginning)

interface CollaboratorOrder {
  collaboratorIds: string[]
}

interface PipelineResult {
  status: 'advanced' | 'completed' | 'rejected' | 'error'
  message: string
  skillLogId?: string
}

/**
 * Start a new pipeline run for a task.
 * Creates a TaskIteration and sets the task to 'progress'.
 */
export async function startPipeline(taskId: string): Promise<PipelineResult> {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: {
      team: true,
      user: { select: { anthropicToken: true } },
    },
  })

  if (!task) {
    return { status: 'error', message: 'Task not found' }
  }

  if (!task.team) {
    return { status: 'error', message: 'Task has no team assigned' }
  }

  if (task.status !== 'pending' && task.status !== 'queue') {
    return { status: 'error', message: `Task is in ${task.status} status, cannot start` }
  }

  if (!task.user.anthropicToken) {
    return { status: 'error', message: 'User has no Anthropic token. Connect your Anthropic account first.' }
  }

  const order = task.team.collaboratorOrder as CollaboratorOrder
  if (!order.collaboratorIds || order.collaboratorIds.length === 0) {
    return { status: 'error', message: 'Team has no collaborators in pipeline' }
  }

  // Count existing iterations to determine iteration number
  const iterationCount = await prisma.taskIteration.count({
    where: { taskId },
  })

  // Create a new iteration
  const iteration = await prisma.taskIteration.create({
    data: {
      taskId,
      iterationNumber: iterationCount + 1,
    },
  })

  // Update task status to progress
  await prisma.task.update({
    where: { id: taskId },
    data: {
      status: 'progress',
      pausedAtEmployee: order.collaboratorIds[0],
      pausedAtIteration: iteration.iterationNumber,
    },
  })

  // Run the first collaborator step
  return advancePipeline(taskId, iteration.id, 0, task.user.anthropicToken)
}

/**
 * Advance the pipeline to the next collaborator.
 * Calls the Anthropic API with the collaborator's skillMd as system prompt
 * and the previous collaborator's output (or task instruction) as user message.
 */
export async function advancePipeline(
  taskId: string,
  iterationId: string,
  collaboratorIndex: number,
  encryptedToken: string
): Promise<PipelineResult> {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: { team: true },
  })

  if (!task || !task.team) {
    return { status: 'error', message: 'Task or team not found' }
  }

  const order = task.team.collaboratorOrder as CollaboratorOrder
  const collaboratorIds = order.collaboratorIds

  if (collaboratorIndex >= collaboratorIds.length) {
    // Pipeline complete — all collaborators have run
    await prisma.task.update({
      where: { id: taskId },
      data: {
        status: 'completed',
        pausedAtEmployee: null,
      },
    })
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

  // Get the previous collaborator's output (if any) as input
  let inputReceived: string | null = null
  if (collaboratorIndex > 0) {
    const prevLog = await prisma.taskSkillLog.findFirst({
      where: {
        taskId,
        iterationId,
        collaboratorId: collaboratorIds[collaboratorIndex - 1],
      },
      select: { passedForward: true },
      orderBy: { startedAt: 'desc' },
    })
    inputReceived = prevLog?.passedForward ?? null
  } else {
    inputReceived = task.instruction
  }

  const userMessage = inputReceived ?? task.instruction ?? task.name
  const systemPrompt = collaborator.skillMd || `You are ${collaborator.name}. ${collaborator.phase === 'reviewer' ? 'Review the work and either approve or reject with specific feedback.' : 'Complete the assigned task thoroughly.'}`

  // Call Anthropic API
  let thoughts = ''
  let conclusion = ''
  let passedForward = ''
  let approved: boolean | null = null

  try {
    const result = await callAnthropic({
      encryptedToken,
      systemPrompt,
      userMessage,
    })

    thoughts = result.text
    conclusion = result.text
    passedForward = result.text

    // For reviewers, check if the response indicates approval or rejection
    if (collaborator.phase === 'reviewer') {
      const lowerText = result.text.toLowerCase()
      const hasReject = lowerText.includes('reject') || lowerText.includes('revision needed') || lowerText.includes('needs work')
      const hasApprove = lowerText.includes('approve') || lowerText.includes('approved') || lowerText.includes('looks good')
      approved = hasApprove && !hasReject
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error'
    thoughts = `Error calling Anthropic API: ${errorMsg}`
    conclusion = thoughts
    passedForward = inputReceived ?? ''
  }

  // Create skill log entry
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

  // Update task position
  await prisma.task.update({
    where: { id: taskId },
    data: {
      pausedAtEmployee: collaboratorId,
    },
  })

  // If reviewer rejected, handle rejection
  if (collaborator.phase === 'reviewer' && approved === false) {
    return rejectPipeline(taskId, collaboratorId, conclusion)
  }

  // Auto-advance to next collaborator
  return advancePipeline(taskId, iterationId, collaboratorIndex + 1, encryptedToken)
}

/**
 * Handle a rejection by a reviewer collaborator.
 * Creates a new iteration and restarts from the configured restart point.
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

  // Count iterations for new iteration number
  const iterationCount = await prisma.taskIteration.count({
    where: { taskId },
  })

  // Create rejection iteration
  await prisma.taskIteration.create({
    data: {
      taskId,
      iterationNumber: iterationCount + 1,
      rejectionReason,
      rejectedByCollaboratorId,
    },
  })

  // Determine restart point
  const order = task.team.collaboratorOrder as CollaboratorOrder
  const restartFromId = task.team.restartFromCollaboratorId
  let restartIndex = 0

  if (restartFromId) {
    const idx = order.collaboratorIds.indexOf(restartFromId)
    if (idx !== -1) restartIndex = idx
  }

  // Update task for new iteration
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
