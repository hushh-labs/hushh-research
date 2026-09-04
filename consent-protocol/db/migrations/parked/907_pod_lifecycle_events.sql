-- ============================================================================
-- Migration 907: pod_lifecycle_events — the provisioning narrative log
-- ============================================================================
-- Append-only narrative of one person's agent being built: lifecycle
-- transitions, the 16 substrate steps, and terminal verdicts. The registry row
-- (migration 900) REMAINS the single authority for state; this table is
-- replayable narrative and a cursor source, never authority. On any
-- disagreement the row wins — enforced by the stream's snapshot frame, which
-- is read from the row on every connect.
--
-- WHY per-user seq AND NOT BIGSERIAL
-- A BIGSERIAL value is handed out before commit, so writer A can hold 100
-- while B holds 101 and commits first; a tailing reader that has seen 101
-- never sees 100. That two-writer race is real here: the reconcile retry can
-- overlap a live provision. Per-user seq computed inside one
-- INSERT ... SELECT COALESCE(MAX(seq),0)+1 with PRIMARY KEY (user_id, seq)
-- makes the race fail loudly (the writer retries once) instead of silently
-- skipping a frame. It also keeps the cursor legible — "step 9 of your
-- setup" — rather than a global row id that leaks fleet volume.
--
-- NO idempotency key, deliberately. A UNIQUE over (attempt, stage, step)
-- silently destroys any legitimately repeating event under a fail-safe writer
-- that swallows rejections. Presence (sleeping/waking) never enters this
-- table at all, so the repeating-event case this would guard against does not
-- exist; provisioning-retry duplicates are distinguished by `attempt`,
-- incremented by the reconcile worker.
-- ============================================================================

CREATE TABLE IF NOT EXISTS pod_lifecycle_events (
  user_id         TEXT        NOT NULL,
  seq             BIGINT      NOT NULL,          -- per-user, gap-free. THE cursor.
  hushh_id        TEXT,
  attempt         INT         NOT NULL DEFAULT 1,
  event           TEXT        NOT NULL,          -- stage | substrate_step | terminal
  stage           TEXT        NOT NULL,          -- vocabulary shared with trace_pod_journey.py
  registry_status TEXT        NOT NULL,          -- what AUTHORITY said when this row was written
  progress_pct    SMALLINT    NOT NULL DEFAULT 0,
  substrate_step  TEXT,                          -- one of the 16 bootstrap step ids
  step_ok         BOOLEAN,
  terminal        BOOLEAN     NOT NULL DEFAULT FALSE,
  reason          TEXT,                          -- closed enum; never exception text
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT now() + interval '30 days',
  PRIMARY KEY (user_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_pod_lifecycle_expiry
  ON pod_lifecycle_events (expires_at);

-- ----------------------------------------------------------------------------
-- Doorbell, never data. A NOTIFY payload is readable by any session that can
-- LISTEN and is capped at 8000 bytes; the listener re-reads the actual rows by
-- cursor. Same shape as migration 011's consent_audit trigger.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION pod_lifecycle_notify()
RETURNS TRIGGER AS $$
DECLARE
  payload TEXT;
BEGIN
  payload := json_build_object('user_id', NEW.user_id, 'seq', NEW.seq)::TEXT;
  PERFORM pg_notify('pod_lifecycle_new', payload);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pod_lifecycle_after_insert ON pod_lifecycle_events;
CREATE TRIGGER pod_lifecycle_after_insert
  AFTER INSERT ON pod_lifecycle_events
  FOR EACH ROW
  EXECUTE FUNCTION pod_lifecycle_notify();

COMMENT ON TABLE pod_lifecycle_events IS
  'Append-only provisioning narrative. The registry row is authority; this is replayable narrative and the stream cursor source. 30-day retention via expires_at.';

-- ----------------------------------------------------------------------------
-- The registry status column becomes a closed set, and `reaped` joins it.
--
-- `status` has been free text since migration 900, so a typo in any of the
-- four writers is undetectable until a reader misroutes on it. `reaped` is a
-- correctness fix, not a nicety: today a reaped pod's row stays `provisioned`
-- and /status reports a healthy agent for a host that does not exist.
--
-- NOT VALID first, then VALIDATE: existing rows are checked in a second step
-- so a single historical oddity cannot brick the migration half-applied.
-- ----------------------------------------------------------------------------

ALTER TABLE personal_agent_registry
  DROP CONSTRAINT IF EXISTS personal_agent_registry_status_check;

ALTER TABLE personal_agent_registry
  ADD CONSTRAINT personal_agent_registry_status_check
  -- The REGISTRY vocabulary, exactly. `reserved` is deliberately absent: it is a
  -- CLIENT state (_STATE_BY_REGISTRY_STATUS maps unprovisioned/pending onto it)
  -- and has never been written to this column. Admitting it here would let a
  -- future writer confuse the two vocabularies the mapping exists to separate.
  CHECK (status IN (
    'unprovisioned',
    'pending',
    'provisioning',
    'connecting',
    'provisioned',
    'provisioning_failed',
    'reaped'
  )) NOT VALID;

ALTER TABLE personal_agent_registry
  VALIDATE CONSTRAINT personal_agent_registry_status_check;
