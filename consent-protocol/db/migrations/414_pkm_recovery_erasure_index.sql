-- migration: transactional=false
-- Keep ON DELETE SET NULL from scanning unrelated recovery references.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pkm_upgrade_steps_archived_revision
  ON public.pkm_upgrade_steps (last_archived_revision_id);
