-- Environment-local account continuity. Firebase remains the identity provider;
-- application ownership never moves from a retired account to its replacement.
BEGIN;

ALTER TABLE public.account_deletion_tombstones
 ADD COLUMN IF NOT EXISTS generation_retired_at timestamptz;
UPDATE public.account_deletion_tombstones SET generation_retired_at=updated_at
 WHERE cleanup_intent_kind='full_account' AND erasure_phase='erased' AND generation_retired_at IS NULL;

CREATE OR REPLACE FUNCTION public.stamp_account_generation_retirement()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF OLD.erasure_phase='erased' AND NEW.generation_retired_at IS DISTINCT FROM OLD.generation_retired_at THEN
  RAISE EXCEPTION 'account retirement time is immutable' USING ERRCODE='42501';
 END IF;
 IF OLD.erasure_phase<>'erased' AND NEW.erasure_phase='erased'
  AND NEW.cleanup_intent_kind='full_account' THEN
  NEW.generation_retired_at:=clock_timestamp();
 ELSIF NEW.generation_retired_at IS DISTINCT FROM OLD.generation_retired_at THEN
  RAISE EXCEPTION 'account retirement requires settled erasure' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS account_generation_retirement_stamp ON public.account_deletion_tombstones;
CREATE TRIGGER account_generation_retirement_stamp BEFORE UPDATE ON public.account_deletion_tombstones
 FOR EACH ROW EXECUTE FUNCTION public.stamp_account_generation_retirement();

CREATE TABLE IF NOT EXISTS public.account_generations (
 identity_hash text NOT NULL CHECK(identity_hash ~ '^sha256:[0-9a-f]{64}$'),
 generation integer NOT NULL CHECK(generation >= 0),
 owner_hash text NOT NULL UNIQUE CHECK(owner_hash ~ '^sha256:[0-9a-f]{64}$'),
 owner_id text UNIQUE,
 identity_uid text,
 admitted_after bigint NOT NULL DEFAULT 0 CHECK(admitted_after >= 0),
 retired_at timestamptz,
 cleanup_operation uuid,
 cleanup_confirmed boolean NOT NULL DEFAULT false,
 enrollment_operation uuid UNIQUE,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(identity_hash,generation),
 CHECK((retired_at IS NULL AND owner_id IS NOT NULL AND identity_uid IS NOT NULL)
  OR (retired_at IS NOT NULL AND owner_id IS NULL AND identity_uid IS NULL)),
 CHECK(owner_id IS NULL OR (char_length(owner_id) BETWEEN 1 AND 128
   AND owner_hash='sha256:'||encode(sha256(convert_to(owner_id,'UTF8')),'hex'))),
 CHECK(identity_uid IS NULL OR (char_length(identity_uid) BETWEEN 1 AND 128
   AND identity_hash='sha256:'||encode(sha256(convert_to(identity_uid,'UTF8')),'hex'))),
 CHECK(generation=0 OR admitted_after>0)
);
CREATE UNIQUE INDEX IF NOT EXISTS account_generations_one_active
 ON public.account_generations(identity_hash) WHERE retired_at IS NULL;
REVOKE ALL ON public.account_generations FROM PUBLIC;

