CREATE TABLE IF NOT EXISTS public.commands (
  id BIGSERIAL PRIMARY KEY,
  command TEXT NOT NULL,
  args JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  executed_at TIMESTAMPTZ
);

-- Executor-liveness tracking columns. Added via ALTER so re-runs of the
-- schema on existing projects are safe (idempotent).
--  - exec_session_id: the bridge session UUID active when dispatch started.
--    Changes on every RealtimeService onCreate(), so if a command row has
--    exec_session_id != current devices.session_id for this device, the
--    executor that started it is definitely gone (rebooted/crashed/killed).
--  - executor_pid: Process.myPid() at dispatch start (informational).
--  - last_heartbeat_at: bumped every ~10s while dispatch is in flight.
--  - device_id: which device this command is targeted at. NULL = broadcast
--    (any online device will pick it up).
ALTER TABLE public.commands ADD COLUMN IF NOT EXISTS exec_session_id TEXT;
ALTER TABLE public.commands ADD COLUMN IF NOT EXISTS executor_pid INT;
ALTER TABLE public.commands ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ;
ALTER TABLE public.commands ADD COLUMN IF NOT EXISTS device_id TEXT;

-- Fast filtering by target device (the realtime listener uses this).
CREATE INDEX IF NOT EXISTS idx_commands_device_id ON public.commands (device_id);

CREATE TABLE IF NOT EXISTS public.phone_capabilities (
  module_name TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '0.0.0',
  type TEXT NOT NULL DEFAULT 'dex',
  status TEXT NOT NULL DEFAULT 'uploaded',
  commands JSONB NOT NULL DEFAULT '[]'::jsonb,
  sha256 TEXT,
  storage_path TEXT,
  download_url TEXT,
  manifest JSONB,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (module_name, version)
);

