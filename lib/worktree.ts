import { prisma } from '@/lib/db'
import { ensureSandboxRunning } from '@/lib/sandbox-manager'
import { loadProjectGitContext } from '@/lib/git'
import { cloudAwareCompute } from '@/lib/compute-router'
import { getCompanionHomeDir } from '@/lib/companion-relay'

// ── Worktree Manager ──────────────────────────────────────────────────────
//
// A Worktree is an isolated git branch + working directory inside the
// project's local directory on the user's machine.
// Multiple chat sessions can collaborate inside the same worktree.
//
// Layout (local mode — user's machine):
//   ~/projects/my-app                  ← main root (wherever the user cloned)
//   ~/projects/my-app/.worktrees/<id>  ← isolated branches (git worktree add)
//
// Paths are resolved via the project's DB record, so the layout
// difference is transparent to callers.

// Cloud-aware: routes to E2BProvider when the path belongs to a
// worktree with activeContext='cloud'. See lib/compute-router.ts.
const compute = cloudAwareCompute

// Each worktree reserves PORTS_PER_WORKTREE consecutive ports starting at
// portBase. The user can reference them as $BORNASTAR_PORT through
// $BORNASTAR_PORT+9 in their run scripts.
const PORT_RANGE_START = 4000
const PORTS_PER_WORKTREE = 10
const PORT_RANGE_END = 4990

// Pool of single-word city codenames used to label new worktrees. Branches
// look like `kampala-v1`, `oslo-v2`, etc — short, memorable, ASCII-safe so
// they can become git refs without sanitization.
const WORKTREE_CODENAMES = [
  'kampala', 'lisbon', 'oslo', 'kyoto', 'porto', 'madrid', 'dakar',
  'luanda', 'nairobi', 'hanoi', 'tbilisi', 'valencia', 'krakow',
  'beirut', 'hobart', 'riga', 'monaco', 'dublin', 'sofia', 'tokyo',
  'seoul', 'lima', 'bogota', 'doha', 'kigali', 'accra', 'bamako',
  'helsinki', 'reykjavik', 'vilnius', 'palermo', 'granada', 'sevilla',
  'marseille', 'brisbane', 'perth', 'athens', 'naples', 'florence',
  'venice', 'milan', 'prague', 'berlin', 'vienna', 'zagreb',
  'belgrade', 'bucharest', 'budapest', 'warsaw', 'tallinn',
  'stockholm', 'copenhagen', 'amsterdam', 'brussels', 'geneva',
  'zurich', 'lyon', 'nice', 'bilbao', 'malaga', 'dubrovnik',
  'mykonos', 'santorini', 'mallorca', 'valletta',
]

/**
 * Best-effort cleanup of a worktree's on-disk state.
 *
 * Runs `git worktree remove --force` (kills the working dir, ignores
 * uncommitted changes) followed by `git branch -D` (force-delete the
 * branch even if unmerged). Both are idempotent in the senses we care
 * about: rerunning when the dir / branch no longer exists is harmless,
 * we just log a warn so an investigator can find it.
 *
 * Used on the destructive path only:
 *   - delete-forever (user explicitly asks for permanent removal)
 *
 * Soft removal (archive) intentionally does NOT call this — the disk +
 * branch must stay intact so restore brings the worktree back with all
 * its uncommitted changes and commits.
 *
 * Never throws. The DB row is the source of truth; if the on-disk side
 * goes wrong we surface a warn-level log and move on.
 */
export async function cleanupWorktreeOnDisk(
  projectId: string,
  worktreePath: string | null | undefined,
  branchName: string | null | undefined,
  loggerTag: string = 'cleanup',
): Promise<void> {
  try {
    const sandboxId = await ensureSandboxRunning(projectId)
    if (!sandboxId) {
      console.warn(`[${loggerTag}] no sandbox available, skipping disk+git cleanup branch=${branchName} path=${worktreePath}`)
      return
    }
    if (worktreePath && worktreePath !== '_pending_') {
      const removeRes = await compute.exec(
        sandboxId,
        `cd ${sandboxId} && git worktree remove --force ${worktreePath}`,
      )
      if (removeRes.exitCode !== 0) {
        console.warn(`[${loggerTag}] git worktree remove non-zero exit=${removeRes.exitCode} path=${worktreePath} stderr=${removeRes.stderr || '(empty)'}`)
      }
    }
    if (branchName) {
      const branchRes = await compute.exec(
        sandboxId,
        `cd ${sandboxId} && git branch -D ${branchName}`,
      )
      if (branchRes.exitCode !== 0) {
        console.warn(`[${loggerTag}] git branch -D non-zero exit=${branchRes.exitCode} branch=${branchName} stderr=${branchRes.stderr || '(empty)'}`)
      }
    }
  } catch (err) {
    console.warn(`[${loggerTag}] disk+git cleanup threw branch=${branchName} path=${worktreePath}: ${(err as Error).message}`)
  }
}

