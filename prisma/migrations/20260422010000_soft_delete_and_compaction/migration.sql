-- Soft delete support for user-facing "delete chat" without losing
-- audit / training data, plus compaction boundary marker on messages.

ALTER TABLE "chat_sessions"
  ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);

ALTER TABLE "chat_messages"
  ADD COLUMN IF NOT EXISTS "deletedAt"    TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "wasCompacted" BOOLEAN NOT NULL DEFAULT FALSE;

-- Filter GETs on deletedAt efficiently.
CREATE INDEX IF NOT EXISTS "chat_sessions_deletedAt_idx"
  ON "chat_sessions" ("deletedAt");
CREATE INDEX IF NOT EXISTS "chat_messages_deletedAt_idx"
  ON "chat_messages" ("deletedAt");
