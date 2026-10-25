-- Owner financial discovery can exhaust provider pages; ordinary search remains bounded.
-- Metadata capacity grants no reading, publication, checkout or sharing authority.
BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='drive_owner_search_jobs'::regclass
   AND tgname='drive_owner_search_capacity') THEN
  ALTER TABLE drive_owner_search_jobs DROP CONSTRAINT drive_owner_search_jobs_matched_check;
  ALTER TABLE drive_owner_search_jobs ADD CONSTRAINT drive_owner_search_jobs_matched_check CHECK(matched>=0);
  ALTER TABLE drive_owner_search_jobs DROP CONSTRAINT drive_owner_search_jobs_unshareable_count_check;
  ALTER TABLE drive_owner_search_jobs ADD CONSTRAINT drive_owner_search_jobs_unshareable_count_check CHECK(unshareable_count>=0);
  ALTER TABLE drive_owner_search_results DROP CONSTRAINT drive_owner_search_results_position_check;
  ALTER TABLE drive_owner_search_results ADD CONSTRAINT drive_owner_search_results_position_check CHECK(position>=1);
  ALTER TABLE drive_packet_heads DROP CONSTRAINT drive_packet_public_summary_policy;
  ALTER TABLE drive_packet_heads ADD CONSTRAINT drive_packet_public_summary_policy CHECK (
   public_summary_revision>=0 AND (public_summary_version IS NULL OR public_summary_version>=0)
   AND (preview_document_count IS NULL OR (preview_document_count>=0 AND
     (preview_document_count<=10000 OR (packet_kind='provider_discovery' AND category='financial'))))
   AND (NOT public_summary_enabled OR (packet_kind='provider_discovery' AND category='financial'
   AND public_summary_version IS NOT NULL AND public_summary_generation IS NOT NULL
   AND public_summary_disclosure IS NOT NULL AND public_summary_generation=connection_generation
   AND public_summary_disclosure='drive-packet-public-summary-v1' AND public_summary_accepted_at IS NOT NULL)));
 END IF;
END $$;
CREATE OR REPLACE FUNCTION guard_drive_owner_search_capacity() RETURNS trigger
 LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE extended BOOLEAN;
BEGIN
 IF TG_TABLE_NAME='drive_owner_search_results' THEN
  IF NEW.position<=10000 THEN RETURN NEW; END IF;
  PERFORM 1 FROM drive_owner_search_jobs j JOIN drive_packet_heads h ON h.packet_id=j.period_packet_id
   WHERE j.job_id=NEW.job_id AND j.user_id=NEW.user_id AND h.user_id=j.user_id
   AND h.connection_generation=j.connection_generation AND h.packet_kind='provider_discovery'
   AND h.category='financial' FOR SHARE OF j,h;
  IF NOT FOUND THEN RAISE check_violation USING MESSAGE='ordinary search result capacity exceeded'; END IF;
 ELSE
  extended := NEW.matched>10000 OR NEW.unshareable_count>10000
   OR EXISTS(SELECT 1 FROM drive_owner_search_results WHERE job_id=NEW.job_id AND position>10000);
  IF NOT extended THEN RETURN NEW; END IF;
  PERFORM 1 FROM drive_packet_heads h WHERE h.packet_id=NEW.period_packet_id
   AND h.user_id=NEW.user_id AND h.connection_generation=NEW.connection_generation
   AND h.packet_kind='provider_discovery' AND h.category='financial' FOR SHARE;
  IF NOT FOUND THEN RAISE check_violation USING MESSAGE='ordinary search capacity exceeded'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION preserve_financial_discovery_capacity() RETURNS trigger
 LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
 IF (NEW.user_id,NEW.connection_generation,NEW.packet_kind,NEW.category)
   IS DISTINCT FROM (OLD.user_id,OLD.connection_generation,OLD.packet_kind,OLD.category)
   AND EXISTS(SELECT 1 FROM drive_owner_search_jobs j WHERE j.period_packet_id=OLD.packet_id
    AND (j.matched>10000 OR j.unshareable_count>10000 OR EXISTS(
     SELECT 1 FROM drive_owner_search_results r WHERE r.job_id=j.job_id AND r.position>10000))) THEN
  RAISE check_violation USING MESSAGE='retained financial discovery scope cannot change';
 END IF;
 RETURN NEW;
END $$;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='drive_owner_search_jobs'::regclass
   AND tgname='drive_owner_search_capacity') THEN
  CREATE TRIGGER drive_owner_search_capacity BEFORE INSERT OR UPDATE OF matched,unshareable_count,
   period_packet_id,user_id,connection_generation ON drive_owner_search_jobs
   FOR EACH ROW EXECUTE FUNCTION guard_drive_owner_search_capacity();
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='drive_owner_search_results'::regclass
   AND tgname='drive_owner_search_result_capacity') THEN
  CREATE TRIGGER drive_owner_search_result_capacity BEFORE INSERT OR UPDATE OF position,job_id,user_id
   ON drive_owner_search_results FOR EACH ROW EXECUTE FUNCTION guard_drive_owner_search_capacity();
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='drive_packet_heads'::regclass
   AND tgname='preserve_financial_discovery_capacity') THEN
  CREATE TRIGGER preserve_financial_discovery_capacity BEFORE UPDATE OF user_id,connection_generation,
   packet_kind,category ON drive_packet_heads FOR EACH ROW EXECUTE FUNCTION preserve_financial_discovery_capacity();
 END IF;
END $$;
-- Re-admit only the legacy capped preparation. Runtime revalidates current
-- processing authority, frozen provenance and lease before any provider call.
UPDATE drive_packet_heads h SET attempts=0,next_at=LEAST(h.next_at,clock_timestamp())
 WHERE h.packet_kind='provider_discovery' AND h.category='financial' AND h.current_version=0
 AND h.error_code='search_limit' AND EXISTS(SELECT 1 FROM drive_owner_search_jobs j
  WHERE j.period_packet_id=h.packet_id AND j.user_id=h.user_id
   AND j.connection_generation=h.connection_generation AND j.status='limited'
   AND j.error_code='search_limit' AND j.matched=10000);
COMMIT;