/**
 * Project-level cleanup. Used by DELETE /api/projects/[id] when the
 * user permanently removes a project: every worktree row that still
 * has a real on-disk path gets its `git worktree remove` + `git branch
 * -D`, then the whole `<homeDir>/.bornastar/worktrees/<projectId>/`
 * directory is rm -rf'd in one shot. Best-effort throughout — any
 * failure is logged but the DB cascade has already completed by the
 * time this runs, so disk inconsistency is recoverable on the next
 * register reconciliation.
 *
 * homeDir is read from the daemon's registered state (the daemon
 * publishes it at register time, see companion-relay.ts). Without it
 * we skip the directory rm-rf — the per-worktree git cleanup still
 * runs, just leaves an empty parent dir behind.
 */
export async function cleanupAllProjectWorktrees(
  projectId: string,
  worktrees: Array<{ worktreePath: string | null; branchName: string }>,
  homeDir: string | null,
): Promise<void> {
  for (const wt of worktrees) {
    if (!wt.worktreePath || wt.worktreePath === '_pending_') continue
    await cleanupWorktreeOnDisk(projectId, wt.worktreePath, wt.branchName, 'project-delete')
  }
  if (!homeDir) return
  // rm -rf the parent dir so we don't leave the empty `<projectId>/`
  // directory behind. The worktree dirs were already removed above —
  // this catches stragglers like .git/worktrees/<id> metadata files
  // and any orphan files git didn't track.
  const sandboxId = await ensureSandboxRunning(projectId)
  if (!sandboxId) return
  const worktreesDir = `${homeDir}/.bornastar/worktrees/${projectId}`
  try {
    await compute.exec(sandboxId, `rm -rf ${worktreesDir}`)
  } catch (err) {
    console.warn(`[project-delete] rm -rf ${worktreesDir} failed: ${(err as Error).message}`)
  }
}

/**
 * Pick a fresh `<city>-v<N>` codename that hasn't been used by any worktree
 * (open, archived, or deleted) in this project — so we never create a
 * duplicate git branch ref. Returns a pretty `name` and a `branchName`.
 */
export async function generateWorktreeCodename(
  projectId: string,
): Promise<{ name: string; branchName: string }> {
  const existing = await prisma.worktree.findMany({
    where: { projectId },
    select: { branchName: true },
  })
  const taken = new Set(existing.map((w) => w.branchName).filter(Boolean))

  const shuffled = [...WORKTREE_CODENAMES].sort(() => Math.random() - 0.5)
  for (const city of shuffled) {
    for (let v = 1; v <= 99; v++) {
      const branchName = `${city}-v${v}`
      if (!taken.has(branchName)) {
        return {
          name: `${city.charAt(0).toUpperCase() + city.slice(1)} v${v}`,
          branchName,
        }
      }
    }
  }
  // Pathological fallback — every city × every version exhausted (>6k worktrees)
  const fallback = `wt-${Date.now().toString(36)}`
  return { name: fallback, branchName: fallback }
}

export interface WorktreeInfo {
  worktreePath: string
  branchName: string
  baseCommit: string
  portBase: number
}

export interface DiffStats {
  added: number
  removed: number
  files: number
}

export interface ChangedFile {
  path: string
  status: 'A' | 'M' | 'D' | 'R' | 'U'
  added: number
  removed: number
  // True when at least one hunk in the file is still uncommitted (working
  // tree differs from HEAD). A file in the changes list with all hunks
  // already committed sets this false — its diff is fully captured in a
  // commit, so the user doesn't need to run "Commit" again for this file.
  // Drives the "U" badge on the Changes list.
  uncommitted: boolean
}

/**
 * Allocate the next free port base for a new worktree in this project.
 */
