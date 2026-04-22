-- Project-level soft delete so the user DELETE button stops wiping the
-- entire dataset (worktrees / chats / messages / files) via onDelete:
-- Cascade. status+deletedAt mirrors the pattern used on worktrees and
-- chat_sessions; hard cleanup is admin-only from here on.

ALTER TABLE "projects"
  ADD COLUMN IF NOT EXISTS "status"    TEXT         NOT NULL DEFAULT 'open',
  ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "projects_userId_deletedAt_idx"
  ON "projects" ("userId", "deletedAt");
