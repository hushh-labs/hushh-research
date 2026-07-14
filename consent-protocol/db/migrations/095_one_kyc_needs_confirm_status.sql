-- Migration 095: Allow the 'needs_confirm' One KYC workflow status
-- =====================================================================
-- The KYC agent LLM redesign introduces a `needs_confirm` state: after Pass 1
-- routing produces a proposal, the workflow waits for the vault owner to confirm
-- which proposed scopes to disclose. This value was added to the Python
-- `_KYC_WORKFLOW_STATES` set but the DB CHECK constraint (migration 050) still
-- rejected it, so intake/refresh writes with status='needs_confirm' failed with
-- a check-constraint violation. Add the value to the constraint.

BEGIN;

ALTER TABLE one_kyc_workflows
  DROP CONSTRAINT IF EXISTS one_kyc_workflows_status_check;

ALTER TABLE one_kyc_workflows
  ADD CONSTRAINT one_kyc_workflows_status_check
    CHECK (status IN (
      'needs_client_connector',
      'needs_scope',
      'needs_confirm',
      'needs_documents',
      'drafting',
      'waiting_on_user',
      'waiting_on_counterparty',
      'completed',
      'blocked'
    ));

COMMIT;
