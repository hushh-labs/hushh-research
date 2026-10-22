-- migration: transactional=false
-- Equality lookup for the existing owner-confirmed Memory outcome projection.
-- Keep text revision semantics, duplicate audit events and all outcome filters.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pkm_events_plg_memory_revision
  ON public.pkm_events (user_id, domain, (metadata->>'data_version'))
  WHERE operation_type = 'content_write'
    AND metadata->'provenance'->>'authorization_mode' = 'owner_confirmed'
    AND NULLIF(BTRIM(metadata->'provenance'->>'mutation_plan_id'), '') IS NOT NULL
    AND NULLIF(BTRIM(metadata->'provenance'->>'confirmation_receipt_id'), '') IS NOT NULL;
