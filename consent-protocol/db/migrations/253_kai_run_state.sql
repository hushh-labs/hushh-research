-- Cross-process state for Kai's two long-running runs: the analysis debate and
-- the portfolio import.
--
-- A live run exists only in the memory of the worker process that started it,
-- and each lane serves several worker processes behind several Cloud Run
-- instances. After a reload, "is my run still active?", "stream it" and
-- "cancel it" usually reached a process that had never seen the run: the client
-- marked a healthy run failed, and import cancel answered 404.
--
-- One row per run lets ANY process answer active-run, follow the run to its end
-- and cancel it. The owning process writes the row at start, refreshes a
-- heartbeat and a progress checkpoint every few seconds, reads cancel requests
-- in the same round trip, and writes a terminal receipt when the run ends.
--
-- What is stored is operational metadata only: identifiers, status, an event
-- count and server-defined event/stage names, and a receipt with a
-- server-defined code. No holdings, statements, file names, model output,
-- market material or PKM context (the posture migration 128 set for
-- kai_analyze_runs). The one exception is relay_ciphertext: when a process that
-- does not hold a run is asked to reattach, it writes a one-time X25519 public
-- key; the owner seals the run's terminal frame to that key (AES-256-GCM, with a
-- salt derived from the backend's signing secret) and the requester deletes it
-- on delivery. The private key is never stored, so the ciphertext cannot be
-- opened, forged or redirected from the database.
--
-- A separate table rather than new kai_analyze_runs columns: migration 128 ends
-- in DELETE FROM kai_analyze_runs and replays on every deploy, which would erase
-- running rows mid-run, and a status CHECK swap would take ACCESS EXCLUSIVE on
-- every replay. Retention: rows expire via expires_at (swept on each run start
-- and end) and are deleted with the account.

BEGIN;

CREATE TABLE IF NOT EXISTS kai_run_state (
  run_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  run_kind TEXT NOT NULL CHECK (run_kind IN ('debate', 'import')),
  session_id TEXT NOT NULL DEFAULT '',
  ticker TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'canceled')),
  terminal_event TEXT,
  terminal_receipt TEXT NOT NULL DEFAULT '{}',
  progress TEXT NOT NULL DEFAULT '{}',
  started_at_iso TEXT,
  completed_at_iso TEXT,
  heartbeat_at BIGINT,
  finished_at BIGINT,
  cancel_requested_at BIGINT,
  relay_public_key TEXT,
  relay_ciphertext TEXT,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);

-- Guarded so a replay on a table with live heartbeats never waits on a lock.
DO $$
BEGIN
  IF to_regclass('public.idx_kai_run_state_owner_active') IS NULL THEN
    CREATE INDEX idx_kai_run_state_owner_active
      ON kai_run_state (user_id, run_kind, session_id, status);
  END IF;
  IF to_regclass('public.idx_kai_run_state_expiry') IS NULL THEN
    CREATE INDEX idx_kai_run_state_expiry ON kai_run_state (expires_at);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.kai_run_state'::regclass AND relrowsecurity
  ) THEN
    ALTER TABLE kai_run_state ENABLE ROW LEVEL SECURITY;
  END IF;
END $$;

REVOKE ALL ON kai_run_state FROM PUBLIC;
DO $$ DECLARE role_name TEXT; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON kai_run_state FROM %I', role_name);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON kai_run_state TO service_role;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'install_account_deletion_write_guards') THEN
    PERFORM public.install_account_deletion_write_guards();
  END IF;
END $$;

COMMENT ON TABLE kai_run_state IS
  'Cross-process state for Kai debate and portfolio-import runs: running row with heartbeat, metadata-only progress, owner cancel request, metadata-only terminal receipt, and a one-time sealed terminal hand-off whose key is never stored. Expires via expires_at; deleted with the account.';

COMMIT;
