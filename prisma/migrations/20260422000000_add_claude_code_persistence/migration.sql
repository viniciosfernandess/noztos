-- Add Claude Code persistence fields so chats survive refreshes,
-- restore the --resume id, and capture a rich training dataset.

-- ChatSession: --resume state + rolled-up usage metrics
ALTER TABLE "chat_sessions"
  ADD COLUMN IF NOT EXISTS "claudeSessionId" TEXT,
  ADD COLUMN IF NOT EXISTS "totalCostUsd"    DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "totalTokens"     INTEGER          NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "numTurns"        INTEGER          NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "lastMessageAt"   TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "chat_sessions_userId_lastMessageAt_idx"
  ON "chat_sessions" ("userId", "lastMessageAt");

-- ChatMessage: structured Claude Code event model
ALTER TABLE "chat_messages"
  ADD COLUMN IF NOT EXISTS "role"              TEXT,
  ADD COLUMN IF NOT EXISTS "worktreeId"        TEXT,
  ADD COLUMN IF NOT EXISTS "toolName"          TEXT,
  ADD COLUMN IF NOT EXISTS "toolInput"         JSONB,
  ADD COLUMN IF NOT EXISTS "toolResult"        JSONB,
  ADD COLUMN IF NOT EXISTS "toolUseId"         TEXT,
  ADD COLUMN IF NOT EXISTS "toolError"         BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "parentMessageId"   TEXT,
  ADD COLUMN IF NOT EXISTS "editOfMessageId"   TEXT,
  ADD COLUMN IF NOT EXISTS "wasInterrupted"    BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "wasRegenerated"    BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "costUsd"           DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "durationMs"        INTEGER,
  ADD COLUMN IF NOT EXISTS "inputTokens"       INTEGER,
  ADD COLUMN IF NOT EXISTS "outputTokens"      INTEGER,
  ADD COLUMN IF NOT EXISTS "cacheReadTokens"   INTEGER,
  ADD COLUMN IF NOT EXISTS "cacheCreateTokens" INTEGER,
  ADD COLUMN IF NOT EXISTS "model"             TEXT,
  ADD COLUMN IF NOT EXISTS "permissionMode"    TEXT,
  ADD COLUMN IF NOT EXISTS "claudeSessionId"   TEXT;

-- Existing rows had `sender` as required; legacy engine is gone, make
-- it nullable so the new flow can leave it null.
ALTER TABLE "chat_messages" ALTER COLUMN "sender" DROP NOT NULL;

-- Backfill role so the new NOT NULL below passes. Legacy rows used
-- `sender` — map sender → role conservatively; anything non-conforming
-- lands as 'system'.
UPDATE "chat_messages" SET "role" =
  CASE
    WHEN "sender" = 'user'      THEN 'user'
    WHEN "sender" = 'assistant' THEN 'assistant'
    WHEN "sender" IS NULL       THEN 'system'
    ELSE 'system'
  END
  WHERE "role" IS NULL;

ALTER TABLE "chat_messages" ALTER COLUMN "role" SET NOT NULL;

-- Promote sessionId to NOT NULL now that the legacy nullable flow is
-- gone. Delete any orphaned rows first (should be zero in practice).
DELETE FROM "chat_messages" WHERE "sessionId" IS NULL;
ALTER TABLE "chat_messages" ALTER COLUMN "sessionId" SET NOT NULL;

-- Indexes: cover the queries the UI + training dataset runs on
CREATE INDEX IF NOT EXISTS "chat_messages_userId_createdAt_idx"
  ON "chat_messages" ("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "chat_messages_worktreeId_createdAt_idx"
  ON "chat_messages" ("worktreeId", "createdAt");
CREATE INDEX IF NOT EXISTS "chat_messages_toolUseId_idx"
  ON "chat_messages" ("toolUseId");
CREATE INDEX IF NOT EXISTS "chat_messages_role_createdAt_idx"
  ON "chat_messages" ("role", "createdAt");
