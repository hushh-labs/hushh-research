-- migration: transactional=false
-- Bound revision foreign-key cleanup across every owner's recovery history.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pkm_domain_commits_archived_revision
  ON public.pkm_domain_commits (archived_revision_id);
