import { prisma } from '@/lib/db'
import { callAnthropic, callAnthropicWithTools, MODELS } from '@/lib/anthropic'
import { createBuildSession, endBuildSession, REPO_TOOLS, executeTool } from '@/lib/tools'
import type { ContentBlock, ToolCallMessage } from '@/lib/anthropic'
import type { ChatReport, ReportEtapa, ReportStep, ReportBuildDetails, ReportToolCall } from '@/lib/report-types'
import { getRepoLockStatus, getLockerTaskName, acquireRepoLock, releaseRepoLock, touchProjectActivity } from '@/lib/repo-lock'

// ── Rules (injected into ALL prompts) ──────────────────────────────────────

const BUILD_RULE = `
CRITICAL RULE — BUILD CONFIRMATION (NEVER VIOLATE):
You must NEVER write code, edit files, create files, build, implement, or execute anything without EXPLICIT confirmation from the user. This means TWO things must happen:

1. The user must explicitly say YES to building (e.g. "yes build it", "go ahead", "do it")
2. The user must confirm WHO should build — which employee or team. If no one is selected (no / skill active), you MUST ask: "Who should I build this with? Select an employee or team with /"

If the user asks you to build, create, implement, code, or make something:
- ALWAYS respond with: "I can build this. Should I proceed with [current skill/employee name], continue without a skill (just me, Claude), or would you like to assign it to another employee or team using /?"
- If NO skill is selected (no / active), say: "I can build this. Should I proceed directly (without a skill), or would you like to assign it to an employee or team using /?"
- NEVER assume. NEVER start building without both confirmations.
- Even if the user says "just do it" — still confirm WHO (you directly, or a specific employee/team).

This rule applies at ALL times, in ALL modes, with ALL skills. No exceptions.

REPOSITORY LOCK:
The repository can only be modified by one source at a time. If a task is currently running and using the repository, you CANNOT start a build. The system will block it automatically, but you should be aware:
- If the user asks to build and a task is running, explain that the repository is locked by a running task.
- Offer to create a task for what they want instead — it will go to Pending for them to manage.
- They can also pause the running task from the Tasks tab to free the repository.`

const TASK_RULE = `
TASK CREATION AWARENESS:
You can suggest creating tasks for later execution. Tasks go to a queue where the user configures them and schedules when they run.

WHEN TO SUGGEST A TASK:
- When you would offer to build something, ALSO offer: "Want me to build this now, or create a task to handle it later?"
- During discussions where you identify actionable work (bugs to fix, features to add, refactors needed), you can proactively suggest: "This could be a good task for later — want me to create it?"
- You do NOT need to suggest tasks for every message. Only when there's a clear, actionable item.

WHEN THE USER ASKS TO CREATE A TASK:
- If the conversation context makes it clear what the task is about, create it immediately using [CREATE_TASK: task name here]. No need to ask for clarification.
- If you're unsure what the task should be about (the request seems unrelated to the conversation), ask: "What should this task be about?" Then create it based on their answer.
- If the user asks to create a task but the request has NOTHING to do with code or development (e.g. "remind me to buy groceries"), offer a reminder instead: [CREATE_REMINDER: reminder text here]

WHEN THE USER ASKS TO CREATE A REMINDER:
- If the user explicitly says "reminder" / "lembrete", create it with [CREATE_REMINDER: reminder text].
- BUT if the reminder seems to be about code/development work that has context in the conversation, ask: "This sounds like it could be a task with full context — want me to create it as a task instead, or keep it as a simple reminder?"
- If they confirm task → [CREATE_TASK: name]. If they confirm reminder → [CREATE_REMINDER: text].

TASKS vs REMINDERS:
- TASK = actionable development work. Carries full conversation context (summary + recent messages). Goes to the task queue for an employee/team to execute.
- REMINDER = lightweight note. Just the text, no heavy context. A simple note in the pending list.
- Never confuse them. Tasks are for building/coding. Reminders are for everything else.

IMPORTANT:
- NEVER create a task or reminder without the user's explicit request or confirmation of your suggestion.
- Task/reminder creation and build confirmation are SEPARATE flows. Never mix them.
- When creating a task, use exactly this format in your response: [CREATE_TASK: descriptive task name]
- When creating a reminder, use exactly this format: [CREATE_REMINDER: reminder text]
- After the tag, briefly confirm what was created.`

// ── Skills ─────────────────────────────────────────────────────────────────

const SKILLS: Record<string, { name: string; systemPrompt: string }> = {
  ceo: {
    name: 'CEO',
    systemPrompt: `You are the CEO. Strategic: challenge assumptions, question scope, ensure the right problem is being solved.
- Ask "Is this the right problem?"
- Identify risks and blockers
- Give clear go/no-go with reasoning
- Think in user outcomes
- Be direct and decisive
Always start your response with "CEO:"`,
  },
  architect: {
    name: 'Architect',
    systemPrompt: `You are the Lead Architect. Define exactly what needs to be built.
- List every file to create or edit with reason
- Define data flow with ASCII diagrams
- Specify key interfaces and types
- Identify edge cases
- Be precise — your output is the builder's contract
Always start your response with "Architect:"`,
  },
  designer: {
    name: 'Designer',
    systemPrompt: `You are the Lead Designer. Review UI/UX and catch AI slop.
- Evaluate information hierarchy
- Check all interaction states
- Identify edge cases
- Ensure simplicity
- Flag complexity without user value
Always start your response with "Designer:"`,
  },
  security: {
    name: 'Security',
    systemPrompt: `You are the Security Reviewer. Find vulnerabilities before production.
- Check injection vectors
- Verify authorization boundaries
- Check secrets handling
- Verify input validation
- OWASP Top 10 + STRIDE
- Rate findings: High/Medium/Low with remediation
Always start your response with "Security:"`,
  },
}

