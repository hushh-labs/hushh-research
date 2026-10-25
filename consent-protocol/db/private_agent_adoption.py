"""Qualify retained external consent guards before immutable lifecycle adoption.

These legacy schema objects have no source lineage in this release. Their exact
reviewed catalog definitions are compatibility evidence, not new product consent.
The qualification never calls, replaces, disables or removes either guard.
"""

from __future__ import annotations

import hashlib
from typing import TYPE_CHECKING, Callable

if TYPE_CHECKING:
    from db.migration_authority import MigrationManifestEntryV2

SOURCE_FILENAME = "420_private_agent_lifecycle_foundation.sql"
SOURCE_SHA256 = "78981e14e2dc4ef0d40a6275f785a5015367ea08d00ab7b4ef352538cb612f2d"
# Exact pg_get_triggerdef(oid,true) and pg_get_functiondef(oid) from the reviewed
# legacy schema. No application rows, credentials or consent records are embedded.
GUARDS = (
    (
        "zz_consumer_memory_consent",
        "guard_consumer_memory_consent",
        7,
        "c1cb9e259b708f2d9b04131f37aba667a16f6641167c725a47bf2633a3c0addf",
        "2ccca2cea80161124e4394a01ae7b250f23b1ee2d25a23f8658cb23a6047fb03",
        "ARRAY['search_path=public']::text[]",
    ),
    (
        "zz_preserve_consumer_memory_consent",
        "preserve_consumer_memory_consent",
        27,
        "f922fa8b6b4e7ef41ee16a771c3903f4094e0524c3de590525727c01cd057ae5",
        "1b09276b80d8f10582587ea4d12512b14f05055c6ef77612e37b000a1646668b",
        "NULL::text[]",
    ),
)
_INVENTORY_START = " IF EXISTS(SELECT 1 FROM (SELECT c.relname,t.tgname FROM pg_trigger t "
_INVENTORY_END = "THEN RAISE EXCEPTION 'Unqualified private-agent triggers'; END IF;"
_ANCHOR = "('consent_audit','zz_personal_agent_renewal_authority'),"


def _qualification_sql() -> str:
    values = ",\n".join(
        f"('{name}','{function}',{kind},'{trigger_hash}','{function_hash}',{config})"
        for name, function, kind, trigger_hash, function_hash, config in GUARDS
    )
    return f"""DO $private_agent_adoption$
DECLARE spec record; installed record; found_count integer;
BEGIN
 -- Fence trigger installation even when neither legacy trigger is present.
 -- Ordinary row writes remain compatible; runner lock_timeout bounds the wait.
 IF to_regclass('public.consent_audit') IS NOT NULL THEN
  LOCK TABLE public.consent_audit IN SHARE UPDATE EXCLUSIVE MODE;
 END IF;
 SELECT count(*) INTO found_count FROM pg_trigger t
 WHERE t.tgrelid=to_regclass('public.consent_audit')
  AND t.tgname IN ('zz_consumer_memory_consent','zz_preserve_consumer_memory_consent');
 IF found_count=0 THEN RETURN; END IF;
 IF found_count<>2 THEN RAISE EXCEPTION 'Incomplete legacy consumer consent guards'; END IF;
 FOR spec IN SELECT * FROM (VALUES {values})
  AS expected(name,function_name,kind,trigger_hash,function_hash,configuration) LOOP
  SELECT t.*,p.prosecdef,p.proconfig,p.proname,n.nspname AS function_schema,
   pg_get_triggerdef(t.oid,true) AS trigger_definition,
   pg_get_functiondef(p.oid) AS function_definition INTO installed
  FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
  JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE t.tgrelid='public.consent_audit'::regclass AND t.tgname=spec.name;
  IF NOT FOUND OR installed.tgisinternal OR installed.tgparentid<>0
   OR installed.tgenabled<>'O' OR installed.tgtype<>spec.kind
   OR installed.tgnargs<>0 OR installed.tgargs<>''::bytea
   OR installed.tgattr::text<>'' OR installed.tgconstraint<>0
   OR installed.tgdeferrable OR installed.tginitdeferred
   OR installed.tgqual IS NOT NULL OR installed.tgoldtable IS NOT NULL
   OR installed.tgnewtable IS NOT NULL OR installed.function_schema<>'public'
   OR installed.proname<>spec.function_name OR installed.prosecdef
   OR installed.proconfig IS DISTINCT FROM spec.configuration
   OR installed.tgfoid IS DISTINCT FROM
     to_regprocedure(format('public.%I()',spec.function_name))::oid
   OR encode(sha256(convert_to(installed.trigger_definition,'UTF8')),'hex')<>spec.trigger_hash
   OR encode(sha256(convert_to(installed.function_definition,'UTF8')),'hex')<>spec.function_hash
   OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname=spec.function_name)<>1 THEN
   RAISE EXCEPTION 'Unqualified legacy consumer consent guard: %',spec.name;
  END IF;
 END LOOP;
END
$private_agent_adoption$;
"""


def private_agent_adoption_sql(entry: MigrationManifestEntryV2) -> str:
    """Keep source/ledger identity and every guard except two qualified names."""
    from db.migration_authority import MigrationAuthorityError

    checksum = hashlib.sha256(entry.sql.encode("utf-8")).hexdigest()
    if (
        entry.migration_id != "420"
        or entry.filename != SOURCE_FILENAME
        or checksum != SOURCE_SHA256
        or entry.checksum_sha256 != checksum
    ):
        raise MigrationAuthorityError("Private-agent adoption source checksum changed")
    inventory = [
        line
        for line in entry.sql.splitlines()
        if line.startswith(_INVENTORY_START) and line.endswith(_INVENTORY_END)
    ]
    if len(inventory) != 1 or inventory[0].count(_ANCHOR) != 1:
        raise MigrationAuthorityError("Private-agent adoption inventory source shape changed")
    additions = "".join(f"('consent_audit','{spec[0]}')," for spec in GUARDS)
    block = f"DO $pod_414$\nBEGIN\n{inventory[0]}\nEND\n$pod_414$;"
    if entry.sql.count(block) != 1:
        raise MigrationAuthorityError("Private-agent adoption inventory block changed")
    qualified = block.replace(_ANCHOR, _ANCHOR + additions)
    return entry.sql.replace(block, _qualification_sql() + qualified, 1)


def execution_sql(
    entry: MigrationManifestEntryV2,
    *,
    replay: Callable[[MigrationManifestEntryV2], str] | None = None,
) -> str:
    """Adapt pending420 in either executing mode; caller keeps observe/skip gates."""
    if entry.migration_id == "420":
        return private_agent_adoption_sql(entry)
    return replay(entry) if replay is not None else entry.sql
