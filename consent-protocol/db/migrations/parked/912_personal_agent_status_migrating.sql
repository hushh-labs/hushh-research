-- 912: admit `migrating` into the registry status vocabulary.
--
-- Moving a person's agent between clouds needs a state that means "this row's
-- pod is frozen while its memory is in flight". Without one, the only options
-- were to leave the row `provisioned` (so the relay keeps serving turns into a
-- pod whose log is being exported, and the export races a live writer) or to
-- borrow `provisioning` (which the retry sweep would pick up and re-provision,
-- replacing the very pod being migrated from).
--
-- `migrating` is read as a REFUSAL by every writer path -- the relay declines
-- turns and ticks with a person-language message, the reconcile sweep skips the
-- row entirely, and liveness suspends judgement -- which is what makes the
-- export's single-writer assumption true rather than hoped for. The commit log's
-- generation check is the second half of that guarantee: the export pins the
-- head generation at start and re-reads it at finish, so a write that slipped
-- through anyway aborts the export instead of silently losing a record.
--
-- Written before 911's job service so the status vocabulary and its writer land
-- together. Migration 910 exists because they did not, once: the writer shipped,
-- the CHECK did not learn the word, and a live recovery failed at the database
-- with the row left claiming a host that was gone.
--
-- Same shape as 907 and 910: DROP IF EXISTS + ADD ... NOT VALID + VALIDATE, so
-- replay is safe and one historical oddity cannot brick the migration half-way.

ALTER TABLE personal_agent_registry
  DROP CONSTRAINT IF EXISTS personal_agent_registry_status_check;

ALTER TABLE personal_agent_registry
  ADD CONSTRAINT personal_agent_registry_status_check
  -- The REGISTRY vocabulary, exactly: every status a writer produces and the
  -- status route maps. `reserved` stays deliberately absent (a CLIENT state).
  CHECK (status IN (
    'unprovisioned',
    'pending',
    'provisioning',
    'connecting',
    'provisioned',
    'provisioning_failed',
    'needs_reinit',
    'migrating',
    'reaped'
  )) NOT VALID;

ALTER TABLE personal_agent_registry
  VALIDATE CONSTRAINT personal_agent_registry_status_check;