// ── Types ──────────────────────────────────────────────────────────────────

interface TeamConfig {
  order: string[]
  canRecreateTasks: Record<string, string>
  hasBuilder: boolean
}

interface ChatRequest {
  projectId: string
  userId: string
  content: string
  mode: 'no_skill' | 'skill' | 'team'
  activeSkillId?: string
  activeTeamId?: string
  teamConfig?: TeamConfig
  isBuild?: boolean
  sessionId?: string
  model?: string
  thinkingBudget?: number
}

interface ChatReply {
  id: string
  content: string
  sender: string
  mode: string
  activeSkillId: string | null
}

interface ChatResult {
  userMessage: ChatReply
  replies: ChatReply[]
}

// TeamRun state shape (stored as JSON in DB)
interface EtapaState {
  name: string
  objective: string
  members: { name: string; status: 'pending' | 'active' | 'done' | 'recreated'; redirectedTo?: string }[]
  status: 'pending' | 'active' | 'done'
}

const ALL_RULES = `${BUILD_RULE}\n\n${TASK_RULE}`

// ── Task/Reminder detection from Claude's response ────────────────────────

const TASK_TAG_REGEX = /\[CREATE_TASK:\s*(.+?)\]/i
const REMINDER_TAG_REGEX = /\[CREATE_REMINDER:\s*(.+?)\]/i

/**
 * Detect if Claude's response contains a task or reminder creation tag.
 * If found, create the task/reminder and return the cleaned response.
 */
async function detectAndCreateTask(
  response: string,
  req: ChatRequest,
): Promise<{ cleanedResponse: string; created: 'task' | 'reminder' | null }> {
  const taskMatch = response.match(TASK_TAG_REGEX)
  if (taskMatch) {
    const taskName = taskMatch[1].trim()
    const context = await gatherChatContext(req)
    await prisma.task.create({
      data: {
        projectId: req.projectId,
        userId: req.userId,
        name: taskName.length > 80 ? taskName.slice(0, 80) + '...' : taskName,
        status: 'pending',
        context: JSON.parse(JSON.stringify({
          source: 'chat_suggested',
          conversationSummary: context,
        })),
      },
    })
    const cleaned = response.replace(TASK_TAG_REGEX, '').trim()
    return { cleanedResponse: cleaned, created: 'task' }
  }

  const reminderMatch = response.match(REMINDER_TAG_REGEX)
  if (reminderMatch) {
    const reminderText = reminderMatch[1].trim()
    await prisma.task.create({
      data: {
        projectId: req.projectId,
        userId: req.userId,
        name: reminderText.length > 80 ? reminderText.slice(0, 80) + '...' : reminderText,
        instruction: reminderText,
        status: 'pending',
        context: JSON.parse(JSON.stringify({
          source: 'reminder',
        })),
      },
    })
    const cleaned = response.replace(REMINDER_TAG_REGEX, '').trim()
    return { cleanedResponse: cleaned, created: 'reminder' }
  }

  return { cleanedResponse: response, created: null }
}

/**
 * Gather chat context for task creation: compact summary + last 10 messages.
 */
async function gatherChatContext(req: ChatRequest): Promise<string> {
  if (!req.sessionId) return ''

  // Try compact summary first
  const compactMsg = await prisma.chatMessage.findFirst({
    where: { sessionId: req.sessionId, sender: 'compact' },
    select: { content: true },
    orderBy: { createdAt: 'desc' },
  })

  // Always get last 10 messages for recent context
  const recentMsgs = await prisma.chatMessage.findMany({
    where: {
      sessionId: req.sessionId,
      sender: { notIn: ['plan', 'step', 'compact'] },
    },
    select: { sender: true, content: true },
    orderBy: { createdAt: 'desc' },
    take: 10,
  })

  const recentContext = recentMsgs.length > 0
    ? recentMsgs
        .reverse()
        .map((m) => `${m.sender}: ${m.content.length > 500 ? m.content.slice(0, 500) + '...' : m.content}`)
        .join('\n\n')
    : ''

  if (compactMsg) {
    return `=== Conversation Summary ===\n${compactMsg.content}\n\n=== Recent Messages ===\n${recentContext}`
  }

  return recentContext
}

// ── User-side task request detection ──────────────────────────────────────

const TASK_REQUEST_PATTERNS = [
  /\b(cria|create|make|faz)\b.*\b(task|tarefa)\b/i,
  /\b(task|tarefa)\b.*\b(pra|para|for|to)\b.*\b(depois|later|queue|fila)\b/i,
]

const REMINDER_REQUEST_PATTERNS = [
  /\b(cria|create|make|faz)\b.*\b(reminder|lembrete|lembrar)\b/i,
  /\b(remind|lembr)\b.*\b(me|eu)\b/i,
  /\b(reminder|lembrete)\b.*\b(de|about|pra|para|for)\b/i,
]

function isUserRequestingTask(content: string): boolean {
  return TASK_REQUEST_PATTERNS.some((p) => p.test(content))
}

function isUserRequestingReminder(content: string): boolean {
  return REMINDER_REQUEST_PATTERNS.some((p) => p.test(content))
}

