import { prisma } from '@/lib/db'
import { ensureSandboxRunning } from '@/lib/sandbox-manager'
import { LocalProvider } from '@/lib/compute-local'

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

const compute = new LocalProvider()

// Paths are
// resolved dynamically from the project's actual disk location.
// `getProjectPaths()` returns both, looking up the project path from
// `ensureSandboxRunning()`. Functions that need paths call this once
// at the top.
async function getProjectPaths(projectId: string): Promise<{ root: string; worktrees: string }> {
  const projectPath = await ensureSandboxRunning(projectId)
  const root = projectPath ?? process.cwd()
  return {
    root,
    worktrees: `${root}/.bornastar-worktrees`,
  }
}

// Backward-compat constants — used by code that hasn't been migrated
// to getProjectPaths() yet. Will break in local mode for those paths.
const SHARED_PROJECT_ROOT = process.cwd()
const WORKTREES_DIR = `${process.cwd()}/.bornastar-worktrees`

// Each worktree reserves PORTS_PER_WORKTREE consecutive ports starting at
// portBase. The user can reference them as $BORNASTAR_PORT through
// $BORNASTAR_PORT+9 in their run scripts.
const PORT_RANGE_START = 4000
const PORTS_PER_WORKTREE = 10
const PORT_RANGE_END = 4990

export const SHARED_PROJECT_ROOT_PATH = SHARED_PROJECT_ROOT

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
 * Pick a fresh `<city>-v<N>` codename that hasn't been used by any worktree
 * (open, archived, trashed, or deleted) in this project — so we never create
 * a duplicate git branch ref. Returns a pretty `name` and a `branchName`.
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

function worktreePathForId(worktreeId: string): string {
  return `${WORKTREES_DIR}/${worktreeId}`
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
 */
export async function provisionWorktree(
  projectId: string,
  worktreeId: string,
  branchName: string,
): Promise<WorktreeInfo | null> {
  const sandboxId = await ensureSandboxRunning(projectId)
  if (!sandboxId) {
    console.warn(`[worktree] No sandbox available for project ${projectId}`)
    return null
  }

  const worktreePath = worktreePathForId(worktreeId)

  try {
    await compute.exec(sandboxId, `mkdir -p ${WORKTREES_DIR}`)

    // Get current HEAD on main as the baseline
    const headRes = await compute.exec(
      sandboxId,
      `cd ${SHARED_PROJECT_ROOT} && git rev-parse HEAD 2>/dev/null || echo NONE`,
    )
    const baseCommit = headRes.stdout?.trim()
    if (!baseCommit || baseCommit === 'NONE') {
      console.warn(`[worktree] No git HEAD found at ${SHARED_PROJECT_ROOT}`)
      return null
    }

    const portBase = await allocatePortBase(projectId)
    if (portBase === null) {
      console.warn(`[worktree] Port range exhausted`)
      return null
    }

    // Reuse if the directory already exists
    const existsRes = await compute.exec(
      sandboxId,
      `test -d ${worktreePath}/.git -o -f ${worktreePath}/.git && echo yes || echo no`,
    )
    if (existsRes.stdout?.trim() === 'yes') {
      console.log(`[worktree] Reusing existing worktree at ${worktreePath}`)
      return { worktreePath, branchName, baseCommit, portBase }
    }

    // Create new worktree on a fresh branch from current main HEAD
    const createRes = await compute.exec(
      sandboxId,
      `cd ${SHARED_PROJECT_ROOT} && git worktree add ${worktreePath} -b ${branchName} 2>&1`,
    )
    if (createRes.exitCode !== 0) {
      // Branch may already exist — try without -b
      const fallbackRes = await compute.exec(
        sandboxId,
        `cd ${SHARED_PROJECT_ROOT} && git worktree add ${worktreePath} ${branchName} 2>&1`,
      )
      if (fallbackRes.exitCode !== 0) {
        console.warn(`[worktree] Failed to create worktree: ${createRes.stdout} | ${fallbackRes.stdout}`)
        return null
      }
    }

    console.log(`[worktree] Created ${branchName} at ${worktreePath} (base: ${baseCommit.slice(0, 8)}, port: ${portBase})`)
    return { worktreePath, branchName, baseCommit, portBase }
  } catch (err) {
    console.error(`[worktree] Error provisioning worktree:`, err)
    return null
  }
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
      `cd ${SHARED_PROJECT_ROOT} && git worktree remove --force ${worktreePath} 2>&1 || true`,
    )
    await compute.exec(
      sandboxId,
      `cd ${SHARED_PROJECT_ROOT} && git branch -D ${branchName} 2>&1 || true`,
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
      `cd ${wt.worktreePath} && (git diff --shortstat origin/main 2>/dev/null || git diff --shortstat ${wt.baseCommit} 2>/dev/null)`,
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

  // Determine which ref to diff against: prefer origin/main, fall back to baseCommit
  const refCheck = await compute.exec(
    sandboxId,
    `cd ${wt.worktreePath} && git rev-parse --verify origin/main 2>/dev/null && echo OK || echo MISSING`,
  )
  const ref = refCheck.stdout?.trim().endsWith('OK') ? 'origin/main' : wt.baseCommit

  try {
    // Run the two diffs separately. The old `&&`-chained version was failing
    // with exit 129 when either diff had no output, because shell chaining
    // propagates the first command's status. Separate execs are cheap and
    // let us recover from either one returning empty.
    const [numstatRes, nameStatusRes] = await Promise.all([
      compute.exec(sandboxId, `cd ${wt.worktreePath} && git diff --numstat ${ref} || true`),
      compute.exec(sandboxId, `cd ${wt.worktreePath} && git diff --name-status ${ref} || true`),
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

    const files: ChangedFile[] = []
    for (const line of nameStatusBlock.split('\n')) {
      const m = line.match(/^([AMDRU])\s+(.+)$/)
      if (!m) continue
      const path = m[2].trim()
      const stats = numstats.get(path) ?? { added: 0, removed: 0 }
      files.push({ path, status: m[1] as ChangedFile['status'], ...stats })
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
