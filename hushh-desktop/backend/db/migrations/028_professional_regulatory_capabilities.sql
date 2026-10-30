BEGIN;

ALTER TABLE ria_profiles
  ADD COLUMN IF NOT EXISTS requested_capabilities TEXT[] NOT NULL DEFAULT ARRAY['advisory']::text[],
  ADD COLUMN IF NOT EXISTS advisory_status TEXT NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS brokerage_status TEXT NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS advisory_provider TEXT,
  ADD COLUMN IF NOT EXISTS brokerage_provider TEXT,
  ADD COLUMN IF NOT EXISTS advisory_verification_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS brokerage_verification_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS individual_legal_name TEXT,
  ADD COLUMN IF NOT EXISTS individual_crd TEXT,
  ADD COLUMN IF NOT EXISTS advisory_firm_legal_name TEXT,
  ADD COLUMN IF NOT EXISTS advisory_firm_iapd_number TEXT,
  ADD COLUMN IF NOT EXISTS broker_firm_legal_name TEXT,
  ADD COLUMN IF NOT EXISTS broker_firm_crd TEXT;

UPDATE ria_profiles
SET
  requested_capabilities = ARRAY['advisory']::text[],
  advisory_status = CASE verification_status
    WHEN 'finra_verified' THEN 'verified'
    ELSE verification_status
  END,
  advisory_provider = CASE verification_provider
    WHEN 'finra' THEN 'iapd'
    ELSE verification_provider
  END,
  advisory_verification_expires_at = COALESCE(advisory_verification_expires_at, verification_expires_at),
  individual_legal_name = COALESCE(individual_legal_name, legal_name),
  individual_crd = COALESCE(individual_crd, finra_crd)
WHERE TRUE;

UPDATE ria_profiles rp
SET
  advisory_firm_legal_name = COALESCE(rp.advisory_firm_legal_name, source.legal_name),
  advisory_firm_iapd_number = COALESCE(rp.advisory_firm_iapd_number, source.sec_iard)
FROM (
  SELECT DISTINCT ON (m.ria_profile_id)
    m.ria_profile_id,
    f.legal_name,
    f.sec_iard
  FROM ria_firm_memberships m
  JOIN ria_firms f ON f.id = m.firm_id
  ORDER BY m.ria_profile_id, m.is_primary DESC, m.id ASC
) AS source
WHERE source.ria_profile_id = rp.id;

UPDATE ria_profiles
SET verification_status = CASE verification_status
  WHEN 'finra_verified' THEN 'verified'
  ELSE verification_status
END,
verification_provider = CASE verification_provider
  WHEN 'finra' THEN 'iapd'
  ELSE verification_provider
END
WHERE verification_status = 'finra_verified'
   OR verification_provider = 'finra';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ria_profiles_verification_status_check'
  ) THEN
    ALTER TABLE ria_profiles DROP CONSTRAINT ria_profiles_verification_status_check;
  END IF;
END $$;

ALTER TABLE ria_profiles
  ADD CONSTRAINT ria_profiles_verification_status_check
  CHECK (verification_status IN ('draft', 'submitted', 'verified', 'active', 'rejected', 'bypassed'));

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ria_profiles_requested_capabilities_check'
  ) THEN
    ALTER TABLE ria_profiles DROP CONSTRAINT ria_profiles_requested_capabilities_check;
  END IF;
END $$;

ALTER TABLE ria_profiles
  ADD CONSTRAINT ria_profiles_requested_capabilities_check
  CHECK (
    requested_capabilities <@ ARRAY['advisory', 'brokerage']::text[]
    AND cardinality(requested_capabilities) > 0
  );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ria_profiles_advisory_status_check'
  ) THEN
    ALTER TABLE ria_profiles DROP CONSTRAINT ria_profiles_advisory_status_check;
  END IF;
END $$;

ALTER TABLE ria_profiles
  ADD CONSTRAINT ria_profiles_advisory_status_check
  CHECK (advisory_status IN ('draft', 'submitted', 'verified', 'active', 'rejected', 'bypassed'));

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ria_profiles_brokerage_status_check'
  ) THEN
    ALTER TABLE ria_profiles DROP CONSTRAINT ria_profiles_brokerage_status_check;
  END IF;
END $$;

ALTER TABLE ria_profiles
  ADD CONSTRAINT ria_profiles_brokerage_status_check
  CHECK (brokerage_status IN ('draft', 'submitted', 'verified', 'active', 'rejected', 'bypassed'));

CREATE INDEX IF NOT EXISTS idx_ria_profiles_advisory_status
  ON ria_profiles(advisory_status);

CREATE INDEX IF NOT EXISTS idx_ria_profiles_brokerage_status
  ON ria_profiles(brokerage_status);

ALTER TABLE ria_verification_events
  ADD COLUMN IF NOT EXISTS capability TEXT NOT NULL DEFAULT 'advisory';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ria_verification_events_outcome_check'
  ) THEN
    ALTER TABLE ria_verification_events DROP CONSTRAINT ria_verification_events_outcome_check;
  END IF;
END $$;

ALTER TABLE ria_verification_events
  ADD CONSTRAINT ria_verification_events_outcome_check
  CHECK (outcome IN (
    'verified',
    'rejected',
    'provider_unavailable',
    'manual_override',
    'bypassed',
    'evidence_only'
  ));

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ria_verification_events_capability_check'
  ) THEN
    ALTER TABLE ria_verification_events DROP CONSTRAINT ria_verification_events_capability_check;
  END IF;
END $$;

ALTER TABLE ria_verification_events
  ADD CONSTRAINT ria_verification_events_capability_check
  CHECK (capability IN ('advisory', 'brokerage'));

ALTER TABLE advisor_investor_relationships
  ADD COLUMN IF NOT EXISTS acting_as TEXT NOT NULL DEFAULT 'advisory';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'advisor_investor_relationships_acting_as_check'
  ) THEN
    ALTER TABLE advisor_investor_relationships DROP CONSTRAINT advisor_investor_relationships_acting_as_check;
  END IF;
END $$;

ALTER TABLE advisor_investor_relationships
  ADD CONSTRAINT advisor_investor_relationships_acting_as_check
  CHECK (acting_as IN ('advisory', 'brokerage'));

COMMIT;