-- Remote identity writes outlive SQL transactions. Retain only dispatch metadata
-- so an unresolved old-owner write can never reach a newly enrolled generation.
CREATE TABLE IF NOT EXISTS public.account_firebase_mutations (
 operation_id uuid PRIMARY KEY,
 owner_hash text NOT NULL CHECK(owner_hash ~ '^sha256:[0-9a-f]{64}$'),
 identity_hash text NOT NULL CHECK(identity_hash ~ '^sha256:[0-9a-f]{64}$'),
 authority_project text NOT NULL CHECK(authority_project ~ '^[a-z][a-z0-9-]{4,62}$'),
 purpose text NOT NULL CHECK(purpose IN ('display_name','welcome_marker')),
 settlement_nonce uuid NOT NULL,
 state text NOT NULL DEFAULT 'dispatched' CHECK(state IN ('dispatched','succeeded','rejected','uncertain')),
 dispatched_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 settled_at timestamptz,
 CHECK((state IN ('dispatched','uncertain') AND settled_at IS NULL)
   OR (state IN ('succeeded','rejected') AND settled_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS account_firebase_mutations_unsettled
 ON public.account_firebase_mutations(authority_project,identity_hash)
 WHERE state IN ('dispatched','uncertain');
REVOKE ALL ON public.account_firebase_mutations FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.guard_account_firebase_mutation_receipt()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  RAISE EXCEPTION 'identity mutation receipts are immutable' USING ERRCODE='42501';
 END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'dispatched' OR NEW.settled_at IS NOT NULL THEN
   RAISE EXCEPTION 'identity mutation requires dispatch' USING ERRCODE='42501';
  END IF;
 ELSIF OLD.state NOT IN ('dispatched','uncertain')
  OR NEW.state NOT IN ('succeeded','rejected','uncertain')
  OR ROW(NEW.operation_id,NEW.owner_hash,NEW.identity_hash,NEW.authority_project,
   NEW.purpose,NEW.settlement_nonce,NEW.dispatched_at)
   IS DISTINCT FROM ROW(OLD.operation_id,OLD.owner_hash,OLD.identity_hash,OLD.authority_project,
   OLD.purpose,OLD.settlement_nonce,OLD.dispatched_at) THEN
  RAISE EXCEPTION 'identity mutation receipt changed' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS account_firebase_mutation_receipt ON public.account_firebase_mutations;
CREATE TRIGGER account_firebase_mutation_receipt BEFORE INSERT OR UPDATE OR DELETE
 ON public.account_firebase_mutations FOR EACH ROW
 EXECUTE FUNCTION public.guard_account_firebase_mutation_receipt();

CREATE OR REPLACE FUNCTION public.account_firebase_mutations_settled(identity_digest text)
RETURNS boolean LANGUAGE sql VOLATILE SET search_path=pg_catalog,public AS $$
 SELECT NOT EXISTS(SELECT 1 FROM public.account_firebase_mutations
  WHERE identity_hash=identity_digest AND state IN ('dispatched','uncertain'));
$$;
COMMENT ON TABLE public.account_firebase_mutations IS
 'Minimal remote SDK dispatch/settlement receipts. No profile values or credentials. Unresolved writes block replacement enrollment; time alone never proves settlement.';

-- Historical erasure is retained, never promoted to verified provider cleanup.
INSERT INTO public.account_generations(identity_hash,generation,owner_hash,retired_at,
 cleanup_operation,cleanup_confirmed)
 SELECT firebase_identity_hash,0,user_id_hash,generation_retired_at,provider_cleanup_id,
  (firebase_identity_hash=user_id_hash AND
   (cleanup_status='quarantined'
    AND cleanup_last_outcome='identity_retained'
    AND cleanup_last_classification='firebase_shared_identity_retained')
   AND public.account_provider_cleanup_qualified(provider_cleanup_receipt,
    provider_cleanup_inventory,user_id_hash,provider_cleanup_id) IS TRUE)
 FROM public.account_deletion_tombstones
 WHERE cleanup_intent_kind='full_account' AND erasure_phase='erased'
 ON CONFLICT DO NOTHING;

-- Bound accepted issuer/database clock lead as well as whole-second precision.
-- A refreshed or late-exchanged old sign-in must not cross retirement merely
-- because the issuer's clock was ahead. Enrollment tells the owner when fresh
-- authentication becomes eligible; this is not a recurring session max age.
CREATE OR REPLACE FUNCTION public.account_generation_admission_cutoff(retired timestamptz)
RETURNS bigint LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT ceil(extract(epoch FROM retired))::bigint+60;
$$;

CREATE OR REPLACE FUNCTION public.guard_account_generation_history()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE settled public.account_deletion_tombstones%ROWTYPE;
 previous public.account_generations%ROWTYPE; qualified boolean;
BEGIN
 IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND
  (OLD.retired_at IS NOT NULL OR NEW.identity_hash IS DISTINCT FROM OLD.identity_hash
   OR NEW.generation IS DISTINCT FROM OLD.generation OR NEW.owner_hash IS DISTINCT FROM OLD.owner_hash
   OR NEW.enrollment_operation IS DISTINCT FROM OLD.enrollment_operation
   OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.admitted_after IS DISTINCT FROM OLD.admitted_after
   OR NEW.retired_at IS NULL)) THEN
  RAISE EXCEPTION 'account generation history is immutable' USING ERRCODE='42501';
 END IF;
 IF TG_OP='UPDATE' AND (NEW.owner_id IS NOT NULL OR NEW.identity_uid IS NOT NULL) THEN
  RAISE EXCEPTION 'retired account identity must be scrubbed' USING ERRCODE='42501';
 END IF;
 IF NEW.retired_at IS NOT NULL THEN
  IF TG_OP='INSERT' AND NEW.generation<>0 THEN
   RAISE EXCEPTION 'retired generation must already exist' USING ERRCODE='42501';
  END IF;
  SELECT * INTO settled FROM public.account_deletion_tombstones
   WHERE user_id_hash=NEW.owner_hash AND firebase_identity_hash=NEW.identity_hash
    AND cleanup_intent_kind='full_account' AND erasure_phase='erased';
  IF NOT FOUND OR NEW.cleanup_operation IS DISTINCT FROM settled.provider_cleanup_id
   OR NEW.retired_at IS DISTINCT FROM settled.generation_retired_at THEN
   RAISE EXCEPTION 'account retirement is unconfirmed' USING ERRCODE='42501';
  END IF;
  qualified:=(settled.cleanup_status='quarantined'
   AND settled.cleanup_last_outcome='identity_retained'
   AND settled.cleanup_last_classification='firebase_shared_identity_retained')
   AND public.account_provider_cleanup_qualified(settled.provider_cleanup_receipt,
    settled.provider_cleanup_inventory,settled.user_id_hash,settled.provider_cleanup_id) IS TRUE;
  IF TG_OP='INSERT' AND NEW.generation=0 AND NEW.owner_hash<>NEW.identity_hash THEN qualified:=false; END IF;
  IF NEW.cleanup_confirmed IS DISTINCT FROM qualified THEN
   RAISE EXCEPTION 'account cleanup evidence changed' USING ERRCODE='42501';
  END IF;
 ELSIF NEW.generation=0 THEN
  IF NEW.owner_id IS DISTINCT FROM NEW.identity_uid OR EXISTS(SELECT 1 FROM public.account_deletion_tombstones
   WHERE user_id_hash=NEW.owner_hash) THEN
   RAISE EXCEPTION 'legacy account is ineligible' USING ERRCODE='42501';
  END IF;
 ELSE
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.identity_hash,199));
  IF NOT public.account_firebase_mutations_settled(NEW.identity_hash) THEN
   RAISE EXCEPTION 'identity mutation requires reconciliation' USING ERRCODE='42501';
  END IF;
  SELECT * INTO previous FROM public.account_generations WHERE identity_hash=NEW.identity_hash
   ORDER BY generation DESC LIMIT 1;
  IF NOT FOUND OR previous.generation<>NEW.generation-1 OR previous.retired_at IS NULL
   OR previous.cleanup_confirmed IS NOT TRUE OR NEW.cleanup_operation IS DISTINCT FROM previous.cleanup_operation
   OR NEW.admitted_after IS DISTINCT FROM public.account_generation_admission_cutoff(previous.retired_at)
   OR NEW.owner_id !~ '^acct_[0-9a-f]{32}$'
   OR EXISTS(SELECT 1 FROM public.account_identity_presence WHERE user_id_hash=NEW.owner_hash) THEN
   RAISE EXCEPTION 'account enrollment lineage is unconfirmed' USING ERRCODE='42501';
  END IF;
 END IF;
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS account_generation_history ON public.account_generations;
CREATE TRIGGER account_generation_history BEFORE INSERT OR UPDATE OR DELETE ON public.account_generations
 FOR EACH ROW EXECUTE FUNCTION public.guard_account_generation_history();

