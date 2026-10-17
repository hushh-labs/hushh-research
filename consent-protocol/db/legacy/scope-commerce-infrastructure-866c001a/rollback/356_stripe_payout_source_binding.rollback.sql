-- Disable new paid admission first. Retain all account mappings and financial history.
BEGIN;
DO $$ DECLARE table_name TEXT; BEGIN
  FOREACH table_name IN ARRAY ARRAY['scope_commerce_seller_accounts',
                                   'stripe_owner_payout_accounts','pkm_owner_payout_accounts'] LOOP
    IF to_regclass(table_name) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS stripe_payout_source_binding ON %I',table_name);
    END IF;
  END LOOP;
END $$;
DROP FUNCTION IF EXISTS enforce_stripe_payout_source_binding();
DROP FUNCTION IF EXISTS scope_commerce_payout_account_claims_v1(TEXT,BOOLEAN,TEXT);
COMMIT;
