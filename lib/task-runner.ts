import { prisma } from '@/lib/db'
import { callAnthropic, callAnthropicWithTools, MODELS } from '@/lib/anthropic'
import { REPO_TOOLS, READ_TOOLS, executeTool } from '@/lib/tools'
import { acquireRepoLock, releaseRepoLock } from '@/lib/repo-lock'
import type { ContentBlock, ToolCallMessage } from '@/lib/anthropic'
import { ensureSandboxRunning, stopSandbox, isSandboxNeeded } from '@/lib/sandbox-manager'
import {
  buildTaskSkillPrompt,
  buildTaskTeamMemberPrompt,
  buildTaskBuilderPrompt,
  getSecurityScanPrompt,
  getCodeHealthPrompt,
  getSuggestionsRules,
  SKILL_NAMES,
} from '@/lib/prompts'

// ── Task Runner ───────────────────────────────────────────────────────────
//
// The engine that executes tasks from the queue, running behind the scenes.
// Uses the same logic as chat-engine (skills, team pipeline, build tool loop)
// but completely isolated from the chat.
//
// Execution results are stored in TaskSkillLog and TaskBuildLog.
//
// All prompts are loaded from /prompts/*.md via lib/prompts.ts

// ── Types ──────────────────────────────────────────────────────────────────

type TaskIntent = 'build' | 'analyze_fix' | 'conversation'

interface TaskContext {
  source?: string
  report?: { question?: string; conclusion?: string }
  conversationSummary?: string
  uploadedFile?: { name: string; content: string }
}

// ── Suggestion Parser ─────────────────────────────────────────────────────

const SUGGESTIONS_MARKER = 'SUGGESTIONS:'

/**
 * Extract suggestions from a response and return the clean response + suggestions.
 */
function extractSuggestions(response: string): { cleanResponse: string; suggestions: string[] } {
  const markerIndex = response.indexOf(SUGGESTIONS_MARKER)
  if (markerIndex === -1) return { cleanResponse: response, suggestions: [] }

  const cleanResponse = response.slice(0, markerIndex).trim()
  const suggestionsBlock = response.slice(markerIndex + SUGGESTIONS_MARKER.length).trim()

  const suggestions = suggestionsBlock
    .split('\n')
    .map((line) => line.replace(/^[-•*]\s*/, '').trim())
    .filter((line) => line.length > 0)

  return { cleanResponse, suggestions }
}

/**
 * Save extracted suggestions to the database.
 */
async function saveSuggestions(taskId: string, suggestions: string[], source: string): Promise<void> {
  for (const text of suggestions) {
    await prisma.taskSuggestion.create({
      data: {
        taskId,
        suggestionText: text,
        reason: `Noticed by ${source} during task execution`,
      },
    })
  }
}

interface PausedState {
  pausedAt: string
  completedEmployees: { name: string; output: string }[]
  currentEmployee: string | null
  filesModifiedBeforePause: string[]
  totalStepsCompleted: number
}

interface AccumulatedContext {
  model?: string
  intent?: TaskIntent
  pausedState?: PausedState
}

interface RunResult {
  status: 'completed' | 'failed' | 'locked'
  summary: string
  filesTouched: string[]
}

// ── Main Entry Point ──────────────────────────────────────────────────────

/**
 * Execute a single task from the queue.
 * Handles skill (single employee) and team (pipeline) execution.
 */
