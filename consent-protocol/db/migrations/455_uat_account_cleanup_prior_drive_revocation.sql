-- Preserve proof of a completed Google Drive disconnect during full account cleanup.
BEGIN;

CREATE OR REPLACE FUNCTION public.account_cleanup_prior_drive_reference(
 owner_id text, inventory jsonb, receipt jsonb)
RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT prior.ref
 FROM public.user_external_connector_connections connection
 CROSS JOIN LATERAL (SELECT
   encode(sha256(convert_to(jsonb_build_array('user_external_connector_connections',
    connection.user_id,connection.connector_id)::text,'UTF8')),'hex') AS ref,
   encode(sha256(convert_to(to_jsonb(connection)::text,'UTF8')),'hex') AS revision
 ) prior
 WHERE connection.user_id=owner_id AND connection.connector_id='google_drive'
   AND connection.status='revoked' AND connection.revocation_outcome='revoked'
   AND connection.envelope_version=2 AND connection.connection_generation>0
   AND connection.credential_version>0 AND connection.revoked_at IS NOT NULL
   AND connection.credential_ciphertext IS NULL AND connection.credential_iv IS NULL
   AND connection.credential_tag IS NULL AND connection.credential_algorithm IS NULL
   AND connection.credential_expires_at IS NULL AND connection.pending_attempt_id IS NULL
   AND connection.refresh_lease_id IS NULL AND connection.refresh_lease_expires_at IS NULL
   AND connection.revocation_pending_until IS NULL
   AND receipt->>'version'='2'
   AND inventory->prior.ref=jsonb_build_object('revision',prior.revision,
       'watchRequired',false,'revocationSupport','unverified')
   AND receipt->'items'->prior.ref=inventory->prior.ref
       || '{"watchOutcome":"not_required","revocation":"pending"}'::jsonb;
$$;
REVOKE ALL ON FUNCTION public.account_cleanup_prior_drive_reference(text,jsonb,jsonb) FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  GRANT EXECUTE ON FUNCTION public.account_cleanup_prior_drive_reference(text,jsonb,jsonb) TO service_role;
 END IF;
END $$;

