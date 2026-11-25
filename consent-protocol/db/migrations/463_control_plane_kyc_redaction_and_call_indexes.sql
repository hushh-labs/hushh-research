-- SPDX-License-Identifier: Apache-2.0
-- SPDX-FileCopyrightText: 2026 Hushh
-- Migration 459: Control-plane KYC plaintext retirement, terminal scheduled-mail
-- recipient_display minimization, and direct-call identity/cascade B-tree indexes.
-- Note: Canonical migrations >= 459 execute inside the migration ledger's outer
-- transaction envelope and intentionally omit top-level BEGIN/COMMIT statements.

UPDATE public.one_kyc_workflows
SET
  sender_email = NULL,
  sender_name = NULL,
  participant_emails = '[]'::jsonb,
  subject = NULL,
  snippet = NULL,
  counterparty_label = NULL,
  draft_subject = NULL,
  last_error_message = NULL,
  metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
    'legacy_plaintext_redacted_at', NOW(),
    'control_plane_redaction_migration', '459_control_plane_kyc_redaction_and_call_indexes'
  ),
  updated_at = NOW()
WHERE sender_email IS NOT NULL
   OR sender_name IS NOT NULL
   OR participant_emails <> '[]'::jsonb
   OR subject IS NOT NULL
   OR snippet IS NOT NULL
   OR counterparty_label IS NOT NULL
   OR draft_subject IS NOT NULL
   OR last_error_message IS NOT NULL;

ALTER TABLE public.one_kyc_workflows
  DROP CONSTRAINT IF EXISTS one_kyc_workflows_retired_plaintext_null_check;

ALTER TABLE public.one_kyc_workflows
  ADD CONSTRAINT one_kyc_workflows_retired_plaintext_null_check
    CHECK (
      sender_email IS NULL
      AND sender_name IS NULL
      AND participant_emails = '[]'::jsonb
      AND subject IS NULL
      AND snippet IS NULL
      AND counterparty_label IS NULL
      AND draft_subject IS NULL
      AND last_error_message IS NULL
    );

UPDATE public.gmail_owner_send_actions
SET recipient_display = NULL
WHERE send_at IS NOT NULL
  AND recipient_display IS NOT NULL
  AND (
    state IN ('cancelled', 'expired')
    OR (state IN ('sent', 'failed', 'outcome_unknown') AND notified_at IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS idx_direct_communication_keys_user_device
  ON public.direct_communication_keys (user_id, device_id);

CREATE INDEX IF NOT EXISTS idx_direct_calls_caller
  ON public.direct_calls (caller_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_direct_calls_conversation
  ON public.direct_calls (conversation_id);

CREATE INDEX IF NOT EXISTS idx_direct_call_commands_user_device
  ON public.direct_call_commands (user_id, device_id);

CREATE INDEX IF NOT EXISTS idx_direct_call_voip_tokens_user_device
  ON public.direct_call_voip_tokens (user_id, device_id);
