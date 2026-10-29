BEGIN;

ALTER TABLE user_push_installations
 ADD COLUMN IF NOT EXISTS sms_alarm_version SMALLINT NOT NULL DEFAULT 0;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='user_push_installations'::regclass
                AND conname='push_installation_sms_alarm_version_check') THEN
  ALTER TABLE user_push_installations ADD CONSTRAINT push_installation_sms_alarm_version_check
   CHECK (sms_alarm_version IN (0, 1));
 END IF;
END $$;

-- Only an updated registrar can attest the compiled Android alarm renderer.
-- Old serving/rollback registrars must reset the capability on re-registration.
CREATE OR REPLACE FUNCTION fence_sms_alarm_capability() RETURNS trigger AS $$
BEGIN
 IF current_setting('hushh.sms_alarm_registration', true) IS DISTINCT FROM '1' THEN
  NEW.sms_alarm_version := 0;
 END IF;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION fence_sms_alarm_capability() FROM PUBLIC;
DROP TRIGGER IF EXISTS push_sms_alarm_capability_fenced ON user_push_installations;
CREATE TRIGGER push_sms_alarm_capability_fenced BEFORE INSERT OR UPDATE
 ON user_push_installations FOR EACH ROW EXECUTE FUNCTION fence_sms_alarm_capability();

COMMIT;
