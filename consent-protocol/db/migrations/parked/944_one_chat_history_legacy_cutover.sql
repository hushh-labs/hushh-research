-- Dev-only cleanup 944. Public-profile 249 and Calendar 252 retain their active identities.
-- This cleanup stays parked until restore and incompatible-writer drain receipts pass.
-- Migration 944: One chat history BYOK cutover. Delete chat history sealed with
-- the platform key.
--
-- Since the chat-history BYOK change, every chat ciphertext is sealed with a key
-- derived from the person's vault, and the ciphertext column itself starts with
-- the plaintext marker 'hussh-chat-v1:'. A row without that marker was sealed
-- with the process-wide platform key (VAULT_DATA_KEY), which Hussh can read.
-- Founder decision (2026-09-26): delete those rows at cutover; do not migrate
-- them (re-sealing would need every person's vault key at once). The new code
-- already treats them as absent, so deleting them changes nothing a person with
-- the new code can see.
--
-- Parked during the compatibility bridge and BYOK writer releases. Activate
-- only after the bridge is a verified rollback target and old writers/active
-- commands have drained. Deployment of person-key readers alone is not cutover.
-- Deletes target only unmarked rows; mixed conversations retain their marked
-- messages. Before/after counts guard marked records and replay is idempotent.
-- Drain/refusal acceptance remains required before this file enters the release
-- manifest. The parked file does not authorize live deletion.
--
-- Not touched: one_capability_runs. Task slots stay on the platform key because
-- Location onboarding runs before a vault exists; that is an open founder
-- decision, not chat history.
--
-- Cascades (existing foreign keys, accepted with the founder decision): for a
-- deleted session, its one_agent_message_feedback rows (197) and adk_chat rows
-- of public.one_action_directive_ledger (248); for a deleted conversation, its
-- typed_chat directive rows (114). Terminal command-channel directive receipts
-- have no session FK and remain in their owning ledger; cleanup does not erase
-- them or make a deleted checkpoint resumable. Active effects must be resolved
-- before cleanup; their authority cannot be inferred from expiry alone.
--
-- Rollback: irreversible by design. The rollback file is a documented no-op;
-- recovering deleted rows means restoring the database from backup, and the
-- restored rows would still be unreadable to the new code.

BEGIN;
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog, public, pg_temp;

DO $$
DECLARE
  cutover_at TIMESTAMPTZ;
  person_sessions_before BIGINT;
  person_conversations_before BIGINT;
  person_messages_before BIGINT;
  person_sessions_after BIGINT;
  person_conversations_after BIGINT;
  person_messages_after BIGINT;
  kept_conversations BIGINT;
BEGIN
  IF to_regclass('public.one_adk_sessions') IS NULL
     OR to_regclass('public.agent_chat_conversations') IS NULL
     OR to_regclass('public.agent_chat_messages') IS NULL THEN
    RAISE EXCEPTION 'migration 944: required chat tables absent; cutover refused';
  END IF;

  -- Block writers only within the measured, bounded cutover transaction; before/after
  -- person-key counts below cannot move under concurrent traffic. Readers are
  -- not blocked. Fail fast instead of queueing behind a long transaction.
  SET LOCAL lock_timeout = '10s';
  LOCK TABLE public.agent_chat_conversations, public.agent_chat_messages, public.one_adk_sessions,
    public.one_action_directive_ledger, public.one_capability_runs IN SHARE ROW EXCLUSIVE MODE;
  cutover_at := clock_timestamp();

  IF EXISTS (
    SELECT 1 FROM public.one_adk_sessions
    WHERE substr(payload_ciphertext, 1, 14) <> 'hussh-chat-v1:'
      AND app_name NOT IN ('hussh_one', 'one.location.commands.v1')
  ) THEN
    RAISE EXCEPTION 'migration 944: unreviewed legacy session namespace';
  END IF;

  -- These refusals supplement the required serving-revision/worker drain.
  -- A quiet interval alone cannot establish that an old writer is disabled.
  IF EXISTS (
    SELECT 1 FROM public.one_adk_sessions
    WHERE substr(payload_ciphertext, 1, 14) <> 'hussh-chat-v1:'
      AND GREATEST(created_at, updated_at) > cutover_at - INTERVAL '15 minutes'
  ) OR EXISTS (
    SELECT 1 FROM public.agent_chat_messages
    WHERE substr(content_ciphertext, 1, 14) <> 'hussh-chat-v1:'
      AND created_at > cutover_at - INTERVAL '15 minutes'
  ) OR EXISTS (
    SELECT 1 FROM public.agent_chat_conversations c
    WHERE (c.title_ciphertext IS NULL OR substr(c.title_ciphertext, 1, 14) <> 'hussh-chat-v1:')
      AND GREATEST(c.created_at, c.updated_at) > cutover_at - INTERVAL '15 minutes'
      AND NOT EXISTS (
        SELECT 1 FROM public.agent_chat_messages m WHERE m.conversation_id = c.id
          AND substr(m.content_ciphertext, 1, 14) = 'hussh-chat-v1:'
      )
  ) THEN
    RAISE EXCEPTION 'migration 944: recent legacy writes; writer drain not established';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.one_adk_sessions
    WHERE app_name = 'one.location.commands.v1'
      AND substr(payload_ciphertext, 1, 14) <> 'hussh-chat-v1:'
      AND command_status IN ('ready', 'admitted')
      AND created_at > cutover_at - INTERVAL '24 hours'
  ) THEN
    RAISE EXCEPTION 'migration 944: live legacy command checkpoints remain';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.one_action_directive_ledger d
    WHERE (
      EXISTS (
        SELECT 1 FROM public.one_capability_runs r
        WHERE r.user_id = d.user_id
          AND (r.pending_directive_id = d.directive_id OR r.run_id = d.workflow_run_id)
          AND r.status NOT IN ('verified_succeeded', 'verified_failed', 'cancelled', 'expired')
      ) OR d.state = 'consumed'
      OR (d.state IN ('issued', 'confirmed')
        AND (d.expires_at > cutover_at OR d.consumed_at IS NOT NULL
          OR d.execution_receipt_hash IS NOT NULL OR d.effect_receipt IS NOT NULL
          OR (d.membership_receipts IS NOT NULL AND d.membership_receipts <> '{}'::jsonb) OR (d.audience_receipts IS NOT NULL AND d.audience_receipts <> '{}'::jsonb)
          OR d.workflow_run_id IS NOT NULL))
    ) AND (
      (d.channel IN ('adk_chat', 'command') AND EXISTS (
        SELECT 1 FROM public.one_adk_sessions s
        WHERE s.user_id = d.user_id AND s.session_id = d.session_id
          AND s.app_name = CASE WHEN d.channel = 'adk_chat'
            THEN d.adk_app_name ELSE 'one.location.commands.v1' END
          AND substr(s.payload_ciphertext, 1, 14) <> 'hussh-chat-v1:'
      )) OR (d.channel = 'typed_chat' AND EXISTS (
        -- Match the real conversation FK; owner metadata does not limit cascade.
        SELECT 1 FROM public.agent_chat_conversations c
        WHERE c.id = d.conversation_id
          AND (c.title_ciphertext IS NULL OR substr(c.title_ciphertext, 1, 14) <> 'hussh-chat-v1:')
          AND NOT EXISTS (
            SELECT 1 FROM public.agent_chat_messages m WHERE m.conversation_id = c.id
              AND substr(m.content_ciphertext, 1, 14) = 'hussh-chat-v1:'
          )
      ))
    )
  ) THEN
    RAISE EXCEPTION 'migration 944: unsettled authority attached to legacy history';
  END IF;

  SELECT COUNT(*) INTO person_sessions_before
  FROM public.one_adk_sessions WHERE substr(payload_ciphertext, 1, 14) = 'hussh-chat-v1:';
  SELECT COUNT(*) INTO person_conversations_before
  FROM public.agent_chat_conversations WHERE substr(title_ciphertext, 1, 14) = 'hussh-chat-v1:';
  SELECT COUNT(*) INTO person_messages_before
  FROM public.agent_chat_messages WHERE substr(content_ciphertext, 1, 14) = 'hussh-chat-v1:';

  DELETE FROM public.agent_chat_messages
  WHERE substr(content_ciphertext, 1, 14) <> 'hussh-chat-v1:';

  SELECT COUNT(*) INTO kept_conversations
  FROM public.agent_chat_conversations AS c
  WHERE (c.title_ciphertext IS NULL OR substr(c.title_ciphertext, 1, 14) <> 'hussh-chat-v1:')
    AND EXISTS (SELECT 1 FROM public.agent_chat_messages AS m WHERE m.conversation_id = c.id);
  IF kept_conversations > 0 THEN
    RAISE NOTICE
      'migration 944: kept % platform-key conversation(s) that hold person-key messages',
      kept_conversations;
  END IF;

  DELETE FROM public.agent_chat_conversations AS c
  WHERE (c.title_ciphertext IS NULL OR substr(c.title_ciphertext, 1, 14) <> 'hussh-chat-v1:')
    AND NOT EXISTS (SELECT 1 FROM public.agent_chat_messages AS m WHERE m.conversation_id = c.id);

  -- One chat sessions and command checkpoints (app_name 'one.location.commands.v1').
  DELETE FROM public.one_adk_sessions
  WHERE substr(payload_ciphertext, 1, 14) <> 'hussh-chat-v1:';

  SELECT COUNT(*) INTO person_sessions_after
  FROM public.one_adk_sessions WHERE substr(payload_ciphertext, 1, 14) = 'hussh-chat-v1:';
  SELECT COUNT(*) INTO person_conversations_after
  FROM public.agent_chat_conversations WHERE substr(title_ciphertext, 1, 14) = 'hussh-chat-v1:';
  SELECT COUNT(*) INTO person_messages_after
  FROM public.agent_chat_messages WHERE substr(content_ciphertext, 1, 14) = 'hussh-chat-v1:';

  IF person_sessions_after <> person_sessions_before
     OR person_conversations_after <> person_conversations_before
     OR person_messages_after <> person_messages_before THEN
    RAISE EXCEPTION
      'migration 944 refused: person-key rows changed (sessions % -> %, conversations % -> %, messages % -> %)',
      person_sessions_before, person_sessions_after,
      person_conversations_before, person_conversations_after,
      person_messages_before, person_messages_after;
  END IF;
END
$$;

COMMIT;
