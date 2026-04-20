// Git operations + GitHub API helpers used by the Checks panel and the
// commit/push/PR flow. Kept in one module so the endpoint routes stay thin.
//
// Two kinds of operations live here:
//
//  • Shell-based git commands run directly on the user's machine via
//    `compute.exec`. Used for everything that touches the working tree:
//    commit, push, rebase, diff, etc.
//
//  • GitHub REST API calls made directly from our Node server using the
//    user's OAuth token. Used for things the companion doesn't need to do —
//    reading branch-protection rules, creating/merging PRs, polling PR
//    status. Avoids any dependency on `gh` being installed locally.

import { prisma } from '@/lib/db'
import { decrypt } from '@/lib/crypto'
import { ensureSandboxRunning } from '@/lib/sandbox-manager'
import { LocalProvider } from '@/lib/compute-local'

const compute = new LocalProvider()

// The
// "project root" is wherever `ensureSandboxRunning()` resolved the
// project on the user's disk. Callers that need the root should call
// `getProjectRoot(projectId)` instead of using a constant.
export async function getProjectRoot(projectId: string): Promise<string> {
  const path = await ensureSandboxRunning(projectId)
  return path ?? process.cwd()
}
// Backward compat for routes that import this constant — they'll
// need to migrate to getProjectRoot() but this prevents compile errors.
export const PROJECT_ROOT = process.cwd()

// ── Project metadata lookup ────────────────────────────────────────────────

export interface ProjectGitContext {
  sandboxId: string
  githubOwner: string
  githubRepo: string
  githubToken: string | null
  userId: string
}

export async function loadProjectGitContext(projectId: string): Promise<ProjectGitContext | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { userId: true, repository: { select: { githubOwner: true, githubRepo: true } } },
  })
  if (!project?.repository) return null

  const user = await prisma.user.findUnique({
    where: { id: project.userId },
    select: { githubToken: true },
  })

  let githubToken: string | null = null
  if (user?.githubToken) {
    try { githubToken = decrypt(user.githubToken) } catch {}
  }

  const sandboxId = await ensureSandboxRunning(projectId)
  if (!sandboxId) return null

  return {
    sandboxId,
    githubOwner: project.repository.githubOwner,
    githubRepo: project.repository.githubRepo,
    githubToken,
    userId: project.userId,
  }
}

// Given a worktreeId (possibly null = main), resolve the on-disk working dir
// we should run git commands from.
export async function resolveWorkingDir(projectId: string, worktreeId?: string | null): Promise<string | null> {
  if (!worktreeId) return getProjectRoot(projectId)
  const wt = await prisma.worktree.findUnique({
    where: { id: worktreeId },
    select: { projectId: true, worktreePath: true },
  })
  if (!wt || wt.projectId !== projectId || !wt.worktreePath) return null
  return wt.worktreePath
}

// ── Git shell helpers ──────────────────────────────────────────────────────
// All of these run via compute.exec so we can share sandbox lifecycle / logs
// with the rest of the app.

export async function runGit(sandboxId: string, cwd: string, args: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const res = await compute.exec(sandboxId, `cd ${cwd} && git ${args}`)
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', exitCode: res.exitCode ?? 0 }
}

// Current branch name inside a working dir.
export async function currentBranch(sandboxId: string, cwd: string): Promise<string> {
  const r = await runGit(sandboxId, cwd, 'rev-parse --abbrev-ref HEAD')
  return r.stdout.trim()
}

// Uncommitted change count (tracked files with working-tree differences +
// unstaged + staged differences combined).
export async function uncommittedCount(sandboxId: string, cwd: string): Promise<number> {
  const r = await runGit(sandboxId, cwd, "status --porcelain")
  if (!r.stdout.trim()) return 0
  return r.stdout.trim().split('\n').length
}

// How many commits ahead / behind origin/main (or base ref when no origin).
export async function aheadBehind(sandboxId: string, cwd: string, baseRef = 'origin/main'): Promise<{ ahead: number; behind: number }> {
  // Verify the base ref exists — rev-list fails noisily otherwise
  const check = await runGit(sandboxId, cwd, `rev-parse --verify ${baseRef} 2>/dev/null`)
  if (check.exitCode !== 0) return { ahead: 0, behind: 0 }
  const r = await runGit(sandboxId, cwd, `rev-list --left-right --count ${baseRef}...HEAD`)
  const parts = r.stdout.trim().split(/\s+/)
  return { behind: Number(parts[0] ?? 0), ahead: Number(parts[1] ?? 0) }
}

