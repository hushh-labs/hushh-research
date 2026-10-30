-- Run after rolling back 204, outside a transaction.
DROP INDEX CONCURRENTLY IF EXISTS public.idx_one_location_events_recipient_type;
