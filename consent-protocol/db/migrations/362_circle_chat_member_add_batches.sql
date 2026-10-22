BEGIN;

-- A reviewed multi-person add remains one action in Circle chat. Existing
-- history has no reliable action boundary and deliberately keeps NULL here.
ALTER TABLE circle_chat_membership_events ADD COLUMN IF NOT EXISTS batch_id UUID;
CREATE INDEX IF NOT EXISTS circle_chat_membership_events_batch
  ON circle_chat_membership_events(circle_id, batch_id)
  WHERE batch_id IS NOT NULL;

CREATE OR REPLACE FUNCTION record_circle_chat_membership_event() RETURNS trigger AS $$
DECLARE
  event_kind TEXT;
  actor_id TEXT;
  event_id UUID;
  event_batch_id UUID;
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
    -- The service sets this only around one reviewed membership write loop.
    -- Membership metadata does not retain it across leave/rejoin.
    event_batch_id := NULLIF(current_setting('hushh.circle_member_add_batch_id', true), '')::uuid;
  ELSIF event_kind = 'member_left' THEN
    actor_id := NEW.user_id;
  ELSE
    SELECT owner_user_id INTO actor_id FROM one_location_circles WHERE id = NEW.circle_id;
  END IF;
  IF actor_id IS NULL THEN actor_id := NEW.user_id; END IF;

  INSERT INTO circle_chat_membership_events(circle_id, kind, subject_user_id, actor_user_id, batch_id)
  VALUES(NEW.circle_id, event_kind, NEW.user_id, actor_id, event_batch_id)
  RETURNING id INTO event_id;

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

COMMIT;
