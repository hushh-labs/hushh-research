BEGIN;

DROP FUNCTION IF EXISTS public.commit_pkm_domain_mutation_v5(
  TEXT, TEXT, INTEGER, INTEGER, JSONB, JSONB, JSONB, JSONB, JSONB, JSONB,
  BOOLEAN, TEXT[], JSONB, UUID, TEXT, JSONB, JSONB, TEXT, JSONB
);

DROP TABLE IF EXISTS one_location_pkm_finalize_authorizations;
DROP TABLE IF EXISTS one_location_onboarding_drafts;
DROP TABLE IF EXISTS one_location_onboarding_receipts;
DROP TABLE IF EXISTS one_location_onboarding_interactions;

ALTER TABLE IF EXISTS one_capability_runs
  DROP CONSTRAINT IF EXISTS one_capability_runs_run_owner_unique;

COMMIT;
