// Shared shape for the per-worktree file listing returned by
// /api/projects/[id]/repository/files. Lives here so the cache module
// (`worktree-cache.ts`) and the renderer (`WorkPanel.tsx`) agree on the
// type without one importing from the other.
export interface FileEntry {
  id: string
  path: string
  isModified: boolean
  isNew: boolean
  sizeBytes: number
  // True when at least one hunk in this file is still uncommitted vs HEAD.
  // Drives the "U" badge in the Changes list. Optional because the main-
  // view aggregation (cross-worktree) doesn't compute it.
  uncommitted?: boolean
  // Cross-worktree info — present only when at least one open worktree touched this file
  added?: number
  removed?: number
  worktrees?: { id: string; name: string }[]
}

// Single file's diff content as stored in the per-worktree hunks cache.
// `originalContent` is what the file looked like at baseCommit;
// `content` is the current on-disk version. The browser computes hunks
// from these via buildHunksFromContents() — server stays stateless.
export interface FileDiff {
  content: string
  originalContent: string
}

// Per-worktree to-do row. Mirrors the Prisma `Todo` model fields the UI
// actually uses. Lives here so the cache module and ChecksPanel share
// one shape without re-importing across UI ↔ cache layers.
export interface Todo {
  id: string
  content: string
  done: boolean
  position: number
  createdAt: string
}

// Aggregate of every "small" piece of worktree state the right panel
// hydrates on entry — kept together because they're tied to the same
// lifecycle (mount worktree → load all; close worktree → drop all)
// and they're tiny enough that one cache slice covers them without
// per-field listener fan-out. Each field is independently optional so
// `setCachedMeta(key, partial)` can fill in pieces over time without
// erasing what's already there.
export interface WorktreeMeta {
  prDraft?: { title: string; body: string }
  todos?: Todo[]
}