// ── Build confirmation detection ───────────────────────────────────────────

const BUILD_CONFIRM_PATTERNS = [
  /\b(pode|can|go ahead|do it|build|construi|execut|faz|make it|proceed|sim|yes)\b/i,
]

const BUILD_CANCEL_PATTERNS = [
  /\b(cancel|para|stop|nao|no|dont|nope)\b.*\b(build|construi|execut)/i,
]

/**
 * Detect if the user is confirming a build.
 * Returns the buildWith target or null if not a confirmation.
 */
function detectBuildConfirmation(content: string, currentSkillId: string | undefined, mode: string): string | null {
  const lower = content.toLowerCase()

  // Check for cancellation first
  for (const pattern of BUILD_CANCEL_PATTERNS) {
    if (pattern.test(lower)) return null
  }

  // Check for build confirmation
  const isBuildConfirm = BUILD_CONFIRM_PATTERNS.some((p) => p.test(lower)) &&
    (lower.includes('build') || lower.includes('construi') || lower.includes('execut') ||
     lower.includes('pode') || lower.includes('go ahead') || lower.includes('faz') ||
     lower.includes('proceed') || lower.includes('do it'))

  if (!isBuildConfirm) return null

  // Determine who builds
  if (mode === 'skill' && currentSkillId) return currentSkillId
  if (mode === 'team') return 'team'
  return 'claude' // no skill = Claude direct
}

// ── Sync entry (no_skill + skill) ──────────────────────────────────────────

export async function processChatSync(req: ChatRequest): Promise<ChatResult> {
  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    select: { anthropicToken: true },
  })

  if (!user?.anthropicToken) {
    const userMsg = await saveMessage(req, 'user', req.content)
    const errMsg = await saveMessage(req, 'system', 'Connect your Claude API key first.')
    return { userMessage: userMsg, replies: [errMsg] }
  }

  // Detect build confirmation and create/end session
  const buildTarget = detectBuildConfirmation(req.content, req.activeSkillId, req.mode)
  if (buildTarget) {
    // Check if repo is locked by a running task
    const lockStatus = await getRepoLockStatus(req.projectId)
    if (lockStatus.locked && lockStatus.lockedBy === 'task') {
      const taskName = await getLockerTaskName(req.projectId)
      const userMessage = await saveMessage(req, 'user', req.content)
      const lockMsg = await saveMessage(req, 'system',
        `Cannot start build — a task is currently running${taskName ? ` ("${taskName}")` : ''} and modifying the repository. You can:\n• Pause it in the Tasks tab\n• Or I can create a task for what you want — it'll go to Pending for you to manage.`
      )
      return { userMessage, replies: [lockMsg] }
    }

    // Acquire lock for chat build
    await acquireRepoLock(req.projectId, 'chat')
    await createBuildSession(req.projectId, req.userId, buildTarget)
    const skillName = buildTarget === 'claude' ? 'Claude (direct)' : SKILLS[buildTarget]?.name ?? buildTarget
    const userMessage = await saveMessage(req, 'user', req.content)
    const confirmMsg = await saveMessage(req, 'system', `Build authorized with ${skillName}. Ready to execute.`)
    return { userMessage, replies: [confirmMsg] }
  }

  // Detect build stop
  const lower = req.content.toLowerCase()
  if (lower.includes('stop build') || lower.includes('cancel build') || lower.includes('para de construir')) {
    await endBuildSession(req.projectId)
    await releaseRepoLock(req.projectId, 'chat')
    const userMessage = await saveMessage(req, 'user', req.content)
    const stopMsg = await saveMessage(req, 'system', 'Build session ended.')
    return { userMessage, replies: [stopMsg] }
  }

  // Track user activity for idle detection
  await touchProjectActivity(req.projectId)

  // Detect explicit user task request: "create a task for me"
  if (isUserRequestingTask(req.content)) {
    const userMessage = await saveMessage(req, 'user', req.content)
    return handleUserTaskRequest(req, user.anthropicToken, userMessage)
  }

  // Detect explicit reminder request: "create a reminder"
  if (isUserRequestingReminder(req.content)) {
    const userMessage = await saveMessage(req, 'user', req.content)
    return handleUserReminderRequest(req, user.anthropicToken, userMessage)
  }

  // Check context and auto-compact if needed
  let compactSummary: string | null = null
  if (req.sessionId) {
    const usage = await getContextUsage(req.sessionId, req.model)
    compactSummary = usage.compactSummary
    if (usage.shouldCompact) {
      compactSummary = await compactConversation(req.sessionId, req.projectId, req.userId, user.anthropicToken, req.model)
    }
  }

  const userMessage = await saveMessage(req, 'user', req.content)

  // If build is authorized, use build handlers (with file tools)
  if (req.isBuild) {
    if (req.mode === 'skill') {
      return handleBuildWithSkill(req, user.anthropicToken, userMessage, compactSummary)
    }
    return handleBuildDirect(req, user.anthropicToken, userMessage, compactSummary)
  }

  if (req.mode === 'skill') {
    return handleSkill(req, user.anthropicToken, userMessage, compactSummary)
  }
  return handleNoSkill(req, user.anthropicToken, userMessage, compactSummary)
}

// ── Async entry (team) ─────────────────────────────────────────────────────

export async function processChat(req: ChatRequest): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    select: { anthropicToken: true },
  })

  if (!user?.anthropicToken) {
    await saveMessage(req, 'system', 'Connect your Claude API key first.')
    return
  }

  if (req.mode === 'team') {
    await handleTeam(req, user.anthropicToken, req.isBuild ?? false)
  }
}

