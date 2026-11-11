BEGIN;

-- This SQL fence is shared by the reminder enqueue and the existing system
-- push dispatcher. It checks live, account-specific authority at send time.
CREATE OR REPLACE FUNCTION calendar_email_followup_grant_current(
  m calendar_email_followup_monitors
) RETURNS BOOLEAN LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
  SELECT CASE WHEN m.account_id = 'default' THEN EXISTS (
    SELECT 1 FROM google_provider_connections c
    JOIN google_service_grants g ON g.user_id=c.user_id AND g.provider='google'
      AND g.service='calendar'
    JOIN kai_gmail_connections k ON k.user_id=c.user_id
    WHERE c.user_id=m.user_id AND c.provider='google' AND c.status='connected'
      AND c.connected_at=m.calendar_connected_at
      AND c.provider_subject IS NOT NULL
      AND encode(digest(c.provider_subject,'sha256'),'hex')=m.provider_subject_sha256
      AND g.status='connected' AND g.xmin::text=m.calendar_grant_revision
      AND k.status='connected' AND k.revoked=FALSE AND k.google_sub=c.provider_subject
      AND k.followup_read_generation=m.mail_generation
      AND 'https://www.googleapis.com/auth/gmail.readonly' = ANY(
        regexp_split_to_array(k.scope_csv,'[ ,]+'))
  ) ELSE EXISTS (
    SELECT 1 FROM google_calendar_additional_accounts a
    WHERE a.user_id=m.user_id AND a.account_id=m.account_id
      AND a.status='connected' AND a.gmail_read_enabled=TRUE
      AND a.gmail_read_generation=m.mail_generation
      AND a.connected_at=m.calendar_connected_at
      AND encode(digest(a.provider_subject,'sha256'),'hex')=m.provider_subject_sha256
      AND 'https://www.googleapis.com/auth/gmail.readonly' = ANY(
        regexp_split_to_array(a.scope_csv,'[ ,]+'))
      AND ARRAY[
        'https://www.googleapis.com/auth/calendar.events.readonly',
        'https://www.googleapis.com/auth/calendar.events',
        'https://www.googleapis.com/auth/calendar.readonly',
        'https://www.googleapis.com/auth/calendar'
      ] && regexp_split_to_array(a.scope_csv,'[ ,]+')
      AND ARRAY[
        'https://www.googleapis.com/auth/calendar.freebusy',
        'https://www.googleapis.com/auth/calendar.events.freebusy',
        'https://www.googleapis.com/auth/calendar.readonly',
        'https://www.googleapis.com/auth/calendar'
      ] && regexp_split_to_array(a.scope_csv,'[ ,]+')
  ) END;
$$;

ALTER TABLE system_push_outbox DROP CONSTRAINT IF EXISTS system_push_outbox_source_kind_check;
ALTER TABLE system_push_outbox ADD CONSTRAINT system_push_outbox_source_kind_check
  CHECK (source_kind IN ('share','location_request','circle_member','connection_request',
                        'calendar_email_followup'));

ALTER TABLE feed_events DROP CONSTRAINT IF EXISTS feed_events_source_domain_check;
ALTER TABLE feed_events ADD CONSTRAINT feed_events_source_domain_check
  CHECK (source_domain IN ('consent','location','kai','kyc','connected_systems',
                          'connections','pwm','calendar_email_followup'));

SELECT install_account_deletion_write_guards();
COMMIT;