CREATE OR REPLACE FUNCTION public.retire_erased_account_generation()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE current_generation public.account_generations%ROWTYPE; confirmed boolean;
BEGIN
 IF NEW.cleanup_intent_kind<>'full_account' OR NEW.erasure_phase<>'erased'
  OR OLD.erasure_phase='erased' THEN RETURN NEW; END IF;
 confirmed:=(NEW.cleanup_status='quarantined'
  AND NEW.cleanup_last_outcome='identity_retained'
  AND NEW.cleanup_last_classification='firebase_shared_identity_retained')
  AND public.account_provider_cleanup_qualified(
  NEW.provider_cleanup_receipt,NEW.provider_cleanup_inventory,NEW.user_id_hash,
  NEW.provider_cleanup_id) IS TRUE;
 SELECT * INTO current_generation FROM public.account_generations
  WHERE owner_hash=NEW.user_id_hash FOR UPDATE;
 IF FOUND THEN
  IF current_generation.retired_at IS NOT NULL
   OR current_generation.identity_hash IS DISTINCT FROM NEW.firebase_identity_hash THEN
   RAISE EXCEPTION 'account generation retirement changed' USING ERRCODE='42501';
  END IF;
  UPDATE public.account_generations SET retired_at=NEW.generation_retired_at,owner_id=NULL,
   identity_uid=NULL,cleanup_operation=NEW.provider_cleanup_id,cleanup_confirmed=confirmed
   WHERE owner_hash=NEW.user_id_hash;
 ELSE
  -- Only a legacy generation-zero owner may lack an explicit generation row.
  IF NEW.firebase_identity_hash IS DISTINCT FROM NEW.user_id_hash THEN
   RAISE EXCEPTION 'account generation binding is missing' USING ERRCODE='42501';
  END IF;
  INSERT INTO public.account_generations(identity_hash,generation,owner_hash,retired_at,
   cleanup_operation,cleanup_confirmed) VALUES(NEW.firebase_identity_hash,0,NEW.user_id_hash,
   NEW.generation_retired_at,NEW.provider_cleanup_id,confirmed);
 END IF;
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS account_generation_retirement ON public.account_deletion_tombstones;
CREATE TRIGGER account_generation_retirement AFTER UPDATE OF erasure_phase
 ON public.account_deletion_tombstones FOR EACH ROW
 EXECUTE FUNCTION public.retire_erased_account_generation();

