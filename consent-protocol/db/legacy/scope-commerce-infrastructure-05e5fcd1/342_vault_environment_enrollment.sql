-- Connect lists a stranger only after they have used THIS environment.
-- A database copied from another environment (dev from UAT on 2026-07-10,
-- production from UAT on 2026-07-28) carries active vaults for people who never
-- signed in here, and an active vault alone cannot tell them apart.
-- The stamp is set the first time the person unlocks their vault here; the
-- backfill uses only this environment's own unlock ledger, inside a window that
-- starts after every known restore, so a copied ledger row never counts.
BEGIN;

ALTER TABLE public.vault_keys
  ADD COLUMN IF NOT EXISTS environment_enrolled_at TIMESTAMPTZ;

COMMENT ON COLUMN public.vault_keys.environment_enrolled_at IS
  'First vault unlock in this environment. Null means the vault was copied in and never used here; Connect hides such strangers.';

DO $$
DECLARE
  ledger regclass := COALESCE(
    to_regclass('public.internal_access_events'),
    to_regclass('public.consent_audit')
  );
BEGIN
  IF ledger IS NULL THEN
    RETURN;
  END IF;
  EXECUTE format(
    'UPDATE public.vault_keys vault
        SET environment_enrolled_at = to_timestamp(unlocks.first_issued / 1000.0)
       FROM (
         SELECT user_id, MIN(issued_at) AS first_issued
           FROM %s
          WHERE scope = %L
            AND action = %L
            AND issued_at > (EXTRACT(EPOCH FROM now() - interval %L) * 1000)::bigint
          GROUP BY user_id
       ) unlocks
      WHERE vault.user_id = unlocks.user_id
        AND vault.vault_status = %L
        AND vault.environment_enrolled_at IS NULL',
    ledger, 'vault.owner', 'CONSENT_GRANTED', '60 days', 'active'
  );
END $$;

COMMIT;