export async function runTask(taskId: string): Promise<RunResult> {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: {
      user: { select: { anthropicToken: true } },
      project: { include: { repository: true } },
    },
  })

  if (!task) return { status: 'failed', summary: 'Task not found', filesTouched: [] }
  if (!task.user.anthropicToken) return { status: 'failed', summary: 'No API key configured', filesTouched: [] }

  const context = task.context as TaskContext
  const accumulated = task.accumulatedContext as AccumulatedContext
  const intent = accumulated.intent ?? 'build'
  const modelKey = accumulated.model ?? 'sonnet'
  const modelId = MODELS[modelKey as keyof typeof MODELS]?.id
  const canBuild = intent === 'build' || intent === 'analyze_fix'
  const hasRepo = !!task.project.repository
  const pausedState = accumulated.pausedState

  // Start sandbox if this task needs to write files
  if (hasRepo && canBuild) {
    console.log(`[task-runner] Starting sandbox for build task ${taskId}`)
    await ensureSandboxRunning(task.projectId)
  }

  // If resuming: check if files were modified externally → if so, clear paused state (restart)
  let shouldRestart = false
  if (pausedState && hasRepo && pausedState.filesModifiedBeforePause.length > 0) {
    const repo = task.project.repository!
    for (const filePath of pausedState.filesModifiedBeforePause) {
      const file = await prisma.repoFile.findUnique({
        where: { repositoryId_path: { repositoryId: repo.id, path: filePath } },
        select: { content: true, isModified: true },
      })
      // If file was changed externally (not by the paused task), restart
      if (!file || !file.isModified) {
        shouldRestart = true
        break
      }
    }
    if (shouldRestart) {
      // Clear paused state — will run from scratch
      await prisma.task.update({
        where: { id: taskId },
        data: {
          accumulatedContext: JSON.parse(JSON.stringify({
            ...accumulated,
            pausedState: undefined,
          })),
        },
      })
      // Clear old logs
      await prisma.taskSkillLog.deleteMany({ where: { taskId } })
      await prisma.taskBuildLog.deleteMany({ where: { taskId } })
      await prisma.taskIteration.deleteMany({ where: { taskId } })
    }
  }

  // Acquire repo lock
  if (hasRepo) {
    const locked = await acquireRepoLock(task.projectId, 'task', taskId)
    if (!locked) return { status: 'locked', summary: 'Repository is in use', filesTouched: [] }
  }

  // Mark task as in progress
  await prisma.task.update({
    where: { id: taskId },
    data: { status: 'progress' },
  })

  // Build the task prompt from context
  const effectivePausedState = shouldRestart ? null : pausedState
  const taskPrompt = buildTaskPrompt(task.name, task.instruction, context, intent, effectivePausedState)

  try {
    let result: RunResult

    if (task.executorType === 'team') {
      result = await runTeamTask({
        taskId,
        projectId: task.projectId,
        encryptedToken: task.user.anthropicToken,
        repositoryId: task.project.repository?.id,
        taskPrompt,
        intent,
        canBuild,
        model: modelId,
        executorId: task.executorId,
      })
    } else {
      // Skill (single employee) or no_skill
      result = await runSkillTask({
        taskId,
        projectId: task.projectId,
        encryptedToken: task.user.anthropicToken,
        repositoryId: task.project.repository?.id,
        taskPrompt,
        intent,
        canBuild,
        model: modelId,
        skillId: task.executorId,
      })
    }

    // Mark as completed
    // Count suggestions generated during this task
    const suggestionsCount = await prisma.taskSuggestion.count({ where: { taskId } })

    await prisma.task.update({
      where: { id: taskId },
      data: {
        status: 'completed',
        accumulatedContext: JSON.parse(JSON.stringify({
          ...accumulated,
          result: {
            summary: result.summary.slice(0, 2000),
            filesTouched: result.filesTouched,
            completedAt: new Date().toISOString(),
            suggestionsCount,
          },
        })),
      },
    })

    // If recurring, auto-create next occurrence
    if (task.isRecurring && task.recurrenceConfig) {
      const config = task.recurrenceConfig as { intervalDays?: number }
      const intervalDays = config.intervalDays ?? 7
      const nextDate = new Date(Date.now() + intervalDays * 24 * 60 * 60 * 1000)

      // Get next queue position
      const maxPos = await prisma.task.aggregate({
        where: { projectId: task.projectId, status: 'queue' },
        _max: { queuePosition: true },
      })

      await prisma.task.create({
        data: {
          projectId: task.projectId,
          userId: task.userId,
          name: task.name,
          instruction: task.instruction,
          executorType: task.executorType,
          executorId: task.executorId,
          status: 'queue',
          isRecurring: true,
          recurrenceConfig: JSON.parse(JSON.stringify(task.recurrenceConfig)),
          scheduledAt: nextDate,
          queuePosition: (maxPos._max.queuePosition ?? -1) + 1,
          context: JSON.parse(JSON.stringify(task.context)),
          accumulatedContext: JSON.parse(JSON.stringify({
            model: accumulated.model,
            intent: accumulated.intent,
          })),
        },
      })
    }

    return result

  } catch (err) {
    console.error(`[task-runner] Task ${taskId} failed:`, err)

    const errorMessage = err instanceof Error ? err.message : 'Unknown error'
    const isCreditsError = errorMessage.toLowerCase().includes('credit') ||
      errorMessage.toLowerCase().includes('quota') ||
      errorMessage.toLowerCase().includes('rate_limit') ||
      errorMessage.toLowerCase().includes('overloaded') ||
      errorMessage.includes('429') ||
      errorMessage.includes('529')

    // Build paused state with what was done so far
    const skillLogs = await prisma.taskSkillLog.findMany({
      where: { taskId },
      select: { collaboratorName: true, conclusion: true, finishedAt: true },
      orderBy: { startedAt: 'asc' },
    })

    const buildLogs = await prisma.taskBuildLog.findMany({
      where: { taskId },
      select: { filesTouched: true },
    })

    const completedEmployees = skillLogs
      .filter((l) => l.finishedAt)
      .map((l) => ({ name: l.collaboratorName, output: (l.conclusion ?? '').slice(0, 1000) }))

    const filesModified = buildLogs.flatMap((b) => {
      const files = b.filesTouched as { path: string }[]
      return files.map((f) => f.path)
    })

    const lastActive = skillLogs.find((l) => !l.finishedAt)

    const pausedState = {
      pausedAt: new Date().toISOString(),
      completedEmployees,
      currentEmployee: lastActive?.collaboratorName ?? null,
      filesModifiedBeforePause: [...new Set(filesModified)],
      totalStepsCompleted: completedEmployees.length,
    }

    const failReason = isCreditsError
      ? 'API credits exhausted or rate limited. Task paused automatically — will continue when credits are available.'
      : `Task failed: ${errorMessage.slice(0, 200)}`

    // Reload accumulated to avoid overwriting
    const freshTask = await prisma.task.findUnique({ where: { id: taskId }, select: { accumulatedContext: true } })
    const freshAccumulated = (freshTask?.accumulatedContext ?? {}) as Record<string, unknown>

    await prisma.task.update({
      where: { id: taskId },
      data: {
        status: 'queue',
        scheduledAt: null,
        pausedAt: new Date(),
        accumulatedContext: JSON.parse(JSON.stringify({
          ...freshAccumulated,
          pausedState,
          failReason,
        })),
      },
    })

    return { status: 'failed', summary: failReason, filesTouched: [...new Set(filesModified)] }

  } finally {
    // Always release repo lock
    if (hasRepo) {
      await releaseRepoLock(task.projectId, 'task')
    }
    // Stop sandbox if no longer needed (no other tasks, terminal not open)
    if (hasRepo && canBuild) {
      const needed = await isSandboxNeeded(task.projectId)
      if (!needed) {
        console.log(`[task-runner] Stopping sandbox — no longer needed`)
        await stopSandbox(task.projectId).catch(() => {})
      }
    }
  }
}