-- Called only after independent cryptographic verification of recent identity
-- proof. No generic login, callback, job or token consumer calls this function.
CREATE OR REPLACE FUNCTION public.enroll_account_generation(identity text, previous_generation integer,
 cleanup uuid, enrollment uuid, authenticated_at bigint)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,public AS $$
DECLARE identity_digest text; previous public.account_generations%ROWTYPE;
 active public.account_generations%ROWTYPE; new_owner text; cutoff bigint;
BEGIN
 IF identity IS NULL OR char_length(identity) NOT BETWEEN 1 AND 128 OR enrollment IS NULL
  OR cleanup IS NULL OR authenticated_at IS NULL THEN RETURN NULL; END IF;
 identity_digest:='sha256:'||encode(sha256(convert_to(identity,'UTF8')),'hex');
 -- This lock is never acquired by owner erasure. Enrollment occurs strictly
 -- after its committed retirement, so it cannot invert owner lock order.
 PERFORM pg_advisory_xact_lock(hashtextextended(identity_digest,199));
 IF NOT public.account_firebase_mutations_settled(identity_digest) THEN RETURN NULL; END IF;
 SELECT * INTO active FROM public.account_generations
  WHERE identity_hash=identity_digest AND retired_at IS NULL;
 IF FOUND THEN
  IF active.enrollment_operation=enrollment AND active.generation=previous_generation+1
   AND active.cleanup_operation=cleanup
   AND authenticated_at>active.admitted_after THEN
   RETURN jsonb_build_object('owner_id',active.owner_id,'generation',active.generation,
    'admitted_after',active.admitted_after);
  END IF;
  RETURN NULL;
 END IF;
 SELECT * INTO previous FROM public.account_generations
  WHERE identity_hash=identity_digest ORDER BY generation DESC LIMIT 1;
 IF NOT FOUND OR previous.generation IS DISTINCT FROM previous_generation
  OR previous.retired_at IS NULL OR previous.cleanup_confirmed IS NOT TRUE
  OR previous.cleanup_operation IS DISTINCT FROM cleanup THEN RETURN NULL; END IF;
 -- Round up and require a strictly later signed auth_time. iat/refresh time
 -- never establishes fresh authentication. Future-skew tolerance is zero.
 cutoff:=public.account_generation_admission_cutoff(previous.retired_at);
 IF authenticated_at<=cutoff OR authenticated_at<extract(epoch FROM clock_timestamp())-300
  OR authenticated_at>extract(epoch FROM clock_timestamp()) THEN RETURN NULL; END IF;
 new_owner:='acct_'||replace(gen_random_uuid()::text,'-','');
 INSERT INTO public.account_generations(identity_hash,generation,owner_hash,owner_id,identity_uid,
  admitted_after,enrollment_operation,cleanup_operation)
 VALUES(identity_digest,previous.generation+1,'sha256:'||encode(sha256(convert_to(new_owner,'UTF8')),'hex'),
  new_owner,identity,cutoff,enrollment,cleanup) RETURNING * INTO active;
 RETURN jsonb_build_object('owner_id',active.owner_id,'generation',active.generation,
  'admitted_after',active.admitted_after);
