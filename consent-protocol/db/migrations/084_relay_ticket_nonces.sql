-- 084_relay_ticket_nonces.sql
-- Cross-instance one-time nonce registry for signed One voice relay tickets.
--
-- The in-memory nonce guard in api/routes/one/relay_auth.py is per-process,
-- so a signed ticket could be replayed once per gunicorn worker per Cloud Run
-- instance within its 60s window. This table makes single-use enforcement
-- global: consumption is an INSERT .. ON CONFLICT DO NOTHING; a conflicting
-- insert means replay.
--
-- Scale-plane doctrine (AGENTS.md): Postgres now, Redis later. The swap seam
-- is consume_relay_ticket_shared() in relay_auth.py; a Redis SETNX-with-TTL
-- replaces this table without contract changes.

CREATE TABLE IF NOT EXISTS relay_ticket_nonces (
    nonce TEXT PRIMARY KEY,
    expires_at BIGINT NOT NULL
);

-- Pruning scans by expiry.
CREATE INDEX IF NOT EXISTS idx_relay_ticket_nonces_expires_at
    ON relay_ticket_nonces (expires_at);
