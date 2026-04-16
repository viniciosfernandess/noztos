// Demo data for the Checks + Conflicts flow. Both exports are null
// in production — ChecksPanel / useGitStatus / ConflictResolver short
// -circuit when these are set, so flipping a constant is enough to
// preview any state without touching real git.
//
// Set MOCK_GIT_STATUS to a shape (see interfaces below) to simulate a
// worktree state across the whole UI. Set MOCK_CONFLICTS similarly
// when you also want to walk the conflict resolver.

export interface MockPullRequest {
  number: number
  title: string
  body: string | null
  state: 'open' | 'closed'
  draft: boolean
  merged: boolean
  html_url: string
  head: { ref: string }
  base: { ref: string }
  derivedStatus: 'draft' | 'open' | 'changes_requested' | 'approved' | 'merged' | 'closed' | 'conflicts'
  mergeable_state: string | null
}

export interface MockGitStatus {
  branch: string
  uncommitted: number
  commitsAhead: number
  commitsBehind: number
  mainProtected: boolean
  mainProtectionChecked: number
  pr: MockPullRequest | null
  githubConnected: boolean
  ciStatus?: 'passing' | 'pending' | 'failing' | null
}

export const MOCK_GIT_STATUS: MockGitStatus | null = null

export const MOCK_CONFLICTS: {
  files: Array<{
    path: string
    kind: 'text' | 'rename' | 'delete' | 'binary'
    meta?: { oldPath?: string; deletedBy?: 'ours' | 'theirs'; size?: number }
  }>
  contents: Record<string, string>
  original?: Record<string, string>
} | null = null