END;
$$;

COMMENT ON TABLE public.account_generations IS
 'Environment-local ownership generations. Retired history has hashes and cleanup references only; active rows bind an opaque application owner to its existing Firebase identity. Ordinary authentication never enrolls replacements.';

-- Migration 201 protects new bindings but intentionally allows unchanged-owner
-- updates during cleanup. Once erasure is terminal, that exception cannot let
-- old jobs mutate residual rows under a retired generation. Do not acquire an
-- advisory lock after the UPDATE tuple lock (it would invert erasure ordering).
CREATE OR REPLACE FUNCTION public.reject_retired_account_update()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE identity_column text; previous_owner text;
BEGIN
 IF current_setting('transaction_isolation') NOT IN ('read committed','read uncommitted') THEN
  RAISE EXCEPTION 'account generation guard requires read committed isolation' USING ERRCODE='25001';
 END IF;
 FOREACH identity_column IN ARRAY TG_ARGV LOOP
  EXECUTE format('SELECT ($1).%I::text',identity_column) INTO previous_owner USING OLD;
  IF previous_owner IS NOT NULL AND EXISTS(SELECT 1 FROM public.account_deletion_tombstones
   WHERE user_id_hash='sha256:'||encode(sha256(convert_to(previous_owner,'UTF8')),'hex')
    AND cleanup_intent_kind='full_account' AND erasure_phase='erased') THEN
   RAISE EXCEPTION 'account generation is retired' USING ERRCODE='23514',
    CONSTRAINT='account_retired_generation_update_guard';
  END IF;
 END LOOP;
 RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION public.install_account_generation_update_guards()