// ── Skill Task (single employee) ──────────────────────────────────────────

async function runSkillTask(options: {
  taskId: string
  projectId: string
  encryptedToken: string
  repositoryId?: string
  taskPrompt: string
  intent: TaskIntent
  canBuild: boolean
  model?: string
  skillId: string | null
}): Promise<RunResult> {
  const skillName = options.skillId ? (SKILL_NAMES[options.skillId] ?? 'Claude') : 'Claude'

  const systemPrompt = options.skillId
    ? `${buildTaskSkillPrompt(options.skillId, options.canBuild)}\n\nYou are executing a task autonomously. No user interaction — complete the work based on the instructions provided.`
    : `${getSuggestionsRules()}\n\nYou are a skilled developer executing a task autonomously. Complete the work based on the instructions provided.`

  // Conversation/review mode — read tools only (can read files, not write)
  if (!options.canBuild) {
    const readResult = await runReadToolLoop({
      encryptedToken: options.encryptedToken,
      systemPrompt: systemPrompt + '\n\nYou have access to read files in the repository. Use them to analyze code.',
      userMessage: options.taskPrompt,
      repositoryId: options.repositoryId ?? '',
      projectId: options.projectId,
      model: options.model,
    })

    const { cleanResponse, suggestions } = extractSuggestions(readResult.summary)
    if (suggestions.length > 0) await saveSuggestions(options.taskId, suggestions, skillName)

    await prisma.taskSkillLog.create({
      data: {
        taskId: options.taskId,
        collaboratorName: skillName,
        inputReceived: options.taskPrompt,
        thoughts: cleanResponse,
        conclusion: cleanResponse,
        passedForward: cleanResponse,
        finishedAt: new Date(),
      },
    })

    return { status: 'completed', summary: cleanResponse, filesTouched: [] }
  }

  // Build mode — tool loop
  const buildResult = await runBuildLoop({
    encryptedToken: options.encryptedToken,
    systemPrompt: `${systemPrompt}\n\nYou have access to file tools. Read, write, and modify files as needed to complete the task.`,
    userMessage: options.taskPrompt,
    repositoryId: options.repositoryId!,
    projectId: options.projectId,
    model: options.model,
  })

  const { cleanResponse: cleanBuildSummary, suggestions: buildSuggestions } = extractSuggestions(buildResult.summary)
  if (buildSuggestions.length > 0) await saveSuggestions(options.taskId, buildSuggestions, skillName)

  await prisma.taskSkillLog.create({
    data: {
      taskId: options.taskId,
      collaboratorName: skillName,
      inputReceived: options.taskPrompt,
      thoughts: cleanBuildSummary,
      conclusion: cleanBuildSummary,
      passedForward: cleanBuildSummary,
      finishedAt: new Date(),
    },
  })

  if (buildResult.filesTouched.length > 0) {
    await prisma.taskBuildLog.create({
      data: {
        taskId: options.taskId,
        filesTouched: buildResult.filesTouched.map((p) => ({ path: p, action: 'write' })),
      },
    })
  }

  return { status: 'completed', summary: buildResult.summary, filesTouched: buildResult.filesTouched }
}

