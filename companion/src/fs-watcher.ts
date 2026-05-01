import chokidar, { type FSWatcher } from 'chokidar'
import { EventEmitter } from 'node:events'
import { relative } from 'node:path'

// ── Filesystem watcher ────────────────────────────────────────────────
//
// Replaces the browser's 5s polling on /repository/files and friends.
// Chokidar (using OS-native FSEvents / inotify) detects real edits and
// emits a debounced `change` event with the list of paths that changed.
// The daemon forwards those to the browser via SSE, which invalidates
// the Explorer / Changes / stats caches on demand.
//
// Two roots watched in a single chokidar instance:
//   • projectPath              — the user's repo (main view)
//   • worktreesPath (optional) — `~/.bornastar/worktrees/<projectId>/`
//     where every worktree of that project lives. Outside the repo, so
//     the project tree stays clean (no `.bornastar-worktrees/` showing
//     up in `git status` or the Explorer).
//
// Each batch carries a `source` field so consumers know which root the
// paths are relative to. For `'worktrees'`, the first segment of every
// emitted path is the worktreeId.

// Specific noise patterns instead of a broad dotfile catch-all — matches
// what VSCode/Cursor/Zed ignore by default. Files like `.env`,
// `.eslintrc`, `.gitignore` stay watched because users edit them.
const DEFAULT_IGNORES = [
  /(?:^|[/\\])\.git(?:[/\\]|$)/,             // .git directory (recursively)
  /(?:^|[/\\])\.DS_Store$/,                  // macOS metadata
  /(?:^|[/\\])node_modules(?:[/\\]|$)/,
  /(?:^|[/\\])\.next(?:[/\\]|$)/,
  /(?:^|[/\\])dist(?:[/\\]|$)/,
  /(?:^|[/\\])build(?:[/\\]|$)/,
  /(?:^|[/\\])__pycache__(?:[/\\]|$)/,
  /(?:^|[/\\])\.pytest_cache(?:[/\\]|$)/,
  /(?:^|[/\\])venv(?:[/\\]|$)/,
  /(?:^|[/\\])\.venv(?:[/\\]|$)/,
  /(?:^|[/\\])coverage(?:[/\\]|$)/,
]

// Minimum gap between batched events (milliseconds). Editors save in
// bursts (save-format-save-lint) — we wait for the burst to settle so
// the browser only refetches once per change, not four times. 50ms
// matches the VSCode/Cursor cadence: just enough to coalesce a single
// save burst, imperceptible to a human watching the badge flip.
const DEBOUNCE_MS = 50

// Source of a batch — which root the paths are relative to.
//   'project'   — paths under `projectPath` (main view)
//   'worktrees' — paths under `worktreesPath`; first segment = worktreeId
export type FsChangeSource = 'project' | 'worktrees'

export interface FsChangeBatch {
  projectPath: string
  source: FsChangeSource
  paths: string[]
}

export class ProjectWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null
  // Two pending sets so a burst that touches both roots flushes as two
  // separate batches with correct `source`. Sharing a flushTimer keeps
  // the debounce window consistent across roots.
  private pendingProject = new Set<string>()
  private pendingWorktrees = new Set<string>()
  private flushTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly projectPath: string,
    private readonly worktreesPath: string | null = null,
  ) {
    super()
  }

  start(): void {
    if (this.watcher) return
    // No `awaitWriteFinish`: VSCode/Cursor don't use it. Native FSEvents
    // already coalesces the kernel-level write events, and our consumers
    // only refetch metadata — they never read file content directly off
    // an emitted path. Removing it shaves 100-200ms off every edit.
    const roots = this.worktreesPath
      ? [this.projectPath, this.worktreesPath]
      : this.projectPath
    this.watcher = chokidar.watch(roots, {
      ignored: DEFAULT_IGNORES,
      ignoreInitial: true,
      persistent: true,
    })
    this.watcher.on('all', (event, abs) => {
      if (event !== 'add' && event !== 'change' && event !== 'unlink'
          && event !== 'addDir' && event !== 'unlinkDir') return
      // Classify the event by which root the absolute path falls under.
      // Worktrees take priority (their root may be a sibling — never a
      // child of projectPath in the new layout, but the check is cheap
      // and safe regardless).
      if (this.worktreesPath && (abs === this.worktreesPath || abs.startsWith(this.worktreesPath + '/'))) {
        const rel = relative(this.worktreesPath, abs)
        if (!rel || rel.startsWith('..')) return
        this.pendingWorktrees.add(rel)
      } else if (abs === this.projectPath || abs.startsWith(this.projectPath + '/')) {
        const rel = relative(this.projectPath, abs)
        if (!rel || rel.startsWith('..')) return
        this.pendingProject.add(rel)
      } else {
        return
      }
      this.scheduleFlush()
    })
    this.watcher.on('error', (err) => this.emit('error', err))
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      if (this.pendingProject.size > 0) {
        const paths = Array.from(this.pendingProject)
        this.pendingProject.clear()
        const batch: FsChangeBatch = { projectPath: this.projectPath, source: 'project', paths }
        this.emit('change', batch)
      }
      if (this.pendingWorktrees.size > 0) {
        const paths = Array.from(this.pendingWorktrees)
        this.pendingWorktrees.clear()
        const batch: FsChangeBatch = { projectPath: this.projectPath, source: 'worktrees', paths }
        this.emit('change', batch)
      }
    }, DEBOUNCE_MS)
  }

  stop(): void {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null }
    this.watcher?.close()
    this.watcher = null
    this.pendingProject.clear()
    this.pendingWorktrees.clear()
  }
}
