BEGIN;
DROP TRIGGER IF EXISTS push_sms_alarm_capability_fenced ON user_push_installations;
DROP FUNCTION IF EXISTS fence_sms_alarm_capability();
ALTER TABLE user_push_installations DROP COLUMN IF EXISTS sms_alarm_version;
COMMIT;
