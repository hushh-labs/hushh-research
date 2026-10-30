-- Drive estimates and owner prices support cents. Existing orders retain their
-- amounts. Replay recognizes the exact successor checks without taking DDL locks.
BEGIN;

DO $$
DECLARE rule RECORD;
BEGIN
  FOR rule IN SELECT * FROM (VALUES
    ('drive_request_payment_orders', 'drive_request_payment_orders_amount_cents_check',
      'amount_cents BETWEEN 50 AND 50000',
      'CHECKamount_cents>=50ANDamount_cents<=50000'),
    ('drive_request_payment_obligations', 'drive_request_payment_obligations_amount_cents_check',
      'amount_cents BETWEEN 50 AND 50000',
      'CHECKamount_cents>=50ANDamount_cents<=50000'),
    ('drive_request_owner_payouts', 'drive_request_owner_payouts_gross_amount_cents_check',
      'gross_amount_cents BETWEEN 50 AND 50000',
      'CHECKgross_amount_cents>=50ANDgross_amount_cents<=50000'),
    ('drive_request_owner_pricing', 'drive_request_owner_pricing_amount_cents_check',
      'amount_cents BETWEEN 50 AND 50000',
      'CHECKamount_cents>=50ANDamount_cents<=50000'),
    ('drive_share_requests', 'drive_share_requests_locked_quote_check',
      '(quoted_amount_cents IS NULL AND quote_version IS NULL) OR (payment_required=TRUE AND quoted_amount_cents BETWEEN 50 AND 50000 AND quote_version >= 0)',
      'CHECKquoted_amount_centsISNULLANDquote_versionISNULLORpayment_required=trueANDquoted_amount_cents>=50ANDquoted_amount_cents<=50000ANDquote_version>=0'),
    ('drive_share_requests', 'drive_share_requests_initial_quote_check',
      'initial_quote_cents IS NULL OR initial_quote_cents BETWEEN 50 AND 50000',
      'CHECKinitial_quote_centsISNULLORinitial_quote_cents>=50ANDinitial_quote_cents<=50000')
  ) AS rules(table_name, constraint_name, expression, normalized_definition)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conrelid=rule.table_name::regclass AND conname=rule.constraint_name
        AND contype='c' AND convalidated
        AND regexp_replace(pg_get_constraintdef(oid),'[()[:space:]]','','g')=rule.normalized_definition) THEN
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I',rule.table_name,rule.constraint_name);
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (%s) NOT VALID',rule.table_name,rule.constraint_name,rule.expression);
      EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I',rule.table_name,rule.constraint_name);
    END IF;
  END LOOP;
END $$;

COMMIT;
