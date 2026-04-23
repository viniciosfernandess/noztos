-- ── Enable Supabase Realtime + RLS for chat tables ─────────────────────
--
-- This migration flips on the two pieces Supabase Realtime needs to
-- fan out chat events to mobile clients without bouncing every row
-- through our server:
--
--   1. Add chat_messages and chat_sessions to the `supabase_realtime`
--      publication. Supabase's Realtime server tails this publication
--      and re-broadcasts INSERT/UPDATE/DELETE to every subscribed
--      client whose RLS lets them see the row.
--
--   2. Enable row-level security on both tables with a self-only
--      SELECT policy. RLS is what makes Realtime safe to expose
--      publicly: the Postgres role used by Realtime (`authenticated`)
--      only sees rows where userId matches the JWT `sub` claim.
--
-- Caminho B auth flow:
--   /api/realtime-token mints a short-lived JWT signed with
--   SUPABASE_JWT_SECRET, claims = { sub: bornastarUserId, role: 'authenticated' }.
--   Browsers/mobile pass that JWT to supabase-js; Postgres then
--   enforces the policies below against current_setting('request.jwt.claims').
--
-- Idempotent guards so re-running against an already-initialised DB is
-- a no-op.

-- 1. Publication membership — add the two tables if not already in the
--    Realtime publication.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'chat_messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE chat_messages;
  END IF;
EXCEPTION WHEN undefined_object THEN
  -- Local / non-Supabase Postgres has no such publication. Skip.
  NULL;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'chat_sessions'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE chat_sessions;
  END IF;
EXCEPTION WHEN undefined_object THEN
  NULL;
END $$;

-- 2. RLS — enable and define a self-only SELECT policy for each.
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_sessions ENABLE ROW LEVEL SECURITY;

-- Drop-if-exists + create keeps the migration re-runnable without
-- conflict errors on a re-apply.
DROP POLICY IF EXISTS "chat_messages self-read" ON chat_messages;
CREATE POLICY "chat_messages self-read" ON chat_messages
  FOR SELECT
  TO authenticated
  USING ("userId" = (current_setting('request.jwt.claims', true)::jsonb ->> 'sub'));

DROP POLICY IF EXISTS "chat_sessions self-read" ON chat_sessions;
CREATE POLICY "chat_sessions self-read" ON chat_sessions
  FOR SELECT
  TO authenticated
  USING ("userId" = (current_setting('request.jwt.claims', true)::jsonb ->> 'sub'));

-- Writes still go through the Node server (Prisma uses the `service_role`
-- or bypass-RLS connection), so we do NOT add INSERT/UPDATE/DELETE
-- policies for `authenticated`. This is deliberate: clients read-only
-- via Realtime, all mutations go through our API for auth + billing
-- + rate limiting.
