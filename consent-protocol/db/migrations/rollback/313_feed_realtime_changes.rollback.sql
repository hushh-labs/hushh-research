-- Remove only this migration's delivery mechanism; preserve Feed rows and all
-- domain projection/identity/document triggers.
BEGIN;
DROP TRIGGER IF EXISTS feed_events_realtime_wake ON public.feed_events;
DROP FUNCTION IF EXISTS public.notify_feed_changed();
COMMIT;
