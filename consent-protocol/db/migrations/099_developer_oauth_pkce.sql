-- OAuth 2.1 authorization-code + PKCE credentials for developer MCP apps.
-- Raw secrets, authorization codes, and bearer tokens are never persisted.

BEGIN;

CREATE TABLE IF NOT EXISTS developer_oauth_clients (
    app_id TEXT PRIMARY KEY REFERENCES developer_apps(app_id) ON DELETE CASCADE,
    client_id TEXT NOT NULL UNIQUE,
    client_secret_hash TEXT NOT NULL,
    client_secret_prefix TEXT NOT NULL,
    redirect_uris JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at BIGINT NOT NULL,
    secret_rotated_at BIGINT NOT NULL,
    revoked_at BIGINT
);

CREATE TABLE IF NOT EXISTS developer_oauth_authorizations (
    id BIGSERIAL PRIMARY KEY,
    transaction_ref TEXT NOT NULL UNIQUE,
    code_hash TEXT UNIQUE,
    app_id TEXT NOT NULL REFERENCES developer_apps(app_id) ON DELETE CASCADE,
    client_id TEXT NOT NULL REFERENCES developer_oauth_clients(client_id) ON DELETE CASCADE,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    subject_firebase_uid TEXT,
    requested_scope TEXT NOT NULL,
    state TEXT,
    status TEXT NOT NULL,
    expires_at BIGINT NOT NULL,
    created_at BIGINT NOT NULL,
    consumed_at BIGINT,
    CONSTRAINT developer_oauth_authorization_status_check
        CHECK (status IN ('pending', 'issued', 'consumed', 'denied'))
);

CREATE INDEX IF NOT EXISTS idx_developer_oauth_authorizations_code_hash
    ON developer_oauth_authorizations(code_hash) WHERE code_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_developer_oauth_authorizations_transaction
    ON developer_oauth_authorizations(transaction_ref);

CREATE TABLE IF NOT EXISTS developer_oauth_tokens (
    id BIGSERIAL PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    token_prefix TEXT NOT NULL,
    token_kind TEXT NOT NULL,
    app_id TEXT NOT NULL REFERENCES developer_apps(app_id) ON DELETE CASCADE,
    subject_firebase_uid TEXT NOT NULL,
    authorization_id BIGINT REFERENCES developer_oauth_authorizations(id) ON DELETE SET NULL,
    scopes JSONB NOT NULL DEFAULT '["mcp:tools"]'::jsonb,
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL,
    revoked_at BIGINT,
    last_used_at BIGINT,
    CONSTRAINT developer_oauth_token_kind_check CHECK (token_kind IN ('access', 'refresh'))
);

CREATE INDEX IF NOT EXISTS idx_developer_oauth_tokens_active
    ON developer_oauth_tokens(token_hash, token_kind, app_id)
    WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS developer_oauth_audit_events (
    id BIGSERIAL PRIMARY KEY,
    app_id TEXT NOT NULL,
    client_id TEXT,
    subject_firebase_uid TEXT,
    event_type TEXT NOT NULL,
    created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_developer_oauth_audit_events_app_created
    ON developer_oauth_audit_events(app_id, created_at DESC);

COMMENT ON TABLE developer_oauth_clients IS
  'Registered OAuth clients for developer MCP apps. Client secrets are peppered HMAC hashes.';
COMMENT ON TABLE developer_oauth_tokens IS
  'Opaque OAuth access and refresh tokens. Raw values are returned once and are never stored.';

COMMIT;
