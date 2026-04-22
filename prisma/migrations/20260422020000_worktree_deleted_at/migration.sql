-- Keep Worktree's unlinked state in sync with the pattern used on
-- ChatSession / ChatMessage: `deletedAt` stamped alongside status='deleted'
-- so every query layer (status-based or timestamp-based) agrees.

ALTER TABLE "worktrees"
  ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "worktrees_deletedAt_idx"
  ON "worktrees" ("deletedAt");