// Configure git identity so commits don't fail. Uses user metadata if
// available; otherwise falls back to a sane default. Safe to call on every
// commit — it's a no-op when already set.
export async function ensureGitIdentity(sandboxId: string, cwd: string, userEmail?: string, userName?: string) {
  const email = userEmail || 'noreply@bornastar.app'
  const name = userName || 'Bornastar'
  await compute.exec(sandboxId, `cd ${cwd} && git config user.email "${email.replace(/"/g, '')}" && git config user.name "${name.replace(/"/g, '')}"`)
}

// Commit everything in the working tree. Returns the commit SHA on success.
export async function commitAll(sandboxId: string, cwd: string, message: string, coAuthor?: string): Promise<string | null> {
  // Escape single quotes by closing / escaping / reopening the shell string
  const body = coAuthor ? `${message}\n\nCo-Authored-By: ${coAuthor}` : message
  const safe = body.replace(/'/g, `'\\''`)
  // Add everything + commit
  await runGit(sandboxId, cwd, 'add -A')
  const commit = await compute.exec(sandboxId, `cd ${cwd} && git commit -m '${safe}'`)
  if ((commit.exitCode ?? 0) !== 0) {
    // `nothing to commit` is not really an error for us
    if (/nothing to commit/i.test(commit.stdout + commit.stderr)) return null
    throw new Error(commit.stderr || commit.stdout || 'commit failed')
  }
  const sha = await runGit(sandboxId, cwd, 'rev-parse HEAD')
  return sha.stdout.trim() || null
}

// Push the current branch. Sets upstream if not set. Accepts a GitHub token
// to embed in the remote URL for the push; avoids relying on stored creds.
export async function pushCurrent(sandboxId: string, cwd: string, token: string | null, owner: string, repo: string): Promise<{ ok: boolean; error?: string }> {
  const branch = await currentBranch(sandboxId, cwd)
  if (!branch) return { ok: false, error: 'no branch checked out' }

  // Build authenticated URL for this one push; leave the configured remote
  // alone so other flows aren't affected.
  const remote = token
    ? `https://${token}@github.com/${owner}/${repo}.git`
    : `https://github.com/${owner}/${repo}.git`
  const r = await compute.exec(sandboxId, `cd ${cwd} && git push --set-upstream ${remote} HEAD:refs/heads/${branch}`)
  const combined = `${r.stdout}\n${r.stderr}`
  if ((r.exitCode ?? 0) !== 0) {
    // Detect branch-protection rejection specifically so the UI can surface
    // a "main is protected" banner without parsing raw text in the client.
    const protectedHit = /protected branch|GH006|refusing to allow/i.test(combined)
    return { ok: false, error: protectedHit ? 'protected' : combined.slice(-500) }
  }
  return { ok: true }
}

// Rebase the current branch onto origin/main (used by "Update branch").
export async function rebaseOntoMain(sandboxId: string, cwd: string, token: string | null, owner: string, repo: string): Promise<{ ok: boolean; conflict?: boolean; error?: string }> {
  // Fetch latest main first — authenticated so private repos work.
  const remote = token
    ? `https://${token}@github.com/${owner}/${repo}.git`
    : `https://github.com/${owner}/${repo}.git`
  const fetch = await compute.exec(sandboxId, `cd ${cwd} && git fetch ${remote} main:refs/remotes/origin/main`)
  if ((fetch.exitCode ?? 0) !== 0) {
    return { ok: false, error: fetch.stderr || fetch.stdout || 'fetch failed' }
  }
  const rebase = await compute.exec(sandboxId, `cd ${cwd} && git rebase origin/main`)
  const combined = `${rebase.stdout}\n${rebase.stderr}`
  if ((rebase.exitCode ?? 0) !== 0) {
    // Abort so the working tree isn't left mid-rebase; user can retry from a
    // clean state or we'll offer explicit conflict UX later.
    await compute.exec(sandboxId, `cd ${cwd} && git rebase --abort 2>&1 || true`)
    if (/CONFLICT|Merge conflict|could not apply/i.test(combined)) {
      return { ok: false, conflict: true, error: combined.slice(-500) }
    }
    return { ok: false, error: combined.slice(-500) }
  }
  return { ok: true }
}

// Discard changes to one or more paths back to HEAD.
export async function discardPaths(sandboxId: string, cwd: string, paths: string[]): Promise<boolean> {
  if (paths.length === 0) return true
  const quoted = paths.map((p) => `'${p.replace(/'/g, "'\\''")}'`).join(' ')
  // Use `git checkout HEAD --` which works for both tracked-modified and
  // staged changes. For untracked files, checkout is a no-op — we also run
  // `git clean -fd` for them.
  await compute.exec(sandboxId, `cd ${cwd} && git checkout HEAD -- ${quoted} 2>&1 || true`)
  await compute.exec(sandboxId, `cd ${cwd} && git clean -fd -- ${quoted} 2>&1 || true`)
  return true
}

// ── GitHub REST helpers ────────────────────────────────────────────────────

const GH_API = 'https://api.github.com'

function ghHeaders(token: string | null): HeadersInit {
  const h: HeadersInit = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (token) (h as Record<string, string>).Authorization = `Bearer ${token}`
  return h
}

export interface BranchProtectionInfo {
  protected: boolean
  // If the API 404s (not protected) vs errored (couldn't tell) we distinguish
  // so the UI can fall back appropriately.
  checkedAt: number
  error?: string
}

export async function getBranchProtection(owner: string, repo: string, branch: string, token: string | null): Promise<BranchProtectionInfo> {
  try {
    const res = await fetch(`${GH_API}/repos/${owner}/${repo}/branches/${branch}/protection`, { headers: ghHeaders(token) })
    if (res.status === 404) return { protected: false, checkedAt: Date.now() }
    if (res.status === 401 || res.status === 403) {
      // Without auth we still return a usable answer but flag that we couldn't
      // be sure. Branch protection state is visible to collaborators only.
      return { protected: false, checkedAt: Date.now(), error: 'unauthorized' }
    }
    if (res.ok) return { protected: true, checkedAt: Date.now() }
    return { protected: false, checkedAt: Date.now(), error: `http ${res.status}` }
  } catch (e) {
    return { protected: false, checkedAt: Date.now(), error: e instanceof Error ? e.message : 'fetch failed' }
  }
}

export interface PullRequestInfo {
  number: number
  title: string
  body: string | null
  state: 'open' | 'closed'
  draft: boolean
  merged: boolean
  mergeable: boolean | null
  mergeable_state: string | null
  html_url: string
  head: { ref: string }
  base: { ref: string }
  user: { login: string } | null
  review_decision?: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null
  updated_at: string
  // Our derived bucket — single label the UI can switch on.
  derivedStatus: 'draft' | 'open' | 'changes_requested' | 'approved' | 'merged' | 'closed' | 'conflicts'
}

// Find the most recently updated PR for a given head branch (owner:branch).
export async function findPullRequestForBranch(owner: string, repo: string, branch: string, token: string | null): Promise<PullRequestInfo | null> {
  const url = `${GH_API}/repos/${owner}/${repo}/pulls?head=${owner}:${encodeURIComponent(branch)}&state=all&per_page=5&sort=updated&direction=desc`
  const res = await fetch(url, { headers: ghHeaders(token) })
  if (!res.ok) return null
  const list = (await res.json()) as Array<Record<string, unknown>>
  if (!list.length) return null
  const pr = list[0]
  return enrichPR(pr, owner, repo, token)
}

async function enrichPR(pr: Record<string, unknown>, owner: string, repo: string, token: string | null): Promise<PullRequestInfo> {
  const number = pr.number as number
  const state = pr.state as 'open' | 'closed'
  const draft = !!pr.draft
  const merged = !!pr.merged_at
  const mergeable = (pr.mergeable as boolean | null) ?? null
  const mergeable_state = (pr.mergeable_state as string | null) ?? null

  // Review decision isn't on the list response — hit the detail endpoint.
  let review_decision: PullRequestInfo['review_decision'] = null
  try {
    const d = await fetch(`${GH_API}/repos/${owner}/${repo}/pulls/${number}`, { headers: ghHeaders(token) })
    if (d.ok) {
      const body = (await d.json()) as Record<string, unknown>
      const asAny = body as { mergeable_state?: string; auto_merge?: unknown; merged_by?: unknown }
      // v3 API exposes `mergeable_state`; for review decision we use the
      // reviews endpoint as a light fallback.
      void asAny
      try {
        const rev = await fetch(`${GH_API}/repos/${owner}/${repo}/pulls/${number}/reviews?per_page=50`, { headers: ghHeaders(token) })
        if (rev.ok) {
          const reviews = (await rev.json()) as Array<{ state: string; submitted_at: string; user?: { login: string } }>
          const byUser = new Map<string, { state: string; submitted_at: string }>()
          for (const r of reviews) {
            const login = r.user?.login ?? '?'
            const prev = byUser.get(login)
            if (!prev || new Date(r.submitted_at) > new Date(prev.submitted_at)) {
              byUser.set(login, { state: r.state, submitted_at: r.submitted_at })
            }
          }
          const states = [...byUser.values()].map((v) => v.state)
          if (states.includes('CHANGES_REQUESTED')) review_decision = 'CHANGES_REQUESTED'
          else if (states.includes('APPROVED')) review_decision = 'APPROVED'
          else review_decision = 'REVIEW_REQUIRED'
        }
      } catch {}
    }
  } catch {}

  // Derive a single UI-facing status bucket.
  let derivedStatus: PullRequestInfo['derivedStatus'] = 'open'
  if (merged) derivedStatus = 'merged'
  else if (state === 'closed') derivedStatus = 'closed'
  else if (draft) derivedStatus = 'draft'
  else if (mergeable_state === 'dirty' || mergeable === false) derivedStatus = 'conflicts'
  else if (review_decision === 'CHANGES_REQUESTED') derivedStatus = 'changes_requested'
  else if (review_decision === 'APPROVED') derivedStatus = 'approved'

  return {
    number,
    title: (pr.title as string) ?? '',
    body: (pr.body as string | null) ?? null,
    state,
    draft,
    merged,
    mergeable,
    mergeable_state,
    html_url: (pr.html_url as string) ?? '',
    head: { ref: (pr as { head: { ref: string } }).head.ref },
    base: { ref: (pr as { base: { ref: string } }).base.ref },
    user: (pr.user as { login: string } | null) ?? null,
    review_decision,
    updated_at: (pr.updated_at as string) ?? '',
    derivedStatus,
  }
}

export async function createPullRequest(owner: string, repo: string, token: string, params: { title: string; body?: string; head: string; base: string; draft?: boolean }): Promise<{ ok: true; pr: PullRequestInfo } | { ok: false; error: string; status: number }> {
  const res = await fetch(`${GH_API}/repos/${owner}/${repo}/pulls`, {
    method: 'POST',
    headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: params.title, body: params.body ?? '', head: params.head, base: params.base, draft: !!params.draft }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, error: text.slice(0, 400), status: res.status }
  }
  const pr = (await res.json()) as Record<string, unknown>
  return { ok: true, pr: await enrichPR(pr, owner, repo, token) }
}

