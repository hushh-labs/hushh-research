BEGIN;
DROP TRIGGER IF EXISTS external_connector_live_memory_journal
  ON public.user_external_connector_connections;
DROP TRIGGER IF EXISTS erase_live_memory_connector_journal ON public.actor_profiles;
DROP TRIGGER IF EXISTS erase_live_memory_connector_journal ON public.vault_keys;
DROP FUNCTION IF EXISTS public.append_live_memory_connector_event();
DROP FUNCTION IF EXISTS public.erase_live_memory_connector_journal_on_root_delete();
DROP TABLE IF EXISTS public.live_memory_connector_events;
DROP TABLE IF EXISTS public.live_memory_connector_streams;
COMMIT;
