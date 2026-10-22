-- Add admission fencing without rewriting any existing financial record.
BEGIN;
-- The read-only admission probe also rejects policy-filtered false absence.
CREATE OR REPLACE FUNCTION scope_commerce_payout_account_claims_v1(
  p_owner TEXT,p_livemode BOOLEAN,p_account TEXT)
RETURNS TEXT[] LANGUAGE sql STABLE SET row_security=off AS $$
  SELECT COALESCE(array_agg(DISTINCT account_id),ARRAY[]::TEXT[]) FROM (
    SELECT account_id FROM scope_commerce_seller_accounts
    WHERE livemode=p_livemode AND
      ((p_account IS NULL AND user_id=p_owner) OR account_id=p_account)
    UNION ALL
    SELECT account_id FROM scope_commerce_sellers
    WHERE p_account IS NOT NULL AND account_id=p_account AND (livemode=p_livemode OR livemode IS NULL)
  ) claims;
$$;
CREATE OR REPLACE FUNCTION enforce_stripe_payout_source_binding()
RETURNS trigger LANGUAGE plpgsql VOLATILE SET row_security=off AS $$
DECLARE
  account_ref TEXT;
  account_mode TEXT;
  foreign_table TEXT;
  conflict BOOLEAN;
  query TEXT;
BEGIN
  -- The cross-table check needs a fresh snapshot after waiting for the lock.
  -- Reject stronger snapshot isolation instead of admitting an unseen claim.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'payout_binding_isolation_unsupported' USING ERRCODE='25000';
  END IF;
  IF TG_TABLE_NAME ='scope_commerce_seller_accounts' THEN
    account_ref := NEW.account_id;
    account_mode := CASE WHEN NEW.livemode THEN 'live' ELSE 'test' END;
  ELSE
    account_ref := NEW.stripe_account_id;
    IF TG_TABLE_NAME='stripe_owner_payout_accounts' THEN
      account_mode := NEW.stripe_mode;
    END IF;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    TG_TABLE_SCHEMA || ':hussh-payout-source:' || account_ref, 0));
  IF account_ref IS NULL THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME ='scope_commerce_seller_accounts' THEN
    FOREACH foreign_table IN ARRAY ARRAY['stripe_owner_payout_accounts','pkm_owner_payout_accounts'] LOOP
      IF to_regclass(format('%I.%I',TG_TABLE_SCHEMA,foreign_table)) IS NULL THEN
        CONTINUE;
      END IF;
      query := format('SELECT EXISTS(SELECT 1 FROM %I.%I WHERE stripe_account_id=$1',
                      TG_TABLE_SCHEMA,foreign_table);
      IF foreign_table='stripe_owner_payout_accounts' THEN
        query := query || ' AND stripe_mode=$2)';
        EXECUTE query INTO conflict USING account_ref,account_mode;
      ELSE
        EXECUTE query || ')' INTO conflict USING account_ref;
      END IF;
      IF conflict THEN
        RAISE EXCEPTION 'payout_financial_source_conflict' USING ERRCODE='23514';
      END IF;
    END LOOP;
  ELSE
    FOREACH foreign_table IN ARRAY ARRAY['scope_commerce_seller_accounts','scope_commerce_sellers'] LOOP
      IF to_regclass(format('%I.%I',TG_TABLE_SCHEMA,foreign_table)) IS NULL THEN CONTINUE; END IF;
      EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.%I
                      WHERE account_id=$1 AND ($2 IS NULL OR livemode IS NULL OR livemode=($2=''live'')))',
                     TG_TABLE_SCHEMA,foreign_table) INTO conflict USING account_ref,account_mode;
      IF conflict THEN
        RAISE EXCEPTION 'payout_financial_source_conflict' USING ERRCODE='23514';
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END $$;
DO $$ DECLARE table_name TEXT; columns TEXT; BEGIN
  FOREACH table_name IN ARRAY ARRAY['scope_commerce_seller_accounts',
                                   'stripe_owner_payout_accounts','pkm_owner_payout_accounts'] LOOP
    IF to_regclass(table_name) IS NULL THEN CONTINUE; END IF;
    columns := CASE table_name
      WHEN 'scope_commerce_seller_accounts' THEN 'user_id,account_id,livemode'
      WHEN 'stripe_owner_payout_accounts' THEN 'user_id,stripe_account_id,stripe_mode'
      ELSE 'user_id,stripe_account_id' END;
    EXECUTE format('DROP TRIGGER IF EXISTS stripe_payout_source_binding ON %I',table_name);
    EXECUTE format('CREATE TRIGGER stripe_payout_source_binding BEFORE INSERT OR UPDATE OF %s
                    ON %I FOR EACH ROW EXECUTE FUNCTION enforce_stripe_payout_source_binding()',
                   columns,table_name);
  END LOOP;
END $$;
COMMIT;
