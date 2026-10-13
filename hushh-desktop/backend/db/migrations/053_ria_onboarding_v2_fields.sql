BEGIN;

-- Onboarding v2: license-first prepopulation fields on ria_profiles
ALTER TABLE ria_profiles
  ADD COLUMN IF NOT EXISTS license_number TEXT,
  ADD COLUMN IF NOT EXISTS regulator TEXT,
  ADD COLUMN IF NOT EXISTS regulator_status TEXT,
  ADD COLUMN IF NOT EXISTS license_expiry_date DATE,
  ADD COLUMN IF NOT EXISTS certifications TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS onboarding_type TEXT NOT NULL DEFAULT 'individual',
  ADD COLUMN IF NOT EXISTS services_offered TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS fee_structure TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS min_engagement_amount NUMERIC,
  ADD COLUMN IF NOT EXISTS min_engagement_currency TEXT DEFAULT 'USD';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ria_profiles_onboarding_type_check'
  ) THEN
    ALTER TABLE ria_profiles DROP CONSTRAINT ria_profiles_onboarding_type_check;
  END IF;
END $$;

ALTER TABLE ria_profiles
  ADD CONSTRAINT ria_profiles_onboarding_type_check
  CHECK (onboarding_type IN ('individual', 'firm'));

CREATE INDEX IF NOT EXISTS idx_ria_profiles_license_number
  ON ria_profiles(license_number)
  WHERE license_number IS NOT NULL;

-- Business contact / address (1:1 with ria_profiles via user_id)
CREATE TABLE IF NOT EXISTS ria_business_contacts (
  user_id TEXT PRIMARY KEY REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  email TEXT,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  phone TEXT,
  phone_verified BOOLEAN NOT NULL DEFAULT FALSE,
  city TEXT,
  area_locality TEXT,
  full_street_address TEXT,
  pin_zip TEXT,
  country_code TEXT DEFAULT 'US',
  latitude NUMERIC,
  longitude NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ria_business_contacts_city
  ON ria_business_contacts(city)
  WHERE city IS NOT NULL;

-- License verification audit trail
CREATE TABLE IF NOT EXISTS ria_license_verifications (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  license_number TEXT NOT NULL,
  regulator TEXT,
  verification_source TEXT NOT NULL,
  raw_response JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ria_license_verifications_status_check'
  ) THEN
    ALTER TABLE ria_license_verifications DROP CONSTRAINT ria_license_verifications_status_check;
  END IF;
END $$;

ALTER TABLE ria_license_verifications
  ADD CONSTRAINT ria_license_verifications_status_check
  CHECK (status IN ('pending', 'completed', 'failed', 'partial'));

CREATE INDEX IF NOT EXISTS idx_ria_license_verifications_license
  ON ria_license_verifications(license_number);

CREATE INDEX IF NOT EXISTS idx_ria_license_verifications_user
  ON ria_license_verifications(user_id);

COMMIT;
