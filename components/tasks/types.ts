// Shared types for the task UI. Mirrors the server-side schema enough
// for the components to be type-safe without pulling Prisma client into
// the bundle.

export type TaskStatus = 'pending' | 'scheduled' | 'running' | 'done' | 'failed'
export type ExecutorKind = 'workflow' | 'skill'
export type ChatMode = 'agent' | 'plan' | 'ask'

export interface TaskListItem {
  id: string
  name: string
  status: TaskStatus
  worktreeId: string
  branchName: string | null
  instruction: string | null
  executorKind: ExecutorKind | null
  executorId: string | null
  chatMode: ChatMode | null
  scheduledAt: string | null
  reviewedAt: string | null
  sourceTaskId: string | null
  createdAt: string
  updatedAt: string
  contextSource: {
    chatId?: string
    cutoffMessageId?: string
    cutoffAt?: string | null
    rowCount?: number
  } | null
}

export interface TaskIterationItem {
  id: string
  iterationNumber: number
  instruction: string
  executorKind: string
  executorId: string
  chatMode: string
  status: string
  startedAt: string | null
  finishedAt: string | null
  outputSummary: string | null
  fullOutput: string | null
  filesTouched: string[] | null
  errorReason: string | null
  workflowRunId: string | null
  createdAt: string
}

export interface TaskDetail extends TaskListItem {
  iterations: TaskIterationItem[]
}

// User-facing executor options.
// Skills mirror the platform-default Collaborators (CEO, Architect, etc.).
// Workflows are the two structured multi-agent flows.
export const WORKFLOW_OPTIONS: { id: string; label: string }[] = [
  { id: 'build', label: 'Build workflow' },
  { id: 'debug', label: 'Debug workflow' },
]

export const CHAT_MODE_NOTE = 'Workflows always run in agent mode — the inner roles handle their own permissions.'

export const SKILL_OPTIONS: { id: string; label: string }[] = [
  { id: 'ceo', label: 'CEO' },
  { id: 'architect', label: 'Architect' },
  { id: 'designer', label: 'Designer' },
  { id: 'security', label: 'Security' },
  { id: 'tester', label: 'Tester' },
  { id: 'reviewer', label: 'Reviewer' },
  { id: 'docs', label: 'Docs' },
  { id: 'devops', label: 'DevOps' },
]