// ── User Task Request Handler ─────────────────────────────────────────────

async function handleUserTaskRequest(req: ChatRequest, token: string, userMessage: ChatReply): Promise<ChatResult> {
  // Ask Claude to determine if the request relates to conversation context
  let content: string
  try {
    const recentContext = await gatherChatContext(req)
    const result = await callAnthropic({
      encryptedToken: token,
      systemPrompt: `You help users create tasks. The user just asked to create a task.

CONVERSATION CONTEXT:
${recentContext || '(no prior conversation)'}

RULES:
- If the conversation context makes it clear what the task should be about, create it immediately. Use [CREATE_TASK: descriptive task name] and briefly confirm.
- If the user's request is vague but the conversation gives enough context, infer the task and create it. Use [CREATE_TASK: descriptive task name].
- If you genuinely cannot determine what the task should be about (no relevant conversation context), ask the user: "What should this task be about?"
- If the request has nothing to do with code/development (e.g. personal reminders), use [CREATE_REMINDER: reminder text] instead and briefly confirm.
- Keep task names clear and actionable (e.g. "Implement dark mode for settings page", not "Do the thing we discussed").`,
      userMessage: req.content,
      ...getModelOptions(req),
    })
    content = result.text
  } catch {
    content = 'Sorry, I had trouble creating the task. Please try again.'
  }

  // Process the response for task/reminder tags
  const { cleanedResponse, created } = await detectAndCreateTask(content, req)

  if (created === 'task') {
    const reply = await saveMessage(req, 'claude', cleanedResponse)
    const confirmMsg = await saveMessage(req, 'system', 'Task created — manage it in the Tasks tab.')
    return { userMessage, replies: [reply, confirmMsg] }
  }

  if (created === 'reminder') {
    const reply = await saveMessage(req, 'claude', cleanedResponse)
    const confirmMsg = await saveMessage(req, 'system', 'Reminder created — find it in the Tasks tab.')
    return { userMessage, replies: [reply, confirmMsg] }
  }

  // Claude asked for clarification — no task created yet
  const reply = await saveMessage(req, 'claude', content)
  return { userMessage, replies: [reply] }
}

// ── User Reminder Request Handler ─────────────────────────────────────────

async function handleUserReminderRequest(req: ChatRequest, token: string, userMessage: ChatReply): Promise<ChatResult> {
  let content: string
  try {
    const recentContext = await gatherChatContext(req)
    const result = await callAnthropic({
      encryptedToken: token,
      systemPrompt: `You help users create reminders and tasks. The user asked to create a reminder.

CONVERSATION CONTEXT:
${recentContext || '(no prior conversation)'}

RULES:
- If the reminder is about code/development work and the conversation has relevant context, ask: "This sounds like it could be a task with full context attached — want me to create it as a task instead, or keep it as a simple reminder?"
- If they want a task → use [CREATE_TASK: descriptive task name]
- If they want a reminder (or it's clearly non-dev) → use [CREATE_REMINDER: reminder text]
- If the request is clear and simple → just create the reminder directly with [CREATE_REMINDER: text] and confirm.`,
      userMessage: req.content,
      ...getModelOptions(req),
    })
    content = result.text
  } catch {
    content = 'Sorry, I had trouble creating the reminder. Please try again.'
  }

  const { cleanedResponse, created } = await detectAndCreateTask(content, req)

  if (created === 'task') {
    const reply = await saveMessage(req, 'claude', cleanedResponse)
    const confirmMsg = await saveMessage(req, 'system', 'Task created — manage it in the Tasks tab.')
    return { userMessage, replies: [reply, confirmMsg] }
  }

  if (created === 'reminder') {
    const reply = await saveMessage(req, 'claude', cleanedResponse)
    const confirmMsg = await saveMessage(req, 'system', 'Reminder created — find it in the Tasks tab.')
    return { userMessage, replies: [reply, confirmMsg] }
  }

  // Claude asked for clarification
  const reply = await saveMessage(req, 'claude', content)
  return { userMessage, replies: [reply] }
}

// ── No Skill ───────────────────────────────────────────────────────────────

async function handleNoSkill(req: ChatRequest, token: string, userMessage: ChatReply, compactSummary: string | null = null): Promise<ChatResult> {
  let content: string
  try {
    const result = await callAnthropic({
      encryptedToken: token,
      systemPrompt: `You are a helpful AI assistant. Be concise and direct.\n\n${ALL_RULES}`,
      userMessage: req.content,
      compactSummary: compactSummary ?? undefined,
      ...getModelOptions(req),
    })
    content = result.text
  } catch {
    content = 'Sorry, I encountered an error. Please try again.'
  }

  // Check if Claude proactively suggested a task/reminder
  const { cleanedResponse, created } = await detectAndCreateTask(content, req)
  const replies: ChatReply[] = []
  replies.push(await saveMessage(req, 'claude', cleanedResponse))
  if (created === 'task') {
    replies.push(await saveMessage(req, 'system', 'Task created — manage it in the Tasks tab.'))
  } else if (created === 'reminder') {
    replies.push(await saveMessage(req, 'system', 'Reminder created — find it in the Tasks tab.'))
  }

  return { userMessage, replies }
}

// ── Skill ──────────────────────────────────────────────────────────────────

