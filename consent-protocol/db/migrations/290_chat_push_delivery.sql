BEGIN;

-- Installations, rather than platforms, own subscriptions. A token belongs
-- to exactly one account even when that installation switches accounts.
ALTER TABLE user_push_tokens ADD COLUMN IF NOT EXISTS device_id UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE user_push_tokens ADD COLUMN IF NOT EXISTS preview_key_id UUID;
ALTER TABLE user_push_tokens ADD COLUMN IF NOT EXISTS preview_public_key VARCHAR(87);
CREATE UNIQUE INDEX IF NOT EXISTS user_push_tokens_installation ON user_push_tokens(device_id);
-- Preserve the most recently registered legacy owner and fence unseen concurrent
-- claims. The old user/platform conflict target remains available.
DELETE FROM user_push_tokens older USING user_push_tokens newer
 WHERE older.token=newer.token
 AND (COALESCE(older.updated_at,older.created_at),older.id)
   < (COALESCE(newer.updated_at,newer.created_at),newer.id);
CREATE UNIQUE INDEX IF NOT EXISTS user_push_tokens_token_owner ON user_push_tokens(token);

-- Keep the v1 UNIQUE(user_id, platform) upsert usable by serving/rollback
-- revisions. The existing registry service owns both this compatibility
-- projection and the installation registry; modern readers deduplicate tokens.
CREATE TABLE IF NOT EXISTS user_push_installations (
 id BIGSERIAL PRIMARY KEY,
 user_id TEXT NOT NULL,
 token TEXT NOT NULL UNIQUE,
 platform TEXT NOT NULL CHECK (platform IN ('web','ios','android')),
 device_id UUID NOT NULL UNIQUE,
 preview_key_id UUID,
 preview_public_key VARCHAR(87),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_push_installations_user ON user_push_installations(user_id);
-- Old handlers do not run the new Python ownership locks. An old-client
-- account transfer must revoke the former owner's preview registration too.
CREATE OR REPLACE FUNCTION reconcile_legacy_push_owner() RETURNS trigger AS $$
BEGIN
 DELETE FROM user_push_tokens WHERE token=NEW.token AND user_id<>NEW.user_id;
 DELETE FROM user_push_installations WHERE token=NEW.token AND user_id<>NEW.user_id;
 IF current_setting('hushh.push_installation_projection',true) IS DISTINCT FROM '1' THEN
  -- An old handler cannot attest that the current binary supports sealed push.
  -- Preserve generic alerts after a downgrade instead of sending data-only push.
  UPDATE user_push_installations SET preview_key_id=NULL,preview_public_key=NULL
   WHERE token=NEW.token AND user_id=NEW.user_id;
 END IF;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;
DROP TRIGGER IF EXISTS push_legacy_owner_reconciled ON user_push_tokens;
-- PostgreSQL runs same-event triggers by name. The canonical tombstone guard
-- must acquire lifecycle locks before this bridge touches installation rows.
DROP TRIGGER IF EXISTS zz_push_legacy_owner_reconciled ON user_push_tokens;
CREATE TRIGGER zz_push_legacy_owner_reconciled BEFORE INSERT OR UPDATE OF token, user_id
 ON user_push_tokens FOR EACH ROW EXECUTE FUNCTION reconcile_legacy_push_owner();

-- Old serving/rollback revisions erase the original registry only. The existing
-- full-account tombstone is also the cleanup boundary for additive installations.
CREATE OR REPLACE FUNCTION erase_tombstoned_push_registrations() RETURNS trigger AS $$
BEGIN
 DELETE FROM user_push_tokens
  WHERE 'sha256:' || encode(digest(user_id,'sha256'),'hex')=NEW.user_id_hash;
 DELETE FROM user_push_installations
  WHERE 'sha256:' || encode(digest(user_id,'sha256'),'hex')=NEW.user_id_hash;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;
DROP TRIGGER IF EXISTS push_account_erased ON account_deletion_tombstones;
CREATE TRIGGER push_account_erased AFTER INSERT ON account_deletion_tombstones
 FOR EACH ROW EXECUTE FUNCTION erase_tombstoned_push_registrations();
DELETE FROM user_push_tokens p USING account_deletion_tombstones t
 WHERE t.user_id_hash='sha256:' || encode(digest(p.user_id,'sha256'),'hex');
DELETE FROM user_push_installations p USING account_deletion_tombstones t
 WHERE t.user_id_hash='sha256:' || encode(digest(p.user_id,'sha256'),'hex');

-- After device removal, keep one surviving subscription visible to old senders.
-- The caller invokes this in a fresh transaction after releasing deletion locks.
CREATE OR REPLACE FUNCTION restore_legacy_push_projection(owner_id TEXT) RETURNS void AS $$
DECLARE candidate RECORD; lane TEXT; attempt INTEGER;
BEGIN
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(owner_id,198));
 IF EXISTS (SELECT 1 FROM account_deletion_tombstones
  WHERE user_id_hash='sha256:' || encode(digest(owner_id,'sha256'),'hex')) THEN RETURN; END IF;
 PERFORM set_config('hushh.push_installation_projection','1',true);
 FOREACH lane IN ARRAY ARRAY['web','ios','android'] LOOP
  FOR attempt IN 1..3 LOOP
   BEGIN
    PERFORM 1 FROM user_push_tokens WHERE user_id=owner_id AND platform=lane FOR UPDATE;
    IF FOUND THEN EXIT; END IF;
    SELECT * INTO candidate FROM user_push_installations
     WHERE user_id=owner_id AND platform=lane ORDER BY updated_at DESC,id DESC LIMIT 1 FOR UPDATE;
    IF NOT FOUND THEN EXIT; END IF;
    INSERT INTO user_push_tokens(user_id,token,platform)
     VALUES(owner_id,candidate.token,lane) ON CONFLICT(user_id,platform) DO NOTHING;
    EXIT;
   EXCEPTION WHEN deadlock_detected OR serialization_failure OR unique_violation THEN
    -- Release the selected row before retrying an old-handler ownership race.
    IF attempt=3 THEN RAISE; END IF;
   END;
  END LOOP;
 END LOOP;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