// ── Team Task (full pipeline) ─────────────────────────────────────────────

async function runTeamTask(options: {
  taskId: string
  projectId: string
  encryptedToken: string
  repositoryId?: string
  taskPrompt: string
  intent: TaskIntent
  canBuild: boolean
  model?: string
  executorId: string | null
}): Promise<RunResult> {
  // Load team config
  const team = options.executorId
    ? await prisma.team.findUnique({
        where: { id: options.executorId },
        select: {
          collaboratorOrder: true,
          hasBuilder: true,
          rejectionRules: true,
          restartFromCollaboratorId: true,
        },
      })
    : null

  if (!team) return { status: 'failed', summary: 'Team not found', filesTouched: [] }

  const orderData = team.collaboratorOrder as { collaboratorIds?: string[] }
  const collaboratorIds = orderData.collaboratorIds ?? []
  if (collaboratorIds.length === 0) return { status: 'failed', summary: 'Team has no members', filesTouched: [] }

  // Load collaborators
  const collaborators = await prisma.collaborator.findMany({
    where: { id: { in: collaboratorIds } },
    select: { id: true, name: true, phase: true, skillMd: true },
  })
  const collabMap = new Map(collaborators.map((c) => [c.id, c]))

  // Filter order: skip builder if conversation-only
  const orderedIds = options.canBuild && team.hasBuilder
    ? collaboratorIds
    : collaboratorIds.filter((id) => {
        const c = collabMap.get(id)
        return c && c.name.toLowerCase() !== 'builder'
      })

  // Create iteration
  const iterationCount = await prisma.taskIteration.count({ where: { taskId: options.taskId } })
  const iteration = await prisma.taskIteration.create({
    data: { taskId: options.taskId, iterationNumber: iterationCount + 1 },
  })

  // ── Step 1: Divide into etapas ──────────────────────────────────
  let etapas: { name: string; objective: string }[] = []
  try {
    const planResult = await callAnthropic({
      encryptedToken: options.encryptedToken,
      systemPrompt: `You analyze tasks and break them into execution stages for maximum precision.
If complex: split into stages (up to 5). If simple: use 1 stage.
Respond ONLY in JSON: {"etapas":[{"name":"Stage name","objective":"Specific objective"}]}`,
      userMessage: options.taskPrompt,
      model: options.model,
    })
    try {
      const parsed = JSON.parse(planResult.text)
      etapas = parsed.etapas ?? [{ name: 'Execution', objective: options.taskPrompt }]
    } catch {
      etapas = [{ name: 'Execution', objective: options.taskPrompt }]
    }
  } catch {
    etapas = [{ name: 'Execution', objective: options.taskPrompt }]
  }

  // ── Step 2: Execute etapas ──────────────────────────────────────
  let previousEtapaResult = ''
  const allFilesTouched: string[] = []
  const allOutputs: string[] = []
  const rejectionRules = (team.rejectionRules ?? {}) as Record<string, boolean>
  const MAX_RESTARTS = 2

  for (const etapa of etapas) {
    let previousOutput = etapa.objective
    if (previousEtapaResult) {
      previousOutput = `Context from previous stage: ${previousEtapaResult}\n\nCurrent stage: ${etapa.objective}`
    }

    let restartCount = 0

    for (let i = 0; i < orderedIds.length; i++) {
      const collab = collabMap.get(orderedIds[i])
      if (!collab) continue

      const isBuilder = collab.name.toLowerCase() === 'builder'
      const canRecreate = !!rejectionRules[collab.id]

      const memberContext = `TASK: "${etapa.name}"
OBJECTIVE: ${etapa.objective}
${previousEtapaResult ? `PREVIOUS STAGE: ${previousEtapaResult}` : ''}

Previous member output:
${previousOutput}

${canRecreate
  ? 'You can REJECT if critical issues. Start with "REJECT:" and explain. Otherwise "APPROVED:" with analysis.'
  : 'Analyze and pass conclusions to next member.'}

${isBuilder ? '' : 'CONVERSATION only. Do NOT write code.'}`

      let output: string
      const startedAt = new Date()

      if (isBuilder && options.canBuild && options.repositoryId) {
        // Builder executes code
        const buildResult = await runBuildLoop({
          encryptedToken: options.encryptedToken,
          systemPrompt: `${buildTaskBuilderPrompt()}\n\nCONTEXT FROM TEAM:\n${previousOutput}`,
          userMessage: previousOutput,
          repositoryId: options.repositoryId,
          projectId: options.projectId,
          model: options.model,
        })
        const { cleanResponse: cleanBuild, suggestions: builderSuggestions } = extractSuggestions(buildResult.summary)
        if (builderSuggestions.length > 0) await saveSuggestions(options.taskId, builderSuggestions, 'Builder')
        output = `Builder: ${cleanBuild}`
        allFilesTouched.push(...buildResult.filesTouched)
      } else {
        // Non-builder: with read tools to analyze code
        const systemPrompt = collab.skillMd
          ? `${collab.skillMd}\n\n${getSuggestionsRules()}`
          : `${buildTaskTeamMemberPrompt(collab.name.toLowerCase())}`
        const readResult = await runReadToolLoop({
          encryptedToken: options.encryptedToken,
          systemPrompt: `${systemPrompt}\n\n${memberContext}`,
          userMessage: previousOutput,
          repositoryId: options.repositoryId ?? '',
          projectId: options.projectId,
          model: options.model,
        })
        const { cleanResponse: cleanMember, suggestions: memberSuggestions } = extractSuggestions(readResult.summary)
        if (memberSuggestions.length > 0) await saveSuggestions(options.taskId, memberSuggestions, collab.name)
        output = cleanMember
        if (!output.startsWith(`${collab.name}:`)) output = `${collab.name}: ${output}`
      }

      // Log
      const approved = canRecreate
        ? !output.toUpperCase().includes('REJECT:')
        : null

      await prisma.taskSkillLog.create({
        data: {
          taskId: options.taskId,
          iterationId: iteration.id,
          collaboratorId: collab.id,
          collaboratorName: collab.name,
          inputReceived: previousOutput.slice(0, 2000),
          thoughts: output.slice(0, 5000),
          conclusion: output.slice(0, 2000),
          passedForward: output.slice(0, 2000),
          approved,
          finishedAt: new Date(),
        },
      })

      await prisma.task.update({
        where: { id: options.taskId },
        data: { pausedAtEmployee: collab.id },
      })

      // Handle rejection
      if (canRecreate && output.toUpperCase().includes('REJECT:') && restartCount < MAX_RESTARTS) {
        const restartId = team.restartFromCollaboratorId
        const restartIndex = restartId ? orderedIds.indexOf(restartId) : 0
        previousOutput = `REJECTED by ${collab.name}: ${output}\n\nRe-analyze with this feedback.`
        i = (restartIndex >= 0 ? restartIndex : 0) - 1
        restartCount++
        continue
      }

      previousOutput = output
      allOutputs.push(output)
    }

    previousEtapaResult = previousOutput
  }

  // ── Step 3: Conclusion ──────────────────────────────────────────
  let conclusion: string
  try {
    const result = await callAnthropic({
      encryptedToken: options.encryptedToken,
      systemPrompt: 'Summarize the team execution. Highlight what was done, key decisions, and any issues found.',
      userMessage: `Task: ${options.taskPrompt}\n\nFinal result: ${previousEtapaResult}`,
      model: options.model,
    })
    conclusion = result.text
  } catch {
    conclusion = 'Task execution complete.'
  }

  // Log build if files were touched
  if (allFilesTouched.length > 0) {
    await prisma.taskBuildLog.create({
      data: {
        taskId: options.taskId,
        iterationId: iteration.id,
        filesTouched: [...new Set(allFilesTouched)].map((p) => ({ path: p, action: 'write' })),
      },
    })
  }

  return {
    status: 'completed',
    summary: conclusion,
    filesTouched: [...new Set(allFilesTouched)],
  }
}

