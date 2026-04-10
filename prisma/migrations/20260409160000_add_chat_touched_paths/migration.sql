-- Add per-chat touched paths so we can attribute diff stats to a specific
-- chat on main (where multiple chats share the same working tree).
ALTER TABLE "chat_sessions"
  ADD COLUMN "touchedPaths" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
