-- Run outside a transaction, after stopping overlapping migration runners.
DROP INDEX CONCURRENTLY IF EXISTS public.idx_pkm_events_plg_memory_revision;