// ── Build Tool Loop ───────────────────────────────────────────────────────

const MAX_ITERATIONS = 30

// ── Read-only Tool Loop (for conversation/review tasks) ───────────────────

async function runReadToolLoop(options: {
  encryptedToken: string
  systemPrompt: string
  userMessage: string
  repositoryId: string
  projectId: string
  model?: string
}): Promise<{ summary: string }> {
  const messages: ToolCallMessage[] = [{ role: 'user', content: options.userMessage }]
  const allText: string[] = []

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await callAnthropicWithTools({
      encryptedToken: options.encryptedToken,
      systemPrompt: options.systemPrompt,
      messages,
      tools: READ_TOOLS,
      maxTokens: 8192,
      model: options.model,
    })

    for (const block of response.content) {
      if (block.type === 'text') allText.push(block.text)
    }

    if (response.stopReason === 'end_turn' || response.stopReason === 'max_tokens') break

    const toolUseBlocks = response.content.filter(
      (b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use'
    )
    if (toolUseBlocks.length === 0) break

    messages.push({ role: 'assistant', content: response.content })

    const toolResults: { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }[] = []
    for (const toolCall of toolUseBlocks) {
      const result = await executeTool(options.repositoryId, toolCall.name, toolCall.input, options.projectId)
      toolResults.push({ type: 'tool_result', tool_use_id: toolCall.id, content: result.result, is_error: result.isError || undefined })
    }

    messages.push({ role: 'user', content: toolResults as unknown as ContentBlock[] })
  }

  return { summary: allText.join('\n\n') || 'Analysis completed.' }
}