-- Multi-device registry. One row per device, keyed by a stable UUID the
-- phone generates once (in SharedPreferences) and reuses forever.
--
-- The heartbeat edge function upserts into this table on every tick —
-- updating last_alive_at, session_id, currently_executing_id, etc.
-- The list-devices edge function reads from it so the AI agent can pick
-- which device to send commands to.
-- The get-result edge function reads from it to detect dead executors.
DROP TABLE IF EXISTS public.phone_bridge_session;
CREATE TABLE IF NOT EXISTS public.devices (
  device_id TEXT PRIMARY KEY,
  name TEXT,
  model TEXT,
  manufacturer TEXT,
  product TEXT,
  device_codename TEXT,
  android_version TEXT,
  sdk_int INT,
  privilege_level TEXT,
  status TEXT NOT NULL DEFAULT 'offline',
  session_id TEXT,
  started_at TIMESTAMPTZ,
  last_alive_at TIMESTAMPTZ,
  pid INT,
  currently_executing_id BIGINT,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotent ALTERs so existing devices tables get the new columns on
-- re-runs of SCHEMA_SQL. The CREATE TABLE IF NOT EXISTS above is a no-op
-- if the table already exists, so these ALTERs are needed to add the
-- new columns to pre-existing tables.
ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS manufacturer TEXT;
ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS product TEXT;
ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS device_codename TEXT;
ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS sdk_int INT;
ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS privilege_level TEXT;
ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS shizuku_uid INT;

ALTER TABLE public.devices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_all_devices" ON public.devices;
CREATE POLICY "anon_all_devices" ON public.devices
  FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

ALTER TABLE public.commands ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_all_commands" ON public.commands;
CREATE POLICY "anon_all_commands" ON public.commands
  FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

ALTER TABLE public.phone_capabilities ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_all_capabilities" ON public.phone_capabilities;
CREATE POLICY "anon_all_capabilities" ON public.phone_capabilities
  FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

ALTER TABLE public.commands REPLICA IDENTITY FULL;

-- Add to the realtime publication. Wrapped in a DO block so re-runs don't fail
-- when the table is already a member (pg error 42710 duplicate_object).
DO $pub$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.commands;
EXCEPTION WHEN duplicate_object THEN NULL;
END $pub$;

-- Optional hourly cleanup via pg_cron (only if the extension is installed).
-- Uses distinct dollar-quote tags ($do$, $cleanup$) so they don't conflict with each other.
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('phone_bridge_cleanup', '0 * * * *',
      $cleanup$DELETE FROM public.commands WHERE created_at < now() - interval '1 day'$cleanup$);
  END IF;
EXCEPTION WHEN OTHERS THEN NULL;
END $do$;

-- Knowledge + skills tables — dual storage. The phone keeps a local
-- file-system cache (files/knowledge/ + files/skills/) for fast
-- reads + offline access; the database is the canonical store
-- that syncs across all the user's devices.
--
-- device_id semantics:
--   NULL  = global — entry applies to ALL devices (visible to every
--           phone the user controls). Use for general knowledge.
--   <uuid> = device-specific — only visible to that device. Use for
--            ROM-specific quirks, install paths, etc.
-- author_device_id records which device originally wrote the entry
-- (informational; useful for provenance).
CREATE TABLE IF NOT EXISTS public.knowledge (
  id TEXT PRIMARY KEY,
  device_id TEXT,
  title TEXT NOT NULL,
  summary TEXT,
  content TEXT NOT NULL,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  author_device_id TEXT
);

CREATE TABLE IF NOT EXISTS public.skills (
  id TEXT PRIMARY KEY,
  device_id TEXT,
  title TEXT NOT NULL,
  summary TEXT,
  content TEXT NOT NULL,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  author_device_id TEXT
);

-- Idempotent ALTERs for existing projects.
ALTER TABLE public.knowledge ADD COLUMN IF NOT EXISTS device_id TEXT;
ALTER TABLE public.knowledge ADD COLUMN IF NOT EXISTS author_device_id TEXT;
ALTER TABLE public.skills  ADD COLUMN IF NOT EXISTS device_id TEXT;
ALTER TABLE public.skills  ADD COLUMN IF NOT EXISTS author_device_id TEXT;

-- Indexes for fast device-scoped queries (the pull edge function
-- filters by `WHERE device_id IS NULL OR device_id = $1`).
CREATE INDEX IF NOT EXISTS idx_knowledge_device_id ON public.knowledge (device_id);
CREATE INDEX IF NOT EXISTS idx_skills_device_id ON public.skills (device_id);

ALTER TABLE public.knowledge ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_all_knowledge" ON public.knowledge;
CREATE POLICY "anon_all_knowledge" ON public.knowledge
  FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

ALTER TABLE public.skills ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_all_skills" ON public.skills;
CREATE POLICY "anon_all_skills" ON public.skills
  FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

-- ====================================================================
-- AGENT-TO-AGENT CHAT SYSTEM (multi-agent discussions)
-- ====================================================================
-- Defensive cleanup: if a previous half-applied schema left any of these
-- tables around (possibly with a different column layout), drop them first
-- so the CREATE TABLE below creates a clean schema. The CASCADE ensures
-- dependent objects (indexes, policies) go too. Safe because these tables
-- are brand new — the user has no production data in them yet.
DROP TABLE IF EXISTS public.chat_messages CASCADE;
DROP TABLE IF EXISTS public.chat_participants CASCADE;
DROP TABLE IF EXISTS public.chats CASCADE;
DROP TABLE IF EXISTS public.agents CASCADE;

-- agents registry: each AI agent announces itself (name, description,
-- capabilities) and keeps its heartbeat fresh so others can see it's alive.
-- NOTE: no inline FOREIGN KEY references here — added via ALTER TABLE
-- ADD CONSTRAINT below. The Supabase /database/query API has been observed
-- to choke on inline FK references in CREATE TABLE when run as a single
-- multi-statement query string (errors with 'column id referenced in
-- foreign key constraint does not exist'). Splitting the FK creation into
-- its own ALTER statements sidesteps the issue entirely.
CREATE TABLE IF NOT EXISTS public.agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  alive BOOLEAN NOT NULL DEFAULT false,
  last_alive_at TIMESTAMPTZ,
  session_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- chat sessions between 2+ agents
CREATE TABLE IF NOT EXISTS public.chats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT,
  status TEXT NOT NULL DEFAULT 'active',  -- active | closed
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ
);

-- which agents are in which chat (composite PK).
CREATE TABLE IF NOT EXISTS public.chat_participants (
  chat_id UUID NOT NULL,
  agent_id UUID NOT NULL,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (chat_id, agent_id)
);

-- messages in chats. kind discriminates between ask/reply/result/system.
-- in_reply_to lets a reply/result reference the ask that prompted it so
-- chat-ask + chat-wait-for-result can correlate.
CREATE TABLE IF NOT EXISTS public.chat_messages (
  id BIGSERIAL PRIMARY KEY,
  chat_id UUID NOT NULL,
  from_agent UUID,
  to_agent UUID,  -- NULL = broadcast to all participants
  kind TEXT NOT NULL,  -- ask | reply | result | system | note
  content TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  in_reply_to BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending'  -- pending | consumed | expired
);

-- Add foreign-key constraints separately (avoids the inline-FK parsing issue).
-- DROP+ADD pattern makes this idempotent on re-runs.
ALTER TABLE public.chat_participants DROP CONSTRAINT IF EXISTS cp_chat_fk;
ALTER TABLE public.chat_participants ADD CONSTRAINT cp_chat_fk
  FOREIGN KEY (chat_id) REFERENCES public.chats(id) ON DELETE CASCADE;
ALTER TABLE public.chat_participants DROP CONSTRAINT IF EXISTS cp_agent_fk;
ALTER TABLE public.chat_participants ADD CONSTRAINT cp_agent_fk
  FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;

ALTER TABLE public.chat_messages DROP CONSTRAINT IF EXISTS cm_chat_fk;
ALTER TABLE public.chat_messages ADD CONSTRAINT cm_chat_fk
  FOREIGN KEY (chat_id) REFERENCES public.chats(id) ON DELETE CASCADE;
ALTER TABLE public.chat_messages DROP CONSTRAINT IF EXISTS cm_from_agent_fk;
ALTER TABLE public.chat_messages ADD CONSTRAINT cm_from_agent_fk
  FOREIGN KEY (from_agent) REFERENCES public.agents(id);
ALTER TABLE public.chat_messages DROP CONSTRAINT IF EXISTS cm_to_agent_fk;
ALTER TABLE public.chat_messages ADD CONSTRAINT cm_to_agent_fk
  FOREIGN KEY (to_agent) REFERENCES public.agents(id);
ALTER TABLE public.chat_messages DROP CONSTRAINT IF EXISTS cm_in_reply_to_fk;
ALTER TABLE public.chat_messages ADD CONSTRAINT cm_in_reply_to_fk
  FOREIGN KEY (in_reply_to) REFERENCES public.chat_messages(id);

-- Idempotent ALTERs for the new tables (no-op on fresh DBs; useful if the
-- user runs setup again after a partial upgrade).
ALTER TABLE public.agents ADD COLUMN IF NOT EXISTS session_id TEXT;
ALTER TABLE public.chat_messages ADD COLUMN IF NOT EXISTS in_reply_to BIGINT;
ALTER TABLE public.chat_messages ADD COLUMN IF NOT EXISTS consumed_at TIMESTAMPTZ;
ALTER TABLE public.chat_messages ADD COLUMN IF NOT EXISTS status TEXT;
UPDATE public.chat_messages SET status = 'pending' WHERE status IS NULL;

-- Fast lookups for the long-poll edge functions.
CREATE INDEX IF NOT EXISTS idx_chat_messages_chat_id ON public.chat_messages(chat_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_to_agent_status
  ON public.chat_messages(to_agent, status);
CREATE INDEX IF NOT EXISTS idx_chat_messages_kind_status
  ON public.chat_messages(kind, status);
CREATE INDEX IF NOT EXISTS idx_chat_messages_in_reply_to
  ON public.chat_messages(in_reply_to);
CREATE INDEX IF NOT EXISTS idx_agents_alive ON public.agents(alive, last_alive_at);

-- Mark agents stale (>60s since last heartbeat) as not alive via a periodic
-- check. We use a pg_cron job if available; otherwise the agent-list edge
-- function does this check inline.
ALTER TABLE public.agents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_all_agents" ON public.agents;
CREATE POLICY "anon_all_agents" ON public.agents
  FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

ALTER TABLE public.chats ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_all_chats" ON public.chats;
CREATE POLICY "anon_all_chats" ON public.chats
  FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

ALTER TABLE public.chat_participants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_all_chat_participants" ON public.chat_participants;
CREATE POLICY "anon_all_chat_participants" ON public.chat_participants
  FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_all_chat_messages" ON public.chat_messages;
CREATE POLICY "anon_all_chat_messages" ON public.chat_messages
  FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

-- ====================================================================
-- ROOMS (multi-agent floor control — one speaker at a time)
-- ====================================================================
CREATE TABLE IF NOT EXISTS public.rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.room_members (
  room_id UUID NOT NULL,
  agent_id UUID NOT NULL,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, agent_id)
);

CREATE TABLE IF NOT EXISTS public.room_speaker_state (
  room_id UUID PRIMARY KEY,
  current_speaker UUID,
  speaker_started_at TIMESTAMPTZ,
  next_speaker UUID,
  demand_phase_started_at TIMESTAMPTZ,
  demand_requests JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- FK constraints (added separately to avoid inline-FK parse issues).
ALTER TABLE public.room_members DROP CONSTRAINT IF EXISTS rm_room_fk;
ALTER TABLE public.room_members ADD CONSTRAINT rm_room_fk
  FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;
ALTER TABLE public.room_members DROP CONSTRAINT IF EXISTS rm_agent_fk;
ALTER TABLE public.room_members ADD CONSTRAINT rm_agent_fk
  FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;
ALTER TABLE public.room_speaker_state DROP CONSTRAINT IF EXISTS rss_room_fk;
ALTER TABLE public.room_speaker_state ADD CONSTRAINT rss_room_fk
  FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;

ALTER TABLE public.rooms ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_all_rooms" ON public.rooms;
CREATE POLICY "anon_all_rooms" ON public.rooms
  FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

ALTER TABLE public.room_members ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_all_room_members" ON public.room_members;
CREATE POLICY "anon_all_room_members" ON public.room_members
  FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

ALTER TABLE public.room_speaker_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_all_room_speaker_state" ON public.room_speaker_state;
CREATE POLICY "anon_all_room_speaker_state" ON public.room_speaker_state
  FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

-- ====================================================================
-- TEMPORARY SCHEMA (TmpDB — agent scratchpad tables)
-- ====================================================================
-- Agents can create/drop/insert/query tables in the 'temporary' schema
-- as a scratchpad for organizing work, storing intermediate results,
-- sharing state between agents, etc.
-- Tables are NOT in 'public' — they're isolated in 'temporary'.
CREATE SCHEMA IF NOT EXISTS temporary;

-- Grant access to the anon + authenticated roles on the temporary schema.
GRANT USAGE ON SCHEMA temporary TO anon, authenticated;
GRANT CREATE ON SCHEMA temporary TO anon, authenticated;

-- Ensure the supabase_realtime publication exists (for TmpDB-stream).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime WITH (publish = 'insert, update, delete');
  END IF;
END
$$;
