-- Environment-local erasure never revokes a reviewed shared Google project grant.
-- Approval is bound to the immutable inventory digest; uncertain effects remain refused.
BEGIN;

CREATE OR REPLACE FUNCTION public.account_provider_cleanup_contract_version()
RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 2 $$;

CREATE OR REPLACE FUNCTION public.guard_account_shared_provider_authority()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE ref text; expected jsonb; item jsonb;
BEGIN
 IF NEW.cleanup_intent_kind<>'full_account' OR NEW.erasure_phase='erased' THEN RETURN NEW; END IF;
 IF TG_OP='INSERT' AND NEW.provider_cleanup_receipt->>'version' IS DISTINCT FROM '2' THEN
  RAISE EXCEPTION 'current cleanup producer contract is required' USING ERRCODE='42501';
 END IF;
 IF TG_OP='UPDATE' AND NEW.provider_cleanup_receipt->>'version' IS DISTINCT FROM '2'
  AND NEW.provider_cleanup_receipt IS DISTINCT FROM OLD.provider_cleanup_receipt THEN
  RAISE EXCEPTION 'legacy provider cleanup requires reviewed recovery' USING ERRCODE='42501';
 END IF;
 FOR ref,expected IN SELECT * FROM jsonb_each(NEW.provider_cleanup_inventory) LOOP
  IF NOT expected ? 'authorityScope' THEN CONTINUE; END IF;
  item:=NEW.provider_cleanup_receipt->'items'->ref;
  IF NEW.provider_cleanup_receipt->>'version' IS DISTINCT FROM '2'
   OR expected->>'authorityScope' IS DISTINCT FROM 'retain_shared_google'
   OR item->>'authorityScope' IS DISTINCT FROM expected->>'authorityScope'
   OR item ? 'refresh' OR item ? 'custodyRevision'
   OR coalesce(item->>'watchOutcome','') NOT IN ('pending','not_required','retained_shared')
   OR coalesce(item->>'revocation','') NOT IN ('pending','local_erasure_approved')
   OR ((item->>'watchOutcome'='retained_shared' OR item->>'revocation'='local_erasure_approved')
    AND NEW.provider_cleanup_receipt->'localErasureAccepted' IS DISTINCT FROM 'true'::jsonb) THEN
   RAISE EXCEPTION 'shared provider authority cannot be dispatched' USING ERRCODE='42501';
  END IF;
 END LOOP;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS account_shared_provider_authority ON public.account_deletion_tombstones;
CREATE TRIGGER account_shared_provider_authority BEFORE INSERT OR UPDATE ON public.account_deletion_tombstones
 FOR EACH ROW EXECUTE FUNCTION public.guard_account_shared_provider_authority();

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