CREATE OR REPLACE FUNCTION public.guard_account_cleanup_refresh_receipt()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE ref text; item jsonb; previous jsonb; action jsonb; observed jsonb;
BEGIN
 IF TG_OP='INSERT' THEN
  IF EXISTS(SELECT 1 FROM jsonb_each(NEW.provider_cleanup_receipt->'items')
   WHERE value->>'revocationSupport'='unverified' AND value->>'revocation'='revoked') THEN
   RAISE EXCEPTION 'prior Drive revocation requires a current cleanup claim' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
 END IF;
 IF NEW.provider_cleanup_receipt IS NOT DISTINCT FROM OLD.provider_cleanup_receipt THEN RETURN NEW; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_each(OLD.provider_cleanup_receipt->'items')
  WHERE value->>'revocationSupport'='unverified' AND value->>'revocation'='revoked'
   AND value IS DISTINCT FROM NEW.provider_cleanup_receipt->'items'->key) THEN
  RAISE EXCEPTION 'prior Drive revocation is immutable' USING ERRCODE='42501';
 END IF;
 FOR ref,item IN SELECT * FROM jsonb_each(NEW.provider_cleanup_receipt->'items') LOOP
  previous:=OLD.provider_cleanup_receipt->'items'->ref;
  IF item->>'revocationSupport'='unverified' AND item->>'revocation'='revoked'
   AND item IS DISTINCT FROM previous
   AND (OLD.provider_cleanup_id IS NULL OR NEW.provider_cleanup_id IS NULL
    OR OLD.erasure_phase<>'provider_cleanup' OR NEW.erasure_phase<>'provider_cleanup'
    OR NEW.cleanup_status<>'running' OR NEW.cleanup_claim_token IS NULL
    OR ref IS DISTINCT FROM public.account_cleanup_prior_drive_reference(
      OLD.account_owner_id,OLD.provider_cleanup_inventory,OLD.provider_cleanup_receipt)
    OR item IS DISTINCT FROM previous||'{"revocation":"revoked"}'::jsonb) THEN
   RAISE EXCEPTION 'prior Drive revocation is unconfirmed' USING ERRCODE='42501';
  END IF;
  IF NEW.provider_cleanup_id IS NULL THEN CONTINUE; END IF;
  IF item->>'custodyRevision' IS DISTINCT FROM previous->>'custodyRevision' THEN
   action:=previous->'refresh';
   IF OLD.erasure_phase<>'provider_cleanup' OR NEW.erasure_phase<>'provider_cleanup'
    OR NEW.cleanup_claim_token IS DISTINCT FROM OLD.cleanup_claim_token
    OR action->>'state' NOT IN ('dispatched','uncertain')
    OR item->'refresh' IS DISTINCT FROM action||'{"state":"captured"}'::jsonb
    OR action->>'fromRevision' IS DISTINCT FROM coalesce(previous->>'custodyRevision',previous->>'revision')
    OR coalesce(item->>'custodyRevision','') !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'provider refresh capture is unconfirmed' USING ERRCODE='42501';
   END IF;
   observed:=public.account_provider_cleanup_live_inventory(NEW.account_owner_id);
   IF observed->ref->>'revision' IS DISTINCT FROM item->>'custodyRevision' THEN
    RAISE EXCEPTION 'provider refresh custody changed' USING ERRCODE='42501';
   END IF;
  END IF;
  IF item->'refresh' IS DISTINCT FROM previous->'refresh' THEN
   action:=item->'refresh';
   IF jsonb_typeof(action) IS DISTINCT FROM 'object'
    OR action-ARRAY['state','operationId','fromRevision']<>'{}'::jsonb
    OR coalesce(action->>'operationId','') !~ '^[0-9a-f-]{36}$'
    OR coalesce(action->>'fromRevision','') !~ '^[0-9a-f]{64}$'
    OR coalesce(action->>'state','') NOT IN ('dispatched','captured','uncertain') THEN
    RAISE EXCEPTION 'provider refresh receipt is invalid' USING ERRCODE='42501';
   END IF;
   IF action->>'state'='dispatched' THEN
    IF previous->'refresh'->>'state' IN ('dispatched','uncertain')
     OR action->>'fromRevision' IS DISTINCT FROM coalesce(previous->>'custodyRevision',previous->>'revision')
     OR NEW.cleanup_status<>'running' OR NEW.cleanup_claim_token IS NULL THEN
     RAISE EXCEPTION 'provider refresh has no current claim' USING ERRCODE='42501';
    END IF;
    observed:=public.account_provider_cleanup_live_inventory(NEW.account_owner_id);
    IF observed->ref->>'revision' IS DISTINCT FROM action->>'fromRevision' THEN
     RAISE EXCEPTION 'provider refresh source changed' USING ERRCODE='42501';
    END IF;
   ELSIF action->>'state'='captured' THEN
    IF item->>'custodyRevision' IS NOT DISTINCT FROM previous->>'custodyRevision' THEN
     RAISE EXCEPTION 'provider refresh capture lacks custody revision' USING ERRCODE='42501';
    END IF;
   ELSIF previous->'refresh'->>'state' IS DISTINCT FROM 'dispatched'
    OR action IS DISTINCT FROM previous->'refresh'||'{"state":"uncertain"}'::jsonb THEN
    RAISE EXCEPTION 'provider refresh uncertainty has no dispatch' USING ERRCODE='42501';
   END IF;
  END IF;
 END LOOP;
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS account_cleanup_refresh_receipt ON public.account_deletion_tombstones;
CREATE TRIGGER account_cleanup_refresh_receipt BEFORE INSERT OR UPDATE ON public.account_deletion_tombstones
 FOR EACH ROW EXECUTE FUNCTION public.guard_account_cleanup_refresh_receipt();

CREATE OR REPLACE FUNCTION public.account_provider_cleanup_qualified(
 receipt jsonb, inventory jsonb, owner_hash text, cleanup_id uuid)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE item jsonb; item_id text; items jsonb; expected jsonb;