// ── Build Tool Loop ───────────────────────────────────────────────────────

async function runBuildLoop(options: {
  encryptedToken: string
  systemPrompt: string
  userMessage: string
  repositoryId: string
  projectId: string
  model?: string
}): Promise<{ summary: string; filesTouched: string[] }> {
  const messages: ToolCallMessage[] = [
    { role: 'user', content: options.userMessage },
  ]
  const allText: string[] = []
  const filesTouched = new Set<string>()

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await callAnthropicWithTools({
      encryptedToken: options.encryptedToken,
      systemPrompt: options.systemPrompt,
      messages,
      tools: REPO_TOOLS,
      maxTokens: 8192,
      model: options.model,
    })

    for (const block of response.content) {
      if (block.type === 'text') allText.push(block.text)
    }

    if (response.stopReason === 'end_turn' || response.stopReason === 'max_tokens') break

    const toolUseBlocks = response.content.filter(
      (b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use'
    )
    if (toolUseBlocks.length === 0) break

    messages.push({ role: 'assistant', content: response.content })

    const toolResults: { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }[] = []

    for (const toolCall of toolUseBlocks) {
      const result = await executeTool(options.repositoryId, toolCall.name, toolCall.input, options.projectId)
      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolCall.id,
        content: result.result,
        is_error: result.isError || undefined,
      })

      if (toolCall.name === 'write_file' || toolCall.name === 'delete_file') {
        filesTouched.add(toolCall.input.path as string)
      }
    }

    messages.push({ role: 'user', content: toolResults as unknown as ContentBlock[] })
  }

  return {
    summary: allText.join('\n\n') || 'Build completed.',
    filesTouched: [...filesTouched],
  }
}