ALTER TABLE circle_chat_recipients ALTER COLUMN push_due_at SET DEFAULT now() + interval '2 seconds';

-- Only bounded, sender-encrypted previews. No vault key or plaintext is stored.
ALTER TABLE circle_chat_messages ADD COLUMN IF NOT EXISTS notification_previews JSONB NOT NULL DEFAULT '{}'
 CHECK (octet_length(notification_previews::text) <= 1500000);

CREATE TABLE IF NOT EXISTS direct_message_push_outbox (
 message_id UUID PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
 recipient_user_id TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','leased','sent','suppressed','failed')),
 attempts SMALLINT NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
 due_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '2 seconds'
);
CREATE INDEX IF NOT EXISTS direct_message_push_due ON direct_message_push_outbox(due_at)
 WHERE status IN ('pending','leased');
CREATE OR REPLACE FUNCTION queue_direct_message_push() RETURNS trigger AS $$
BEGIN
 INSERT INTO direct_message_push_outbox(message_id, recipient_user_id)
 SELECT NEW.id, CASE WHEN c.participant_a_user_id = NEW.sender_user_id
   THEN c.participant_b_user_id ELSE c.participant_a_user_id END
 FROM conversations c WHERE c.id = NEW.conversation_id;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;
DROP TRIGGER IF EXISTS direct_message_push_queued ON messages;
CREATE TRIGGER direct_message_push_queued AFTER INSERT ON messages
 FOR EACH ROW EXECUTE FUNCTION queue_direct_message_push();

-- A successful device is never retried because another device failed. Hashes
-- fence token refresh/account transfers; the registration row is rechecked.
CREATE TABLE IF NOT EXISTS chat_push_device_deliveries (
 event_id TEXT NOT NULL,
 device_id UUID NOT NULL,
 recipient_user_id TEXT NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
 direct_message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
 circle_message_id UUID REFERENCES circle_chat_messages(id) ON DELETE CASCADE,
 accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(event_id, device_id, recipient_user_id),
 CHECK ((direct_message_id IS NULL) <> (circle_message_id IS NULL))
);
CREATE INDEX IF NOT EXISTS chat_push_device_delivery_expiry ON chat_push_device_deliveries(accepted_at);
ALTER TABLE direct_message_push_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_push_device_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_push_installations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON direct_message_push_outbox, chat_push_device_deliveries, user_push_installations FROM PUBLIC;
REVOKE ALL ON FUNCTION queue_direct_message_push() FROM PUBLIC;
REVOKE ALL ON FUNCTION reconcile_legacy_push_owner() FROM PUBLIC;
REVOKE ALL ON FUNCTION erase_tombstoned_push_registrations() FROM PUBLIC;
REVOKE ALL ON FUNCTION restore_legacy_push_projection(TEXT) FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  GRANT ALL ON direct_message_push_outbox, chat_push_device_deliveries, user_push_installations TO service_role;
  GRANT USAGE, SELECT ON SEQUENCE user_push_installations_id_seq TO service_role;
  GRANT EXECUTE ON FUNCTION queue_direct_message_push() TO service_role;
  GRANT EXECUTE ON FUNCTION reconcile_legacy_push_owner() TO service_role;
  GRANT EXECUTE ON FUNCTION erase_tombstoned_push_registrations() TO service_role;
  GRANT EXECUTE ON FUNCTION restore_legacy_push_projection(TEXT) TO service_role;
 END IF;
END $$;
SELECT install_account_deletion_write_guards();
COMMIT;
