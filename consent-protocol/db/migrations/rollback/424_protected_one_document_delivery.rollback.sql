BEGIN;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM document_delivery_contracts)
    OR EXISTS(SELECT 1 FROM document_delivery_cleanup WHERE status<>'removed')
    OR EXISTS(SELECT 1 FROM document_delivery_financial_bindings) THEN
  RAISE EXCEPTION 'Disable new intake and reconcile retained document deliveries before schema rollback';
 END IF;
END $$;
DROP FUNCTION document_delivery_summary_for(UUID);
DROP TABLE document_delivery_cleanup,document_delivery_financial_bindings,
 document_delivery_idempotency,document_delivery_activity,document_delivery_key_challenges,
 document_delivery_file_receipts,document_delivery_artifacts,document_delivery_packages,
 document_delivery_public_keys,document_delivery_contracts;
DROP FUNCTION preserve_document_delivery_financial_binding(),retain_document_delivery_erasure_inventory();
COMMIT;
