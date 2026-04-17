import { prisma } from '@/lib/db'
import { callAnthropic, callAnthropicWithTools, MODELS } from '@/lib/anthropic'
import { REPO_TOOLS, READ_TOOLS, executeTool } from '@/lib/tools'
import type { ContentBlock, ToolCallMessage, ToolDefinition } from '@/lib/anthropic'
import type { ChatReport, ReportEtapa, ReportStep, ReportBuildDetails, ReportToolCall, ReportFileChange } from '@/lib/report-types'
import { touchProjectActivity } from '@/lib/repo-lock'
import {
  buildChatPrompt,
  buildSkillChatPrompt,
  buildTeamChatPrompt,
  buildTeamMemberPrompt,
  buildTeamBuilderPrompt,
  buildClassifiedPrompt,
  buildEnvironmentBlock,
  getBasePrompt,
  getSkillPrompt,
  getModePrompt,
  SKILL_NAMES,
  type PermissionMode,
} from '@/lib/prompts'
import { classifyMessage, getModeFileName, type ConversationMessage } from '@/lib/classifier'
import { maybeExtractSessionMemory, getSessionMemory } from '@/lib/session-memory'
import { analyzeContext, logContextSuggestions } from '@/lib/context-analysis'

// ── File Read Cache ────────────────────────────────────────────────────────
// Deduplicates file reads within the same session. When the same file is
// requested again within TTL, we skip the E2B round-trip and return cached
// content — same pattern as Claude Code's FileStateCache.

const FILE_READ_CACHE = new Map<string, { content: string; expiresAt: number }>()
const FILE_CACHE_TTL_MS = 10 * 60 * 1000 // 10 minutes

function getCachedFile(sessionId: string, filePath: string): string | null {
  const key = `${sessionId}:${filePath}`
  const entry = FILE_READ_CACHE.get(key)
  if (!entry || Date.now() > entry.expiresAt) {
    FILE_READ_CACHE.delete(key)
    return null
  }
  return entry.content
}

function setCachedFile(sessionId: string, filePath: string, content: string): void {
  const key = `${sessionId}:${filePath}`
  FILE_READ_CACHE.set(key, { content, expiresAt: Date.now() + FILE_CACHE_TTL_MS })
  // Prune expired entries when cache grows large
  if (FILE_READ_CACHE.size > 300) {
    const now = Date.now()
    for (const [k, v] of FILE_READ_CACHE) {
      if (now > v.expiresAt) FILE_READ_CACHE.delete(k)
    }
  }
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
  permissionMode?: PermissionMode
  projectName?: string
  repoName?: string
  contextPaths?: string[]
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
  permissionRequired?: boolean
  permissionReason?: string
}

// TeamRun state shape (stored as JSON in DB)
interface EtapaState {
  name: string
  objective: string
  members: { name: string; status: 'pending' | 'active' | 'done' | 'recreated'; redirectedTo?: string }[]
  status: 'pending' | 'active' | 'done'
}

// Rules are now loaded from /prompts/*.md via lib/prompts.ts

// ── Error Detection ───────────────────────────────────────────────────────

function getChatErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  const lower = msg.toLowerCase()
  console.error('[chat-engine] Error caught:', msg)

  if (lower.includes('rate_limit') || lower.includes('too many requests') || msg.includes('429')) {
    return 'Rate limited by Anthropic — too many tokens per minute. Wait 30-60 seconds and try again. Tip: upgrade your Anthropic plan for higher limits.'
  }
  if (lower.includes('credit') || lower.includes('quota') || lower.includes('billing')) {
    return 'Your API credits have been exhausted. Please check your Anthropic account billing and add credits.'
  }
  if (lower.includes('overloaded') || msg.includes('529')) {
    return 'Anthropic servers are currently overloaded. Please try again in a few minutes.'
  }
  if (lower.includes('invalid_api_key') || lower.includes('authentication') || lower.includes('401')) {
    return 'Your API key is invalid or expired. Please update it in Settings.'
  }
  if (lower.includes('timeout') || lower.includes('timed out')) {
    return 'The request timed out. This might be due to a complex request — try simplifying or try again.'
  }

  return 'Sorry, I encountered an error. Please try again.'
}

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

  // Enrich req with project/repo name for context injection
  const [projectInfo, repoInfo] = await Promise.all([
    prisma.project.findUnique({ where: { id: req.projectId }, select: { name: true } }),
    prisma.repository.findUnique({ where: { projectId: req.projectId }, select: { githubOwner: true, githubRepo: true } }),
  ])
  req = {
    ...req,
    projectName: projectInfo?.name ?? undefined,
    repoName: repoInfo ? `${repoInfo.githubOwner}/${repoInfo.githubRepo}` : undefined,
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

  // Edição mode: unified edit loop (prefetch + REPO_TOOLS + 30 iterations + report)
  if (req.permissionMode === 'edicao') {
    return handleEdit(req, user.anthropicToken, userMessage, compactSummary)
  }

  // Planejamento mode: Haiku classifies freely + when-planning-output.md always accompanies
  if (req.permissionMode === 'planejamento') {
    return handlePlan(req, user.anthropicToken, userMessage, compactSummary)
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

// ── Prefetch Context ───────────────────────────────────────────────────────
//
// Uses semantic vector search (Voyage AI + pgvector) to find relevant chunks.
// Falls back to grep-based search if the index isn't ready yet.

async function prefetchContext(req: ChatRequest, keywords: string[], classifierMode?: string | null): Promise<string> {
  const repo = await prisma.repository.findUnique({
    where: { projectId: req.projectId },
    select: { id: true, fileTree: true },
  })
  if (!repo) return ''

  const sections: string[] = []

  // Pinned files — injected first, highest priority context
  if (req.contextPaths && req.contextPaths.length > 0) {
    const sessionId = req.sessionId ?? req.projectId
    const pinnedResults = await Promise.all(
      req.contextPaths.map(async (filePath) => {
        const cached = getCachedFile(sessionId, filePath)
        if (cached) return { filePath, content: cached }
        // Pass sessionId so the read happens inside the chat's worktree.
        // Pinned files reflect the chat's current state, not main.
        const file = await executeTool(repo.id, 'read_file', { path: filePath }, req.projectId, req.sessionId)
        if (!file.isError && file.result.trim()) {
          setCachedFile(sessionId, filePath, file.result)
          return { filePath, content: file.result }
        }
        return null
      })
    )
    for (const entry of pinnedResults) {
      if (entry) sections.push(`## ${entry.filePath} [pinned]\n\`\`\`\n${entry.content}\n\`\`\``)
    }
    console.log(`[prefetch] pinned: ${pinnedResults.filter(Boolean).length} files`)
  }

  // fileTree — always injected as the project map
  let fileTree = repo.fileTree
  if (!fileTree) {
    try {
      // run_command_readonly auto-cds into the worktree if sessionId is set
      const treeResult = await executeTool(repo.id, 'run_command_readonly', {
        command: `find . -type f -not -path './.git/*' -not -path './node_modules/*' -not -path './__pycache__/*' -not -path './.next/*' -not -path './dist/*' | sed 's|^\\./||' | sort`
      }, req.projectId, req.sessionId)
      if (!treeResult.isError && treeResult.result.trim()) {
        fileTree = treeResult.result.trim()
        prisma.repository.update({
          where: { projectId: req.projectId },
          data: { fileTree, fileTreeUpdatedAt: new Date() },
        }).catch(() => {})
        console.log(`[filetree] Built on-demand: ${fileTree.split('\n').length} files`)
      }
    } catch {}
  }
  if (fileTree) sections.push(`## Project file tree\n${fileTree}`)

  // ── Vector retrieval ────────────────────────────────────────────────────
  try {
    const { retrieveChunks, hasIndex } = await import('@/lib/embeddings/retriever')
    const indexed = await hasIndex(repo.id)

    if (!indexed) {
      // Index empty — build in background, current message uses grep fallback
      console.log('[prefetch] Index empty — triggering background build')
      import('@/lib/embeddings/indexer').then(({ buildIndex }) => {
        buildIndex(req.projectId).catch(() => {})
      })
    }

    if (indexed) {
      // Build query: question + keywords for richer embedding
      const query = keywords.length > 0
        ? `${req.content}\n\nKeywords: ${keywords.join(', ')}`
        : req.content

      const pinnedSet = new Set(req.contextPaths ?? [])
      const allChunks = await retrieveChunks(repo.id, query, classifierMode ?? null)
      // Remove chunks from pinned files — already in context complete
      const chunks = allChunks.filter(c => !pinnedSet.has(c.filePath))

      if (chunks.length > 0) {
        // Group by file — show each file once with all its relevant chunks
        const byFile = new Map<string, typeof chunks>()
        for (const chunk of chunks) {
          if (!byFile.has(chunk.filePath)) byFile.set(chunk.filePath, [])
          byFile.get(chunk.filePath)!.push(chunk)
        }

        for (const [filePath, fileChunks] of byFile) {
          const content = fileChunks.map((c) => c.content).join('\n\n// ...\n\n')
          sections.push(`## ${filePath}\n\`\`\`\n${content}\n\`\`\``)
        }

        const fileCount = byFile.size
        const chunkCount = chunks.length
        const topScore = chunks[0]?.score.toFixed(3)
        const skipped = allChunks.length - chunks.length
        console.log(`[prefetch] vector: ${chunkCount} chunks from ${fileCount} files | top score: ${topScore}${skipped > 0 ? ` | skipped ${skipped} pinned` : ''}`)
        return sections.join('\n\n')
      }
    }
  } catch (err) {
    // Index not available — fall through to grep
    console.log('[prefetch] Vector search unavailable, falling back to grep:', (err as Error).message)
  }

  // ── Grep fallback (no index yet) ────────────────────────────────────────
  if (keywords.length === 0) return sections.join('\n\n')

  // All keyword searches fire in parallel — scoped to the chat's worktree
  const searchResults = await Promise.all(
    keywords.slice(0, 3).map(kw => executeTool(repo.id, 'search_files', { query: kw }, req.projectId, req.sessionId).then(r => ({ kw, r })))
  )

  const fileScores = new Map<string, number>()
  for (const { kw, r } of searchResults) {
    if (r.isError || !r.result.trim()) continue
    for (const line of r.result.split('\n')) {
      const match = line.match(/^\.?\/?([^:]+\.[a-z]+):\d+:/)
      if (!match) continue
      const filePath = match[1].replace(/^\//, '')
      if (/\.(lock|log|map)$/.test(filePath)) continue
      if (/(node_modules|__pycache__|\.next|dist\/|\.test\.|\.spec\.)/.test(filePath)) continue

      let score = fileScores.get(filePath) || 0
      if (/\.(ts|tsx)$/.test(filePath)) score += 2
      else if (/\.(js|jsx)$/.test(filePath)) score += 1
      if (filePath.toLowerCase().includes(kw.toLowerCase())) score += 3
      if (/^(lib|app|src|middleware|components|hooks|utils)\//.test(filePath)) score += 1
      fileScores.set(filePath, score + 1)
    }
  }

  const topFiles = Array.from(fileScores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([path]) => path)

  console.log(`[prefetch] grep fallback: [${topFiles.join(', ')}]`)

  // All file reads fire in parallel — scoped to the chat's worktree
  const sessionId = req.sessionId ?? req.projectId
  const fileResults = await Promise.all(
    topFiles.map(async filePath => {
      const cached = getCachedFile(sessionId, filePath)
      if (cached) return { filePath, content: cached }
      const file = await executeTool(repo.id, 'read_file', { path: filePath }, req.projectId, req.sessionId)
      if (!file.isError && file.result.trim()) {
        setCachedFile(sessionId, filePath, file.result)
        return { filePath, content: file.result }
      }
      return null
    })
  )

  for (const entry of fileResults) {
    if (entry) sections.push(`## ${entry.filePath}\n\`\`\`\n${entry.content}\n\`\`\``)
  }

  return sections.join('\n\n')
}

// ── Recent Messages for Classifier Context ────────────────────────────────

async function getRecentMessagesForClassifier(req: ChatRequest, limit = 4): Promise<ConversationMessage[]> {
  if (!req.sessionId && !req.projectId) return []

  try {
    const where = req.sessionId
      ? { sessionId: req.sessionId }
      : { projectId: req.projectId }

    const messages = await prisma.chatMessage.findMany({
      where: { ...where, sender: { in: ['user', 'claude'] } },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { sender: true, content: true },
    })

    return messages
      .reverse()
      .map(m => ({
        role: (m.sender === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
        content: m.content,
      }))
  } catch {
    return []
  }
}

// ── Permission Mode Helpers ────────────────────────────────────────────────

/**
 * Returns the correct tool pool based on permission mode.
 * Build sessions always get REPO_TOOLS regardless of mode.
 */
function getToolsForMode(permissionMode?: PermissionMode, isBuild?: boolean): ToolDefinition[] {
  if (isBuild) return REPO_TOOLS as unknown as ToolDefinition[]
  return (permissionMode === 'edicao' ? REPO_TOOLS : READ_TOOLS) as unknown as ToolDefinition[]
}

const PERMISSION_REQUEST_REGEX = /\[REQUEST_EDIT_PERMISSION:\s*(.+?)\]/i

/**
 * Detect if Claude is requesting edit permission in leitura mode.
 * Returns { required: true, reason, cleaned } if found.
 */
function detectPermissionRequest(content: string): { required: boolean; reason: string; cleaned: string } {
  const match = content.match(PERMISSION_REQUEST_REGEX)
  if (!match) return { required: false, reason: '', cleaned: content }
  return {
    required: true,
    reason: match[1].trim(),
    cleaned: content.replace(PERMISSION_REQUEST_REGEX, '').trim(),
  }
}

// ── Edit Mode (unified loop) ───────────────────────────────────────────────
//
// Best of both worlds:
//   - Prefetch semantic context (from Ask) → Claude starts with relevant code
//   - systemParts with cache blocks (from Ask) → cheaper API calls
//   - 30 iterations (from Build) → enough for complex changes
//   - Per-file step logging (from Build) → real-time visibility
//   - Final report (from Build) → traceability
//   - Repo lock while editing → prevents conflicts
//   - No separate build session authorization — permission mode handles it

async function handleEdit(req: ChatRequest, token: string, userMessage: ChatReply, _compactSummary: string | null = null): Promise<ChatResult> {
  const buildStart = Date.now()

  const repo = await prisma.repository.findUnique({ where: { projectId: req.projectId } })
  if (!repo) {
    const reply = await saveMessage(req, 'system', 'No repository connected. Clone a repo first.')
    return { userMessage, replies: [reply] }
  }

  // Each chat works in its own worktree — no need to acquire a global repo
  // lock. Concurrent chats can run in parallel without conflicting.
  try {
    // Classify + build prompt (same as Ask — mode-aware, cached blocks)
    const recentMessages = await getRecentMessagesForClassifier(req)
    const classification = await classifyMessage(req.content, token, recentMessages)
    const modeFile = getModeFileName(classification.mode)
    // isExecution=true → loads when-after-execution.md with edit-specific rules
    const systemParts = [...buildClassifiedPrompt(modeFile, true), buildEnvironmentBlock(req.model, req.permissionMode, req.projectName, req.repoName)]
    console.log(`[edit] Mode: ${classification.mode} | Parts: ${systemParts.length} | Prompt: ${systemParts.reduce((s, p) => s + p.length, 0)} chars`)

    // Prefetch semantic context — Claude starts with relevant code already in hand
    const context = await prefetchContext(req, classification.keywords, classification.mode)
    const userContent = context
      ? `${req.content}\n\n---\nFILES ALREADY LOADED — these files are in your context, do not fetch them again. Use tools only if you need files not listed here:\n${context}`
      : req.content

    // Run unified edit tool loop
    const result = await runEditToolLoop({
      encryptedToken: token,
      systemParts,
      userContent,
      repositoryId: repo.id,
      projectId: req.projectId,
      chatReq: req,
      compactSummary: _compactSummary,
    })

    const report: ChatReport = {
      type: 'build',
      mode: req.mode === 'skill' ? 'skill' : 'no_skill',
      timestamp: new Date().toISOString(),
      question: req.content,
      build: {
        executor: req.activeSkillId ? (SKILL_NAMES[req.activeSkillId] ?? req.activeSkillId) : 'Claude',
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

    const reply = await saveMessage(req, 'claude', result.summary, report)

    // Update file tree + semantic index after Agent edits — keeps context fresh
    if (result.fileActions.length > 0) {
      refreshFileTree(req.projectId).catch(() => {})
      const touchedPaths = result.fileActions.map((a: { path: string }) => a.path).filter(Boolean)
      if (touchedPaths.length > 0) {
        import('@/lib/embeddings/indexer').then(({ updateIndex }) => {
          updateIndex(req.projectId, touchedPaths).catch(() => {})
        })
      }
    }

    return { userMessage, replies: [reply] }
  } finally {
    // Worktree-based isolation — no global lock to release
  }
}

async function refreshFileTree(projectId: string): Promise<void> {
  try {
    const { ensureSandboxRunning, execInSandbox } = await import('@/lib/sandbox-manager')
    const projectPath = await ensureSandboxRunning(projectId)
    if (!projectPath) return
    const result = await execInSandbox(projectId, `find ${projectPath} -type f -not -path '*/.git/*' -not -path '*/node_modules/*' -not -path '*/__pycache__/*' -not -path '*/.next/*' -not -path '*/dist/*' | sed 's|${projectPath}/||' | sort`)
    if (result.stdout.trim()) {
      await prisma.repository.update({
        where: { projectId },
        data: { fileTree: result.stdout.trim(), fileTreeUpdatedAt: new Date() },
      })
      console.log(`[filetree] Refreshed: ${result.stdout.trim().split('\n').length} files`)
    }
  } catch (err) {
    console.error('[filetree] Refresh failed:', err)
  }
}

// ── Edit Tool Loop ─────────────────────────────────────────────────────────

const MAX_EDIT_ITERATIONS = 30

async function runEditToolLoop(options: {
  encryptedToken: string
  systemParts: string[]
  userContent: string
  repositoryId: string
  projectId: string
  chatReq: ChatRequest
  compactSummary?: string | null
}): Promise<{ summary: string; fileActions: ReportFileChange[]; toolCalls: ReportToolCall[]; iterationCount: number }> {
  const messages: ToolCallMessage[] = [{ role: 'user', content: options.userContent }]
  const allText: string[] = []
  const fileActions: ReportFileChange[] = []
  const reportToolCalls: ReportToolCall[] = []
  let iterationCount = 0

  for (let i = 0; i < MAX_EDIT_ITERATIONS; i++) {
    iterationCount++
    const response = await callAnthropicWithTools({
      encryptedToken: options.encryptedToken,
      systemParts: options.systemParts,
      compactSummary: options.compactSummary ?? undefined,
      messages,
      tools: REPO_TOOLS as unknown as ToolDefinition[],
      maxTokens: 8192,
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

    // Step messages fire in parallel, then all tools execute in parallel
    await Promise.all(toolUseBlocks.map(tc =>
      saveMessage(options.chatReq, 'step', JSON.stringify({ type: 'tool_call', label: toolStepLabel(tc.name, tc.input) }))
    ))

    const toolResults = await Promise.all(toolUseBlocks.map(async toolCall => {
      const result = await executeTool(options.repositoryId, toolCall.name, toolCall.input, options.projectId, options.chatReq.sessionId)

      const toolPath = toolCall.input.path as string | undefined
      reportToolCalls.push({ tool: toolCall.name, path: toolPath, action: `${toolCall.name}${toolPath ? ` → ${toolPath}` : ''}` })

      if (toolCall.name === 'write_file' || toolCall.name === 'edit_file' || toolCall.name === 'delete_file') {
        const filePath = toolCall.input.path as string
        const action = toolCall.name === 'delete_file' ? 'delete' : 'write'
        let diff: string | undefined
        try {
          const diffResult = await executeTool(options.repositoryId, 'run_command_readonly', {
            command: `git diff HEAD -- '${filePath}' 2>/dev/null || git diff -- '${filePath}' 2>/dev/null`
          }, options.projectId, options.chatReq.sessionId)
          if (!diffResult.isError && diffResult.result.trim()) diff = diffResult.result.trim()
        } catch {}
        fileActions.push({ path: filePath, action, diff })
      }

      return { type: 'tool_result' as const, tool_use_id: toolCall.id, content: result.result, is_error: result.isError || undefined }
    }))

    messages.push({ role: 'user', content: toolResults as unknown as ContentBlock[] })
  }

  return {
    summary: allText.join('\n\n') || 'Done.',
    fileActions,
    toolCalls: reportToolCalls,
    iterationCount,
  }
}

// ── Plan Mode ──────────────────────────────────────────────────────────────
//
// Always forces when-planning.md into the prompt regardless of Haiku's classification.
// Uses READ_TOOLS — Claude reads the codebase to produce an accurate plan.
// Never executes writes. No permission request needed — Plan mode never acts.

async function handlePlan(req: ChatRequest, token: string, userMessage: ChatReply, _compactSummary: string | null = null): Promise<ChatResult> {
  let content: string

  try {
    const recentMessages = await getRecentMessagesForClassifier(req)
    const classification = await classifyMessage(req.content, token, recentMessages)

    // Block 0: base.md — shared cache
    // Block 1: classified mode (Haiku decides) + when-planning-output.md always
    // Same pattern as Edit: mode tells Claude how to approach, planning-output tells how to format the result
    const base = getBasePrompt()
    const modeFile = getModeFileName(classification.mode)
    const modePrompt = modeFile ? getModePrompt(modeFile) : null
    const planningOutput = getModePrompt('when-planning-output.md')
    const block1Parts = [...(modePrompt ? [modePrompt] : []), planningOutput].join('\n\n---\n\n')
    const systemParts = [base, block1Parts, buildEnvironmentBlock(req.model, req.permissionMode, req.projectName, req.repoName)]

    console.log(`[plan] Classified: ${classification.mode} | Keywords: [${classification.keywords.join(', ')}] | Prompt: ${systemParts.reduce((s, p) => s + p.length, 0)} chars`)

    // Prefetch semantic context + READ_TOOLS — Claude reads to plan accurately
    const context = await prefetchContext(req, classification.keywords, classification.mode)
    const userContent = context
      ? `${req.content}\n\n---\nFILES ALREADY LOADED — these files are in your context, do not fetch them again. Use tools only if you need files not listed here:\n${context}`
      : req.content

    const response = await callAnthropicWithTools({
      encryptedToken: token,
      systemParts,
      compactSummary: _compactSummary ?? undefined,
      messages: [{ role: 'user', content: userContent }],
      tools: READ_TOOLS as unknown as ToolDefinition[],
      maxTokens: 8192,
    })
    content = await processReadToolLoop(token, req, response, systemParts, READ_TOOLS as unknown as ToolDefinition[], _compactSummary ?? undefined)
  } catch (err) {
    content = getChatErrorMessage(err)
  }

  const { cleanedResponse, created } = await detectAndCreateTask(content, req)
  const replies: ChatReply[] = []
  replies.push(await saveMessage(req, 'claude', cleanedResponse))
  if (created === 'task') {
    replies.push(await saveMessage(req, 'system', 'Task created — manage it in the Tasks tab.'))
  }

  if (req.sessionId) {
    const allMessages = await prisma.chatMessage.findMany({
      where: { sessionId: req.sessionId },
      select: { content: true, sender: true },
      orderBy: { createdAt: 'asc' },
    })
    const ctxStats = analyzeContext(allMessages)
    logContextSuggestions(ctxStats, req.sessionId)
    maybeExtractSessionMemory(req.sessionId, req.projectId, req.userId, allMessages, token)
  }

  return { userMessage, replies }
}

// ── No Skill ───────────────────────────────────────────────────────────────

async function handleNoSkill(req: ChatRequest, token: string, userMessage: ChatReply, compactSummary: string | null = null): Promise<ChatResult> {
  let content: string

  try {
    // Fetch recent messages so Haiku has conversation context for keyword extraction
    const recentMessages = await getRecentMessagesForClassifier(req)
    // Classify the message to pick the right mode prompt + keywords
    const classification = await classifyMessage(req.content, token, recentMessages)
    const modeFile = getModeFileName(classification.mode)
    // Leitura never loads when-after-execution.md — Claude isn't editing anything
    const systemParts = [...buildClassifiedPrompt(modeFile, false), buildEnvironmentBlock(req.model, req.permissionMode, req.projectName, req.repoName)]
    const totalPromptSize = systemParts.reduce((s, p) => s + p.length, 0)
    console.log(`[prompt] Mode: ${classification.mode} → File: ${modeFile || 'none'} | Permission: ${req.permissionMode ?? 'leitura'} | Parts: ${systemParts.length} | Prompt size: ${totalPromptSize} chars`)

    // Tools always follow permission mode — greeting/offtopic only skip prefetch
    const tools = getToolsForMode(req.permissionMode, req.isBuild)
    const isGreeting = classification.mode === 'greeting' || classification.mode === 'offtopic'
    const context = isGreeting ? '' : await prefetchContext(req, classification.keywords, classification.mode)
    const userContent = context
      ? `${req.content}\n\n---\nRelevant code from the repository:\n${context}`
      : req.content

    const response = await callAnthropicWithTools({
      encryptedToken: token,
      systemParts,
      compactSummary: compactSummary ?? undefined,
      messages: [{ role: 'user', content: userContent }],
      tools,
      maxTokens: 8192,
    })
    content = await processReadToolLoop(token, req, response, systemParts, tools, compactSummary ?? undefined)
  } catch (err) {
    content = getChatErrorMessage(err)
  }

  // Check if Claude is requesting edit permission (leitura mode)
  const permCheck = detectPermissionRequest(content)
  if (permCheck.required) {
    const savedUser = await saveMessage(req, 'claude', permCheck.cleaned)
    return { userMessage, replies: [savedUser], permissionRequired: true, permissionReason: permCheck.reason }
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

  // Fire-and-forget: context analysis + session memory — never blocks the response
  if (req.sessionId) {
    const allMessages = await prisma.chatMessage.findMany({
      where: { sessionId: req.sessionId },
      select: { content: true, sender: true },
      orderBy: { createdAt: 'asc' },
    })
    const ctxStats = analyzeContext(allMessages)
    logContextSuggestions(ctxStats, req.sessionId)
    maybeExtractSessionMemory(req.sessionId, req.projectId, req.userId, allMessages, token)
  }

  return { userMessage, replies }
}

// ── Skill ──────────────────────────────────────────────────────────────────

async function handleSkill(req: ChatRequest, token: string, userMessage: ChatReply, compactSummary: string | null = null): Promise<ChatResult> {
  const skillId = req.activeSkillId
  const skillName = skillId ? SKILL_NAMES[skillId] : null
  if (!skillId || !skillName) {
    const reply = await saveMessage(req, 'system', 'No employee selected.')
    return { userMessage, replies: [reply] }
  }

  let content: string

  try {
    // Classify + build prompt with skill + mode
    const recentMessages = await getRecentMessagesForClassifier(req)
    const classification = await classifyMessage(req.content, token, recentMessages)
    const modeFile = getModeFileName(classification.mode)
    // Leitura never loads when-after-execution.md — Claude isn't editing anything
    const [base, ...modeParts] = buildClassifiedPrompt(modeFile, false)
    // base.md stays as block [0] alone — shared cache hit across ALL skills.
    // skill prompt is block [1] — only this block changes on skill switch.
    const systemParts = [base, getSkillPrompt(skillId), ...modeParts, buildEnvironmentBlock(req.model, req.permissionMode, req.projectName, req.repoName)]
    const totalSize = systemParts.reduce((s, p) => s + p.length, 0)
    console.log(`[prompt] Skill: ${skillName} | Mode: ${classification.mode} → File: ${modeFile || 'none'} | Permission: ${req.permissionMode ?? 'leitura'} | Parts: ${systemParts.length} | Prompt size: ${totalSize} chars`)

    const tools = getToolsForMode(req.permissionMode, req.isBuild)

    // Always: prefetch semantic context + give Claude tools to expand if needed.
    const context = await prefetchContext(req, classification.keywords, classification.mode)
    const userContent = context
      ? `${req.content}\n\n---\nFILES ALREADY LOADED — these files are in your context, do not fetch them again. Use tools only if you need files not listed here:\n${context}`
      : req.content

    const response = await callAnthropicWithTools({
      encryptedToken: token,
      systemParts,
      compactSummary: compactSummary ?? undefined,
      messages: [{ role: 'user', content: userContent }],
      tools,
      maxTokens: 8192,
    })
    content = await processReadToolLoop(token, req, response, systemParts, tools, compactSummary ?? undefined)
    if (!content.startsWith(`${skillName}:`)) content = `${skillName}: ${content}`
  } catch (err) {
    content = `${skillName}: ${getChatErrorMessage(err)}`
  }

  // Check if Claude is requesting edit permission (leitura mode)
  const permCheck = detectPermissionRequest(content)
  if (permCheck.required) {
    const savedUser = await saveMessage(req, skillName, permCheck.cleaned)
    return { userMessage, replies: [savedUser], permissionRequired: true, permissionReason: permCheck.reason }
  }

  // Check if employee proactively suggested a task/reminder
  const { cleanedResponse, created } = await detectAndCreateTask(content, req)
  const replies: ChatReply[] = []
  replies.push(await saveMessage(req, skillName, cleanedResponse))
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
    .map((id) => id === 'builder' ? { id: 'builder', name: 'Builder' } : { id, name: SKILL_NAMES[id] ?? id })
    .filter((s) => !!s.name)

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
                systemPrompt: `${buildTeamBuilderPrompt()}\n\nCONTEXT FROM TEAM:\n${previousOutput}`,
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
            } catch (buildErr) {
              content = `Builder: [Build error — ${getChatErrorMessage(buildErr)}]`
            }
          } else {
            content = 'Builder: No repository connected. Cannot build.'
          }
        } else {
          // Non-builder members — with read tools to analyze code
          const memberRepo = await prisma.repository.findUnique({ where: { projectId: req.projectId }, select: { id: true } })
          try {
            if (memberRepo) {
              // With read tools — can read files while analyzing
              const memberMessages: ToolCallMessage[] = [{ role: 'user', content: previousOutput }]
              let memberText = ''

              for (let ti = 0; ti < 5; ti++) {
                const response = await callAnthropicWithTools({
                  encryptedToken: token,
                  systemPrompt: `${buildTeamMemberPrompt(member.id)}\n\n${teamContext}`,
                  messages: memberMessages,
                  tools: READ_TOOLS,
                  maxTokens: 8192,
                })

                for (const block of response.content) {
                  if (block.type === 'text') memberText += (memberText ? '\n\n' : '') + block.text
                }

                if (response.stopReason === 'end_turn' || response.stopReason === 'max_tokens') break

                const memberToolBlocks = response.content.filter(
                  (b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use'
                )
                if (memberToolBlocks.length === 0) break

                memberMessages.push({ role: 'assistant', content: response.content })
                const memberToolResults = await Promise.all(
                  memberToolBlocks.map(async tc => {
                    const r = await executeTool(memberRepo.id, tc.name, tc.input, req.projectId, req.sessionId)
                    return { type: 'tool_result' as const, tool_use_id: tc.id, content: r.result, is_error: r.isError || undefined }
                  })
                )
                memberMessages.push({ role: 'user', content: memberToolResults as unknown as ContentBlock[] })
              }

              content = memberText || `${member.name}: [No response]`
            } else {
              const result = await callAnthropic({
                encryptedToken: token,
                systemPrompt: `${buildTeamMemberPrompt(member.id)}\n\n${teamContext}`,
                userMessage: previousOutput,
                ...getModelOptions(req),
              })
              content = result.text
            }
            if (!content.startsWith(`${member.name}:`)) content = `${member.name}: ${content}`
          } catch (memberErr) {
            content = `${member.name}: [${getChatErrorMessage(memberErr)}]`
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
    await saveMessage(req, 'system', `Team processing failed. ${getChatErrorMessage(err)}`)
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

  // Build mode — always execution, use after-execution prompt
  const buildPrompt = buildClassifiedPrompt(null, true).join('\n\n---\n\n')

  const result = await runBuildToolLoop({
    encryptedToken: token,
    systemPrompt: buildPrompt,
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

  const reply = await saveMessage(req, 'builder', result.summary, report)
  return { userMessage, replies: [reply] }
}

// ── Build: With Skill ──────────────────────────────────────────────────────

async function handleBuildWithSkill(req: ChatRequest, token: string, userMessage: ChatReply, _compactSummary: string | null = null): Promise<ChatResult> {
  const buildStart = Date.now()
  const skillId = req.activeSkillId
  const skillBuildName = skillId ? SKILL_NAMES[skillId] : null
  if (!skillId || !skillBuildName) {
    const reply = await saveMessage(req, 'system', 'No employee selected.')
    return { userMessage, replies: [reply] }
  }

  const repo = await prisma.repository.findUnique({ where: { projectId: req.projectId } })
  if (!repo) {
    const reply = await saveMessage(req, 'system', 'No repository connected. Clone a repo first.')
    return { userMessage, replies: [reply] }
  }

  // Build with skill — execution mode + skill prompt
  const buildPrompt = [getSkillPrompt(skillId), ...buildClassifiedPrompt(null, true)].join('\n\n---\n\n')

  const result = await runBuildToolLoop({
    encryptedToken: token,
    systemPrompt: buildPrompt,
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
      executor: skillBuildName,
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

  const reply = await saveMessage(req, skillBuildName, `${skillBuildName}: ${result.summary}`, report)
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
}): Promise<{ summary: string; filesTouched: string[]; fileActions: ReportFileChange[]; toolCalls: ReportToolCall[]; iterationCount: number }> {
  const messages: ToolCallMessage[] = [
    { role: 'user', content: options.userMessage },
  ]
  const allText: string[] = []
  const filesTouched = new Set<string>()
  const fileActions: ReportFileChange[] = []
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

    // All tool calls fire in parallel
    const toolResults = await Promise.all(
      toolUseBlocks.map(async toolCall => {
        const result = await executeTool(options.repositoryId, toolCall.name, toolCall.input, options.projectId, options.chatReq.sessionId)

        const toolPath = toolCall.input.path as string | undefined
        reportToolCalls.push({
          tool: toolCall.name,
          path: toolPath,
          action: `${toolCall.name}${toolPath ? ` → ${toolPath}` : ''}`,
        })

        if (toolCall.name === 'write_file' || toolCall.name === 'delete_file') {
          const filePath = toolCall.input.path as string
          filesTouched.add(filePath)
          const action = toolCall.name === 'delete_file' ? 'delete' : 'write'
          let diff: string | undefined
          try {
            const diffResult = await executeTool(options.repositoryId, 'run_command_readonly', {
              command: `git diff HEAD -- '${filePath}' 2>/dev/null || git diff -- '${filePath}' 2>/dev/null`
            }, options.projectId, options.chatReq.sessionId)
            if (!diffResult.isError && diffResult.result.trim()) diff = diffResult.result.trim()
          } catch {}
          fileActions.push({ path: filePath, action, diff })
          saveMessage(options.chatReq, 'step', JSON.stringify({
            type: 'file_changed',
            path: toolCall.input.path,
            action: toolCall.name,
            diff,
          })).catch(() => {})
        }

        return {
          type: 'tool_result' as const,
          tool_use_id: toolCall.id,
          content: result.result,
          is_error: result.isError || undefined,
        }
      })
    )

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
 * Compact the conversation — uses session memory as structured context when available,
 * falls back to full conversation summary otherwise.
 */
export async function compactConversation(
  sessionId: string,
  projectId: string,
  userId: string,
  encryptedToken: string,
  modelKey: string = 'sonnet'
): Promise<string> {
  const messages = await prisma.chatMessage.findMany({
    where: { sessionId, sender: { notIn: ['plan', 'step', 'compact', 'session_memory'] } },
    select: { content: true, sender: true },
    orderBy: { createdAt: 'asc' },
  })

  const modelId = MODELS[modelKey as keyof typeof MODELS]?.id

  // Try session-memory-assisted compaction first
  const sessionMemory = await getSessionMemory(sessionId)

  let summary: string
  try {
    if (sessionMemory) {
      // Session memory path: structured notes + recent messages
      // This is smarter — session memory already captured decisions and context
      const recentMessages = messages.slice(-20) // last 20 messages
      const recentText = recentMessages.map((m) => `${m.sender}: ${m.content}`).join('\n\n')

      const result = await callAnthropic({
        encryptedToken,
        systemPrompt: 'You are a conversation compactor. You have structured session notes and recent messages. Produce a concise but complete context summary that preserves: all technical decisions, file paths, function names, errors and fixes, current state, and next steps. This summary replaces the conversation history as context.',
        userMessage: `## Structured Session Notes\n\n${sessionMemory}\n\n---\n\n## Recent Messages\n\n${recentText}`,
        model: modelId,
      })
      summary = result.text
      console.log('[compact] Used session memory assisted compaction')
    } else {
      // Fallback: full conversation summary
      const allText = messages.map((m) => `${m.sender}: ${m.content}`).join('\n\n')
      const result = await callAnthropic({
        encryptedToken,
        systemPrompt: 'You are a conversation compactor. Summarize the conversation below, keeping ALL technical decisions, code changes, file paths, architecture choices, errors encountered, and action items. Remove small talk and redundant back-and-forth. Be thorough — this summary replaces the original messages as context for future conversation.',
        userMessage: allText,
        model: modelId,
      })
      summary = result.text
      console.log('[compact] Used full conversation compaction (no session memory)')
    }
  } catch {
    const allText = messages.map((m) => m.content).join('\n')
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

// ── Tool Step Label ────────────────────────────────────────────────────────

function toolStepLabel(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'read_file':
      return `Reading \`${input.path}\``
    case 'list_dir':
      return `Listing \`${input.path || '/'}\``
    case 'search_files':
      return `Searching for \`${input.query}\`${input.glob ? ` in \`${input.glob}\`` : ''}`
    case 'glob':
      return `Finding files matching \`${input.pattern}\``
    case 'web_fetch':
      return `Fetching \`${input.url}\``
    case 'run_command_readonly':
      return `Running \`${input.command}\``
    case 'edit_file':
      return `Editing \`${input.path}\``
    case 'write_file':
      return `Writing \`${input.path}\``
    case 'delete_file':
      return `Deleting \`${input.path}\``
    case 'run_command':
      return `Running \`${input.command}\``
    default:
      return `Using ${toolName}`
  }
}

// ── Read-only tool loop (for conversation modes) ──────────────────────────

const MAX_READ_ITERATIONS: Record<string, number> = {
  leitura: 10,
  planejamento: 15,
  edicao: 10,
}

async function processReadToolLoop(
  token: string,
  req: ChatRequest,
  initialResponse: { content: ContentBlock[]; stopReason: string },
  systemParts?: string | string[],
  tools?: ToolDefinition[],
  compactSummary?: string,
): Promise<string> {
  const activeTools = tools ?? (READ_TOOLS as unknown as ToolDefinition[])
  const parts: string[] = Array.isArray(systemParts)
    ? systemParts
    : systemParts
    ? [systemParts]
    : buildClassifiedPrompt(null, false)
  const messages: ToolCallMessage[] = [{ role: 'user', content: req.content }]

  // Only collect text from end_turn responses — intermediate text (e.g. "Vou analisar...")
  // from rounds where the model is still calling tools is discarded.
  if (initialResponse.stopReason === 'end_turn' || initialResponse.stopReason === 'max_tokens') {
    const text = initialResponse.content.filter((b) => b.type === 'text').map((b) => (b as { type: 'text'; text: string }).text).join('\n\n')
    return text || 'Sorry, I could not generate a response.'
  }

  messages.push({ role: 'assistant', content: initialResponse.content })

  const toolUseBlocks = initialResponse.content.filter(
    (b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use'
  )

  if (toolUseBlocks.length === 0) {
    const text = initialResponse.content.filter((b) => b.type === 'text').map((b) => (b as { type: 'text'; text: string }).text).join('\n\n')
    return text
  }

  const repo = await prisma.repository.findUnique({ where: { projectId: req.projectId }, select: { id: true } })
  if (!repo) return 'Sorry, I could not generate a response.'

  // Execute tools in parallel — step messages fire concurrently, then all tools run at once
  const execBatch = async (blocks: Extract<ContentBlock, { type: 'tool_use' }>[]) => {
    await Promise.all(blocks.map(tc =>
      saveMessage(req, 'step', JSON.stringify({ type: 'tool_call', label: toolStepLabel(tc.name, tc.input) }))
    ))
    return Promise.all(blocks.map(async tc => {
      const result = await executeTool(repo.id, tc.name, tc.input, req.projectId, req.sessionId)
      return { type: 'tool_result' as const, tool_use_id: tc.id, content: result.result, is_error: result.isError || undefined }
    }))
  }

  const toolResults = await execBatch(toolUseBlocks)
  messages.push({ role: 'user', content: toolResults as unknown as ContentBlock[] })

  let finalText = ''
  let hitLimit = false

  const maxIter = MAX_READ_ITERATIONS[req.permissionMode ?? 'leitura'] ?? 10
  for (let i = 0; i < maxIter; i++) {
    const response = await callAnthropicWithTools({
      encryptedToken: token,
      systemParts: parts,
      compactSummary,
      messages,
      tools: activeTools,
      maxTokens: 8192,
    })

    const roundText = response.content.filter((b) => b.type === 'text').map((b) => (b as { type: 'text'; text: string }).text).join('\n\n')

    if (response.stopReason === 'end_turn' || response.stopReason === 'max_tokens') {
      if (roundText) finalText = roundText
      break
    }

    const newToolBlocks = response.content.filter(
      (b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use'
    )
    if (newToolBlocks.length === 0) {
      finalText = roundText
      break
    }

    messages.push({ role: 'assistant', content: response.content })
    const newResults = await execBatch(newToolBlocks)
    messages.push({ role: 'user', content: newResults as unknown as ContentBlock[] })

    // Last iteration — force synthesis on next step
    if (i === maxIter - 1) hitLimit = true
  }

  // Synthesis call — fires when loop hit the limit OR model never produced a final answer
  if (hitLimit || !finalText) {
    console.log('[read-loop] Forcing synthesis after max iterations')
    const synthesis = await callAnthropicWithTools({
      encryptedToken: token,
      systemParts: parts,
      compactSummary,
      messages: [...messages, { role: 'user', content: 'Based on everything you have read, provide your complete answer now.' }],
      tools: [],
      maxTokens: 8192,
    })
    finalText = synthesis.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { type: 'text'; text: string }).text)
      .join('\n\n')
  }

  return finalText || 'Sorry, I could not generate a response.'
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
