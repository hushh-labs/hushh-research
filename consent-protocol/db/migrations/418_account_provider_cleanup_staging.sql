-- Keep provider retry authority in its existing encrypted rows until approved
-- cleanup settles. Old account writers fail closed during the rolling window.
BEGIN;

ALTER TABLE public.account_deletion_tombstones
 ADD COLUMN IF NOT EXISTS erasure_phase text,
 ADD COLUMN IF NOT EXISTS account_owner_id text,
 ADD COLUMN IF NOT EXISTS firebase_identity_hash text,
 ADD COLUMN IF NOT EXISTS provider_cleanup_requested_target text NOT NULL DEFAULT 'both'
  CHECK(provider_cleanup_requested_target IN ('investor','ria','both')),
 ADD COLUMN IF NOT EXISTS provider_cleanup_id uuid,
 ADD COLUMN IF NOT EXISTS provider_cleanup_inventory jsonb NOT NULL DEFAULT '{}'::jsonb,
 ADD COLUMN IF NOT EXISTS provider_cleanup_receipt jsonb NOT NULL DEFAULT '{}'::jsonb,
 ADD COLUMN IF NOT EXISTS provider_cleanup_next_attempt_at timestamptz;

-- Historical erasure is not evidence of provider revocation.
UPDATE public.account_deletion_tombstones SET erasure_phase='erased',
 provider_cleanup_receipt=jsonb_build_object('version',1,'coverage','legacy_unconfirmed')
 WHERE erasure_phase IS NULL;
-- Existing accounts are generation zero. The identity digest survives terminal
-- scrubbing solely for authenticated cleanup discovery and generation history.
UPDATE public.account_deletion_tombstones SET firebase_identity_hash=CASE
 WHEN firebase_uid IS NOT NULL THEN 'sha256:'||encode(sha256(convert_to(firebase_uid,'UTF8')),'hex')
 ELSE user_id_hash END WHERE firebase_identity_hash IS NULL;
ALTER TABLE public.account_deletion_tombstones
 ALTER COLUMN erasure_phase SET NOT NULL,
 ALTER COLUMN erasure_phase SET DEFAULT 'provider_cleanup';
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.account_deletion_tombstones'::regclass AND conname='account_erasure_phase_valid') THEN
  ALTER TABLE public.account_deletion_tombstones ADD CONSTRAINT account_erasure_phase_valid
   CHECK(erasure_phase IN ('provider_cleanup','local_erasure','erased'));
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.account_deletion_tombstones'::regclass AND conname='account_provider_cleanup_receipt_bounded') THEN
  ALTER TABLE public.account_deletion_tombstones ADD CONSTRAINT account_provider_cleanup_receipt_bounded
   CHECK(jsonb_typeof(provider_cleanup_receipt)='object' AND octet_length(provider_cleanup_receipt::text)<=262144);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.account_deletion_tombstones'::regclass AND conname='account_provider_cleanup_not_firebase') THEN
  ALTER TABLE public.account_deletion_tombstones ADD CONSTRAINT account_provider_cleanup_not_firebase
   CHECK(erasure_phase='erased' OR cleanup_next_attempt_at IS NULL);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.account_deletion_tombstones'::regclass AND conname='account_provider_cleanup_inventory_bounded') THEN
  ALTER TABLE public.account_deletion_tombstones ADD CONSTRAINT account_provider_cleanup_inventory_bounded
   CHECK(jsonb_typeof(provider_cleanup_inventory)='object' AND octet_length(provider_cleanup_inventory::text)<=65536);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.account_deletion_tombstones'::regclass AND conname='account_provider_cleanup_authority_retained') THEN
  ALTER TABLE public.account_deletion_tombstones ADD CONSTRAINT account_provider_cleanup_authority_retained
   CHECK(erasure_phase='erased' OR (provider_cleanup_id IS NOT NULL
    AND firebase_uid IS NOT NULL AND account_owner_id IS NOT NULL));
 END IF;
