BEGIN;

DROP TRIGGER IF EXISTS calendar_grant_feed_projection ON google_service_grants;
DROP TRIGGER IF EXISTS calendar_proposal_feed_projection ON google_calendar_action_proposals;
DROP TRIGGER IF EXISTS calendar_legacy_delete_feed_projection ON google_calendar_action_proposals;
DROP TRIGGER IF EXISTS mail_connection_feed_projection ON kai_gmail_connections;
DROP TRIGGER IF EXISTS mail_information_request_feed_projection ON gmail_personal_information_requests;
DROP TRIGGER IF EXISTS mail_sync_feed_projection ON kai_gmail_sync_runs;
DROP TRIGGER IF EXISTS mail_send_feed_projection ON gmail_owner_send_actions;

DROP FUNCTION IF EXISTS feed_from_calendar_grant();
DROP FUNCTION IF EXISTS feed_from_calendar_proposal();
DROP FUNCTION IF EXISTS feed_from_calendar_legacy_delete();
DROP FUNCTION IF EXISTS feed_from_mail_connection();
DROP FUNCTION IF EXISTS feed_from_mail_information_request();
DROP FUNCTION IF EXISTS feed_from_mail_sync();
DROP FUNCTION IF EXISTS feed_from_mail_send();
DROP FUNCTION IF EXISTS project_calendar_mail_feed(TEXT, TEXT, TEXT, TIMESTAMPTZ);

-- Feed history remains useful and is intentionally not deleted by rollback.
COMMIT;
