BEGIN;
-- Disable capture and drain/retain remote cleanup obligations before rollback.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM one_company_crm_deliveries) THEN
    RAISE EXCEPTION 'Company CRM receipts must be reconciled before rollback';
  END IF;
END $$;
DROP TABLE IF EXISTS one_company_crm_deliveries;
DROP TABLE IF EXISTS one_company_crm_cursor;
COMMIT;