async function allocatePortBase(projectId: string): Promise<number | null> {
  const inUse = await prisma.worktree.findMany({
    where: { projectId, status: 'open', portBase: { not: null } },
    select: { portBase: true },
  })
  const taken = new Set(inUse.map((w) => w.portBase!))
  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port += PORTS_PER_WORKTREE) {
    if (!taken.has(port)) return port
  }
  return null
}

/**
 * Provision the on-disk worktree for a brand new Worktree row. Idempotent —
 * reuses an existing physical worktree directory if it already exists. The
 * caller is responsible for picking the branch name (use
 * `generateWorktreeCodename`).
 *
 * Worktrees live OUTSIDE the project repo, in
 * `<homeDir>/.bornastar/worktrees/<projectId>/<worktreeId>/`, where
 * `homeDir` is reported by the daemon at register time. Keeps the
 * project tree clean (no `.bornastar-worktrees/` showing in `git
 * status` / Explorer) and lets cleanup be a single `rm -rf` of the
 * project's worktree subdir.
 */
export async function provisionWorktree(
  projectId: string,
  worktreeId: string,
  branchName: string,
  userId: string,
): Promise<WorktreeInfo | null> {
  const sandboxId = await ensureSandboxRunning(projectId)
  if (!sandboxId) {
    console.warn(`[worktree] No sandbox available for project ${projectId}`)
    return null
  }

  const homeDir = getCompanionHomeDir(userId)
  if (!homeDir) {
    console.warn(`[worktree] No homeDir registered for user ${userId.slice(0, 8)} — daemon must register first`)
    return null
  }
  const worktreesDir = `${homeDir}/.bornastar/worktrees/${projectId}`

  try {
    await compute.exec(sandboxId, `mkdir -p ${worktreesDir}`)

    // If the project has a GitHub remote, fetch + fast-forward main before
    // creating the worktree so it always starts from the latest upstream state.
    const ctx = await loadProjectGitContext(projectId)
    if (ctx?.githubOwner && ctx?.githubToken) {
      const remoteUrl = `https://${ctx.githubToken}@github.com/${ctx.githubOwner}/${ctx.githubRepo}.git`
      await compute.exec(
        sandboxId,
        `cd ${sandboxId} && git fetch ${remoteUrl} main:refs/remotes/origin/main 2>/dev/null || true`,
      )
      await compute.exec(
        sandboxId,
        `cd ${sandboxId} && git merge origin/main --ff-only 2>/dev/null || true`,
      )
    }

    // Get current HEAD on main as the baseline
    const headRes = await compute.exec(
      sandboxId,
      `cd ${sandboxId} && git rev-parse HEAD 2>/dev/null || echo NONE`,
    )
    const baseCommit = headRes.stdout?.trim()
    if (!baseCommit || baseCommit === 'NONE') {
      console.warn(`[worktree] No git HEAD found at ${sandboxId}`)
      return null
    }

    const portBase = await allocatePortBase(projectId)
    if (portBase === null) {
      console.warn(`[worktree] Port range exhausted`)
      return null
    }

    // Reuse if the directory already exists
    const worktreePath = `${worktreesDir}/${worktreeId}`

    const existsRes = await compute.exec(
      sandboxId,
      `test -d ${worktreePath}/.git -o -f ${worktreePath}/.git && echo yes || echo no`,
    )
    if (existsRes.stdout?.trim() === 'yes') {
      console.log(`[worktree] Reusing existing worktree at ${worktreePath}`)
      return { worktreePath, branchName, baseCommit, portBase }
    }

    // Create new worktree on a fresh branch from current main HEAD.
    //
    // Retry-on-flake: this command intermittently fails with exit 255
    // and a stderr that only contains the "Preparing worktree…"
    // progress line — no fatal message, no useful diagnostic. The
    // pattern observed is "fails immediately after deleting other
    // worktrees, succeeds on a fresh retry seconds later." Best fit
    // is transient .git/index.lock contention with another process
    // (the daemon's fs watcher, a concurrent git status, …). Retrying
    // 1× after a short delay reliably clears it. If the second pass
    // also fails the failure is logged with full stdout+stderr.
    let createRes = await compute.exec(
      sandboxId,
      `cd ${sandboxId} && git worktree add ${worktreePath} -b ${branchName}`,
    )
    if (createRes.exitCode === 255 || createRes.exitCode === 128) {
      console.warn(`[worktree] git worktree add transient (exit=${createRes.exitCode}) branch=${branchName}, retrying in 500ms`)
      await new Promise((r) => setTimeout(r, 500))
      createRes = await compute.exec(
        sandboxId,
        `cd ${sandboxId} && git worktree add ${worktreePath} -b ${branchName}`,
      )
    }
    if (createRes.exitCode !== 0) {
      // Branch may already exist — try without -b
      const fallbackRes = await compute.exec(
        sandboxId,
        `cd ${sandboxId} && git worktree add ${worktreePath} ${branchName}`,
      )
      if (fallbackRes.exitCode !== 0) {
        console.warn(
          `[worktree] git worktree add FAILED branch=${branchName} path=${worktreePath}\n`
          + `  --- create exit=${createRes.exitCode} ---\n`
          + `  stdout: ${createRes.stdout || '(empty)'}\n`
          + `  stderr: ${createRes.stderr || '(empty)'}\n`
          + `  --- fallback exit=${fallbackRes.exitCode} ---\n`
          + `  stdout: ${fallbackRes.stdout || '(empty)'}\n`
          + `  stderr: ${fallbackRes.stderr || '(empty)'}`,
        )
        return null
      }
    }

    // Copy gitignored dev-local env files from the project root into the
    // new worktree. Git only carries tracked files, so `.env` (and the
    // like) never appear inside `git worktree add`'d directories on
    // their own — Claude Code + dev scripts would fail silently looking
    // for them. Mirrors Conductor's behaviour: each worktree gets its
    // own copy, so experimenting with new env vars in a feature branch
    // doesn't leak to main. Mismatches the user has to manage manually
    // if credentials diverge (rare).
    const ENV_FILES = ['.env', '.env.local', '.env.development', '.env.development.local']
    for (const f of ENV_FILES) {
      await compute.exec(
        sandboxId,
        `[ -f ${sandboxId}/${f} ] && cp -n ${sandboxId}/${f} ${worktreePath}/${f} || true`,
      )
    }

    console.log(`[isolation] worktree created branch=${branchName} path=${worktreePath} base=${baseCommit.slice(0, 8)} port=${portBase}`)
    return { worktreePath, branchName, baseCommit, portBase }
  } catch (err) {
    console.error(`[worktree] Error provisioning worktree:`, err)
    return null
  }
}

