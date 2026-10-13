-- Purpose-limited authorization, not a profile or findings store.
CREATE TABLE IF NOT EXISTS pwm_claim_invitations (
    id UUID PRIMARY KEY,
    inviter_user_id TEXT NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    contact_commitment TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','claimed','revoked')),
    recipient_user_id TEXT REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days',
    claimed_at TIMESTAMPTZ,
    consent_version TEXT,
    CHECK ((state = 'claimed') = (recipient_user_id IS NOT NULL AND claimed_at IS NOT NULL AND consent_version IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS pwm_claim_invitations_owner ON pwm_claim_invitations(inviter_user_id, created_at);
COMMENT ON TABLE pwm_claim_invitations IS 'PWM invitation authorization only; hashed token and keyed contact commitment; no biography, raw contact or findings. Delete on owner reset/deletion; expire after seven days.';

DO $$ BEGIN
  IF to_regprocedure('install_account_deletion_write_guards()') IS NOT NULL THEN
    PERFORM install_account_deletion_write_guards();
  END IF;
END $$;
