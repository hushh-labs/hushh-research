-- 910: admit `needs_reinit` into the registry status vocabulary.
--
-- The recovery lifecycle (2026-08-21) added the writer -- `mark_needs_reinit`
-- flips a CONFIRMED-gone host's row to `needs_reinit` and clears the sticky
-- cloud authorization -- but migration 907's CHECK enumerated the vocabulary
-- without it. Observed live on dev (2026-08-25): the reachability gate detected
-- a deleted host, the wake path tried to record the verdict, and Postgres
-- refused with `personal_agent_registry_status_check` -- so the row stayed
-- `active` with a dead host and the app's recovery affordance never rendered.
-- A vocabulary reader and writer living in two files with nothing comparing
-- them, again -- this time the second file was SQL. The paired guard now lives
-- in tests/test_pod_status_vocabulary_is_one_vocabulary.py.
--
-- Same shape as 907: DROP IF EXISTS + ADD ... NOT VALID + VALIDATE, so replay
-- is safe and a single historical oddity cannot brick the migration half-way.

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
    'reaped'
  )) NOT VALID;

ALTER TABLE personal_agent_registry
  VALIDATE CONSTRAINT personal_agent_registry_status_check;
