-- UAT-only acceptance of legacy erasures for re-enrollment (migration 437).
-- The release manifest confines this overlay to the attested UAT database.
-- Owners whose legacy erasure kept their external identity can start fresh;
-- every other history stays Action required. Settled rows no longer qualify,
-- so each replayed release settles only rows that have qualified since.
BEGIN;

SELECT count(*) FILTER (WHERE public.settle_legacy_account_generation(legacy.identity_hash)) AS settled
FROM (
  SELECT generation_row.identity_hash
  FROM public.account_generations generation_row
  JOIN public.account_deletion_tombstones erasure ON erasure.user_id_hash=generation_row.owner_hash
  WHERE generation_row.retired_at IS NOT NULL AND generation_row.generation=0
    AND generation_row.cleanup_operation IS NULL AND generation_row.cleanup_confirmed IS FALSE
    AND erasure.provider_cleanup_id IS NULL
    AND erasure.cleanup_last_classification IN ('firebase_shared_identity_retained','uat_backend_only_erasure')
  ORDER BY generation_row.identity_hash
) legacy;

COMMIT;
