"""Qualify the exact attempt-email erasure successor during immutable lifecycle replay."""


def attempt_email_qualification_sql() -> str:
    return """DO $attempt_email_adoption$
DECLARE installed record;
BEGIN
 LOCK TABLE public.account_deletion_tombstones IN SHARE UPDATE EXCLUSIVE MODE;
 IF to_regclass('public.one_attempt_email_preferences') IS NULL
  AND to_regclass('public.one_attempt_email_outbox') IS NULL
  AND to_regprocedure('public.erase_one_attempt_email()') IS NULL
  AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE
   tgrelid='public.account_deletion_tombstones'::regclass AND tgname='one_attempt_email_erasure')
 THEN RETURN; END IF;
 SELECT t.*,p.prosecdef,p.proconfig,p.prosrc,p.proowner,p.proleakproof,p.prolang,
  p.provolatile,p.prorettype,n.nspname AS function_schema INTO installed
 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
 JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE t.tgrelid='public.account_deletion_tombstones'::regclass
  AND t.tgname='one_attempt_email_erasure';
 IF NOT FOUND OR installed.tgenabled<>'O' OR installed.tgisinternal
  OR installed.tgtype<>5 OR installed.tgparentid<>0 OR installed.tgnargs<>0
  OR installed.tgargs<>''::bytea OR installed.tgattr::text<>''
  OR installed.tgconstraint<>0 OR installed.tgdeferrable OR installed.tginitdeferred
  OR installed.tgqual IS NOT NULL OR installed.tgoldtable IS NOT NULL
  OR installed.tgnewtable IS NOT NULL OR installed.function_schema<>'public'
  OR installed.tgfoid IS DISTINCT FROM to_regprocedure('public.erase_one_attempt_email()')::oid
  OR installed.prosecdef OR installed.proleakproof OR installed.provolatile<>'v'
  OR installed.prorettype<>'pg_catalog.trigger'::regtype
  OR installed.prolang IS DISTINCT FROM (SELECT oid FROM pg_language WHERE lanname='plpgsql')
  OR installed.proowner IS DISTINCT FROM
   (SELECT relowner FROM pg_class WHERE oid='public.account_deletion_tombstones'::regclass)
  OR installed.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']::text[]
  OR encode(sha256(convert_to(installed.prosrc,'UTF8')),'hex')<>'8a9c5e2f2408003c8858a171258230285bdca3cbdf27c83f65defbf40ce5ccaa'
  OR to_regclass('public.one_attempt_email_preferences') IS NULL
  OR to_regclass('public.one_attempt_email_outbox') IS NULL
  OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='erase_one_attempt_email')<>1 THEN
  RAISE EXCEPTION 'Unqualified attempt email erasure successor';
 END IF;
END
$attempt_email_adoption$;
"""
