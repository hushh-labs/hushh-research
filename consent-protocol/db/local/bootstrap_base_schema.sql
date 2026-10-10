-- Local-development bootstrap for tables the migration set does not create.
--
-- WHY THIS FILE EXISTS
--
-- `db/migrations/` starts at 003. Nothing in the repository creates
-- `consent_audit` or `users`, and `feed_events` (migration 117) has a trigger
-- that reads `consent_audit`, so it cannot be created either. On a deployed
-- environment those tables come from the Supabase base schema, which is
-- provisioned outside this repository. The practical consequence is that a
-- complete database CANNOT be built from a fresh clone, and a developer who
-- applies every migration to an empty PostgreSQL still ends up without them.
--
-- This file closes that gap for LOCAL DEVELOPMENT ONLY so the stack can run
-- against an isolated database. It is not a migration, it is not in the
-- release manifest, and it must never run against dev, UAT or production --
-- those already have these tables, with the authoritative column sets.
--
-- Column shapes follow `db/offline_schema.sql`, which is generated from UAT,
-- so they match what the code expects. Where that generated schema is SQLite,
-- the types are mapped to their PostgreSQL equivalents.
--
-- Usage:
--   psql -d <local-db> -f db/local/bootstrap_base_schema.sql
--   then apply db/migrations/*.sql in numeric order (repeat until stable;
--   some early migrations depend on tables later ones create).

BEGIN;

-- The account row the rest of the schema keys against.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT,
  display_name TEXT,
  photo_url TEXT,
  phone_number TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Consent lifecycle authority. `feed_events` fans out from this table, and
-- the information-request lane writes REQUESTED / CONSENT_GRANTED /
-- CONSENT_DENIED / REVOKED / TIMEOUT / CANCELLED here.
CREATE TABLE IF NOT EXISTS consent_audit (
  id BIGSERIAL PRIMARY KEY,
  token_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  action TEXT NOT NULL,
  issued_at BIGINT NOT NULL,
  expires_at BIGINT,
  revoked_at BIGINT,
  metadata JSONB,
  token_type TEXT,
  ip_address TEXT,
  user_agent TEXT,
  request_id TEXT,
  scope_description TEXT,
  poll_timeout_at BIGINT
);

DO $$
BEGIN
  IF to_regclass('public.idx_consent_audit_user') IS NULL THEN
    CREATE INDEX idx_consent_audit_user ON consent_audit (user_id, issued_at DESC);
  END IF;
  IF to_regclass('public.idx_consent_audit_token') IS NULL THEN
    CREATE INDEX idx_consent_audit_token ON consent_audit (token_id);
  END IF;
END $$;

COMMIT;
