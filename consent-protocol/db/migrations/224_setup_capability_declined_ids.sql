-- Durable "declined" marker for optional setup capabilities.
--
-- setup_capability_ids only ever records a capability the person finished.
-- Nothing today distinguishes "never tried Gmail" from "was asked and said
-- not now" -- this column closes that gap so a proactive connect prompt
-- (in chat, or elsewhere) can stop re-asking once someone has said no.
-- Shares setup_capability_ids' existing setup_capabilities_updated_at
-- timestamp column rather than adding a second one; both are the same
-- "setup capability state changed" fact.

BEGIN;

ALTER TABLE vault_keys
  ADD COLUMN IF NOT EXISTS setup_capability_declined_ids TEXT;

COMMENT ON COLUMN vault_keys.setup_capability_declined_ids IS
  'JSON array of setup capability ids the person explicitly declined (e.g. dismissed a connect prompt). Never includes the mandatory "connections" prerequisite. Distinct from setup_capability_ids, which only records completions.';

COMMIT;