/**
 * Sweep orphan worktree placeholders. A placeholder is a row whose
 * `worktreePath` is still `_pending_` — it means the create-worktree
 * route inserted the row but never finished provisioning (server crash
 * mid-call, or a 500 followed by no client retry). After
 * ORPHAN_PLACEHOLDER_TTL_MS without resuming, we nuke it so it doesn't
 * pollute the sidebar / branch-name namespace forever. The matching
 * disk artefacts (none — git worktree add never ran) need no cleanup;
 * partial creates leave a directory and we'd need `git worktree prune`
 * to handle that, deferred until we actually see it in the wild.
 */
const ORPHAN_PLACEHOLDER_TTL_MS = 5 * 60_000 // 5 min — generous for slow networks
const PLACEHOLDER_SWEEP_INTERVAL_MS = 5 * 60_000

export async function cleanupOrphanPlaceholders(): Promise<number> {
  const cutoff = new Date(Date.now() - ORPHAN_PLACEHOLDER_TTL_MS)
  const stale = await prisma.worktree.findMany({
    where: { worktreePath: '_pending_', createdAt: { lt: cutoff } },
    select: { id: true },
  })
  if (stale.length === 0) return 0
  // Cascade: delete the placeholder + any sessions that point at it
  // (shouldn't be any in practice — sessions are created AFTER the
  // worktree finalises — but defensive).
  for (const w of stale) {
    await prisma.chatSession.deleteMany({ where: { worktreeId: w.id } })
    await prisma.worktree.delete({ where: { id: w.id } })
  }
  console.log(`[worktree-cleanup] removed ${stale.length} orphan placeholder(s)`)
  return stale.length
}

