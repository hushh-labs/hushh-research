-- Renumbered from the ADK branch's 249: public-profile migration 249 already owns that ID.
-- Migration 250: One chat history BYOK cutover. Delete chat history sealed with
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
-- of one_action_directive_ledger (248); for a deleted conversation, its
-- typed_chat directive rows (114). All metadata only.
--
-- Rollback: irreversible by design. The rollback file is a documented no-op;
-- recovering deleted rows means restoring the database from backup, and the
-- restored rows would still be unreadable to the new code.

BEGIN;

DO $$
DECLARE
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
    RAISE NOTICE 'migration 250: chat tables absent; nothing to cut over';
    RETURN;
  END IF;

  -- Hold writers off for the few milliseconds this takes, so the before/after
  -- person-key counts below cannot move under concurrent traffic. Readers are
  -- not blocked. Fail fast instead of queueing behind a long transaction.
  SET LOCAL lock_timeout = '10s';
  LOCK TABLE agent_chat_messages, agent_chat_conversations, one_adk_sessions
    IN SHARE ROW EXCLUSIVE MODE;

  SELECT COUNT(*) INTO person_sessions_before
  FROM one_adk_sessions WHERE substr(payload_ciphertext, 1, 14) = 'hussh-chat-v1:';
  SELECT COUNT(*) INTO person_conversations_before
  FROM agent_chat_conversations WHERE substr(title_ciphertext, 1, 14) = 'hussh-chat-v1:';
  SELECT COUNT(*) INTO person_messages_before
  FROM agent_chat_messages WHERE substr(content_ciphertext, 1, 14) = 'hussh-chat-v1:';

  DELETE FROM agent_chat_messages
  WHERE substr(content_ciphertext, 1, 14) <> 'hussh-chat-v1:';

  SELECT COUNT(*) INTO kept_conversations
  FROM agent_chat_conversations AS c
  WHERE (c.title_ciphertext IS NULL OR substr(c.title_ciphertext, 1, 14) <> 'hussh-chat-v1:')
    AND EXISTS (SELECT 1 FROM agent_chat_messages AS m WHERE m.conversation_id = c.id);
  IF kept_conversations > 0 THEN
    RAISE NOTICE
      'migration 250: kept % platform-key conversation(s) that hold person-key messages',
      kept_conversations;
  END IF;

  DELETE FROM agent_chat_conversations AS c
  WHERE (c.title_ciphertext IS NULL OR substr(c.title_ciphertext, 1, 14) <> 'hussh-chat-v1:')
    AND NOT EXISTS (SELECT 1 FROM agent_chat_messages AS m WHERE m.conversation_id = c.id);

  -- One chat sessions and command checkpoints (app_name 'one.location.commands.v1').
  DELETE FROM one_adk_sessions
  WHERE substr(payload_ciphertext, 1, 14) <> 'hussh-chat-v1:';

  SELECT COUNT(*) INTO person_sessions_after
  FROM one_adk_sessions WHERE substr(payload_ciphertext, 1, 14) = 'hussh-chat-v1:';
  SELECT COUNT(*) INTO person_conversations_after
  FROM agent_chat_conversations WHERE substr(title_ciphertext, 1, 14) = 'hussh-chat-v1:';
  SELECT COUNT(*) INTO person_messages_after
  FROM agent_chat_messages WHERE substr(content_ciphertext, 1, 14) = 'hussh-chat-v1:';

  IF person_sessions_after <> person_sessions_before
     OR person_conversations_after <> person_conversations_before
     OR person_messages_after <> person_messages_before THEN
    RAISE EXCEPTION
      'migration 250 refused: person-key rows changed (sessions % -> %, conversations % -> %, messages % -> %)',
      person_sessions_before, person_sessions_after,
      person_conversations_before, person_conversations_after,
      person_messages_before, person_messages_after;
  END IF;
END
$$;

COMMIT;
