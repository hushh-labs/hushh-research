-- Shared pacing and bounded sharing recovery; no source metadata or credentials.
BEGIN;
CREATE TABLE IF NOT EXISTS drive_rest_owner_admission (
 user_id TEXT NOT NULL,
 connection_generation BIGINT NOT NULL,
 connector_id TEXT NOT NULL DEFAULT 'google_drive' CHECK(connector_id='google_drive'),
 next_start_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 sharing_cooldown_until TIMESTAMPTZ,
 PRIMARY KEY(user_id,connection_generation),
 FOREIGN KEY(user_id,connector_id) REFERENCES user_external_connector_connections(user_id,connector_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS drive_rest_call_leases (
 lease_id UUID PRIMARY KEY,
 user_id TEXT NOT NULL,
 connection_generation BIGINT NOT NULL,
 expires_at TIMESTAMPTZ NOT NULL,
 FOREIGN KEY(user_id,connection_generation) REFERENCES drive_rest_owner_admission(user_id,connection_generation) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS drive_rest_call_leases_owner ON drive_rest_call_leases(user_id,connection_generation,expires_at);
ALTER TABLE drive_bulk_share_effects DROP CONSTRAINT IF EXISTS drive_bulk_share_effects_attempts_check;
ALTER TABLE drive_bulk_share_effects ADD CONSTRAINT drive_bulk_share_effects_attempts_check CHECK(attempts BETWEEN 0 AND 6);
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='drive_bulk_share_effects' AND column_name='sharing_quota_attempts') THEN
  ALTER TABLE drive_bulk_share_effects ADD COLUMN sharing_quota_attempts SMALLINT NOT NULL DEFAULT 0;
  ALTER TABLE drive_bulk_share_effects ADD COLUMN first_sharing_quota_at TIMESTAMPTZ;
  ALTER TABLE drive_bulk_share_effects ADD COLUMN ordinary_failure_attempts SMALLINT NOT NULL DEFAULT 0 CHECK(ordinary_failure_attempts BETWEEN 0 AND 5);
  -- Existing claim counts are conservative evidence, not a recovered refusal log.
  -- Anchor old quota recovery to the last recorded refusal; its first is unknown.
  UPDATE drive_bulk_share_effects SET
   ordinary_failure_attempts=CASE WHEN safe_error_code='sharing_rate_limited' THEN 0 ELSE LEAST(attempts,5) END,
   sharing_quota_attempts=CASE WHEN safe_error_code='sharing_rate_limited' THEN LEAST(attempts,5) ELSE 0 END,
   first_sharing_quota_at=CASE WHEN safe_error_code='sharing_rate_limited' THEN updated_at ELSE NULL END;
 END IF;
END $$;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='drive_bulk_share_effects_quota_attempts_check') THEN
  ALTER TABLE drive_bulk_share_effects ADD CONSTRAINT drive_bulk_share_effects_quota_attempts_check CHECK(sharing_quota_attempts BETWEEN 0 AND 6);
 END IF;
END $$;
DO $$ DECLARE t TEXT; r TEXT; BEGIN
 FOREACH t IN ARRAY ARRAY['drive_rest_owner_admission','drive_rest_call_leases'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',t);
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
   IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN EXECUTE format('REVOKE ALL ON %I FROM %I',t,r); END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO service_role',t); END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_proc WHERE proname='install_account_deletion_write_guards') THEN PERFORM public.install_account_deletion_write_guards(); END IF;
END $$;
COMMIT;
