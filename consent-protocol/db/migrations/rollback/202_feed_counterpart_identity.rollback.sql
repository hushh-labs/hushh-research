-- Roll backend reads back first. Removes derived presentation links only;
-- Feed events, read state, source domain records, and identity remain intact.
BEGIN;
DROP TRIGGER IF EXISTS trg_feed_counterpart_identity ON public.feed_events;
DROP FUNCTION IF EXISTS public.populate_feed_counterpart_identity();
DROP TABLE IF EXISTS public.feed_event_counterparts;
DROP FUNCTION IF EXISTS public.resolve_feed_counterpart_user_id(TEXT, TEXT, TEXT, TEXT);
COMMIT;