BEGIN
 IF coalesce(receipt->>'version','') NOT IN ('1','2')
 OR receipt-ARRAY['version','cleanupId','ownerHash','inventorySha256','items','localErasureAccepted']<>'{}'::jsonb
 OR cleanup_id IS NULL
 OR receipt->>'cleanupId' IS DISTINCT FROM cleanup_id::text
 OR receipt->>'ownerHash' IS DISTINCT FROM owner_hash
 OR jsonb_typeof(inventory) IS DISTINCT FROM 'object'
 OR octet_length(inventory::text)>65536
 OR receipt->>'inventorySha256' IS DISTINCT FROM encode(sha256(convert_to(inventory::text,'UTF8')),'hex')
 OR jsonb_typeof(receipt->'items') IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 items:=receipt->'items';
 IF (SELECT count(*) FROM jsonb_object_keys(items))>128
 OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(items) key)
  IS DISTINCT FROM (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(inventory) key)
 THEN RETURN false; END IF;
 FOR item_id,item IN SELECT * FROM jsonb_each(items) LOOP
  expected:=inventory->item_id;
  IF item_id !~ '^[0-9a-f]{64}$' OR coalesce(item->>'revision','') !~ '^[0-9a-f]{64}$'
  OR jsonb_typeof(item) IS DISTINCT FROM 'object'
  OR item-ARRAY['revision','groupDigest','revocationSupport','watchRequired','watchOutcome','revocation','refresh','custodyRevision','authorityScope']<>'{}'::jsonb
  OR expected-ARRAY['revision','groupDigest','revocationSupport','watchRequired','authorityScope']<>'{}'::jsonb
  OR item->>'revision' IS DISTINCT FROM expected->>'revision'
  OR item->>'groupDigest' IS DISTINCT FROM expected->>'groupDigest'
  OR item->>'revocationSupport' IS DISTINCT FROM expected->>'revocationSupport'
  OR item->>'authorityScope' IS DISTINCT FROM expected->>'authorityScope'
  OR item->'watchRequired' IS DISTINCT FROM expected->'watchRequired'
  OR coalesce(item->>'watchOutcome','') NOT IN ('stopped','not_required','retained_shared') THEN RETURN false; END IF;
  IF expected ? 'authorityScope' THEN
   IF receipt->>'version' IS DISTINCT FROM '2'
    OR expected->>'authorityScope' IS DISTINCT FROM 'retain_shared_google'
    OR expected->>'revocationSupport' IS DISTINCT FROM 'required'
    OR coalesce(expected->>'groupDigest','') !~ '^[0-9a-f]{64}$'
    OR item->>'revocation' IS DISTINCT FROM 'local_erasure_approved'
    OR receipt->'localErasureAccepted' IS DISTINCT FROM 'true'::jsonb
    OR item ? 'refresh' OR item ? 'custodyRevision'
    OR item->>'watchOutcome' IS DISTINCT FROM (CASE WHEN expected->'watchRequired'='true'::jsonb
      THEN 'retained_shared' ELSE 'not_required' END) THEN RETURN false; END IF;
   CONTINUE;
  END IF;
  IF item->>'watchOutcome'='retained_shared' THEN RETURN false; END IF;
  IF item ? 'refresh' AND (item->'refresh'->>'state' IS DISTINCT FROM 'captured'
   OR coalesce(item->>'custodyRevision','') !~ '^[0-9a-f]{64}$') THEN RETURN false; END IF;
  IF item ? 'custodyRevision' AND NOT item ? 'refresh' THEN RETURN false; END IF;
  IF expected->'watchRequired'='true'::jsonb AND item->>'watchOutcome'<>'stopped' THEN RETURN false; END IF;
  IF item->>'revocation'='revoked' AND item->>'revocationSupport'='required' THEN CONTINUE; END IF;
  -- Only the guarded transition can introduce this proof. The receipt remains
  -- sufficient after local erasure removes the original connector row.
  IF receipt->>'version'='2' AND item->>'revocation'='revoked'
   AND expected->>'revocationSupport'='unverified'
   AND item->>'watchOutcome'='not_required' AND expected->'watchRequired'='false'::jsonb
   AND NOT (item ?| ARRAY['groupDigest','refresh','custodyRevision']) THEN CONTINUE; END IF;
  IF item->>'revocation'='local_erasure_approved'
   AND item->>'revocationSupport'='unsupported'
   AND receipt->'localErasureAccepted'='true'::jsonb THEN CONTINUE; END IF;
  IF item->>'revocation'='covered_by_group'
   AND item->>'revocationSupport'='required'
   AND item->>'groupDigest' ~ '^[0-9a-f]{64}$'
   AND EXISTS(SELECT 1 FROM jsonb_each(items) other WHERE
    other.value->>'groupDigest'=item->>'groupDigest'
    AND other.value->>'revocation'='revoked') THEN CONTINUE; END IF;
  RETURN false;
 END LOOP;
 RETURN true;
END;
$$;

COMMIT;