async function handleSkill(req: ChatRequest, token: string, userMessage: ChatReply, compactSummary: string | null = null): Promise<ChatResult> {
  const skillId = req.activeSkillId
  if (!skillId || !SKILLS[skillId]) {
    const reply = await saveMessage(req, 'system', 'No employee selected.')
    return { userMessage, replies: [reply] }
  }

  const skill = SKILLS[skillId]
  let content: string
  try {
    const result = await callAnthropic({
      encryptedToken: token,
      systemPrompt: `${skill.systemPrompt}\n\n${ALL_RULES}`,
      compactSummary: compactSummary ?? undefined,
      ...getModelOptions(req),
      userMessage: req.content,
    })
    content = result.text
    if (!content.startsWith(`${skill.name}:`)) content = `${skill.name}: ${content}`
  } catch {
    content = `${skill.name}: Sorry, error. Try again.`
  }

  // Check if employee proactively suggested a task/reminder
  const { cleanedResponse, created } = await detectAndCreateTask(content, req)
  const replies: ChatReply[] = []
  replies.push(await saveMessage(req, skill.name, cleanedResponse))
  if (created === 'task') {
    replies.push(await saveMessage(req, 'system', 'Task created — manage it in the Tasks tab.'))
  } else if (created === 'reminder') {
    replies.push(await saveMessage(req, 'system', 'Reminder created — find it in the Tasks tab.'))
  }

  return { userMessage, replies }
}

// ── Team ───────────────────────────────────────────────────────────────────

