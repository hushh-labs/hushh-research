-- Migration 026: split internal/self access activity from external consent ledger

CREATE TABLE IF NOT EXISTS internal_access_events (
    id SERIAL PRIMARY KEY,
    token_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    action TEXT NOT NULL,
    issued_at BIGINT NOT NULL,
    expires_at BIGINT,
    revoked_at BIGINT,
    metadata JSONB,
    token_type VARCHAR(20) DEFAULT 'internal',
    request_id VARCHAR(32),
    scope_description TEXT
);

CREATE INDEX IF NOT EXISTS idx_internal_access_events_user_id
    ON internal_access_events(user_id);
CREATE INDEX IF NOT EXISTS idx_internal_access_events_user_action
    ON internal_access_events(user_id, action);
CREATE INDEX IF NOT EXISTS idx_internal_access_events_issued_at
    ON internal_access_events(issued_at DESC);
CREATE INDEX IF NOT EXISTS idx_internal_access_events_user_scope_agent
    ON internal_access_events(user_id, agent_id, scope, issued_at DESC);
