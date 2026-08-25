-- Migration 175: consent-safe contact-sync connection provenance
-- ==============================================================
-- A current verified-phone match materializes a connection when the matched
-- account remains contact-discoverable. The account can opt out of future
-- matches through that existing setting; no location or information access is
-- granted by the connection itself.
-- Contact hashes and phone digits are never stored by this migration.

BEGIN;

ALTER TABLE actor_profiles
  ADD COLUMN IF NOT EXISTS contact_sync_consent_enabled_at TIMESTAMPTZ;
ALTER TABLE actor_profiles
  ADD COLUMN IF NOT EXISTS contact_sync_consent_rule_version BIGINT NOT NULL DEFAULT 0;
ALTER TABLE actor_profiles
  ADD COLUMN IF NOT EXISTS contact_sync_consent_contract_version TEXT;
ALTER TABLE actor_profiles
  ALTER COLUMN contact_discoverable SET DEFAULT FALSE;

-- Migration 140's setting defaulted TRUE and disclosed findability only. It
-- cannot be reinterpreted as consent to create a durable relationship. Every
-- legacy row therefore fails closed until the user accepts the combined,
-- versioned contact-sync disclosure.
UPDATE actor_profiles
SET contact_discoverable = FALSE,
    contact_sync_consent_enabled_at = NULL,
    contact_sync_consent_contract_version = NULL,
    updated_at = NOW()
WHERE contact_sync_consent_enabled_at IS NULL
   OR contact_sync_consent_rule_version < 1
   OR contact_sync_consent_contract_version IS DISTINCT FROM 'contact_find_auto_connect_v1';

ALTER TABLE connection_origins
  DROP CONSTRAINT IF EXISTS connection_origins_origin_kind_check;
ALTER TABLE connection_origins
  ADD CONSTRAINT connection_origins_origin_kind_check
  CHECK (origin_kind IN (
    'direct_request',
    'named_circle',
    'circle_member',
    'legacy_invite',
    'import',
    'contact_sync'
  ));

ALTER TABLE connection_origins
  DROP CONSTRAINT IF EXISTS connection_origins_kind_shape;
ALTER TABLE connection_origins
  ADD CONSTRAINT connection_origins_kind_shape CHECK (
    (
      origin_kind = 'named_circle'
      AND source_circle_id IS NOT NULL
      AND origin_key = 'named_circle:' || source_circle_id::text
    )
    OR (
      origin_kind = 'contact_sync'
      AND source_circle_id IS NULL
      AND NULLIF(BTRIM(source_ref), '') IS NOT NULL
      AND origin_key = 'contact_sync:' || source_ref
    )
    OR (
      origin_kind NOT IN ('named_circle', 'contact_sync')
      AND source_circle_id IS NULL
      AND origin_key = origin_kind
    )
  );

CREATE INDEX IF NOT EXISTS idx_connection_origins_active_contact_source
  ON connection_origins (source_ref, connection_id)
  WHERE status = 'active' AND origin_kind = 'contact_sync';

COMMENT ON COLUMN connection_origins.origin_kind IS
  'Why this connection exists. contact_sync is requester-relative verified-phone-match provenance keyed by source_ref; it grants no location or information access.';
COMMENT ON COLUMN actor_profiles.contact_discoverable IS
  'Explicit combined consent for verified phone holders to find and automatically connect with this account; defaults false and grants no location or information access.';
COMMENT ON COLUMN actor_profiles.contact_sync_consent_enabled_at IS
  'Server timestamp when the current combined contact-sync consent began; NULL while disabled or not yet re-consented.';
COMMENT ON COLUMN actor_profiles.contact_sync_consent_rule_version IS
  'Monotonic version incremented on every combined contact-sync consent mutation.';
COMMENT ON COLUMN actor_profiles.contact_sync_consent_contract_version IS
  'Exact authored disclosure accepted by the client; only contact_find_auto_connect_v1 authorizes automatic relationship creation.';

-- Postgres is the shared authority in production today. SlowAPI remains an
-- outer request guard, while this lookup-weighted budget prevents enumeration
-- allowance from multiplying across processes or Cloud Run instances. A future
-- Redis/Memorystore implementation may replace this table behind the service
-- seam without changing the HTTP contract.
CREATE TABLE IF NOT EXISTS contact_sync_lookup_budgets (
  -- No FK on purpose: Firebase-authenticated pre-vault accounts can reach the
  -- route, and abuse policy must not fail through an incidental missing-vault
  -- constraint. AccountService explicitly removes these rows during purge.
  user_id TEXT NOT NULL,
  bucket_kind TEXT NOT NULL CHECK (bucket_kind IN ('minute', 'day')),
  bucket_start TIMESTAMPTZ NOT NULL,
  lookup_count INTEGER NOT NULL CHECK (lookup_count >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, bucket_kind, bucket_start)
);

CREATE INDEX IF NOT EXISTS idx_contact_sync_lookup_budgets_expiry
  ON contact_sync_lookup_budgets (bucket_start);

COMMENT ON TABLE contact_sync_lookup_budgets IS
  'Short-lived lookup counts for the cross-instance contact-sync abuse budget. Contains no contact hashes, digits, or matched identities.';

COMMIT;
