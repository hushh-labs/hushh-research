-- When One reached out on its own, and nothing about what it said.
--
-- Two attention moments share this ledger:
--   * first_connect_insights -- the "Here's what I picked up" card offered once
--     per connected source (subject_ref is 'gmail', 'calendar' or 'drive');
--   * feed_attention_push    -- the generic "One has something for you" push
--     for one notable feed row (subject_ref is that feed_events id).
--
-- A row holds identifiers, an outcome and timestamps only. The inferences a
-- card showed, the feed item's words, and One's message about it are never
-- stored here: the card lives only on the person's screen until Keep saves an
-- item through the encrypted PKM writer, and One's message is sealed in the
-- conversation with the person's chat key. The daily push cap is a count over
-- this table, so it needs no second store.
--
-- Rows follow the person's actor profile (ON DELETE CASCADE), so full account
-- deletion and reset remove them with nothing else to wire.
--
-- Replay-safe: every statement is guarded, so re-running the migration on each
-- deploy changes nothing and never takes a lock on a populated table.

BEGIN;

CREATE TABLE IF NOT EXISTS one_attention_ledger (
  user_id TEXT NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('first_connect_insights', 'feed_attention_push')),
  subject_ref TEXT NOT NULL CHECK (subject_ref ~ '^[a-z0-9_]{1,40}$'),
  outcome TEXT NOT NULL CHECK (
    outcome IN ('pending', 'offered', 'empty', 'failed', 'sent', 'throttled', 'no_device')
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, kind, subject_ref)
);

DO $$
BEGIN
  IF to_regclass('public.idx_one_attention_ledger_recent') IS NULL THEN
    CREATE INDEX idx_one_attention_ledger_recent
      ON one_attention_ledger (kind, user_id, created_at DESC);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.one_attention_ledger'::regclass AND relrowsecurity
  ) THEN
    ALTER TABLE one_attention_ledger ENABLE ROW LEVEL SECURITY;
  END IF;
END $$;

REVOKE ALL ON one_attention_ledger FROM PUBLIC;
DO $$ DECLARE role_name TEXT; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON one_attention_ledger FROM %I', role_name);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON one_attention_ledger TO service_role;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'install_account_deletion_write_guards') THEN
    PERFORM public.install_account_deletion_write_guards();
  END IF;
END $$;

COMMENT ON TABLE one_attention_ledger IS
  'Metadata-only record of One''s own attention moments (first-connect insight card offered per source; generic feed push per feed row). Identifiers, outcome and time only; never card, feed or message text. Deleted with the actor profile.';

COMMIT;
