-- Per-chat unread marker. A ChatMessage with createdAt > lastReadAt and
-- role IN ('assistant','tool') counts as unread for the sidebar badge.

ALTER TABLE "chat_sessions"
  ADD COLUMN IF NOT EXISTS "lastReadAt" TIMESTAMP(3);
