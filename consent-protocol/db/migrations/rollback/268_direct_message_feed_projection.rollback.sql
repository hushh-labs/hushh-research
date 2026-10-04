-- Down path for 268_direct_message_feed_projection.sql.
--
-- Feed rows are derived presentation records; removing this feature removes
-- those rows but never removes encrypted Direct Message history. Delete the
-- projections before the source-cleanup trigger is removed so stale pointers
-- cannot survive a rollback.

BEGIN;

DELETE FROM public.feed_events
 WHERE source_domain = 'connections'
   AND event_type = 'direct_message_received';

DROP TRIGGER IF EXISTS trg_direct_message_feed_projection_deleted ON public.messages;
DROP TRIGGER IF EXISTS trg_direct_message_feed_projected ON public.messages;
DROP FUNCTION IF EXISTS public.remove_direct_message_feed_event();
DROP FUNCTION IF EXISTS public.project_direct_message_feed_event();

COMMIT;
