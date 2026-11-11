BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM system_push_outbox WHERE source_kind='calendar_email_followup')
     OR EXISTS (SELECT 1 FROM feed_events WHERE source_domain='calendar_email_followup') THEN
    RAISE EXCEPTION 'Clear calendar email follow-up delivery rows before rollback';
  END IF;
END $$;
ALTER TABLE system_push_outbox DROP CONSTRAINT IF EXISTS system_push_outbox_source_kind_check;
ALTER TABLE system_push_outbox ADD CONSTRAINT system_push_outbox_source_kind_check
  CHECK (source_kind IN ('share','location_request','circle_member','connection_request'));
ALTER TABLE feed_events DROP CONSTRAINT IF EXISTS feed_events_source_domain_check;
ALTER TABLE feed_events ADD CONSTRAINT feed_events_source_domain_check
  CHECK (source_domain IN ('consent','location','kai','kyc','connected_systems',
                          'connections','pwm'));
DROP FUNCTION IF EXISTS calendar_email_followup_grant_current(calendar_email_followup_monitors);
COMMIT;