// Background sweep: pin on globalThis so hot-reload doesn't spawn
// duplicate timers (matches the pattern used by companion-relay's
// connection sweeper). Production cold-starts pay no extra cost.
const globalForWorktreeCleanup = globalThis as unknown as {
  __bornastarWorktreeCleanupSweeper?: NodeJS.Timeout
}
if (!globalForWorktreeCleanup.__bornastarWorktreeCleanupSweeper) {
  const t = setInterval(() => {
    cleanupOrphanPlaceholders().catch((err) => {
      console.warn('[worktree-cleanup] sweep failed:', (err as Error).message)
    })
  }, PLACEHOLDER_SWEEP_INTERVAL_MS)
  if (typeof t.unref === 'function') t.unref()
  globalForWorktreeCleanup.__bornastarWorktreeCleanupSweeper = t
}

/**
 * Discard all uncommitted + committed changes in a worktree, resetting it
 * back to its baseCommit. Used when the user wants to throw away the work.
 */
export async function discardWorktreeChanges(
  projectId: string,
  worktreeId: string,
): Promise<boolean> {
  const wt = await prisma.worktree.findUnique({
    where: { id: worktreeId },
    select: { worktreePath: true, baseCommit: true },
  })
  if (!wt?.worktreePath || !wt.baseCommit) return false

  const sandboxId = await ensureSandboxRunning(projectId)
  if (!sandboxId) return false

  try {
    await compute.exec(
      sandboxId,
      `cd ${wt.worktreePath} && git reset --hard ${wt.baseCommit} && git clean -fd 2>&1 || true`,
    )
    return true
  } catch (err) {
    console.warn(`[worktree] Failed to discard changes for ${worktreeId}:`, err)
    return false
  }
}

/**
 * Remove the on-disk worktree + delete the branch. Best-effort. Caller passes
 * the actual branchName + worktreePath (snapshot from the DB row before any
 * status updates), so this works regardless of the codename scheme used and
 * isn't affected by concurrent writes to the row.
 */
export async function removeWorktreePhysical(
  projectId: string,
  branchName: string,
  worktreePath: string,
): Promise<void> {
  if (!branchName || !worktreePath) return

  const sandboxId = await ensureSandboxRunning(projectId)
  if (!sandboxId) return

  try {
    await compute.exec(
      sandboxId,
      `cd ${sandboxId} && git worktree remove --force ${worktreePath} 2>&1 || true`,
    )
    await compute.exec(
      sandboxId,
      `cd ${sandboxId} && git branch -D ${branchName} 2>&1 || true`,
    )
    console.log(`[worktree] Removed ${branchName}`)
  } catch (err) {
    console.warn(`[worktree] Cleanup failed for ${branchName}:`, err)
  }
}

/**
 * Diff stats for a worktree — total lines added/removed vs. `origin/main`.
 * This represents "work that hasn't reached the GitHub main branch yet" and
 * includes BOTH uncommitted working-tree changes AND committed-but-not-pushed
 * commits on the branch. The badge clears only when the work is merged + pushed.
 *
 * Falls back to `baseCommit` if `origin/main` isn't available in the sandbox
 * (e.g. no remote configured).
 */
export async function getWorktreeDiffStats(
  projectId: string,
  worktreeId: string,
): Promise<DiffStats | null> {
  const wt = await prisma.worktree.findUnique({
    where: { id: worktreeId },
    select: { worktreePath: true, baseCommit: true },
  })
  if (!wt?.worktreePath || !wt.baseCommit) return null

  const sandboxId = await ensureSandboxRunning(projectId)
  if (!sandboxId) return null

  try {
    const res = await compute.exec(
      sandboxId,
      `cd ${wt.worktreePath} && git diff --shortstat ${wt.baseCommit} 2>/dev/null || true`,
    )
    return parseShortstat(res.stdout?.trim() ?? '')
  } catch (err) {
    console.warn(`[worktree] Failed to get stats for ${worktreeId}:`, err)
    return null
  }
}

/**
 * List of files changed in a worktree, with per-file +/- stats. Compares
 * against `origin/main` (falls back to baseCommit) so the result represents
 * "everything that hasn't reached the GitHub main branch yet".
 */