RETURNS integer LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,public AS $$
DECLARE guarded record; count_tables integer:=0; arguments text;
BEGIN
 -- Reuse the canonical installer's audited table/identity-column discovery.
 -- The INSERT trigger's NUL-separated arguments are catalog identifiers, not
 -- SQL supplied by a caller. Quote them independently, including exceptions.
 FOR guarded IN SELECT t.tgrelid,t.tgargs FROM pg_trigger t
  WHERE t.tgname='trg_reject_deleted_account_insert'
   AND t.tgfoid='public.reject_deleted_account_identity_write()'::regprocedure
   AND NOT t.tgisinternal LOOP
  SELECT string_agg(quote_literal(value),',') INTO arguments
   FROM unnest(string_to_array(encode(guarded.tgargs,'escape'),E'\\000')) value
   WHERE value<>'';
  IF arguments IS NULL THEN RAISE EXCEPTION 'generation guard has no owner columns'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=guarded.tgrelid
   AND t.tgname='account_retired_generation_update' AND t.tgtype=19
   AND t.tgargs=guarded.tgargs AND t.tgfoid='public.reject_retired_account_update()'::regprocedure
   AND t.tgenabled='O' AND t.tgqual IS NULL AND NOT t.tgisinternal) THEN
   EXECUTE format('DROP TRIGGER IF EXISTS account_retired_generation_update ON %s',guarded.tgrelid::regclass);
   EXECUTE format('CREATE TRIGGER account_retired_generation_update BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION public.reject_retired_account_update(%s)',
    guarded.tgrelid::regclass,arguments);
  END IF;
  count_tables:=count_tables+1;
 END LOOP;
 RETURN count_tables;
END;
$$;
SELECT public.install_account_generation_update_guards();

-- Preserve migration 201's discovery and event-trigger policy. Tables/columns
-- added later acquire both guards in the same DDL transaction. Conditional
-- lookup also keeps canonical replay before this forward migration valid.
CREATE OR REPLACE FUNCTION public.refresh_account_deletion_guards_after_identity_ddl()
RETURNS event_trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 PERFORM public.install_account_deletion_write_guards();
 IF to_regprocedure('public.install_account_generation_update_guards()') IS NOT NULL THEN
  PERFORM public.install_account_generation_update_guards();
 END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.refresh_account_deletion_guards_after_identity_ddl() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enroll_account_generation(text,integer,uuid,uuid,bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.account_firebase_mutations_settled(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.install_account_generation_update_guards() FROM PUBLIC;
DO $$ DECLARE client_role text;
BEGIN
 -- PostgreSQL grants function EXECUTE to PUBLIC by default. This enrollment
 -- port is backend-only, including installations with PostgREST/Supabase.
 FOREACH client_role IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=client_role) THEN
   EXECUTE format('REVOKE ALL ON TABLE public.account_generations FROM %I',client_role);
   EXECUTE format('REVOKE ALL ON TABLE public.account_firebase_mutations FROM %I',client_role);
   EXECUTE format('REVOKE ALL ON FUNCTION public.account_firebase_mutations_settled(text) FROM %I',client_role);
   EXECUTE format('REVOKE ALL ON FUNCTION public.enroll_account_generation(text,integer,uuid,uuid,bigint) FROM %I',client_role);
   EXECUTE format('REVOKE ALL ON FUNCTION public.install_account_generation_update_guards() FROM %I',client_role);
  END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  GRANT SELECT,INSERT,UPDATE ON public.account_generations TO service_role;
  GRANT SELECT,INSERT,UPDATE ON public.account_firebase_mutations TO service_role;
  GRANT EXECUTE ON FUNCTION public.account_firebase_mutations_settled(text) TO service_role;
  GRANT EXECUTE ON FUNCTION public.enroll_account_generation(text,integer,uuid,uuid,bigint) TO service_role;
 END IF;
END;
$$;
COMMIT;
