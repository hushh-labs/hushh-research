"""Qualify the exact area-erasure successor during immutable lifecycle replay."""


def area_discovery_qualification_sql() -> str:
    return """DO $area_discovery_adoption$
DECLARE installed record;
BEGIN
 LOCK TABLE public.account_deletion_tombstones IN SHARE UPDATE EXCLUSIVE MODE;
 IF to_regclass('public.one_area_discovery_preferences') IS NULL
  AND to_regclass('public.one_area_discovery_search_budgets') IS NULL
  AND to_regprocedure('public.erase_one_area_discovery()') IS NULL
  AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE
   tgrelid='public.account_deletion_tombstones'::regclass AND tgname='one_area_discovery_erasure')
 THEN RETURN; END IF;
 SELECT t.*,p.prosecdef,p.proconfig,p.prosrc,p.proowner,p.proleakproof,
  p.provolatile,p.prorettype,n.nspname AS function_schema INTO installed
 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
 JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE t.tgrelid='public.account_deletion_tombstones'::regclass
  AND t.tgname='one_area_discovery_erasure';
 IF NOT FOUND OR installed.tgenabled<>'O' OR installed.tgisinternal
  OR installed.tgtype<>5 OR installed.tgparentid<>0 OR installed.tgnargs<>0
  OR installed.tgargs<>''::bytea OR installed.tgattr::text<>''
  OR installed.tgconstraint<>0 OR installed.tgdeferrable OR installed.tginitdeferred
  OR installed.tgqual IS NOT NULL OR installed.tgoldtable IS NOT NULL
  OR installed.tgnewtable IS NOT NULL OR installed.function_schema<>'public'
  OR installed.tgfoid IS DISTINCT FROM to_regprocedure('public.erase_one_area_discovery()')::oid
  OR installed.prosecdef OR installed.proleakproof OR installed.provolatile<>'v'
  OR installed.prorettype<>'pg_catalog.trigger'::regtype
  OR installed.proowner IS DISTINCT FROM
   (SELECT relowner FROM pg_class WHERE oid='public.account_deletion_tombstones'::regclass)
  OR installed.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']::text[]
  OR encode(sha256(convert_to(installed.prosrc,'UTF8')),'hex')<>'3ff58b5f8243e632bf06689bad53cd102b7ebe7765948cea38694a5af86b4e78'
  OR to_regclass('public.one_area_discovery_preferences') IS NULL
  OR to_regclass('public.one_area_discovery_search_budgets') IS NULL
  OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='erase_one_area_discovery')<>1 THEN
  RAISE EXCEPTION 'Unqualified area discovery erasure successor';
 END IF;
END
$area_discovery_adoption$;
"""