// ── Task Prompt Builder ───────────────────────────────────────────────────

function buildTaskPrompt(
  name: string,
  instruction: string | null,
  context: TaskContext,
  intent: TaskIntent,
  pausedState?: PausedState | null,
): string {
  const parts: string[] = []

  parts.push(`TASK: ${name}`)

  if (instruction) {
    parts.push(`\nINSTRUCTIONS:\n${instruction}`)
  }

  const intentLabels: Record<TaskIntent, string> = {
    build: 'BUILD — Write code, create/edit files, implement the solution.',
    analyze_fix: 'ANALYZE & FIX — Investigate first, fix issues if found.',
    conversation: 'REVIEW & DISCUSS — Only analyze, discuss, advise. Do NOT modify any files.',
  }
  parts.push(`\nMODE: ${intentLabels[intent]}`)

  if (context.report) {
    const rep = context.report as Record<string, unknown>
    if (rep.parentTaskName) {
      // Chained task — execution report from previous task
      parts.push(`\nPREVIOUS EXECUTION REPORT:`)
      parts.push(`Task: ${rep.parentTaskName}`)
      if (Array.isArray(rep.steps)) {
        for (const step of rep.steps as { employee: string; output: string }[]) {
          parts.push(`\n${step.employee}: ${step.output}`)
        }
      }
      if (Array.isArray(rep.filesTouched) && (rep.filesTouched as string[]).length > 0) {
        parts.push(`\nFiles modified: ${(rep.filesTouched as string[]).join(', ')}`)
      }
      if (rep.conclusion) parts.push(`\nConclusion: ${rep.conclusion}`)
    } else {
      // Chat report — original format
      parts.push(`\nATTACHED REPORT:\nQuestion: ${rep.question ?? 'N/A'}\nConclusion: ${rep.conclusion ?? 'N/A'}`)
    }
  }

  if (context.conversationSummary) {
    parts.push(`\nCONVERSATION CONTEXT:\n${context.conversationSummary}`)
  }

  if (context.uploadedFile) {
    parts.push(`\nUPLOADED CONTEXT (${context.uploadedFile.name}):\n${context.uploadedFile.content}`)
  }

  // Security scan context
  if (context.source === 'security_scan') {
    const secContext = context as { scanType?: string }
    parts.push(`\nSECURITY AUDIT CONTEXT:\n${getSecurityScanPrompt(secContext.scanType === 'targeted' ? 'targeted' : 'full')}`)
  }

  // Code health context
  if (context.source === 'code_health') {
    const healthCtx = context as { scanType?: string }
    parts.push(`\nCODE HEALTH CONTEXT:\n${getCodeHealthPrompt(healthCtx.scanType === 'targeted' ? 'targeted' : 'full')}`)
  }

  // Resume context — task was paused and is continuing
  if (pausedState && pausedState.completedEmployees.length > 0) {
    parts.push(`\nRESUMING FROM PAUSE:`)
    parts.push(`This task was previously paused. Here is what was already completed:`)
    for (const emp of pausedState.completedEmployees) {
      parts.push(`\n${emp.name}:\n${emp.output}`)
    }
    if (pausedState.filesModifiedBeforePause.length > 0) {
      parts.push(`\nFiles already modified: ${pausedState.filesModifiedBeforePause.join(', ')}`)
    }
    parts.push(`\nContinue from where the team left off. Do NOT redo work that was already completed. Pick up from the next step.`)
  }

  return parts.join('\n')
}
