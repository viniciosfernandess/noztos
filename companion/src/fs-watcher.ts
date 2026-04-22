import chokidar, { type FSWatcher } from 'chokidar'
import { EventEmitter } from 'node:events'
import { relative } from 'node:path'

// ── Filesystem watcher ────────────────────────────────────────────────
//
// Replaces the browser's 5s polling on /repository/files and friends.
// Chokidar (using OS-native FSEvents / inotify) detects real edits on
// the project tree and emits a debounced `change` event with the list of
// paths that changed. The daemon forwards those to the browser via SSE,
// which invalidates the Explorer / Changes / stats caches on demand.
//
// Heavy dirs are ignored so we don't burn file descriptors on
// node_modules, .git, build outputs. We also normalize paths to project-
// relative strings so the browser can tell whether the change belongs to
// main or to a worktree (`.bornastar-worktrees/<id>/…`).

const DEFAULT_IGNORES = [
  /(^|[/\\])\../,                           // dotfiles (includes .git, .DS_Store)
  /node_modules(\/|$)/,
  /\.next(\/|$)/,
  /dist(\/|$)/,
  /build(\/|$)/,
  /__pycache__(\/|$)/,
  /\.pytest_cache(\/|$)/,
  /venv(\/|$)/,
  /\.venv(\/|$)/,
  /coverage(\/|$)/,
]

// Minimum gap between batched events (milliseconds). Editors save in
// bursts (save-format-save-lint) — we wait for the burst to settle so
// the browser only refetches once per change, not four times.
const DEBOUNCE_MS = 300

export interface FsChangeBatch {
  projectPath: string
  paths: string[]   // project-relative paths. Prefix `.bornastar-worktrees/<id>/` ⇒ inside worktree.
}

export class ProjectWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null
  private pending = new Set<string>()
  private flushTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly projectPath: string) {
    super()
  }

  start(): void {
    if (this.watcher) return
    this.watcher = chokidar.watch(this.projectPath, {
      ignored: DEFAULT_IGNORES,
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    })
    this.watcher.on('all', (event, abs) => {
      if (event !== 'add' && event !== 'change' && event !== 'unlink'
          && event !== 'addDir' && event !== 'unlinkDir') return
      const rel = relative(this.projectPath, abs)
      if (!rel || rel.startsWith('..')) return
      this.pending.add(rel)
      this.scheduleFlush()
    })
    this.watcher.on('error', (err) => this.emit('error', err))
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      if (this.pending.size === 0) return
      const paths = Array.from(this.pending)
      this.pending.clear()
      const batch: FsChangeBatch = { projectPath: this.projectPath, paths }
      this.emit('change', batch)
    }, DEBOUNCE_MS)
  }

  stop(): void {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null }
    this.watcher?.close()
    this.watcher = null
    this.pending.clear()
  }
}
