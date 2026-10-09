BEGIN;

-- The owner summary reads aggregate accepted link openings from the existing
-- attribution authority. This also covers QR navigation without storing a
-- second event or claiming that an opening identifies a unique person.
CREATE INDEX IF NOT EXISTS one_referral_attributions_owner_opened
  ON one_referral_attributions (referrer_user_id, first_seen_at DESC);

CREATE OR REPLACE FUNCTION one_referral_attribution_notify()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_notify(
    'one_referral_changed',
    json_build_object(
      'referrer_user_id', NEW.referrer_user_id,
      'reason', 'link_opened'
    )::TEXT
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS one_referral_attributions_notify
  ON one_referral_attributions;
CREATE TRIGGER one_referral_attributions_notify
  AFTER INSERT ON one_referral_attributions
  FOR EACH ROW
  EXECUTE FUNCTION one_referral_attribution_notify();

COMMIT;
