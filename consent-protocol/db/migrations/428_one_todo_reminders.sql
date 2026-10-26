BEGIN;

CREATE TABLE IF NOT EXISTS one_todo_reminder_schedules (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id TEXT NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
 task_ref UUID NOT NULL,
 due_at TIMESTAMPTZ,
 generation BIGINT NOT NULL DEFAULT 1 CHECK (generation > 0),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(user_id, task_ref)
);
ALTER TABLE one_todo_reminder_schedules ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON one_todo_reminder_schedules FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  GRANT ALL ON one_todo_reminder_schedules TO service_role;
 END IF;
END $$;

ALTER TABLE system_push_outbox DROP CONSTRAINT system_push_outbox_source_kind_check;
ALTER TABLE system_push_outbox ADD CONSTRAINT system_push_outbox_source_kind_check
 CHECK (source_kind IN ('share','location_request','circle_member','connection_request','todo_reminder'));

-- The existing PKM compare-and-swap transaction inserts this event only after
-- accepting the encrypted write. A failed schedule rolls back that same write.
-- Strip the transient timing projection from the retained audit event.
CREATE OR REPLACE FUNCTION project_one_todo_reminders() RETURNS trigger AS $$
DECLARE snapshot JSONB; item JSONB; wanted UUID[] := ARRAY[]::UUID[];
 source UUID; version BIGINT; due TIMESTAMPTZ; task UUID;
BEGIN
 IF NEW.domain <> 'one_todos' OR NEW.operation_type <> 'content_write' THEN RETURN NEW; END IF;
 -- Delivery locks its outbox row before rechecking the schedule. Keep that
 -- same order for cancellation/rescheduling to avoid a send/edit deadlock.
 PERFORM id FROM system_push_outbox WHERE source_kind='todo_reminder'
  AND recipient_user_id=NEW.user_id AND status IN ('pending','leased') ORDER BY id FOR UPDATE;
 snapshot := COALESCE(NEW.metadata->'todo_reminders_v1', '{"items":[]}'::JSONB);
 IF jsonb_typeof(snapshot->'items') <> 'array' OR jsonb_array_length(snapshot->'items') > 5000 THEN
  RAISE EXCEPTION 'Invalid reminder snapshot';
 END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(snapshot->'items') LOOP
  task := (item->>'task_ref')::UUID;
  IF task = ANY(wanted) THEN RAISE EXCEPTION 'Duplicate reminder identity'; END IF;
  wanted := array_append(wanted, task);
  due := (item->>'due_at')::TIMESTAMPTZ;
  IF due IS NULL OR NOT isfinite(due) THEN RAISE EXCEPTION 'Invalid reminder time'; END IF;
  source := NULL;
  INSERT INTO one_todo_reminder_schedules(user_id,task_ref,due_at)
   VALUES(NEW.user_id,task,due)
   ON CONFLICT(user_id,task_ref) DO UPDATE SET due_at=EXCLUDED.due_at,
    generation=one_todo_reminder_schedules.generation+1,updated_at=now()
    WHERE one_todo_reminder_schedules.due_at IS DISTINCT FROM EXCLUDED.due_at
   RETURNING id,generation INTO source,version;
  IF source IS NOT NULL AND due + interval '15 minutes' > now() THEN
   INSERT INTO system_push_outbox(source_kind,source_id,source_revision,recipient_user_id,due_at,expires_at)
    VALUES('todo_reminder',source,version::TEXT,NEW.user_id,due,due+interval '15 minutes')
    ON CONFLICT DO NOTHING;
  END IF;
 END LOOP;
 UPDATE one_todo_reminder_schedules SET due_at=NULL,generation=generation+1,updated_at=now()
  WHERE user_id=NEW.user_id AND due_at IS NOT NULL AND NOT(task_ref=ANY(wanted));
 UPDATE system_push_outbox o SET status='suppressed',lease_id=NULL
  WHERE o.source_kind='todo_reminder' AND o.recipient_user_id=NEW.user_id
   AND o.status IN ('pending','leased') AND NOT EXISTS (
    SELECT 1 FROM one_todo_reminder_schedules s WHERE s.id=o.source_id
     AND s.user_id=NEW.user_id AND s.due_at IS NOT NULL AND s.generation::TEXT=o.source_revision);
 NEW.metadata := NEW.metadata - 'todo_reminders_v1';
 PERFORM pg_notify('system_push_ready','');
 RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path=public,pg_temp;
REVOKE ALL ON FUNCTION project_one_todo_reminders() FROM PUBLIC;

-- Reset/erase of the encrypted domain removes its operational reminder state.
CREATE OR REPLACE FUNCTION erase_one_todo_reminders() RETURNS trigger AS $$
BEGIN
 IF OLD.domain = 'one_todos' THEN
  DELETE FROM system_push_outbox WHERE source_kind='todo_reminder' AND recipient_user_id=OLD.user_id;
  DELETE FROM one_todo_reminder_schedules WHERE user_id=OLD.user_id;
 END IF;
 RETURN OLD;
END;
$$ LANGUAGE plpgsql SET search_path=public,pg_temp;
REVOKE ALL ON FUNCTION erase_one_todo_reminders() FROM PUBLIC;
-- Canonical replay must preserve live schedules and hot-table trigger objects.
-- Create missing triggers and refuse drift rather than replacing installed ones.
DO $$
DECLARE spec RECORD; installed RECORD; relation REGCLASS;
BEGIN
 FOR spec IN SELECT * FROM (VALUES
  ('one_todo_reminders_committed','pkm_events','BEFORE INSERT','project_one_todo_reminders',7),
  ('one_todo_reminders_erased','pkm_manifests','AFTER DELETE','erase_one_todo_reminders',9)
 ) AS definitions(name,table_name,events,function_name,trigger_type) LOOP
  relation := format('public.%I',spec.table_name)::REGCLASS;
  SELECT * INTO installed FROM pg_trigger
   WHERE tgrelid=relation AND tgname=spec.name AND NOT tgisinternal;
  IF NOT FOUND THEN
   EXECUTE format('CREATE TRIGGER %I %s ON public.%I FOR EACH ROW EXECUTE FUNCTION public.%I()',
    spec.name,spec.events,spec.table_name,spec.function_name);
  ELSIF installed.tgfoid <> format('public.%I()',spec.function_name)::REGPROCEDURE::OID
   OR installed.tgtype <> spec.trigger_type OR installed.tgenabled <> 'O'
   OR installed.tgqual IS NOT NULL OR installed.tgnargs <> 0
   OR installed.tgattr::TEXT <> '' OR installed.tgconstraint <> 0
   OR installed.tgoldtable IS NOT NULL OR installed.tgnewtable IS NOT NULL THEN
   RAISE EXCEPTION 'Task reminder trigger has unexpected definition: %',spec.name;
  END IF;
 END LOOP;
END $$;
DO $$ BEGIN PERFORM public.install_account_deletion_write_guards(); END $$;
COMMIT;
