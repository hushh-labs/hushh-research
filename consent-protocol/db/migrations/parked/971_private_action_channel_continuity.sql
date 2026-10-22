BEGIN;
-- Canonical 212/231/248 replay predates private pod reviews. Parked migrations
-- are pending-only, so their earlier receipts cannot restore these checks.
-- Preserve every existing channel and the independently enforced exact terms.
LOCK TABLE one_action_directive_ledger IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid='one_action_directive_ledger'::regclass
      AND conname='pod_chat_action_identity' AND contype='c' AND convalidated
      AND regexp_replace(pg_get_constraintdef(oid),'[[:space:]]','','g')=
        'CHECK(((channel<>''pod_chat''::text)OR((adk_app_nameISNULL)AND(action_id=ANY(ARRAY[''connector.mcp.invoke''::text,''browser.model_process''::text,''browser.disclose''::text,''browser.session_remember''::text,''browser.session_restore''::text,''browser.provider_safety''::text]))ANDrequires_confirmationANDtrusted_activation_requiredAND(resource_binding_hmacISNOTNULL))))') THEN
    RAISE EXCEPTION 'Qualified private review action authority is required before channel repair';
  END IF;
END $$;
ALTER TABLE one_action_directive_ledger
  DROP CONSTRAINT IF EXISTS one_action_directive_ledger_channel_check,
  DROP CONSTRAINT IF EXISTS one_action_directive_ledger_check;
ALTER TABLE one_action_directive_ledger
  ADD CONSTRAINT one_action_directive_ledger_channel_check CHECK (
    channel IN ('typed_chat','voice','command','document_review','adk_chat','pod_chat')),
  ADD CONSTRAINT one_action_directive_ledger_check CHECK (
    (channel='typed_chat' AND conversation_id IS NOT NULL AND session_id IS NULL)
    OR (channel IN ('voice','command','adk_chat','pod_chat') AND session_id IS NOT NULL AND conversation_id IS NULL)
    OR (channel='document_review' AND conversation_id IS NULL AND session_id IS NULL));
COMMENT ON CONSTRAINT one_action_directive_ledger_channel_check ON one_action_directive_ledger
  IS 'private-action-channel.v1/971';
COMMENT ON CONSTRAINT one_action_directive_ledger_check ON one_action_directive_ledger
  IS 'private-action-channel.v1/971';
COMMIT;
-- Application rollback disables private reviews and preserves their receipts.
-- The SQL down path refuses while any private review history remains.
