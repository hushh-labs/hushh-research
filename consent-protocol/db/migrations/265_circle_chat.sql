BEGIN;

-- Content and attachment bytes are encrypted on clients. No plaintext previews.
CREATE TABLE IF NOT EXISTS circle_chat_messages (
  id UUID PRIMARY KEY,
  sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  circle_id UUID NOT NULL REFERENCES one_location_circles(id) ON DELETE CASCADE,
  sender_user_id TEXT NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  client_message_id UUID NOT NULL,
  ciphertext TEXT NOT NULL CHECK (length(ciphertext) BETWEEN 22 AND 24000),
  iv VARCHAR(16) NOT NULL CHECK (length(iv) = 16),
  image_ciphertext TEXT CHECK (length(image_ciphertext) BETWEEN 22 AND 6990530),
  image_iv VARCHAR(16) CHECK (length(image_iv) = 16),
  request_digest CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (circle_id, sender_user_id, client_message_id),
  CHECK ((image_ciphertext IS NULL) = (image_iv IS NULL))
);
CREATE INDEX IF NOT EXISTS circle_chat_messages_page
  ON circle_chat_messages(circle_id, sequence DESC);
CREATE INDEX IF NOT EXISTS circle_chat_messages_sender ON circle_chat_messages(sender_user_id);

CREATE TABLE IF NOT EXISTS circle_chat_recipients (
  message_id UUID NOT NULL REFERENCES circle_chat_messages(id) ON DELETE CASCADE,
  recipient_user_id TEXT NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  membership_joined_at TIMESTAMPTZ NOT NULL,
  key_id VARCHAR(160) NOT NULL,
  envelope JSONB NOT NULL CHECK (octet_length(envelope::text) <= 2048),
  read_at TIMESTAMPTZ,
  feed_event_id BIGINT REFERENCES feed_events(id) ON DELETE SET NULL,
  push_status VARCHAR(16) NOT NULL DEFAULT 'pending'
    CHECK (push_status IN ('pending', 'leased', 'sent', 'suppressed', 'failed')),
  push_attempts SMALLINT NOT NULL DEFAULT 0 CHECK (push_attempts BETWEEN 0 AND 5),
  push_due_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '5 seconds',
  PRIMARY KEY(message_id, recipient_user_id)
);
CREATE INDEX IF NOT EXISTS circle_chat_recipients_unread
  ON circle_chat_recipients(recipient_user_id, message_id) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS circle_chat_push_due
  ON circle_chat_recipients(push_due_at) WHERE push_status IN ('pending', 'leased');

CREATE TABLE IF NOT EXISTS circle_chat_preferences (
  circle_id UUID NOT NULL REFERENCES one_location_circles(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  muted BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY(circle_id, user_id)
);

-- Leaving also retires unread Feed projections and prevents queued pushes.
CREATE OR REPLACE FUNCTION circle_chat_membership_ended() RETURNS trigger AS $$
BEGIN
  IF NEW.status <> 'active' OR NEW.joined_at IS DISTINCT FROM OLD.joined_at THEN
    UPDATE feed_events SET read_at = COALESCE(read_at, now())
    WHERE id IN (
      SELECT r.feed_event_id FROM circle_chat_recipients r
      JOIN circle_chat_messages m ON m.id = r.message_id
      WHERE m.circle_id = NEW.circle_id AND r.recipient_user_id = NEW.user_id
    );
    UPDATE circle_chat_recipients r SET push_status = 'suppressed'
    FROM circle_chat_messages m
    WHERE m.id = r.message_id AND m.circle_id = NEW.circle_id
      AND r.recipient_user_id = NEW.user_id AND r.push_status IN ('pending', 'leased');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS circle_chat_membership_ended ON one_location_circle_memberships;
CREATE TRIGGER circle_chat_membership_ended AFTER UPDATE OF status, joined_at
  ON one_location_circle_memberships FOR EACH ROW EXECUTE FUNCTION circle_chat_membership_ended();

-- Removing a source message (including account erasure) removes its Feed
-- projections; a soft-deleted circle erases its encrypted attachments too.
CREATE OR REPLACE FUNCTION circle_chat_recipient_deleted() RETURNS trigger AS $$
BEGIN
  DELETE FROM feed_events WHERE id = OLD.feed_event_id;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS circle_chat_recipient_deleted ON circle_chat_recipients;
CREATE TRIGGER circle_chat_recipient_deleted AFTER DELETE ON circle_chat_recipients
  FOR EACH ROW EXECUTE FUNCTION circle_chat_recipient_deleted();

CREATE OR REPLACE FUNCTION circle_chat_circle_deleted() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'deleted' AND OLD.status <> 'deleted' THEN
    DELETE FROM circle_chat_messages WHERE circle_id = NEW.id;
    DELETE FROM circle_chat_preferences WHERE circle_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS circle_chat_circle_deleted ON one_location_circles;
CREATE TRIGGER circle_chat_circle_deleted AFTER UPDATE OF status ON one_location_circles
  FOR EACH ROW EXECUTE FUNCTION circle_chat_circle_deleted();

ALTER TABLE circle_chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE circle_chat_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE circle_chat_preferences ENABLE ROW LEVEL SECURITY;
SELECT install_account_deletion_write_guards();
COMMIT;
