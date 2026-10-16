-- Independent email login state. No vault/PKM information or raw OTP is stored.
BEGIN;

CREATE TABLE IF NOT EXISTS email_auth_policy_state (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    policy_version TEXT NOT NULL,
    risk_version TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS email_auth_domain_decisions (
    domain TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('pending','approved','denied','revoked')),
    reason TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    risk_version TEXT NOT NULL,
    generation BIGINT NOT NULL DEFAULT 0,
    certificate_status TEXT NOT NULL DEFAULT 'not_checked',
    review_id TEXT,
    lease_until TIMESTAMPTZ,
    checked_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS email_auth_budgets (
    budget_key TEXT PRIMARY KEY,
    count INTEGER NOT NULL CHECK (count > 0),
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS email_auth_enrollments (
    destination_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('provisional','active')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS email_auth_challenges (
    challenge_id TEXT PRIMARY KEY,
    destination_hash TEXT NOT NULL,
    domain TEXT NOT NULL REFERENCES email_auth_domain_decisions(domain),
    decision_generation BIGINT NOT NULL,
    browser_hash TEXT NOT NULL,
    request_key TEXT NOT NULL,
    verifier TEXT NOT NULL,
    verifier_version TEXT NOT NULL,
    payload TEXT,
    destination_ciphertext TEXT,
    payload_version TEXT NOT NULL,
    expected_uid TEXT,
    enrollment_ticket_hash TEXT,
    enrollment_finalized_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    expires_at TIMESTAMPTZ NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
    consumed_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    delivery_state TEXT NOT NULL DEFAULT 'queued'
        CHECK (delivery_state IN ('queued','leased','accepted','failed','cancelled')),
    lease_until TIMESTAMPTZ,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    delivery_lease_id TEXT,
    UNIQUE(destination_hash, browser_hash, request_key)
);
CREATE INDEX IF NOT EXISTS email_auth_challenge_destination_idx
    ON email_auth_challenges(destination_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS email_auth_delivery_idx
    ON email_auth_challenges(next_attempt_at) WHERE delivery_state IN ('queued','leased');
CREATE INDEX IF NOT EXISTS email_auth_budget_expiry_idx ON email_auth_budgets(expires_at);
CREATE INDEX IF NOT EXISTS email_auth_challenge_expiry_idx ON email_auth_challenges(expires_at);

-- Restrict grants through the environment's existing application DB role.
REVOKE ALL ON email_auth_policy_state, email_auth_domain_decisions, email_auth_budgets,
    email_auth_enrollments, email_auth_challenges FROM PUBLIC;

-- Extend the canonical deletion guards to the new Firebase UID binding.
-- Ordered releases include migration 201; isolated migration fixtures may not.
DO $$
BEGIN
    IF to_regprocedure('public.install_account_deletion_write_guards()') IS NOT NULL THEN
        PERFORM public.install_account_deletion_write_guards();
    END IF;
END;
$$;
COMMIT;