async function handleTeam(req: ChatRequest, token: string, isBuild: boolean = false): Promise<void> {
  const config = req.teamConfig
  if (!config || config.order.length === 0) {
    await saveMessage(req, 'system', 'No team configuration provided.')
    return
  }

  // In build mode, keep builder in the order. In conversation, skip builder.
  const orderedIds = isBuild
    ? config.order
    : config.order.filter((id) => id !== 'builder')

  const orderedMembers = orderedIds
    .map((id) => id === 'builder' ? { name: 'Builder', systemPrompt: '' } : SKILLS[id])
    .filter((s): s is NonNullable<typeof s> => !!s)

  if (orderedMembers.length === 0) {
    await saveMessage(req, 'system', 'Team has no conversation members.')
    return
  }

  // Create TeamRun record
  const teamRun = await prisma.teamRun.create({
    data: {
      projectId: req.projectId,
      userId: req.userId,
      teamConfigJson: JSON.parse(JSON.stringify(config)),
      userMessage: req.content,
      status: 'running',
    },
  })

  const startTime = Date.now()
  const reportEtapas: ReportEtapa[] = []
  let buildReportData: ReportBuildDetails | undefined

  try {
    // ── Step 1: Create the etapas plan ─────────────────────────────────

    let etapas: { name: string; objective: string }[] = []
    try {
      const planResult = await callAnthropic({
        encryptedToken: token,
        systemPrompt: `You analyze requests and break them into execution stages for maximum precision.

If complex (multiple parts, large scope): split into as many stages as needed (up to 5) for maximum quality.
If simple (one question, one topic): use 1 stage.

Each stage must have a clear, specific objective that can be independently analyzed.

Respond ONLY in JSON:
{"etapas":[{"name":"Stage name","objective":"Specific objective for this stage"}]}`,
        userMessage: req.content,
        ...getModelOptions(req),
      })
      try {
        const parsed = JSON.parse(planResult.text)
        etapas = parsed.etapas ?? [{ name: 'Analysis', objective: req.content }]
      } catch {
        etapas = [{ name: 'Analysis', objective: req.content }]
      }
    } catch {
      etapas = [{ name: 'Analysis', objective: req.content }]
    }

    // Build initial state
    const memberNames = orderedMembers.map((m) => m.name)
    const initialState: EtapaState[] = etapas.map((e) => ({
      name: e.name,
      objective: e.objective,
      members: memberNames.map((n) => ({ name: n, status: 'pending' as const })),
      status: 'pending' as const,
    }))

    // Save plan to TeamRun and as message
    const planData = {
      etapas: etapas.map((e) => ({ name: e.name, objective: e.objective, members: memberNames })),
    }
    await prisma.teamRun.update({
      where: { id: teamRun.id },
      data: { plan: JSON.parse(JSON.stringify(planData)), state: JSON.parse(JSON.stringify(initialState)) },
    })
    await saveMessage(req, 'plan', JSON.stringify(planData))

    // ── Step 2: Execute each etapa ─────────────────────────────────────

    let previousEtapaResult = ''
    const state = initialState

    for (let ei = 0; ei < etapas.length; ei++) {
      const etapa = etapas[ei]
      state[ei].status = 'active'
      await updateTeamRunState(teamRun.id, state)

      let previousOutput = etapa.objective
      if (previousEtapaResult) {
        previousOutput = `Context from previous stage: ${previousEtapaResult}\n\nCurrent stage objective: ${etapa.objective}`
      }

      let restartCount = 0
      const MAX_RESTARTS = 2
      const currentEtapaSteps: ReportStep[] = []

      for (let i = 0; i < orderedMembers.length; i++) {
        const member = orderedMembers[i]
        const memberId = member.name.toLowerCase()

        // Update state: mark active
        state[ei].members[i].status = 'active'
        await updateTeamRunState(teamRun.id, state)

        const canRecreate = !!config.canRecreateTasks[memberId]

        const teamContext = `STAGE: "${etapa.name}"
OBJECTIVE: ${etapa.objective}
${previousEtapaResult ? `PREVIOUS STAGE RESULT: ${previousEtapaResult}` : ''}

Previous team member said:
${previousOutput}

${canRecreate
  ? 'You can REJECT if critical issues. Start with "REJECT:" and explain. Otherwise "APPROVED:" with analysis.'
  : 'Analyze and pass conclusions to next member. Be specific.'
}

CONVERSATION only. Do NOT write or edit any code. Only analyze, discuss, and advise.`

        let content: string

        // If this is the Builder and we're in build mode — execute code
        if (member.name === 'Builder' && isBuild) {
          const repo = await prisma.repository.findUnique({ where: { projectId: req.projectId } })
          if (repo) {
            try {
              const buildResult = await runBuildToolLoop({
                encryptedToken: token,
                systemPrompt: `You are the Builder. Execute the plan that your team has created. Build exactly what was specified.\n\nCONTEXT FROM TEAM:\n${previousOutput}`,
                userMessage: previousOutput,
                repositoryId: repo.id,
                projectId: req.projectId,
                chatReq: req,
              })
              content = `Builder: Built successfully. Files touched: ${buildResult.filesTouched.join(', ') || 'none'}\n\n${buildResult.summary}`
              buildReportData = {
                executor: 'Builder',
                filesChanged: buildResult.fileActions,
                toolCalls: buildResult.toolCalls,
                reasoning: previousOutput.length > 1000 ? previousOutput.slice(0, 1000) + '...' : previousOutput,
                summary: buildResult.summary,
                iterationCount: buildResult.iterationCount,
              }
            } catch {
              content = 'Builder: [Build error]'
            }
          } else {
            content = 'Builder: No repository connected. Cannot build.'
          }
        } else {
          // Normal conversation for non-builder members
          try {
            const result = await callAnthropic({
              encryptedToken: token,
              systemPrompt: `${member.systemPrompt}\n\n${teamContext}`,
              userMessage: previousOutput,
              ...getModelOptions(req),
            })
            content = result.text
            if (!content.startsWith(`${member.name}:`)) content = `${member.name}: ${content}`
          } catch {
            content = `${member.name}: [Error]`
          }
        }

        await saveMessage(req, member.name, content)

        // Track step for report
        const stepInput = previousOutput
        currentEtapaSteps.push({
          employee: member.name,
          role: member.name === 'Builder' ? 'Builder' : (memberId === 'security' ? 'Reviewer' : 'Planner'),
          input: stepInput.length > 1000 ? stepInput.slice(0, 1000) + '...' : stepInput,
          output: content.length > 1000 ? content.slice(0, 1000) + '...' : content,
          decision: canRecreate ? (content.toUpperCase().includes('REJECT:') ? 'rejected' : 'approved') : null,
          durationMs: undefined,
        })

        // Update state: mark done
        state[ei].members[i].status = 'done'
        await updateTeamRunState(teamRun.id, state)

        // Check rejection
        if (canRecreate && content.toUpperCase().includes('REJECT:') && restartCount < MAX_RESTARTS) {
          state[ei].members[i].status = 'recreated'

          const redirectToId = config.canRecreateTasks[memberId]
          const redirectToIndex = orderedMembers.findIndex((m) => m.name.toLowerCase() === redirectToId)
          const restartIndex = redirectToIndex !== -1 ? redirectToIndex : 0
          const redirectToName = orderedMembers[restartIndex]?.name ?? orderedMembers[0].name

          state[ei].members[i].redirectedTo = redirectToName

          // Mark redirect in report step
          if (currentEtapaSteps.length > 0) {
            currentEtapaSteps[currentEtapaSteps.length - 1].redirectedTo = redirectToName
          }

          // Add new members for restart
          for (let j = restartIndex; j < orderedMembers.length; j++) {
            state[ei].members.push({ name: orderedMembers[j].name, status: 'pending' })
          }

          await updateTeamRunState(teamRun.id, state)
          await saveMessage(req, 'system', `${member.name} rejected. Redirected to ${redirectToName}.`)

          previousOutput = `REJECTED by ${member.name}: ${content}\n\nRe-analyze with this feedback.`
          i = restartIndex - 1
          restartCount++
          continue
        }

        previousOutput = content
      }

      state[ei].status = 'done'
      await updateTeamRunState(teamRun.id, state)
      previousEtapaResult = previousOutput

      // Collect etapa report
      reportEtapas.push({
        name: etapa.name,
        objective: etapa.objective,
        steps: currentEtapaSteps,
        status: currentEtapaSteps.some((s) => s.decision === 'rejected') ? 'rejected' : 'completed',
      })
    }

    // ── Step 3: Conclusion ─────────────────────────────────────────────

    let conclusion: string
    try {
      const conclusionResult = await callAnthropic({
        encryptedToken: token,
        systemPrompt: 'Summarize the team discussion. Highlight key decisions, action items, and concerns. Start with "Team Conclusion:"',
        userMessage: `Original request: ${req.content}\n\nFinal result: ${previousEtapaResult}`,
        ...getModelOptions(req),
      })
      conclusion = conclusionResult.text
      if (!conclusion.startsWith('Team Conclusion:')) conclusion = `Team Conclusion: ${conclusion}`
    } catch {
      conclusion = 'Team Conclusion: Discussion complete.'
    }

    // Build the report
    const teamReport: ChatReport = {
      type: isBuild ? 'team_build' : 'team_discussion',
      mode: 'team',
      timestamp: new Date().toISOString(),
      question: req.content,
      etapas: reportEtapas,
      build: isBuild ? buildReportData : undefined,
      conclusion,
      model: req.model,
      totalDurationMs: Date.now() - startTime,
    }

    await saveMessage(req, 'team', conclusion, teamReport)
    await prisma.teamRun.update({
      where: { id: teamRun.id },
      data: { status: 'completed' },
    })

  } catch (err) {
    console.error('[chat-engine] Team run failed:', err)
    await prisma.teamRun.update({
      where: { id: teamRun.id },
      data: { status: 'failed' },
    })
    await saveMessage(req, 'system', 'Team processing failed. Please try again.')
  }
}

