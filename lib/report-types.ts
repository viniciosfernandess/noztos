// ── Chat Report Types ─────────────────────────────────────────────────────
//
// Attached to the final message of a team conversation or any build.
// Stored as JSON in ChatMessage.report field.

export interface ReportStep {
  employee: string
  role: string // 'Planner' | 'Reviewer' | 'Builder'
  input: string // what this employee received
  output: string // what this employee produced
  decision: 'approved' | 'rejected' | null
  redirectedTo?: string // if rejected, who it went back to
  durationMs?: number
}

export interface ReportEtapa {
  name: string
  objective: string
  steps: ReportStep[]
  status: 'completed' | 'rejected'
}

export interface ReportFileChange {
  path: string
  action: 'write' | 'delete'
  diff?: string  // unified diff output (git diff), optional
}

export interface ReportToolCall {
  tool: string
  path?: string
  action: string // human-readable: "Wrote 45 lines to src/index.ts"
}

export interface ReportBuildDetails {
  executor: string // 'Claude' | employee name
  filesChanged: ReportFileChange[]
  toolCalls: ReportToolCall[]
  reasoning: string // what the builder thought before coding
  summary: string // final build summary
  iterationCount: number
}

export interface ChatReport {
  type: 'team_discussion' | 'build' | 'team_build'
  mode: 'no_skill' | 'skill' | 'team'
  timestamp: string // ISO
  question: string // original user message

  // Team discussion data (team conversations + team builds)
  etapas?: ReportEtapa[]

  // Build data (any mode with build)
  build?: ReportBuildDetails

  // Final conclusion
  conclusion: string

  // Metadata
  model?: string
  totalDurationMs?: number
}