export async function mergePullRequest(owner: string, repo: string, token: string, number: number, method: 'merge' | 'squash' | 'rebase' = 'merge'): Promise<{ ok: boolean; error?: string; status?: number }> {
  const res = await fetch(`${GH_API}/repos/${owner}/${repo}/pulls/${number}/merge`, {
    method: 'PUT',
    headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ merge_method: method }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, status: res.status, error: text.slice(0, 400) }
  }
  return { ok: true }
}

export async function closePullRequest(owner: string, repo: string, token: string, number: number, options: { deleteBranch?: boolean } = {}): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${GH_API}/repos/${owner}/${repo}/pulls/${number}`, {
    method: 'PATCH',
    headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: 'closed' }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, error: text.slice(0, 400) }
  }
  if (options.deleteBranch) {
    // Branch name lookup if needed could happen here; caller should pass
    // branch via the worktree row.
  }
  return { ok: true }
}

// Aggregate CI status for a commit SHA via the Checks API. Returns
// 'passing' when every completed run succeeded, 'failing' if any
// failed/timed_out/cancelled, 'pending' while any are still running,
// null when there are no checks at all (repo has no CI configured).
export async function getCiStatusForRef(
  owner: string,
  repo: string,
  ref: string,
  token: string | null,
): Promise<'passing' | 'pending' | 'failing' | null> {
  try {
    const res = await fetch(
      `${GH_API}/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100`,
      { headers: ghHeaders(token) },
    )
    if (!res.ok) return null
    const body = (await res.json()) as {
      total_count?: number
      check_runs?: Array<{ status: string; conclusion: string | null }>
    }
    const runs = body.check_runs ?? []
    if (runs.length === 0) return null
    const anyRunning = runs.some((r) => r.status !== 'completed')
    if (anyRunning) return 'pending'
    const anyFailed = runs.some((r) => r.conclusion === 'failure' || r.conclusion === 'timed_out' || r.conclusion === 'cancelled' || r.conclusion === 'action_required')
    return anyFailed ? 'failing' : 'passing'
  } catch {
    return null
  }
}

export async function deleteRemoteBranch(owner: string, repo: string, token: string, branch: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${GH_API}/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
    method: 'DELETE',
    headers: ghHeaders(token),
  })
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => '')
    return { ok: false, error: text.slice(0, 400) }
  }
  return { ok: true }
}
