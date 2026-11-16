-- Reserve a reviewed request price without manufacturing owner consent.
SELECT pg_advisory_xact_lock(2690001);
LOCK TABLE scope_commerce_purchases IN ACCESS EXCLUSIVE MODE;

DO $migration$
DECLARE
 installed TEXT;
 old_definition TEXT := $old$CHECK ((status = ANY (ARRAY['awaiting_payment'::text, 'reserved'::text, 'preparing'::text, 'staged'::text, 'revoked'::text, 'expired'::text])))$old$;
 new_definition TEXT := $new$CHECK ((status = ANY (ARRAY['awaiting_payment'::text, 'awaiting_owner'::text, 'reserved'::text, 'preparing'::text, 'staged'::text, 'revoked'::text, 'expired'::text])))$new$;
BEGIN
 SELECT pg_get_constraintdef(oid) INTO installed
 FROM pg_constraint WHERE conrelid='scope_commerce_purchases'::regclass
 AND conname='scope_commerce_purchases_status_check' AND convalidated;
 IF installed = old_definition THEN
  ALTER TABLE scope_commerce_purchases DROP CONSTRAINT scope_commerce_purchases_status_check;
  ALTER TABLE scope_commerce_purchases ADD CONSTRAINT scope_commerce_purchases_status_check
   CHECK(status IN ('awaiting_payment','awaiting_owner','reserved','preparing','staged','revoked','expired'));
 ELSIF installed IS DISTINCT FROM new_definition THEN
  RAISE EXCEPTION 'scope commerce purchase status preimage mismatch';
 END IF;
END
$migration$;

-- A funded request waiting for consent cannot carry preparation or access proof.
DO $admission$
DECLARE
 installed TEXT;
 expected TEXT := $definition$CHECK (((status <> 'awaiting_owner'::text) OR ((price_cents > 0) AND (consent_token_hash IS NULL) AND (preparation_id IS NULL) AND (activation_at IS NULL) AND (expires_at IS NULL) AND (staged_export IS NULL))))$definition$;
BEGIN
 SELECT pg_get_constraintdef(oid) INTO installed FROM pg_constraint
 WHERE conrelid='scope_commerce_purchases'::regclass
 AND conname='scope_commerce_upfront_owner_check' AND convalidated;
 IF installed IS NULL AND NOT EXISTS(
  SELECT 1 FROM pg_constraint WHERE conrelid='scope_commerce_purchases'::regclass
  AND conname='scope_commerce_upfront_owner_check'
 ) THEN
  ALTER TABLE scope_commerce_purchases ADD CONSTRAINT scope_commerce_upfront_owner_check
   CHECK(status <> 'awaiting_owner' OR
    (price_cents > 0 AND consent_token_hash IS NULL AND preparation_id IS NULL
     AND activation_at IS NULL AND expires_at IS NULL AND staged_export IS NULL));
 ELSIF installed IS DISTINCT FROM expected THEN
  RAISE EXCEPTION 'scope commerce upfront owner constraint mismatch';
 END IF;
END
$admission$;
