-- One owner-approved Gmail delivery.  OAuth tokens stay exclusively in
-- kai_gmail_connections; this table deliberately contains metadata/HMACs only.

CREATE TABLE IF NOT EXISTS gmail_owner_send_actions (
    action_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES vault_keys(user_id) ON DELETE CASCADE,
    envelope_hmac TEXT NOT NULL,
    idempotency_hmac TEXT NOT NULL,
    recipient_count INTEGER NOT NULL CHECK (recipient_count BETWEEN 1 AND 50),
    state TEXT NOT NULL CHECK (state IN (
        'prepared', 'sending', 'sent', 'failed', 'outcome_unknown', 'expired'
    )),
    expires_at TIMESTAMPTZ NOT NULL,
    sending_at TIMESTAMPTZ,
    sent_at TIMESTAMPTZ,
    gmail_message_id TEXT,
    gmail_thread_id TEXT,
    safe_error_code TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, idempotency_hmac)
);

CREATE INDEX IF NOT EXISTS idx_gmail_owner_send_actions_expiry
    ON gmail_owner_send_actions (expires_at)
    WHERE state = 'prepared';

CREATE INDEX IF NOT EXISTS idx_gmail_owner_send_actions_user_created
    ON gmail_owner_send_actions (user_id, created_at DESC);
