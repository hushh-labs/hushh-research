BEGIN;
LOCK TABLE pkm_events IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM one_todo_reminder_schedules WHERE due_at + interval '15 minutes' > now()) THEN
  RAISE EXCEPTION 'Cancel or preserve active task reminders before rolling back migration 428';
 END IF;
END $$;
DROP TRIGGER IF EXISTS one_todo_reminders_committed ON pkm_events;
DROP TRIGGER IF EXISTS one_todo_reminders_erased ON pkm_manifests;
DROP FUNCTION IF EXISTS project_one_todo_reminders();
DROP FUNCTION IF EXISTS erase_one_todo_reminders();
DELETE FROM system_push_outbox WHERE source_kind='todo_reminder';
DROP TABLE IF EXISTS one_todo_reminder_schedules;
ALTER TABLE system_push_outbox DROP CONSTRAINT system_push_outbox_source_kind_check;
ALTER TABLE system_push_outbox ADD CONSTRAINT system_push_outbox_source_kind_check
 CHECK (source_kind IN ('share','location_request','circle_member','connection_request'));
COMMIT;
