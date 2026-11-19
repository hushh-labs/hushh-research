-- SPDX-License-Identifier: Apache-2.0
-- SPDX-FileCopyrightText: 2026 Hushh
-- Rollback for migration 459: drop direct-call identity/cascade indexes and the
-- retired-plaintext CHECK constraint on one_kyc_workflows. Scrubbed retired KYC
-- fields and terminal scheduled-mail display names remain redacted by design.

BEGIN;

DROP INDEX IF EXISTS public.idx_direct_call_voip_tokens_user_device;
DROP INDEX IF EXISTS public.idx_direct_call_commands_user_device;
DROP INDEX IF EXISTS public.idx_direct_calls_conversation;
DROP INDEX IF EXISTS public.idx_direct_calls_caller;
DROP INDEX IF EXISTS public.idx_direct_communication_keys_user_device;

ALTER TABLE IF EXISTS public.one_kyc_workflows
  DROP CONSTRAINT IF EXISTS one_kyc_workflows_retired_plaintext_null_check;

COMMIT;
