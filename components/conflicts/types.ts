// Shared types for the conflict resolution UI.
//
// A ConflictFile describes one unmerged path from `git status`. The
// `kind` tells the ConflictResolver which specialized panel to render:
//   text     → ConflictFileNavigator (existing: markers + Keep yours/theirs/both)
//   rename   → RenamePanel (keep rename / keep edits)
//   delete   → DeletePanel (delete / keep edits)
//   binary   → BinaryPanel (keep yours / theirs — no "both")

export type ConflictKind = 'text' | 'rename' | 'delete' | 'binary'

export interface ConflictFile {
  path: string
  kind: ConflictKind
  meta?: {
    oldPath?: string                 // rename: the old file name
    deletedBy?: 'ours' | 'theirs'    // delete/modify: which side deleted
    size?: number                    // binary: byte size for display
  }
}
