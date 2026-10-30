-- Owner-device prepared copies. Object bytes and content-key envelopes are
-- client encrypted; the runtime has no file-decryption key. No Files/pod schema.
BEGIN;
CREATE TABLE IF NOT EXISTS document_delivery_contracts (
 request_id UUID PRIMARY KEY REFERENCES drive_share_requests(request_id) ON DELETE CASCADE,
 owner_user_id TEXT NOT NULL,
 recipient_user_id TEXT NOT NULL CHECK(recipient_user_id<>owner_user_id),
 receive_through TEXT NOT NULL CHECK(receive_through IN ('one','both')),
 revision BIGINT NOT NULL DEFAULT 0 CHECK(revision>=0),
 status TEXT NOT NULL DEFAULT 'requested' CHECK(status IN
   ('requested','preparing','staged','approved','released','revoked','expired','erasing')),
 activity_disclosure_version TEXT NOT NULL CHECK(activity_disclosure_version='one-document-activity-v1'),
 copy_disclosure_version TEXT CHECK(copy_disclosure_version='one-document-copy-v1'),
 activity_accepted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 copy_accepted_at TIMESTAMPTZ,
 recipient_key_id TEXT NOT NULL,
 recipient_key_fingerprint TEXT NOT NULL CHECK(recipient_key_fingerprint ~ '^[0-9a-f]{64}$'),
 generation_id UUID,
 preparation_digest TEXT CHECK(preparation_digest ~ '^[0-9a-f]{64}$'),
 source_selection_digest TEXT CHECK(source_selection_digest ~ '^[0-9a-f]{64}$'),
 selection_envelope JSONB,
 amount_cents INTEGER CHECK(amount_cents BETWEEN 50 AND 50000),
 access_expires_at TIMESTAMPTZ NOT NULL,
 preparation_expires_at TIMESTAMPTZ,
 current_package_id UUID,
 approved_at TIMESTAMPTZ,
 accepted_at TIMESTAMPTZ,
 accepted_terms_digest TEXT,
 accepted_package_digest TEXT,
 hosted_revoked_at TIMESTAMPTZ,
 drive_revoke_status TEXT NOT NULL DEFAULT 'not_requested' CHECK(drive_revoke_status IN
   ('not_requested','pending','removed','needs_attention')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS document_delivery_contract_participants ON document_delivery_contracts(recipient_user_id,created_at DESC);
CREATE TABLE IF NOT EXISTS document_delivery_public_keys (
 user_id TEXT NOT NULL,
 key_id TEXT NOT NULL,
 public_key TEXT NOT NULL,
 fingerprint TEXT NOT NULL CHECK(fingerprint ~ '^[0-9a-f]{64}$'),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(user_id,key_id)
);
CREATE TABLE IF NOT EXISTS document_delivery_packages (
 package_id UUID PRIMARY KEY,
 request_id UUID NOT NULL REFERENCES document_delivery_contracts(request_id) ON DELETE CASCADE,
 revision BIGINT NOT NULL,
 generation_id UUID NOT NULL,
 preparation_digest TEXT NOT NULL,
 content_commitment TEXT NOT NULL,
 terms JSONB NOT NULL,
 terms_digest TEXT NOT NULL,
 package_digest TEXT NOT NULL,
 artifacts JSONB NOT NULL,
 wraps JSONB NOT NULL,
 amendment_of UUID REFERENCES document_delivery_packages(package_id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(request_id,revision)
);
CREATE TABLE IF NOT EXISTS document_delivery_artifacts (
 artifact_id UUID PRIMARY KEY,
 request_id UUID NOT NULL REFERENCES document_delivery_contracts(request_id) ON DELETE CASCADE,
 generation_id UUID NOT NULL,
 file_ref UUID,
 role TEXT NOT NULL CHECK(role IN ('original','watermarked','manifest')),
 descriptor JSONB NOT NULL,
 upload_id UUID NOT NULL UNIQUE,
 bucket_identity TEXT NOT NULL,
 object_key TEXT NOT NULL UNIQUE,
 state TEXT NOT NULL DEFAULT 'reserved' CHECK(state IN
   ('reserved','writing','uploaded','finalized','uncertain','deleting','deleted')),
 object_generation TEXT,
 expires_at TIMESTAMPTZ NOT NULL,
 finalized_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 CHECK((role='manifest')=(file_ref IS NULL))
);
CREATE INDEX IF NOT EXISTS document_delivery_artifact_cleanup ON document_delivery_artifacts(expires_at)
 WHERE state NOT IN ('deleted','finalized');
ALTER TABLE document_delivery_artifacts
 ADD COLUMN IF NOT EXISTS upload_session_envelope JSONB,
 ADD COLUMN IF NOT EXISTS session_observed_at TIMESTAMPTZ,
 ADD COLUMN IF NOT EXISTS write_dispatched_at TIMESTAMPTZ,
 ADD COLUMN IF NOT EXISTS write_settled_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS document_delivery_file_receipts (
 request_id UUID NOT NULL REFERENCES document_delivery_contracts(request_id) ON DELETE CASCADE,
 file_ref UUID NOT NULL,
 hosted_released_at TIMESTAMPTZ,
 drive_state TEXT NOT NULL DEFAULT 'not_required' CHECK(drive_state IN
   ('not_required','pending','confirmed','failed','unknown')),
 drive_receipt_envelope JSONB,
 PRIMARY KEY(request_id,file_ref)
);
ALTER TABLE document_delivery_file_receipts ADD COLUMN IF NOT EXISTS grant_operation_id UUID
 REFERENCES drive_share_permission_operations(operation_id) ON DELETE SET NULL;
CREATE TABLE IF NOT EXISTS document_delivery_key_challenges (
 challenge_id UUID PRIMARY KEY,
 request_id UUID NOT NULL REFERENCES document_delivery_contracts(request_id) ON DELETE CASCADE,
 user_id TEXT NOT NULL,
 key_id TEXT NOT NULL,
 fingerprint TEXT NOT NULL,
 nonce_hash TEXT NOT NULL,
 expires_at TIMESTAMPTZ NOT NULL,
 consumed_at TIMESTAMPTZ,
 verified_at TIMESTAMPTZ
);
ALTER TABLE document_delivery_key_challenges
 ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'delivery' CHECK(purpose IN ('delivery','recovery')),
 ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp();
CREATE INDEX IF NOT EXISTS document_delivery_verified_key ON document_delivery_key_challenges(request_id,key_id,fingerprint)
 WHERE verified_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS document_delivery_activity (
 sequence BIGSERIAL PRIMARY KEY,
 request_id UUID NOT NULL REFERENCES document_delivery_contracts(request_id) ON DELETE CASCADE,
 interaction_id UUID NOT NULL,
 event_id UUID NOT NULL,
 artifact_id UUID,
 provenance TEXT NOT NULL CHECK(provenance IN ('server','client')),
 kind TEXT NOT NULL CHECK(kind IN ('package_released','ciphertext_served','preview_rendered',
   'decrypt_failed','download_requested','handoff_reported','hosted_revoked','erasure_fenced')),
 outcome TEXT NOT NULL CHECK(outcome IN ('success','cancelled','failed')),
 actor_user_id TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(request_id,event_id)
);
CREATE INDEX IF NOT EXISTS document_delivery_activity_request ON document_delivery_activity(request_id,sequence);
CREATE TABLE IF NOT EXISTS document_delivery_idempotency (
 request_id UUID NOT NULL REFERENCES document_delivery_contracts(request_id) ON DELETE CASCADE,
 idempotency_key UUID NOT NULL,
 operation TEXT NOT NULL,
 body_digest TEXT NOT NULL,
 result JSONB,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(request_id,idempotency_key)
);
-- Financial evidence has the existing obligation lifetime, with no participant
-- identity/source metadata. Original paid commitments survive key amendments.
CREATE TABLE IF NOT EXISTS document_delivery_financial_bindings (
 request_id UUID PRIMARY KEY,
 receive_through TEXT NOT NULL CHECK(receive_through IN ('one','both')),
 original_terms_digest TEXT NOT NULL,
 original_package_digest TEXT NOT NULL,
 content_commitment TEXT NOT NULL,
 amount_cents INTEGER NOT NULL CHECK(amount_cents BETWEEN 50 AND 50000),
 expected_count INTEGER NOT NULL CHECK(expected_count BETWEEN 1 AND 25),
 confirmed_count INTEGER NOT NULL DEFAULT 0,
 unsettled_count INTEGER NOT NULL DEFAULT 0,
 erased_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
-- Independent inventory survives request/account cascades until exact-generation
-- removal is observed. It contains only opaque object coordinates, no keys.
CREATE TABLE IF NOT EXISTS document_delivery_cleanup (
 cleanup_id UUID PRIMARY KEY,
 request_id UUID NOT NULL,
 bucket_identity TEXT NOT NULL,
 object_key TEXT NOT NULL UNIQUE,
 object_generation TEXT,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','unknown','removed','needs_attention')),
 attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 removed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS document_delivery_cleanup_pending ON document_delivery_cleanup(next_attempt_at)
 WHERE status IN ('pending','unknown');
ALTER TABLE document_delivery_cleanup
 ADD COLUMN IF NOT EXISTS upload_session_envelope JSONB,
 ADD COLUMN IF NOT EXISTS session_observed_at TIMESTAMPTZ,
 ADD COLUMN IF NOT EXISTS write_dispatched_at TIMESTAMPTZ,
 ADD COLUMN IF NOT EXISTS write_settled_at TIMESTAMPTZ,
 ADD COLUMN IF NOT EXISTS ciphertext_bytes INTEGER;
CREATE OR REPLACE FUNCTION document_delivery_summary_for(target UUID)
RETURNS TABLE(expected BIGINT,confirmed BIGINT,unsettled BIGINT)
LANGUAGE sql STABLE SET search_path FROM CURRENT AS $$
 SELECT COUNT(f.file_ref),
  COUNT(f.file_ref) FILTER(WHERE f.hosted_released_at IS NOT NULL
   AND (c.receive_through='one' OR f.drive_state='confirmed')),
  COUNT(f.file_ref) FILTER(WHERE f.drive_state='unknown' OR EXISTS(SELECT 1
   FROM drive_share_permission_operations p WHERE p.operation_id=f.grant_operation_id
    AND p.state IN ('dispatching','unknown','present_unattributed')) OR (
   c.status NOT IN ('revoked','expired','erasing') AND c.access_expires_at>clock_timestamp()
   AND (f.hosted_released_at IS NULL AND (c.receive_through='one' OR f.drive_state<>'failed')
    OR c.receive_through='both' AND f.drive_state='pending')))
 FROM document_delivery_contracts c LEFT JOIN document_delivery_file_receipts f ON f.request_id=c.request_id
 WHERE c.request_id=target GROUP BY c.request_id
 UNION ALL SELECT b.expected_count::bigint,b.confirmed_count::bigint,b.unsettled_count::bigint
 FROM document_delivery_financial_bindings b WHERE b.request_id=target
 AND NOT EXISTS(SELECT 1 FROM document_delivery_contracts c WHERE c.request_id=target);
$$;
REVOKE ALL ON FUNCTION document_delivery_summary_for(UUID) FROM PUBLIC;
CREATE OR REPLACE FUNCTION preserve_document_delivery_financial_binding()
RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
 IF (NEW.request_id,NEW.receive_through,NEW.original_terms_digest,NEW.original_package_digest,
  NEW.content_commitment,NEW.amount_cents,NEW.expected_count,NEW.created_at)
  IS DISTINCT FROM (OLD.request_id,OLD.receive_through,OLD.original_terms_digest,OLD.original_package_digest,
  OLD.content_commitment,OLD.amount_cents,OLD.expected_count,OLD.created_at)
  OR NEW.confirmed_count<OLD.confirmed_count THEN
  RAISE check_violation USING MESSAGE='original document payment binding is immutable';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS document_delivery_original_binding ON document_delivery_financial_bindings;
CREATE TRIGGER document_delivery_original_binding BEFORE UPDATE ON document_delivery_financial_bindings
 FOR EACH ROW EXECUTE FUNCTION preserve_document_delivery_financial_binding();
CREATE OR REPLACE FUNCTION retain_document_delivery_erasure_inventory()
RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE delivered bigint; unresolved bigint;
BEGIN
 SELECT COUNT(*) FILTER(WHERE f.hosted_released_at IS NOT NULL AND
   (OLD.receive_through='one' OR f.drive_state='confirmed')),
  COUNT(*) FILTER(WHERE f.drive_state='unknown' OR EXISTS(SELECT 1
   FROM drive_share_permission_operations p WHERE p.operation_id=f.grant_operation_id
   AND p.state IN ('dispatching','unknown','present_unattributed')))
 INTO delivered,unresolved FROM document_delivery_file_receipts f WHERE f.request_id=OLD.request_id;
 UPDATE document_delivery_financial_bindings SET confirmed_count=GREATEST(confirmed_count,delivered),
  unsettled_count=GREATEST(CASE WHEN erased_at IS NOT NULL THEN unsettled_count ELSE 0 END,unresolved),erased_at=clock_timestamp()
  WHERE request_id=OLD.request_id;
 UPDATE drive_request_payment_obligations SET
  delivery_confirmed_at_erasure=(delivery_confirmed_at_erasure OR delivered>0),
  delivery_unsettled_at_erasure=(delivery_unsettled_at_erasure OR unresolved>0)
  WHERE request_id=OLD.request_id;
 INSERT INTO document_delivery_cleanup(cleanup_id,request_id,bucket_identity,object_key,object_generation,
  upload_session_envelope,session_observed_at,write_dispatched_at,write_settled_at,ciphertext_bytes)
 SELECT gen_random_uuid(),a.request_id,a.bucket_identity,a.object_key,a.object_generation,
  a.upload_session_envelope,a.session_observed_at,a.write_dispatched_at,a.write_settled_at,(a.descriptor->>'ciphertextBytes')::int
 FROM document_delivery_artifacts a WHERE a.request_id=OLD.request_id
 ON CONFLICT(object_key) DO NOTHING;
 RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS document_delivery_erasure_inventory ON document_delivery_contracts;
CREATE TRIGGER document_delivery_erasure_inventory BEFORE DELETE ON document_delivery_contracts
 FOR EACH ROW EXECUTE FUNCTION retain_document_delivery_erasure_inventory();
-- Repeatable migration admission: existing authority columns must retain their types/null fences.
DO $$
DECLARE t record; c record; actual_type text; required boolean;
BEGIN
 FOR t IN SELECT * FROM jsonb_each('{"document_delivery_contracts":{"request_id":["uuid",true],"owner_user_id":["text",true],"recipient_user_id":["text",true],"receive_through":["text",true],"revision":["bigint",true],"status":["text",true],"activity_disclosure_version":["text",true],"copy_disclosure_version":["text",false],"activity_accepted_at":["timestamp with time zone",true],"copy_accepted_at":["timestamp with time zone",false],"recipient_key_id":["text",true],"recipient_key_fingerprint":["text",true],"generation_id":["uuid",false],"preparation_digest":["text",false],"source_selection_digest":["text",false],"selection_envelope":["jsonb",false],"amount_cents":["integer",false],"access_expires_at":["timestamp with time zone",true],"preparation_expires_at":["timestamp with time zone",false],"current_package_id":["uuid",false],"approved_at":["timestamp with time zone",false],"accepted_at":["timestamp with time zone",false],"accepted_terms_digest":["text",false],"accepted_package_digest":["text",false],"hosted_revoked_at":["timestamp with time zone",false],"drive_revoke_status":["text",true],"created_at":["timestamp with time zone",true],"updated_at":["timestamp with time zone",true]},"document_delivery_public_keys":{"user_id":["text",true],"key_id":["text",true],"public_key":["text",true],"fingerprint":["text",true],"created_at":["timestamp with time zone",true]},"document_delivery_packages":{"package_id":["uuid",true],"request_id":["uuid",true],"revision":["bigint",true],"generation_id":["uuid",true],"preparation_digest":["text",true],"content_commitment":["text",true],"terms":["jsonb",true],"terms_digest":["text",true],"package_digest":["text",true],"artifacts":["jsonb",true],"wraps":["jsonb",true],"amendment_of":["uuid",false],"created_at":["timestamp with time zone",true]},"document_delivery_artifacts":{"artifact_id":["uuid",true],"request_id":["uuid",true],"generation_id":["uuid",true],"file_ref":["uuid",false],"role":["text",true],"descriptor":["jsonb",true],"upload_id":["uuid",true],"bucket_identity":["text",true],"object_key":["text",true],"state":["text",true],"object_generation":["text",false],"expires_at":["timestamp with time zone",true],"finalized_at":["timestamp with time zone",false],"created_at":["timestamp with time zone",true],"upload_session_envelope":["jsonb",false],"session_observed_at":["timestamp with time zone",false],"write_dispatched_at":["timestamp with time zone",false],"write_settled_at":["timestamp with time zone",false]},"document_delivery_file_receipts":{"request_id":["uuid",true],"file_ref":["uuid",true],"hosted_released_at":["timestamp with time zone",false],"drive_state":["text",true],"drive_receipt_envelope":["jsonb",false],"grant_operation_id":["uuid",false]},"document_delivery_key_challenges":{"challenge_id":["uuid",true],"request_id":["uuid",true],"user_id":["text",true],"key_id":["text",true],"fingerprint":["text",true],"nonce_hash":["text",true],"expires_at":["timestamp with time zone",true],"consumed_at":["timestamp with time zone",false],"verified_at":["timestamp with time zone",false],"purpose":["text",true],"created_at":["timestamp with time zone",true]},"document_delivery_activity":{"sequence":["bigint",true],"request_id":["uuid",true],"interaction_id":["uuid",true],"event_id":["uuid",true],"artifact_id":["uuid",false],"provenance":["text",true],"kind":["text",true],"outcome":["text",true],"actor_user_id":["text",true],"created_at":["timestamp with time zone",true]},"document_delivery_idempotency":{"request_id":["uuid",true],"idempotency_key":["uuid",true],"operation":["text",true],"body_digest":["text",true],"result":["jsonb",false],"created_at":["timestamp with time zone",true]},"document_delivery_financial_bindings":{"request_id":["uuid",true],"receive_through":["text",true],"original_terms_digest":["text",true],"original_package_digest":["text",true],"content_commitment":["text",true],"amount_cents":["integer",true],"expected_count":["integer",true],"confirmed_count":["integer",true],"unsettled_count":["integer",true],"erased_at":["timestamp with time zone",false],"created_at":["timestamp with time zone",true]},"document_delivery_cleanup":{"cleanup_id":["uuid",true],"request_id":["uuid",true],"bucket_identity":["text",true],"object_key":["text",true],"object_generation":["text",false],"status":["text",true],"attempts":["integer",true],"next_attempt_at":["timestamp with time zone",true],"created_at":["timestamp with time zone",true],"removed_at":["timestamp with time zone",false],"upload_session_envelope":["jsonb",false],"session_observed_at":["timestamp with time zone",false],"write_dispatched_at":["timestamp with time zone",false],"write_settled_at":["timestamp with time zone",false],"ciphertext_bytes":["integer",false]}}'::jsonb) LOOP
  FOR c IN SELECT * FROM jsonb_each(t.value) LOOP
   SELECT format_type(a.atttypid,a.atttypmod),a.attnotnull INTO actual_type,required
    FROM pg_attribute a WHERE a.attrelid=to_regclass(t.key) AND a.attname=c.key AND NOT a.attisdropped;
   IF actual_type IS DISTINCT FROM c.value->>0 OR ((c.value->>1)::boolean AND required IS DISTINCT FROM true) THEN
    RAISE check_violation USING MESSAGE='document delivery schema shape mismatch';
   END IF;
  END LOOP;
 END LOOP;
END $$;
DO $$
DECLARE table_name text; role_name text;
BEGIN
 FOREACH table_name IN ARRAY ARRAY['document_delivery_contracts','document_delivery_public_keys','document_delivery_packages','document_delivery_artifacts','document_delivery_file_receipts','document_delivery_key_challenges','document_delivery_activity','document_delivery_idempotency','document_delivery_financial_bindings','document_delivery_cleanup'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',table_name);
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
   IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
    EXECUTE format('REVOKE ALL ON %I FROM %I',table_name,role_name);
   END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
   EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO service_role',table_name);
  END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_proc WHERE proname='install_account_deletion_write_guards') THEN
  PERFORM public.install_account_deletion_write_guards();
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  GRANT EXECUTE ON FUNCTION document_delivery_summary_for(UUID) TO service_role;
 END IF;
END $$;
COMMIT;
