BEGIN;

-- Reaction content is a fixed emoji choice; message bodies remain encrypted.
CREATE TABLE IF NOT EXISTS circle_chat_reactions (
  message_id UUID NOT NULL REFERENCES circle_chat_messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  emoji TEXT NOT NULL CHECK (emoji IN ('❤️', '😂', '😮', '😢', '👍', '🙏')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS circle_chat_reactions_message ON circle_chat_reactions(message_id, emoji);

CREATE TABLE IF NOT EXISTS circle_chat_membership_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  circle_id UUID NOT NULL REFERENCES one_location_circles(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('member_joined', 'member_left', 'member_removed')),
  subject_user_id TEXT REFERENCES actor_profiles(user_id) ON DELETE SET NULL,
  actor_user_id TEXT REFERENCES actor_profiles(user_id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS circle_chat_membership_events_page
  ON circle_chat_membership_events(circle_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION record_circle_chat_membership_event() RETURNS trigger AS $$
DECLARE
  event_kind TEXT;
  actor_id TEXT;
  event_id UUID;
  active_user RECORD;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'active' THEN RETURN NEW; END IF;
    event_kind := 'member_joined';
  ELSIF NEW.status = 'active' AND (OLD.status <> 'active' OR NEW.joined_at IS DISTINCT FROM OLD.joined_at) THEN
    event_kind := 'member_joined';
  ELSIF OLD.status = 'active' AND NEW.status IN ('left', 'removed') THEN
    event_kind := CASE WHEN NEW.status = 'left' THEN 'member_left' ELSE 'member_removed' END;
  ELSE
    RETURN NEW;
  END IF;

  IF event_kind = 'member_joined' THEN
    actor_id := NULLIF(NEW.metadata->>'addedBy', '');
  ELSIF event_kind = 'member_left' THEN
    actor_id := NEW.user_id;
  ELSE
    SELECT owner_user_id INTO actor_id FROM one_location_circles WHERE id = NEW.circle_id;
  END IF;
  IF actor_id IS NULL THEN actor_id := NEW.user_id; END IF;

  INSERT INTO circle_chat_membership_events(circle_id, kind, subject_user_id, actor_user_id)
  VALUES(NEW.circle_id, event_kind, NEW.user_id, actor_id) RETURNING id INTO event_id;

  -- The existing member-scoped long poll reauthorizes after waking. The event
  -- itself carries no message content or profile names in the notification.
  FOR active_user IN SELECT user_id FROM one_location_circle_memberships
    WHERE circle_id = NEW.circle_id AND status = 'active'
  LOOP
    PERFORM pg_notify('one_user_state_changed', json_build_object(
      'user_id', active_user.user_id, 'type', 'location_circle_chat_membership',
      'circle_id', NEW.circle_id, 'message_id', event_id)::text);
  END LOOP;

  IF event_kind <> 'member_joined' THEN
    DELETE FROM circle_chat_reactions reaction USING circle_chat_messages message
    WHERE reaction.message_id = message.id AND message.circle_id = NEW.circle_id
      AND reaction.user_id = NEW.user_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS circle_chat_membership_event ON one_location_circle_memberships;
CREATE TRIGGER circle_chat_membership_event
  AFTER INSERT OR UPDATE OF status, joined_at ON one_location_circle_memberships
  FOR EACH ROW EXECUTE FUNCTION record_circle_chat_membership_event();

ALTER TABLE circle_chat_reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE circle_chat_membership_events ENABLE ROW LEVEL SECURITY;
SELECT install_account_deletion_write_guards();

COMMIT;