// ── Build: Direct (no skill) ───────────────────────────────────────────────

async function handleBuildDirect(req: ChatRequest, token: string, userMessage: ChatReply, _compactSummary: string | null = null): Promise<ChatResult> {
  const buildStart = Date.now()
  const repo = await prisma.repository.findUnique({ where: { projectId: req.projectId } })
  if (!repo) {
    const reply = await saveMessage(req, 'system', 'No repository connected. Clone a repo first.')
    return { userMessage, replies: [reply] }
  }

  const result = await runBuildToolLoop({
    encryptedToken: token,
    systemPrompt: `You are a skilled developer. Execute the user's request by reading and writing files in the repository. Be precise and thorough.\n\n${ALL_RULES}`,
    userMessage: req.content,
    repositoryId: repo.id,
    projectId: req.projectId,
    chatReq: req,
  })

  const report: ChatReport = {
    type: 'build',
    mode: 'no_skill',
    timestamp: new Date().toISOString(),
    question: req.content,
    build: {
      executor: 'Claude',
      filesChanged: result.fileActions,
      toolCalls: result.toolCalls,
      reasoning: req.content.length > 1000 ? req.content.slice(0, 1000) + '...' : req.content,
      summary: result.summary,
      iterationCount: result.iterationCount,
    },
    conclusion: result.summary,
    model: req.model,
    totalDurationMs: Date.now() - buildStart,
  }

  await releaseRepoLock(req.projectId, 'chat')
  const reply = await saveMessage(req, 'builder', result.summary, report)
  return { userMessage, replies: [reply] }
}

// ── Build: With Skill ──────────────────────────────────────────────────────

async function handleBuildWithSkill(req: ChatRequest, token: string, userMessage: ChatReply, _compactSummary: string | null = null): Promise<ChatResult> {
  const buildStart = Date.now()
  const skillId = req.activeSkillId
  if (!skillId || !SKILLS[skillId]) {
    const reply = await saveMessage(req, 'system', 'No employee selected.')
    return { userMessage, replies: [reply] }
  }

  const repo = await prisma.repository.findUnique({ where: { projectId: req.projectId } })
  if (!repo) {
    const reply = await saveMessage(req, 'system', 'No repository connected. Clone a repo first.')
    return { userMessage, replies: [reply] }
  }

  const skill = SKILLS[skillId]
  const result = await runBuildToolLoop({
    encryptedToken: token,
    systemPrompt: `${skill.systemPrompt}\n\nYou are now in BUILD MODE. Execute the request by reading and writing files. Apply your expertise as ${skill.name} while building.\n\n${ALL_RULES}`,
    userMessage: req.content,
    repositoryId: repo.id,
    projectId: req.projectId,
    chatReq: req,
  })

  const report: ChatReport = {
    type: 'build',
    mode: 'skill',
    timestamp: new Date().toISOString(),
    question: req.content,
    build: {
      executor: skill.name,
      filesChanged: result.fileActions,
      toolCalls: result.toolCalls,
      reasoning: req.content.length > 1000 ? req.content.slice(0, 1000) + '...' : req.content,
      summary: result.summary,
      iterationCount: result.iterationCount,
    },
    conclusion: result.summary,
    model: req.model,
    totalDurationMs: Date.now() - buildStart,
  }

  await releaseRepoLock(req.projectId, 'chat')
  const reply = await saveMessage(req, skill.name, `${skill.name}: ${result.summary}`, report)
  return { userMessage, replies: [reply] }
}

// ── Build Tool Loop (shared by direct + skill build) ───────────────────────

const MAX_BUILD_ITERATIONS = 30

