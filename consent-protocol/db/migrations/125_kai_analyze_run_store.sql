BEGIN;

-- Coarse terminal checkpoint for resumable Kai analyze ("debate") runs.
--
-- Resumable analyze is two requests: POST /api/kai/analyze/run/start creates an
-- in-memory run on one Cloud Run instance, then GET /api/kai/analyze/run/{id}/
-- stream may land on a DIFFERENT instance that never saw the run -> today it
-- 404s (the prod multi-instance parity bug). This table lets the /stream miss
-- path read through to a durable terminal checkpoint and replay the terminal
-- DecisionCard instead of 404ing.
--
-- Coarse by design: exactly ONE row per run, written ONCE at the terminal
-- transition (completed / failed / canceled) -- never per streamed frame. Debate
-- frames are per-token; a per-frame write would issue hundreds of INSERTs per
-- run against a pool pinned to DB_SQLALCHEMY_MAX_OVERFLOW=0 (migration-era fix
-- #4736) and reintroduce connection-slot starvation. This stores the terminal
-- SSE envelope payload only.
--
-- Contains NO vault secrets, vault keys, consent-export keys, or PKM plaintext.
-- terminal_payload is the DecisionCard envelope already streamed to the client.
-- Gated at runtime by KAI_ANALYZE_DURABLE_RUN_STORE (default OFF); the table is
-- inert until the flag is enabled.

CREATE TABLE IF NOT EXISTS kai_analyze_runs (
  run_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  debate_session_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  risk_profile TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('completed', 'failed', 'canceled')),
  terminal_event TEXT,
  terminal_payload TEXT NOT NULL DEFAULT '{}',
  started_at_iso TEXT,
  completed_at_iso TEXT,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_kai_analyze_runs_expiry
  ON kai_analyze_runs (expires_at);

COMMENT ON TABLE kai_analyze_runs IS
  'Coarse terminal checkpoint for resumable Kai analyze (debate) runs; cross-Cloud-Run-instance DecisionCard recovery. One row per run, written once at terminal transition. No per-frame events, no vault/PKM secrets.';

COMMIT;
