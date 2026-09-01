-- Server-verified WebAuthn / FIDO2 credential store + one-time challenge store (M14).
--
-- PARKED (unapplied, flag-off): 900-band, out of the active migration sequence, not
-- in db/release_migration_manifest.json, so it is never applied until the WebAuthn
-- feature is greenlit; at that point it is renumbered into sequence and manifested.
-- The high band keeps it from colliding with main's fast-moving migration head.
--
-- Gated by WEBAUTHN_ENABLED. This is the credential public-key store the existing
-- client-side PRF vault-unlock flow never had -- the foundation for passkey/hardware-
-- key LOGIN + step-up (docs/future/identity-assurance/README.md). Non-breaking +
-- idempotent; touches no existing table.

BEGIN;

CREATE TABLE IF NOT EXISTS webauthn_credentials (
    id              BIGSERIAL PRIMARY KEY,
    user_id         TEXT NOT NULL,
    credential_id   TEXT NOT NULL UNIQUE,   -- base64url credential id
    public_key      TEXT NOT NULL,          -- base64url COSE public key
    sign_count      BIGINT NOT NULL DEFAULT 0,
    aaguid          TEXT,                   -- authenticator model (AAL/attestation policy)
    device_type     TEXT,                   -- single_device | multi_device
    backed_up       BOOLEAN,
    rp_id           TEXT NOT NULL,
    device_label    TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_webauthn_credentials_user
    ON webauthn_credentials(user_id);

-- One-time, short-TTL challenges, consumed by value (works for usernameless auth).
CREATE TABLE IF NOT EXISTS webauthn_challenges (
    id              BIGSERIAL PRIMARY KEY,
    user_id         TEXT,                   -- NULL for usernameless authentication
    challenge       TEXT NOT NULL,          -- base64url
    ceremony        TEXT NOT NULL,          -- registration | authentication
    rp_id           TEXT NOT NULL,
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_webauthn_challenges_challenge
    ON webauthn_challenges(challenge);
CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_expires
    ON webauthn_challenges(expires_at);

COMMENT ON TABLE webauthn_credentials IS
    'Server-verified WebAuthn/FIDO2 credential public keys (passkeys + hardware keys). sign_count catches cloned authenticators; aaguid drives AAL/attestation policy. Gated by WEBAUTHN_ENABLED. M14.';
COMMENT ON COLUMN webauthn_credentials.aaguid IS
    'Authenticator model id (e.g. a Google Titan / YubiKey AAGUID) for attestation + enterprise allow-list / AAL3 policy.';

COMMIT;
