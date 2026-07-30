-- 125_kai_analyze_run_store.sql
--
-- Durable, cross-instance run store for Kai/RIA "debate" analyze streams.
--
-- Background: KaiAnalyzeRunManager (api/routes/kai/run_manager.py) is an
-- in-memory, per-process singleton. On Cloud Run (multiple instances) a
-- reconnect to GET /analyze/run/{run_id}/stream can land on an instance that
-- never created the run and 404s (ANALYZE_RUN_NOT_FOUND). This table is a
-- COARSE checkpoint mirror (start + terminal only, ~2 writes/run) read ONLY on
-- the 404 miss path so a cross-instance reconnect can still receive the final
-- DecisionCard. It intentionally does NOT store per-token frames (that would
-- re-introduce the pool fanout pinned by DB_SQLALCHEMY_MAX_OVERFLOW=0 in #4736).
--
-- Idempotent + REPLAY-safe: the release pipeline re-executes every manifest
-- migration on each deploy (db/migrate.py --migration-mode replay), so this
-- file uses only IF NOT EXISTS guards and no trigger functions (updated_at is
-- maintained by the application layer). No consent token is ever persisted.

CREATE TABLE IF NOT EXISTS kai_analyze_runs (
    run_id             TEXT PRIMARY KEY,
    user_id            TEXT NOT NULL,
    debate_session_id  TEXT,
    ticker             TEXT,
    risk_profile       TEXT,
    status             TEXT NOT NULL DEFAULT 'running',
    terminal_event     TEXT,
    terminal_payload   JSONB,
    started_at         TIMESTAMPTZ,
    completed_at       TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Ownership / active-run lookups are keyed on the user (the run_id read path is
-- already served by the primary key).
CREATE INDEX IF NOT EXISTS idx_kai_analyze_runs_user_session
    ON kai_analyze_runs (user_id, debate_session_id);

-- Supports time-based retention pruning of terminal rows without a full scan.
CREATE INDEX IF NOT EXISTS idx_kai_analyze_runs_updated_at
    ON kai_analyze_runs (updated_at);

COMMENT ON TABLE kai_analyze_runs IS
    'Coarse-checkpoint durable mirror of in-memory Kai analyze runs; read-through on cross-instance 404 only. Flag-gated by KAI_ANALYZE_DURABLE_RUN_STORE.';
COMMENT ON COLUMN kai_analyze_runs.terminal_payload IS
    'Final terminal event payload (e.g. DecisionCard) used to replay a single terminal SSE frame on cross-instance reconnect.';
