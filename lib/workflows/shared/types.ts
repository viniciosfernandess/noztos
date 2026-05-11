// Shared types for team workflows.
//
// Tudo aqui é runtime-agnostic — runs server-side dentro do orquestrador
// e do client-side leem o snapshot via API. Os tipos de "agent step",
// "block state", etc são compartilhados entre as duas pontas.

export type WorkflowMode = 'ask' | 'agent'

export type WorkflowStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

export type WorkflowType = 'builder'  // V1; futuro: 'review' | 'test' | etc

// ── Planner output ──────────────────────────────────────────────────

export interface PlannerBlock {
  name: string                  // título curto
  objective: string             // RICO — descrição detalhada do que fazer
  estimatedFiles?: string[]     // arquivos prováveis (heurística)
}

export interface PlannerOutput {
  rationale?: string
  blocks: PlannerBlock[]
}

// ── Step state (live) ───────────────────────────────────────────────

export type StepRole = 'planner' | 'architect' | 'builder' | 'reviewer'

export type StepStatus = 'pending' | 'running' | 'completed' | 'failed'

// Live transcript chunk for an in-flight agent step. Same shape the
// chat normal already renders via ClaudeToolCard — text grows
// progressively, tool_use cards appear as the agent invokes tools,
// tool_result fills in once it returns. Persisted in StepState so a
// browser landing on this run mid-flight (or post-completion) sees
// the same activity stream the real-time poller showed.
export type TranscriptChunkType = 'text' | 'tool_use' | 'tool_result' | 'thinking'

export interface TranscriptChunk {
  ts: number                    // unix ms
  type: TranscriptChunkType
  text?: string                 // for 'text' / 'thinking'
  toolName?: string             // for 'tool_use' / 'tool_result'
  toolInput?: Record<string, unknown>  // for 'tool_use'
  toolUseId?: string            // links 'tool_use' → 'tool_result'
  toolResult?: string           // for 'tool_result' (may be truncated)
  toolError?: boolean           // for 'tool_result'
}

export interface StepState {
  role: StepRole
  attempt: number               // 1 = first try, 2+ = after reject
  status: StepStatus
  startedAt?: number
  finishedAt?: number
  durationMs?: number
  // Output paths (artifacts persisted in <worktree>/.team-handoff/...)
  // ou conteúdo inline pra steps menores (planner, reviewer XML decision).
  outputPath?: string           // ex: '.team-handoff/block-01/architect-plan.md'
  output?: string               // texto raw do agent (capturado pelo orquestrador)
  // Reviewer-specific: parsed decision
  decision?: 'APPROVED' | 'REJECT' | 'FORCED_APPROVAL'
  errorReason?: string
  // Live transcript (assistant text + tool calls + tool results) as
  // they stream from `claude -p`. Empty until the step starts; grows
  // throughout the run; persists in DB via WorkflowRun.progress so
  // the user sees full activity even after the run finishes.
  transcript?: TranscriptChunk[]
}

// ── Block state (live) ──────────────────────────────────────────────

export interface BlockState {
  index: number                 // 0-based
  name: string                  // copiado do PlannerBlock
  objective: string
  estimatedFiles?: string[]
  status: StepStatus
  startedAt?: number
  finishedAt?: number
  // Steps em ordem cronológica. Pode ter várias entradas pro mesmo
  // role quando há reject (Architect attempt 1, attempt 2, etc).
  steps: StepState[]
  // Quantos REJECTs o Reviewer deu nesse block (max 2 antes do forced).
  rejectCount: number
  // Path do summary.md (intermediário) ou final-response.md (último block).
  summaryPath?: string
  // Conteúdo raw da summary/final-response (cache pra UI ler sem fs).
  summary?: string
}

// ── Run snapshot ─────────────────────────────────────────────────────

export interface RunSnapshot {
  workflowType: WorkflowType
  userMessage: string
  mode: WorkflowMode
  // Caminho da worktree onde os agents operam (vem da ChatSession)
  projectPath: string
  plan?: PlannerOutput
  blocks: BlockState[]
  currentBlockIndex?: number    // -1 / undefined = phase 0 / pre-blocks
  // Monotonic chunk counter — the runner stamps each delta with seq before
  // pushing to the relay; the persist tick writes the latest value here.
  // The browser uses it on cold-load to set its dedupe cursor so any
  // SSE-replayed delta whose seq is already covered by the DB snapshot
  // gets dropped instead of double-applied to the transcript.
  chunkSeq?: number
  // Live step indicator pra UI mostrar "▶ Architect thinking..." +
  // o transcript em tempo real do agent (text + tool_use + tool_result
  // como vem do stream-json). UI renderiza igual o chat normal renderiza
  // turns do claude.
  currentStep?: {
    role: StepRole
    blockIndex: number
    attempt: number
    startedAt: number
    transcript?: TranscriptChunk[]
  } | null
  finalResponse?: string
}

// ── Agent step input/output (single CLI call) ──────────────────────

export interface AgentStepInput {
  role: StepRole
  systemPrompt: string          // composed: skill + context (block, plan, summaries, etc)
  userText: string              // o `claude -p <text>`
  cwd: string                   // worktree path
  model?: string                // 'sonnet' | 'haiku' | 'opus' | undefined
  allowedTools?: string[]
  disallowedTools?: string[]
  permissionMode?: 'bypassPermissions' | 'plan' | 'default'
  timeoutMs?: number
  // WorkflowRun id. When present, the spawned child is registered so the
  // cancel endpoint can SIGTERM/SIGKILL it directly instead of waiting
  // for the runner to reach its next checkpoint.
  runId?: string
  // Optional live observer fired on every parsed stream-json chunk
  // (assistant text, tool_use, tool_result). The runner uses this
  // to grow `StepState.transcript` and surface real-time activity in
  // the WorkflowRunCard. Synchronous and best-effort; throwing here
  // is swallowed so the agent itself is unaffected.
  onChunk?: (chunk: TranscriptChunk) => void
}

export interface AgentStepResult {
  output: string                // texto final do assistant
  toolCalls: Array<{
    name: string
    input: Record<string, unknown>
    result?: string
    error?: boolean
  }>
  durationMs: number
  costUsd?: number
  error?: string
}
