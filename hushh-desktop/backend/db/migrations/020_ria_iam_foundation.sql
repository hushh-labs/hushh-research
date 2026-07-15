-- Migration 020: RIA + Investor IAM foundation tables
-- ================================================
-- Adds actor/persona, RIA verification, firm memberships,
-- marketplace projections, relationship lifecycle, and consent scope templates.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS actor_profiles (
  user_id TEXT PRIMARY KEY REFERENCES vault_keys(user_id) ON DELETE CASCADE,
  personas TEXT[] NOT NULL DEFAULT ARRAY['investor'],
  last_active_persona TEXT NOT NULL DEFAULT 'investor',
  investor_marketplace_opt_in BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT actor_profiles_persona_values_check
    CHECK (personas <@ ARRAY['investor','ria']),
  CONSTRAINT actor_profiles_last_persona_check
    CHECK (last_active_persona IN ('investor', 'ria')),
  CONSTRAINT actor_profiles_last_in_personas_check
    CHECK (last_active_persona = ANY(personas))
);

CREATE INDEX IF NOT EXISTS idx_actor_profiles_personas
  ON actor_profiles USING GIN(personas);

CREATE INDEX IF NOT EXISTS idx_actor_profiles_marketplace_opt_in
  ON actor_profiles(investor_marketplace_opt_in)
  WHERE investor_marketplace_opt_in = TRUE;

INSERT INTO actor_profiles (user_id, personas, last_active_persona, investor_marketplace_opt_in)
SELECT user_id, ARRAY['investor'], 'investor', FALSE
FROM vault_keys
ON CONFLICT (user_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS ria_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL UNIQUE REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  legal_name TEXT,
  finra_crd TEXT,
  sec_iard TEXT,
  verification_status TEXT NOT NULL DEFAULT 'draft',
  verification_provider TEXT,
  verification_expires_at TIMESTAMPTZ,
  bio TEXT,
  strategy TEXT,
  disclosures_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ria_profiles_verification_status_check
    CHECK (verification_status IN ('draft', 'submitted', 'finra_verified', 'active', 'rejected'))
);

CREATE INDEX IF NOT EXISTS idx_ria_profiles_verification_status
  ON ria_profiles(verification_status);

CREATE INDEX IF NOT EXISTS idx_ria_profiles_display_name
  ON ria_profiles(display_name);

CREATE TABLE IF NOT EXISTS ria_firms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name TEXT NOT NULL,
  finra_firm_crd TEXT,
  sec_iard TEXT,
  website_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ria_firms_legal_name_unique UNIQUE (legal_name)
);

CREATE TABLE IF NOT EXISTS ria_firm_memberships (
  id BIGSERIAL PRIMARY KEY,
  ria_profile_id UUID NOT NULL REFERENCES ria_profiles(id) ON DELETE CASCADE,
  firm_id UUID NOT NULL REFERENCES ria_firms(id) ON DELETE CASCADE,
  role_title TEXT,
  membership_status TEXT NOT NULL DEFAULT 'pending',
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ria_firm_memberships_status_check
    CHECK (membership_status IN ('pending', 'active', 'inactive')),
  CONSTRAINT ria_firm_memberships_unique UNIQUE (ria_profile_id, firm_id)
);

CREATE INDEX IF NOT EXISTS idx_ria_firm_memberships_ria_profile
  ON ria_firm_memberships(ria_profile_id);

CREATE INDEX IF NOT EXISTS idx_ria_firm_memberships_firm
  ON ria_firm_memberships(firm_id);

