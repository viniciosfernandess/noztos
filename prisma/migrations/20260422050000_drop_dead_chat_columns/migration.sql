-- Drop ChatMessage columns that no current code path reads. The legacy
-- task/team pipeline still uses `sender` and `mode`, so those stay
-- until that subsystem is retired.

ALTER TABLE "chat_messages"
  DROP COLUMN IF EXISTS "activeSkillId",
  DROP COLUMN IF EXISTS "report";
