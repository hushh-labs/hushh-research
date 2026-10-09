-- Rollback is safe only before any money has been posted. Preserve financial
-- obligations after use; disable the feature and roll code back instead.
BEGIN;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM scope_commerce_journal) OR EXISTS(SELECT 1 FROM scope_commerce_obligations)
 OR EXISTS(SELECT 1 FROM scope_commerce_provider_operations) THEN
 RAISE EXCEPTION 'cannot discard scope commerce financial obligations';
 END IF;
END $$;
DROP TABLE IF EXISTS scope_commerce_provider_events,scope_commerce_seller_accounts,
 scope_commerce_stripe_customers,scope_commerce_provider_operations,scope_commerce_transfer_recoveries,scope_commerce_withdrawal_allocations,scope_commerce_withdrawals,scope_commerce_source_refund_allocations,scope_commerce_obligations,
 scope_commerce_financial_events,scope_commerce_allocations,scope_commerce_reservations,
 scope_commerce_fundings,scope_commerce_funding_lots,scope_commerce_postings,scope_commerce_journal,
 scope_commerce_purchases,scope_commerce_quotes,scope_commerce_tariffs,
 scope_commerce_sellers,scope_commerce_wallets,scope_commerce_environment;
DROP FUNCTION IF EXISTS scope_commerce_posting_admission(),scope_commerce_balanced(),scope_commerce_immutable();
DROP TRIGGER IF EXISTS scope_commerce_pkm_manifest_refresh ON pkm_manifests;
DROP TRIGGER IF EXISTS scope_commerce_pkm_content_refresh ON pkm_blobs;
DROP FUNCTION IF EXISTS scope_commerce_queue_continuous_refresh_v1();
COMMIT;