export async function getWorktreeChangedFiles(
  projectId: string,
  worktreeId: string,
): Promise<ChangedFile[]> {
  const wt = await prisma.worktree.findUnique({
    where: { id: worktreeId },
    select: { worktreePath: true, baseCommit: true },
  })
  if (!wt?.worktreePath || !wt.baseCommit) return []

  const sandboxId = await ensureSandboxRunning(projectId)
  if (!sandboxId) return []

  try {
    const [numstatRes, nameStatusRes, porcelainRes] = await Promise.all([
      compute.exec(sandboxId, `cd ${wt.worktreePath} && git diff --numstat ${wt.baseCommit} || true`),
      compute.exec(sandboxId, `cd ${wt.worktreePath} && git diff --name-status ${wt.baseCommit} || true`),
      // Working-tree state vs HEAD — any path here has at least one hunk
      // that hasn't been committed yet. Drives the per-file "U" badge.
      compute.exec(sandboxId, `cd ${wt.worktreePath} && git status --porcelain || true`),
    ])
    const numstatBlock = numstatRes.stdout?.trim() ?? ''
    const nameStatusBlock = nameStatusRes.stdout?.trim() ?? ''
    if (!numstatBlock && !nameStatusBlock) return []
    const numstats = new Map<string, { added: number; removed: number }>()
    for (const line of numstatBlock.split('\n')) {
      const m = line.match(/^(\d+|-)\s+(\d+|-)\s+(.+)$/)
      if (!m) continue
      const added = m[1] === '-' ? 0 : parseInt(m[1], 10)
      const removed = m[2] === '-' ? 0 : parseInt(m[2], 10)
      numstats.set(m[3].trim(), { added, removed })
    }

    // Parse `git status --porcelain` to build the uncommitted set.
    // Format: "XY <path>" where XY is two status chars (e.g. " M", "M ",
    // "MM", "??", "AD"). Any line ≥3 chars points at an uncommitted path.
    // Renames show as "RR old -> new" — both names get added so a
    // post-rename commit clears the badge from either side.
    const uncommittedSet = new Set<string>()
    for (const line of (porcelainRes.stdout ?? '').split('\n')) {
      if (line.length < 4) continue
      const rest = line.slice(3)
      const arrow = rest.indexOf(' -> ')
      if (arrow >= 0) {
        uncommittedSet.add(rest.slice(0, arrow).trim())
        uncommittedSet.add(rest.slice(arrow + 4).trim())
      } else {
        uncommittedSet.add(rest.trim())
      }
    }

    const files: ChangedFile[] = []
    for (const line of nameStatusBlock.split('\n')) {
      const m = line.match(/^([AMDRU])\s+(.+)$/)
      if (!m) continue
      const path = m[2].trim()
      const stats = numstats.get(path) ?? { added: 0, removed: 0 }
      files.push({
        path,
        status: m[1] as ChangedFile['status'],
        ...stats,
        uncommitted: uncommittedSet.has(path),
      })
    }
    return files
  } catch (err) {
    console.warn(`[worktree] Failed to list files for ${worktreeId}:`, err)
    return []
  }
}

/**
 * Aggregated view of every modified file across every open worktree in a
 * project. Used by the file tree (center) and the global changes list.
 */
export async function getAllProjectChanges(projectId: string): Promise<{
  files: Array<ChangedFile & { worktrees: { id: string; name: string }[] }>
}> {
  const worktrees = await prisma.worktree.findMany({
    where: { projectId, status: 'open' },
    select: { id: true, name: true, worktreePath: true, baseCommit: true },
  })

  const byPath = new Map<string, ChangedFile & { worktrees: { id: string; name: string }[] }>()

  await Promise.all(worktrees.map(async (w) => {
    if (!w.worktreePath || !w.baseCommit) return
    const files = await getWorktreeChangedFiles(projectId, w.id)
    for (const f of files) {
      const existing = byPath.get(f.path)
      if (existing) {
        existing.added += f.added
        existing.removed += f.removed
        existing.worktrees.push({ id: w.id, name: w.name })
      } else {
        byPath.set(f.path, { ...f, worktrees: [{ id: w.id, name: w.name }] })
      }
    }
  }))

  return { files: Array.from(byPath.values()).sort((a, b) => a.path.localeCompare(b.path)) }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function parseShortstat(text: string): DiffStats {
  if (!text) return { added: 0, removed: 0, files: 0 }
  let added = 0
  let removed = 0
  let files = 0
  const filesMatch = text.match(/(\d+) files? changed/)
  const addedMatch = text.match(/(\d+) insertions?\(\+\)/)
  const removedMatch = text.match(/(\d+) deletions?\(-\)/)
  if (filesMatch) files = parseInt(filesMatch[1], 10)
  if (addedMatch) added = parseInt(addedMatch[1], 10)
  if (removedMatch) removed = parseInt(removedMatch[1], 10)
  return { added, removed, files }
}