CREATE TABLE IF NOT EXISTS ria_verification_events (
  id BIGSERIAL PRIMARY KEY,
  ria_profile_id UUID NOT NULL REFERENCES ria_profiles(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  outcome TEXT NOT NULL,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  reference_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ria_verification_events_outcome_check
    CHECK (outcome IN ('verified', 'rejected', 'provider_unavailable', 'manual_override'))
);

CREATE INDEX IF NOT EXISTS idx_ria_verification_events_profile_checked
  ON ria_verification_events(ria_profile_id, checked_at DESC);

CREATE TABLE IF NOT EXISTS advisor_investor_relationships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  investor_user_id TEXT NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  ria_profile_id UUID NOT NULL REFERENCES ria_profiles(id) ON DELETE CASCADE,
  firm_id UUID REFERENCES ria_firms(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'discovered',
  last_request_id TEXT,
  granted_scope TEXT,
  consent_granted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT advisor_investor_relationships_status_check
    CHECK (
      status IN (
        'discovered',
        'request_pending',
        'approved',
        'revoked',
        'expired',
        'blocked',
        'disconnected'
      )
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_advisor_investor_relationships_no_firm
  ON advisor_investor_relationships(investor_user_id, ria_profile_id)
  WHERE firm_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_advisor_investor_relationships_with_firm
  ON advisor_investor_relationships(investor_user_id, ria_profile_id, firm_id)
  WHERE firm_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_advisor_investor_relationships_status
  ON advisor_investor_relationships(status);

CREATE TABLE IF NOT EXISTS consent_scope_templates (
  template_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 1,
  requester_actor_type TEXT NOT NULL,
  subject_actor_type TEXT NOT NULL,
  template_name TEXT NOT NULL,
  description TEXT,
  allowed_scopes TEXT[] NOT NULL,
  default_duration_hours INTEGER NOT NULL,
  max_duration_hours INTEGER NOT NULL DEFAULT 8760,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT consent_scope_templates_actor_check
    CHECK (
      requester_actor_type IN ('ria', 'investor')
      AND subject_actor_type IN ('ria', 'investor')
    ),
  CONSTRAINT consent_scope_templates_duration_check
    CHECK (
      default_duration_hours > 0
      AND max_duration_hours > 0
      AND default_duration_hours <= max_duration_hours
    )
);

CREATE INDEX IF NOT EXISTS idx_consent_scope_templates_direction
  ON consent_scope_templates(requester_actor_type, subject_actor_type)
  WHERE active = TRUE;

INSERT INTO consent_scope_templates (
  template_id,
  version,
  requester_actor_type,
  subject_actor_type,
  template_name,
  description,
  allowed_scopes,
  default_duration_hours,
  max_duration_hours,
  active
)
VALUES
  (
    'ria_financial_summary_v1',
    1,
    'ria',
    'investor',
    'RIA financial summary',
    'Advisory access to investor financial summary and portfolio profile domains.',
    ARRAY['attr.financial.*', 'world_model.read'],
    168,
    8760,
    TRUE
  ),
  (
    'ria_risk_profile_v1',
    1,
    'ria',
    'investor',
    'RIA risk profile',
    'Advisory access to investor risk and professional preference profiles.',
    ARRAY['attr.financial.risk.*', 'attr.professional.*'],
    168,
    8760,
    TRUE
  ),
  (
    'investor_advisor_disclosure_v1',
    1,
    'investor',
    'ria',
    'Investor advisor disclosure access',
    'Investor access request to advisor public disclosure and strategy summary.',
    ARRAY['attr.ria.disclosures.*', 'attr.ria.strategy.*'],
    168,
    8760,
    TRUE
  )
ON CONFLICT (template_id) DO UPDATE
SET
  version = EXCLUDED.version,
  requester_actor_type = EXCLUDED.requester_actor_type,
  subject_actor_type = EXCLUDED.subject_actor_type,
  template_name = EXCLUDED.template_name,
  description = EXCLUDED.description,
  allowed_scopes = EXCLUDED.allowed_scopes,
  default_duration_hours = EXCLUDED.default_duration_hours,
  max_duration_hours = EXCLUDED.max_duration_hours,
  active = EXCLUDED.active,
  updated_at = NOW();

CREATE TABLE IF NOT EXISTS marketplace_public_profiles (
  user_id TEXT PRIMARY KEY REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  profile_type TEXT NOT NULL,
  display_name TEXT NOT NULL,
  headline TEXT,
  location_hint TEXT,
  strategy_summary TEXT,
  verification_badge TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_discoverable BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT marketplace_public_profiles_type_check
    CHECK (profile_type IN ('investor', 'ria'))
);

CREATE INDEX IF NOT EXISTS idx_marketplace_public_profiles_discoverable
  ON marketplace_public_profiles(profile_type, is_discoverable)
  WHERE is_discoverable = TRUE;

CREATE INDEX IF NOT EXISTS idx_marketplace_public_profiles_display_name
  ON marketplace_public_profiles(display_name);

COMMIT;
