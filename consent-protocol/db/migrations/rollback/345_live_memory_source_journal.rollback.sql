BEGIN;
DO $$ DECLARE v_table TEXT; BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'actor_identity_cache','consent_audit','connections','connection_requests','trusted_connections',
    'drive_request_payment_orders','drive_request_payment_refunds',
    'drive_request_owner_payouts'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS live_memory_source_journal ON public.%I',v_table);
  END LOOP;
END $$;
DROP TRIGGER IF EXISTS erase_live_memory_source_journal ON public.actor_profiles;
DROP TRIGGER IF EXISTS erase_live_memory_source_journal ON public.vault_keys;
DROP FUNCTION IF EXISTS public.capture_live_memory_source_hint();
DROP FUNCTION IF EXISTS public.append_live_memory_source_hint(TEXT,TEXT,TEXT);
DROP FUNCTION IF EXISTS public.erase_live_memory_source_journal_on_root_delete();
DROP TABLE IF EXISTS public.live_memory_source_events;
DROP TABLE IF EXISTS public.live_memory_source_streams;
COMMIT;
