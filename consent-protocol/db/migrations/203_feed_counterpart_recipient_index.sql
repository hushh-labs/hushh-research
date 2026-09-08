-- migration: transactional=false
-- One statement: PostgreSQL concurrent indexes cannot run in a transaction.
-- Migration 204 checks validity before installing the indexed resolver.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_one_location_events_recipient_type
  ON public.one_location_events (recipient_user_id, event_type);