async function runBuildToolLoop(options: {
  encryptedToken: string
  systemPrompt: string
  userMessage: string
  repositoryId: string
  projectId: string
  chatReq: ChatRequest
}): Promise<{ summary: string; filesTouched: string[]; fileActions: { path: string; action: 'write' | 'delete' }[]; toolCalls: ReportToolCall[]; iterationCount: number }> {
  const messages: ToolCallMessage[] = [
    { role: 'user', content: options.userMessage },
  ]
  const allText: string[] = []
  const filesTouched = new Set<string>()
  const fileActions: { path: string; action: 'write' | 'delete' }[] = []
  const reportToolCalls: ReportToolCall[] = []
  let iterationCount = 0

  for (let i = 0; i < MAX_BUILD_ITERATIONS; i++) {
    iterationCount++
    const response = await callAnthropicWithTools({
      encryptedToken: options.encryptedToken,
      systemPrompt: options.systemPrompt,
      messages,
      tools: REPO_TOOLS,
      maxTokens: 8192,
    })

    for (const block of response.content) {
      if (block.type === 'text') {
        allText.push(block.text)
      }
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

      // Track for report
      const toolPath = toolCall.input.path as string | undefined
      reportToolCalls.push({
        tool: toolCall.name,
        path: toolPath,
        action: `${toolCall.name}${toolPath ? ` → ${toolPath}` : ''}`,
      })

      if (toolCall.name === 'write_file' || toolCall.name === 'delete_file') {
        const filePath = toolCall.input.path as string
        filesTouched.add(filePath)
        fileActions.push({ path: filePath, action: toolCall.name === 'delete_file' ? 'delete' : 'write' })
        // Log file change in chat
        await saveMessage(options.chatReq, 'step', JSON.stringify({
          type: 'file_changed',
          path: toolCall.input.path,
          action: toolCall.name,
        }))
      }
    }

    messages.push({ role: 'user', content: toolResults as unknown as ContentBlock[] })
  }

  const summary = allText.join('\n\n') || 'Build completed.'
  return { summary, filesTouched: [...filesTouched], fileActions, toolCalls: reportToolCalls, iterationCount }
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function updateTeamRunState(teamRunId: string, state: EtapaState[]): Promise<void> {
  await prisma.teamRun.update({
    where: { id: teamRunId },
    data: { state: JSON.parse(JSON.stringify(state)) },
  })
}

// ── Token counting + compaction ────────────────────────────────────────────

// Rough token estimate: ~4 chars per token
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

// Context window limits per model
const MODEL_LIMITS: Record<string, number> = {
  haiku: 200000,
  sonnet: 200000,
  opus: 200000,
}

const COMPACT_THRESHOLD = 0.7 // compact at 70% of limit

/**
 * Get the current context usage (0-1) for a session.
 */
export async function getContextUsage(sessionId: string, modelKey: string = 'sonnet'): Promise<{
  used: number
  limit: number
  percentage: number
  shouldCompact: boolean
  compactSummary: string | null
}> {
  const messages = await prisma.chatMessage.findMany({
    where: { sessionId },
    select: { content: true, sender: true },
    orderBy: { createdAt: 'asc' },
  })

  // Check for existing compact summary
  const compactMsg = messages.filter((m) => m.sender === 'compact').pop()
  const compactSummary = compactMsg?.content ?? null

  // Count tokens of non-compact messages after last compaction
  const compactIndex = compactMsg ? messages.lastIndexOf(compactMsg) : -1
  const relevantMessages = compactIndex >= 0 ? messages.slice(compactIndex + 1) : messages
  const totalText = relevantMessages.map((m) => m.content).join('\n')
  const used = estimateTokens(totalText) + (compactSummary ? estimateTokens(compactSummary) : 0)

  const limit = MODEL_LIMITS[modelKey] ?? 200000
  const percentage = used / limit
  const shouldCompact = percentage >= COMPACT_THRESHOLD

  return { used, limit, percentage, shouldCompact, compactSummary }
}

/**
 * Compact the conversation — summarize old messages, save as special message.
 */
export async function compactConversation(
  sessionId: string,
  projectId: string,
  userId: string,
  encryptedToken: string,
  modelKey: string = 'sonnet'
): Promise<string> {
  const messages = await prisma.chatMessage.findMany({
    where: { sessionId, sender: { notIn: ['plan', 'step', 'compact'] } },
    select: { content: true, sender: true },
    orderBy: { createdAt: 'asc' },
  })

  const allText = messages.map((m) => `${m.sender}: ${m.content}`).join('\n\n')

  const modelId = MODELS[modelKey as keyof typeof MODELS]?.id

  let summary: string
  try {
    const result = await callAnthropic({
      encryptedToken,
      systemPrompt: 'You are a conversation compactor. Summarize the conversation below, keeping ALL technical decisions, code changes, file paths, architecture choices, errors encountered, and action items. Remove small talk and redundant back-and-forth. Be thorough — this summary replaces the original messages as context for future conversation.',
      userMessage: allText,
      model: modelId,
    })
    summary = result.text
  } catch {
    summary = allText.slice(-5000) // fallback: keep last ~5000 chars
  }

  // Save compact summary as special message
  await prisma.chatMessage.create({
    data: {
      projectId,
      userId,
      sessionId,
      content: summary,
      sender: 'compact',
      mode: 'no_skill',
    },
  })

  return summary
}

function getModelOptions(req: ChatRequest): { model?: string; thinkingBudget?: number } {
  const modelKey = req.model as keyof typeof MODELS | undefined
  return {
    model: modelKey && MODELS[modelKey] ? MODELS[modelKey].id : undefined,
    thinkingBudget: req.thinkingBudget,
  }
}

async function saveMessage(req: ChatRequest, sender: string, content: string, report?: ChatReport): Promise<ChatReply> {
  const msg = await prisma.chatMessage.create({
    data: {
      projectId: req.projectId,
      userId: req.userId,
      sessionId: req.sessionId ?? null,
      content,
      sender,
      mode: req.mode,
      activeSkillId: req.activeSkillId ?? null,
      report: report ? JSON.parse(JSON.stringify(report)) : undefined,
    },
    select: { id: true, content: true, sender: true, mode: true, activeSkillId: true },
  })

  // Auto-name session from first user message
  if (sender === 'user' && req.sessionId) {
    const count = await prisma.chatMessage.count({
      where: { sessionId: req.sessionId, sender: 'user' },
    })
    if (count === 1) {
      const name = content.length > 40 ? content.slice(0, 40) + '...' : content
      await prisma.chatSession.update({
        where: { id: req.sessionId },
        data: { name },
      })
    }
  }

  return msg
}
