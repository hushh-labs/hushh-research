-- Migration 167: push referral changes instead of waiting to be asked.
--
-- The Referrals tab was polling. A count that only moves when someone reloads
-- is wrong the moment it is drawn, because a referral changes state from
-- something the OTHER person did -- they finished setup, they opened an agent,
-- their credited minutes crossed the bar. The referrer is not touching anything
-- when any of that happens.
--
-- So the database says so. Every write that can change what the tab shows
-- raises a NOTIFY carrying the REFERRER's id; the backend holds one LISTEN
-- connection per instance and pushes to that referrer's open stream.
--
-- WHY THE PAYLOAD IS ALMOST EMPTY. NOTIFY is capped at 8000 bytes and, more
-- importantly, its payload travels to every listening connection on the
-- database. So it carries the referrer id and a reason -- never the referred
-- person's id, never their agent, never a count. The stream is a doorbell: it
-- says "your referrals changed", and the client re-reads the summary through
-- the authenticated endpoint that already decides what that referrer may see.
-- Putting the data in the payload would mean re-implementing that privacy
-- decision in a trigger, and getting it wrong somewhere nobody would look.
--
-- WHY ENGAGEMENT SESSIONS NOTIFY TOO. Credited minutes are the number that
-- moves most often and the one a person actually watches. A session row is
-- updated on every heartbeat, so this fires at most once per heartbeat per
-- referred user, and only when that user is actually somebody's referral --
-- the lookup returns no rows otherwise and nothing is sent.

BEGIN;

CREATE OR REPLACE FUNCTION one_referral_relationship_notify()
RETURNS TRIGGER AS $$
DECLARE
  row_data one_referral_relationships;
BEGIN
  row_data := COALESCE(NEW, OLD);

  -- A status that did not move cannot change what the tab shows. Skipping the
  -- no-op keeps a bulk UPDATE from waking every open stream for nothing.
  IF TG_OP = 'UPDATE' AND NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  PERFORM pg_notify(
    'one_referral_changed',
    json_build_object(
      'referrer_user_id', row_data.referrer_user_id,
      'reason', 'relationship_' || lower(TG_OP)
    )::TEXT
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS one_referral_relationships_notify
  ON one_referral_relationships;

CREATE TRIGGER one_referral_relationships_notify
  AFTER INSERT OR UPDATE ON one_referral_relationships
  FOR EACH ROW
  EXECUTE FUNCTION one_referral_relationship_notify();


CREATE OR REPLACE FUNCTION one_agent_engagement_session_notify()
RETURNS TRIGGER AS $$
DECLARE
  referrer TEXT;
BEGIN
  -- Only credited time is worth waking a stream for. A heartbeat that earned
  -- nothing (backgrounded, idle, replayed) changes no number on the screen.
  IF TG_OP = 'UPDATE'
     AND NEW.credited_active_seconds = OLD.credited_active_seconds
     AND NEW.meaningful_event_count = OLD.meaningful_event_count THEN
    RETURN NEW;
  END IF;

  SELECT r.referrer_user_id INTO referrer
    FROM one_referral_relationships r
   WHERE r.referred_user_id = NEW.user_id
   LIMIT 1;

  -- This person is nobody's referral. Say nothing.
  IF referrer IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM pg_notify(
    'one_referral_changed',
    json_build_object(
      'referrer_user_id', referrer,
      'reason', 'engagement'
    )::TEXT
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS one_agent_engagement_sessions_notify
  ON one_agent_engagement_sessions;

CREATE TRIGGER one_agent_engagement_sessions_notify
  AFTER INSERT OR UPDATE ON one_agent_engagement_sessions
  FOR EACH ROW
  EXECUTE FUNCTION one_agent_engagement_session_notify();

-- The engagement trigger looks up the relationship by the REFERRED user on
-- every credited heartbeat. Without this that is a sequential scan on the hot
-- path of the whole program.
CREATE INDEX IF NOT EXISTS one_referral_relationships_referred_lookup
  ON one_referral_relationships (referred_user_id);

COMMENT ON FUNCTION one_referral_relationship_notify() IS
  'Raises NOTIFY one_referral_changed carrying only the referrer id and a reason. The stream is a doorbell; the client re-reads the authenticated summary, which owns what a referrer may see.';

COMMIT;