END $$;

CREATE OR REPLACE FUNCTION public.account_provider_cleanup_pending(owner_id text)
RETURNS boolean LANGUAGE sql VOLATILE SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM public.account_deletion_tombstones
  WHERE user_id_hash='sha256:'||encode(sha256(convert_to(owner_id,'UTF8')),'hex')
  AND cleanup_intent_kind='full_account' AND erasure_phase<>'erased');
$$;

-- Only hashes leave the existing custody tables. Preparation holds the owner
-- barriers and locks these rows before recording this inventory. The final
-- erasure rechecks it; an absent table is a supported legacy schema, a failed
-- read is never an empty inventory.
CREATE OR REPLACE FUNCTION public.account_provider_cleanup_live_inventory(owner_id text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,public AS $$
DECLARE source text; identity_column text; query text; row_value jsonb;
 ref text; result jsonb:='{}'::jsonb; count_rows integer:=0;
BEGIN
 FOR source,identity_column IN SELECT * FROM (VALUES
  ('google_provider_connections','provider'),
  ('google_calendar_additional_accounts','account_id'),
  ('kai_gmail_connections','user_id'),
  ('user_external_connector_connections','connector_id'),
  ('external_connector_oauth_attempts','attempt_id')) sources(name,key) LOOP
  IF to_regclass('public.'||source) IS NULL THEN CONTINUE; END IF;
  query:=format('SELECT to_jsonb(source_row) FROM public.%I source_row WHERE user_id=$1',source);
  IF source='external_connector_oauth_attempts' THEN
   query:=query||' AND pending_credential_ciphertext IS NOT NULL';
  END IF;
  IF source='user_external_connector_connections' THEN
   -- A lock row created before the first authorization is not an issued grant.
   -- Missing historical fields are not evidence that a grant never existed.
   query:=query||' AND NOT (status=''revoked''
    AND coalesce(to_jsonb(source_row)->>''connection_generation'','''')=''0''
    AND coalesce(to_jsonb(source_row)->>''credential_version'','''')=''0''
    AND credential_ciphertext IS NULL AND credential_iv IS NULL
    AND connected_at IS NULL AND pending_attempt_id IS NULL
    AND coalesce(revocation_outcome,'''')=''not_attempted'')';
  END IF;
  FOR row_value IN EXECUTE query||' LIMIT 129 FOR UPDATE' USING owner_id LOOP
   count_rows:=count_rows+1;
   IF count_rows>128 OR row_value->>identity_column IS NULL THEN
    RAISE EXCEPTION 'provider cleanup inventory is unavailable' USING ERRCODE='54000';
   END IF;
   ref:=encode(sha256(convert_to(jsonb_build_array(source,owner_id,row_value->>identity_column)::text,'UTF8')),'hex');
   result:=result||jsonb_build_object(ref,jsonb_build_object('revision',
    encode(sha256(convert_to(row_value::text,'UTF8')),'hex'),
    'watchRequired',source='kai_gmail_connections','revocationSupport','required'));
  END LOOP;
 END LOOP;
 RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.account_provider_cleanup_revisions(inventory jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
 SELECT coalesce(jsonb_object_agg(key,jsonb_build_object('revision',value->>'revision',
  'watchRequired',value->'watchRequired')),'{}'::jsonb)
 FROM jsonb_each(inventory);
$$;

-- Refresh may replace authority while deletion is pending. Only the original
-- encrypted envelope and its version/expiry can change; owner, provider,
-- subject, generation, watch state and approval bindings stay frozen.
CREATE OR REPLACE FUNCTION public.account_cleanup_refresh_columns(source text)
RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
 SELECT CASE source
 WHEN 'google_provider_connections' THEN ARRAY['refresh_token_ciphertext','refresh_token_iv','refresh_token_tag']
 WHEN 'google_calendar_additional_accounts' THEN ARRAY['refresh_token_ciphertext','refresh_token_iv','refresh_token_tag']
 WHEN 'kai_gmail_connections' THEN ARRAY['refresh_token_ciphertext','refresh_token_iv','refresh_token_tag','token_updated_at']
 WHEN 'user_external_connector_connections' THEN ARRAY['credential_ciphertext','credential_iv',
  'credential_algorithm','credential_version']
 WHEN 'external_connector_oauth_attempts' THEN ARRAY['pending_credential_ciphertext','pending_credential_iv']
 ELSE ARRAY[]::text[] END;
$$;

CREATE OR REPLACE FUNCTION public.account_cleanup_effective_inventory(inventory jsonb,receipt jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
 SELECT coalesce(jsonb_object_agg(key,value||jsonb_build_object('revision',
  coalesce(receipt->'items'->key->>'custodyRevision',value->>'revision'))),'{}'::jsonb)
 FROM jsonb_each(inventory);
$$;

CREATE OR REPLACE FUNCTION public.guard_account_cleanup_refresh_receipt()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE ref text; item jsonb; previous jsonb; action jsonb; observed jsonb;
BEGIN
 IF NEW.provider_cleanup_id IS NULL OR TG_OP<>'UPDATE' THEN RETURN NEW; END IF;
 FOR ref,item IN SELECT * FROM jsonb_each(NEW.provider_cleanup_receipt->'items') LOOP
  previous:=OLD.provider_cleanup_receipt->'items'->ref;
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
CREATE TRIGGER account_cleanup_refresh_receipt BEFORE UPDATE ON public.account_deletion_tombstones
 FOR EACH ROW EXECUTE FUNCTION public.guard_account_cleanup_refresh_receipt();

CREATE OR REPLACE FUNCTION public.account_provider_cleanup_qualified(
 receipt jsonb, inventory jsonb, owner_hash text, cleanup_id uuid)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE item jsonb; item_id text; items jsonb; expected jsonb;
BEGIN
 IF receipt->>'version' IS DISTINCT FROM '1'
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
  OR item-ARRAY['revision','groupDigest','revocationSupport','watchRequired','watchOutcome','revocation','refresh','custodyRevision']<>'{}'::jsonb
  OR expected-ARRAY['revision','groupDigest','revocationSupport','watchRequired']<>'{}'::jsonb
  OR item->>'revision' IS DISTINCT FROM expected->>'revision'
  OR item->>'groupDigest' IS DISTINCT FROM expected->>'groupDigest'
  OR item->>'revocationSupport' IS DISTINCT FROM expected->>'revocationSupport'
  OR item->'watchRequired' IS DISTINCT FROM expected->'watchRequired'
  OR coalesce(item->>'watchOutcome','') NOT IN ('stopped','not_required') THEN RETURN false; END IF;
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

CREATE OR REPLACE FUNCTION public.guard_account_provider_cleanup_phase()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='INSERT' AND NEW.firebase_identity_hash IS NULL THEN
  NEW.firebase_identity_hash:=CASE WHEN NEW.firebase_uid IS NOT NULL
   THEN 'sha256:'||encode(sha256(convert_to(NEW.firebase_uid,'UTF8')),'hex') ELSE NEW.user_id_hash END;
 END IF;
 IF TG_OP='DELETE' THEN
  IF OLD.cleanup_intent_kind='full_account' THEN
   RAISE EXCEPTION 'retired account cleanup history is immutable' USING ERRCODE='42501';
  END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' AND NEW.cleanup_intent_kind IS DISTINCT FROM OLD.cleanup_intent_kind THEN
  RAISE EXCEPTION 'cleanup intent kind is immutable' USING ERRCODE='42501';
 END IF;
 IF TG_OP='UPDATE' AND NEW.firebase_identity_hash IS DISTINCT FROM OLD.firebase_identity_hash THEN
  RAISE EXCEPTION 'cleanup identity binding is immutable' USING ERRCODE='42501';
 END IF;
 IF NEW.firebase_identity_hash IS NULL OR NEW.firebase_identity_hash !~ '^sha256:[0-9a-f]{64}$' THEN
  RAISE EXCEPTION 'cleanup identity binding is required' USING ERRCODE='42501';
 END IF;
 IF NEW.firebase_uid IS NOT NULL AND NEW.firebase_identity_hash IS DISTINCT FROM
  'sha256:'||encode(sha256(convert_to(NEW.firebase_uid,'UTF8')),'hex') THEN
  RAISE EXCEPTION 'cleanup identity binding does not match' USING ERRCODE='42501';
 END IF;
 IF NEW.cleanup_intent_kind='full_account' AND TG_OP='INSERT'
  AND NEW.erasure_phase<>'provider_cleanup' THEN
  RAISE EXCEPTION 'account cleanup must start with provider preparation' USING ERRCODE='42501';
 END IF;
 IF TG_OP='UPDATE' AND OLD.erasure_phase='local_erasure'
  AND NEW.erasure_phase='provider_cleanup' THEN
  RAISE EXCEPTION 'local erasure cannot return to provider preparation' USING ERRCODE='42501';
 END IF;
 IF NEW.cleanup_intent_kind='phone_orphan' THEN
  NEW.erasure_phase:='erased';
 ELSIF TG_OP='UPDATE' AND OLD.erasure_phase='erased'
  AND NEW.erasure_phase IS DISTINCT FROM OLD.erasure_phase THEN
  RAISE EXCEPTION 'retired account cleanup cannot restart' USING ERRCODE='42501';
 END IF;
 IF NEW.erasure_phase='local_erasure'
  AND public.account_provider_cleanup_qualified(NEW.provider_cleanup_receipt,
   NEW.provider_cleanup_inventory,NEW.user_id_hash,NEW.provider_cleanup_id) IS NOT TRUE THEN
  RAISE EXCEPTION 'provider cleanup is unconfirmed' USING ERRCODE='42501';
 END IF;
 IF NEW.erasure_phase='local_erasure' AND OLD.erasure_phase='provider_cleanup' THEN
  IF NEW.account_owner_id IS NULL OR NEW.user_id_hash IS DISTINCT FROM
   'sha256:'||encode(sha256(convert_to(NEW.account_owner_id,'UTF8')),'hex') THEN
   RAISE EXCEPTION 'provider cleanup owner is unconfirmed' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.account_owner_id,171));
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.account_owner_id,198));
  IF public.account_provider_cleanup_revisions(public.account_cleanup_effective_inventory(
    NEW.provider_cleanup_inventory,NEW.provider_cleanup_receipt))
   IS DISTINCT FROM public.account_provider_cleanup_revisions(
    public.account_provider_cleanup_live_inventory(NEW.account_owner_id)) THEN
   RAISE EXCEPTION 'provider cleanup inventory changed' USING ERRCODE='42501';
  END IF;
 END IF;
 IF NEW.cleanup_intent_kind='full_account' AND TG_OP='UPDATE'
  AND OLD.erasure_phase='provider_cleanup' AND NEW.erasure_phase='erased' THEN
  RAISE EXCEPTION 'local erasure has not settled' USING ERRCODE='42501';
 END IF;
 IF TG_OP='UPDATE' AND OLD.provider_cleanup_id IS NOT NULL
  AND (NEW.provider_cleanup_id IS DISTINCT FROM OLD.provider_cleanup_id
   OR NEW.user_id_hash IS DISTINCT FROM OLD.user_id_hash
   OR NEW.provider_cleanup_inventory IS DISTINCT FROM OLD.provider_cleanup_inventory
   OR NEW.provider_cleanup_requested_target IS DISTINCT FROM OLD.provider_cleanup_requested_target
   OR (NEW.erasure_phase<>'erased' AND (NEW.account_owner_id IS DISTINCT FROM OLD.account_owner_id
    OR NEW.firebase_uid IS DISTINCT FROM OLD.firebase_uid))) THEN
  RAISE EXCEPTION 'provider cleanup inventory is immutable' USING ERRCODE='42501';
 END IF;
 IF NEW.erasure_phase='erased' AND NEW.firebase_uid IS NULL THEN
  NEW.account_owner_id:=NULL;
 END IF;
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS account_provider_cleanup_phase ON public.account_deletion_tombstones;
CREATE TRIGGER account_provider_cleanup_phase BEFORE INSERT OR UPDATE OR DELETE
 ON public.account_deletion_tombstones FOR EACH ROW
 EXECUTE FUNCTION public.guard_account_provider_cleanup_phase();

-- Local row/key erasure and its terminal marker are one transaction. Never
-- leave a committed phase in which unrelated workers may erase retained keys.
CREATE OR REPLACE FUNCTION public.require_account_local_erasure_settlement()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.account_deletion_tombstones
  WHERE user_id_hash=NEW.user_id_hash AND erasure_phase='local_erasure') THEN
  RAISE EXCEPTION 'local erasure did not settle atomically' USING ERRCODE='42501';
 END IF;
 RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS account_local_erasure_settlement ON public.account_deletion_tombstones;
CREATE CONSTRAINT TRIGGER account_local_erasure_settlement AFTER INSERT OR UPDATE
 ON public.account_deletion_tombstones DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION public.require_account_local_erasure_settlement();

CREATE OR REPLACE FUNCTION public.record_account_deletion_tombstone()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE current_phase text; receipt jsonb; inventory jsonb; cleanup_id uuid;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(OLD.user_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(OLD.user_id,198));
 SELECT erasure_phase,provider_cleanup_receipt,
  provider_cleanup_inventory,provider_cleanup_id
 INTO current_phase,receipt,inventory,cleanup_id FROM public.account_deletion_tombstones
 WHERE user_id_hash='sha256:'||encode(sha256(convert_to(OLD.user_id,'UTF8')),'hex');
 IF (current_phase='local_erasure' AND public.account_provider_cleanup_qualified(receipt,inventory,
  'sha256:'||encode(sha256(convert_to(OLD.user_id,'UTF8')),'hex'),cleanup_id) IS TRUE)
 THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'durable provider cleanup required before account erasure' USING ERRCODE='42501';
END;
$$;

CREATE OR REPLACE FUNCTION public.retain_account_cleanup_custody()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE journal public.account_deletion_tombstones%ROWTYPE;
 old_row jsonb:=to_jsonb(OLD); new_row jsonb; identity_column text;
 ref text; item jsonb; revision text; allowed text[];
BEGIN
 IF current_setting('transaction_isolation') NOT IN ('read committed','read uncommitted') THEN
  RAISE EXCEPTION 'cleanup custody requires read committed isolation' USING ERRCODE='25001';
 END IF;
 IF public.account_provider_cleanup_pending(OLD.user_id) THEN
  PERFORM pg_advisory_xact_lock(hashtextextended(OLD.user_id,171));
  PERFORM pg_advisory_xact_lock(hashtextextended(OLD.user_id,198));
  SELECT * INTO journal FROM public.account_deletion_tombstones
  WHERE user_id_hash='sha256:'||encode(sha256(convert_to(OLD.user_id,'UTF8')),'hex')
  AND erasure_phase='provider_cleanup' FOR UPDATE;
  IF FOUND THEN
   identity_column:=CASE TG_TABLE_NAME WHEN 'google_provider_connections' THEN 'provider'
    WHEN 'google_calendar_additional_accounts' THEN 'account_id'
    WHEN 'user_external_connector_connections' THEN 'connector_id'
    WHEN 'external_connector_oauth_attempts' THEN 'attempt_id' ELSE 'user_id' END;
   ref:=encode(sha256(convert_to(jsonb_build_array(TG_TABLE_NAME,OLD.user_id,old_row->>identity_column)::text,'UTF8')),'hex');
   item:=journal.provider_cleanup_receipt->'items'->ref;
   revision:=encode(sha256(convert_to(old_row::text,'UTF8')),'hex');
   allowed:=public.account_cleanup_refresh_columns(TG_TABLE_NAME);
   new_row:=CASE WHEN TG_OP='UPDATE' THEN to_jsonb(NEW) ELSE NULL END;
   IF TG_OP<>'UPDATE' OR coalesce(item->'refresh'->>'state','') NOT IN ('dispatched','uncertain')
    OR item->'refresh'->>'fromRevision' IS DISTINCT FROM revision
    OR coalesce(item->>'custodyRevision',item->>'revision') IS DISTINCT FROM revision
    OR old_row-allowed IS DISTINCT FROM new_row-allowed THEN
    RAISE EXCEPTION 'provider cleanup retains credential custody' USING ERRCODE='42501';
   END IF;
  END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION public.require_account_cleanup_refresh_capture()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE receipt jsonb; identity_column text; ref text; item jsonb;
BEGIN
 SELECT provider_cleanup_receipt INTO receipt FROM public.account_deletion_tombstones
 WHERE account_owner_id=NEW.user_id AND erasure_phase='provider_cleanup';
 IF NOT FOUND THEN RETURN NULL; END IF;
 identity_column:=CASE TG_TABLE_NAME WHEN 'google_provider_connections' THEN 'provider'
  WHEN 'google_calendar_additional_accounts' THEN 'account_id'
  WHEN 'user_external_connector_connections' THEN 'connector_id'
  WHEN 'external_connector_oauth_attempts' THEN 'attempt_id' ELSE 'user_id' END;
 ref:=encode(sha256(convert_to(jsonb_build_array(TG_TABLE_NAME,NEW.user_id,
  to_jsonb(NEW)->>identity_column)::text,'UTF8')),'hex');
 item:=receipt->'items'->ref;
 IF item->'refresh'->>'state' IS DISTINCT FROM 'captured'
  OR item->>'custodyRevision' IS DISTINCT FROM encode(sha256(convert_to(to_jsonb(NEW)::text,'UTF8')),'hex') THEN
  RAISE EXCEPTION 'provider refresh must capture authority atomically' USING ERRCODE='42501';
 END IF;
 RETURN NULL;
END;
$$;
DO $$ DECLARE family text; BEGIN
 FOREACH family IN ARRAY ARRAY['google_provider_connections','google_calendar_additional_accounts',
  'kai_gmail_connections','user_external_connector_connections','external_connector_oauth_attempts'] LOOP
  IF to_regclass('public.'||family) IS NOT NULL THEN
   EXECUTE format('DROP TRIGGER IF EXISTS retain_account_cleanup_custody ON public.%I',family);
   EXECUTE format('CREATE TRIGGER retain_account_cleanup_custody BEFORE UPDATE OR DELETE ON public.%I '
    'FOR EACH ROW EXECUTE FUNCTION public.retain_account_cleanup_custody()',family);
   EXECUTE format('DROP TRIGGER IF EXISTS account_cleanup_refresh_capture ON public.%I',family);
   EXECUTE format('CREATE CONSTRAINT TRIGGER account_cleanup_refresh_capture AFTER UPDATE ON public.%I '
    'DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_account_cleanup_refresh_capture()',family);
  END IF;
 END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.erase_tombstoned_push_registrations()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.erasure_phase='provider_cleanup' THEN RETURN NEW; END IF;
 DELETE FROM public.user_push_tokens
 WHERE 'sha256:'||encode(digest(user_id,'sha256'),'hex')=NEW.user_id_hash;
 DELETE FROM public.user_push_installations
 WHERE 'sha256:'||encode(digest(user_id,'sha256'),'hex')=NEW.user_id_hash;
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS push_account_erased ON public.account_deletion_tombstones;
CREATE TRIGGER push_account_erased AFTER INSERT OR UPDATE OF erasure_phase
 ON public.account_deletion_tombstones FOR EACH ROW
 EXECUTE FUNCTION public.erase_tombstoned_push_registrations();

CREATE OR REPLACE FUNCTION public.erase_one_marketing_preference()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.cleanup_intent_kind='phone_orphan' OR NEW.erasure_phase='provider_cleanup' THEN RETURN NEW; END IF;
 DELETE FROM public.one_marketing_preferences WHERE user_hash=NEW.user_id_hash;
 INSERT INTO public.one_marketing_changes(user_hash,revision,erased)
 VALUES(NEW.user_id_hash,1,true) ON CONFLICT(user_hash) DO UPDATE SET
 revision=one_marketing_changes.revision+1,erased=true,pending=true,updated_at=NOW();
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS one_marketing_erasure ON public.account_deletion_tombstones;
CREATE TRIGGER one_marketing_erasure AFTER INSERT OR UPDATE OF erasure_phase
 ON public.account_deletion_tombstones FOR EACH ROW
 EXECUTE FUNCTION public.erase_one_marketing_preference();

-- Earlier canonical migrations replay their own cleanup projections. Retain
-- these rows without aborting that replay while a provider operation is pending.
-- Ordinary authenticated reads/writes are separately fenced by the lifecycle.
CREATE OR REPLACE FUNCTION public.retain_prepared_account_projection()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE owner_hash text;
BEGIN
 IF TG_TABLE_NAME='one_marketing_changes' THEN
  owner_hash:=NEW.user_hash;
 ELSIF TG_TABLE_NAME='one_marketing_preferences' THEN
  owner_hash:=OLD.user_hash;
 ELSE
  owner_hash:='sha256:'||encode(sha256(convert_to(OLD.user_id,'UTF8')),'hex');
 END IF;
 IF EXISTS(SELECT 1 FROM public.account_deletion_tombstones
  WHERE user_id_hash=owner_hash AND erasure_phase='provider_cleanup') THEN RETURN NULL; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END;
$$;
DO $$ DECLARE family text; BEGIN
 FOREACH family IN ARRAY ARRAY['user_push_tokens','user_push_installations','one_marketing_preferences',
  'connected_documents','drive_picker_sessions','drive_native_picker_attempts'] LOOP
  IF to_regclass('public.'||family) IS NULL THEN CONTINUE; END IF;
  EXECUTE format('DROP TRIGGER IF EXISTS retain_prepared_account_projection ON public.%I',family);
  EXECUTE format('CREATE TRIGGER retain_prepared_account_projection BEFORE DELETE ON public.%I '
   'FOR EACH ROW EXECUTE FUNCTION public.retain_prepared_account_projection()',family);
 END LOOP;
END $$;
DROP TRIGGER IF EXISTS retain_prepared_account_projection ON public.one_marketing_changes;
CREATE TRIGGER retain_prepared_account_projection BEFORE INSERT OR UPDATE
 ON public.one_marketing_changes FOR EACH ROW
 EXECUTE FUNCTION public.retain_prepared_account_projection();

COMMENT ON COLUMN public.account_deletion_tombstones.provider_cleanup_receipt IS
 'Bounded cleanup inventory hashes and typed outcomes only. No tokens, ciphertext, vault keys, account labels or provider error bodies. Credentials remain in their original encrypted rows.';
CREATE INDEX IF NOT EXISTS account_provider_cleanup_due ON public.account_deletion_tombstones
 (provider_cleanup_next_attempt_at) WHERE erasure_phase='provider_cleanup';
CREATE INDEX IF NOT EXISTS account_cleanup_identity ON public.account_deletion_tombstones
 (firebase_identity_hash,deleted_at DESC);
REVOKE ALL ON FUNCTION public.account_provider_cleanup_live_inventory(text) FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  GRANT EXECUTE ON FUNCTION public.account_provider_cleanup_live_inventory(text) TO service_role;
 END IF;
END $$;
COMMIT;
