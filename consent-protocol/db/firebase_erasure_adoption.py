"""Closed migration/replay qualification for the isolated Dev erasure successor.

Applied migrations remain byte-identical. Pins were measured on real PostgreSQL16.
"""

from __future__ import annotations

import hashlib
import re

FOOTPRINT = """(EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.account_deletion_tombstones')
 AND attname IN ('firebase_erasure_authority','firebase_erasure_checkpoint','firebase_cleanup_project') AND NOT attisdropped)
 OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname IN ('account_firebase_erasure_contract_version',
   'account_firebase_erasure_qualified','guard_account_firebase_erasure'))
 OR EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.account_deletion_tombstones')
 AND tgname='account_firebase_erasure'))"""


def qualification_sql(*, required: bool = False) -> str:
    rows = []
    for signature, pin in PINS.items():
        config = (
            "NULL::text[]"
            if pin["proconfig"] is None
            else "ARRAY[" + ",".join("'" + v + "'" for v in pin["proconfig"]) + "]::text[]"
        )
        rows.append(
            f"('{signature}','{pin['hash']}','{pin['provolatile']}',{config},{str(pin['publicExecute']).lower()})"
        )
    triggers = ",".join(f"('{p['relname']}','{p['tgname']}','{p['hash']}')" for p in TRIGGERS)
    absent = "RAISE EXCEPTION 'Firebase erasure contract is absent';" if required else "RETURN;"
    return f"""DO $qualify_firebase_erasure$
DECLARE spec record; actual record; registry_owner oid; grant_vector oid[];
BEGIN
 IF NOT {FOOTPRINT} THEN {absent} END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname IN ('account_firebase_erasure_contract_version',
   'account_firebase_erasure_qualified','guard_account_firebase_erasure')
   AND NOT EXISTS(SELECT 1 FROM (VALUES ('account_firebase_erasure_contract_version()'),
    ('account_firebase_erasure_qualified(public.account_deletion_tombstones)'),
    ('guard_account_firebase_erasure()')) expected(signature)
    WHERE p.oid=to_regprocedure('public.'||expected.signature))) THEN
  RAISE EXCEPTION 'Firebase erasure function overload changed';
 END IF;
 SELECT relowner INTO registry_owner FROM pg_class WHERE oid=to_regclass('public.account_deletion_tombstones');
 IF registry_owner IS NULL OR current_user<>session_user OR registry_owner<>(SELECT oid FROM pg_roles WHERE rolname=current_user) THEN
  RAISE EXCEPTION 'Firebase erasure requires the qualified Dev database owner';
 END IF;
 FOR spec IN SELECT * FROM (VALUES {",".join(rows)}) p(signature,sha256,volatility,configuration,public_execute) LOOP
  SELECT p.*,encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex') AS sha256
   INTO actual FROM pg_proc p WHERE p.oid=to_regprocedure('public.'||spec.signature);
  IF actual.sha256 IS DISTINCT FROM spec.sha256 OR actual.proowner IS DISTINCT FROM registry_owner
   OR actual.prosecdef IS DISTINCT FROM false OR actual.prokind IS DISTINCT FROM 'f'
   OR actual.provolatile::text IS DISTINCT FROM spec.volatility OR actual.proconfig IS DISTINCT FROM spec.configuration THEN
   RAISE EXCEPTION 'Firebase erasure function family changed: %',spec.signature;
  END IF;
  SELECT array_agg(grantee ORDER BY grantee) INTO grant_vector
   FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner)));
  IF grant_vector IS DISTINCT FROM (CASE WHEN spec.public_execute THEN ARRAY[0::oid,registry_owner] ELSE ARRAY[registry_owner] END)
   OR EXISTS(SELECT 1 FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) a
    WHERE a.grantor IS DISTINCT FROM registry_owner OR a.privilege_type IS DISTINCT FROM 'EXECUTE'
     OR a.is_grantable IS DISTINCT FROM false) THEN
   RAISE EXCEPTION 'Firebase erasure function ACL changed: %',spec.signature;
  END IF;
 END LOOP;
 FOR spec IN SELECT * FROM (VALUES {triggers}) p(relation,name,sha256) LOOP
  SELECT t.*,encode(sha256(convert_to(pg_get_triggerdef(t.oid,true),'UTF8')),'hex') AS sha256
   INTO actual FROM pg_trigger t WHERE t.tgrelid=to_regclass('public.'||spec.relation) AND t.tgname=spec.name;
  IF actual.sha256 IS DISTINCT FROM spec.sha256 OR actual.tgenabled IS DISTINCT FROM 'O'
   OR actual.tgisinternal IS DISTINCT FROM false THEN RAISE EXCEPTION 'Firebase erasure trigger changed'; END IF;
 END LOOP;
 FOR spec IN SELECT * FROM (VALUES ('firebase_erasure_authority','jsonb',false,NULL::text),
   ('firebase_erasure_checkpoint','jsonb',true,'''{{}}''::jsonb'),
   ('firebase_cleanup_project','text',false,NULL::text)) p(name,type,not_null,expression) LOOP
  SELECT a.*,pg_get_expr(d.adbin,d.adrelid) AS expression INTO actual FROM pg_attribute a
   LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
   WHERE a.attrelid='public.account_deletion_tombstones'::regclass AND a.attname=spec.name AND NOT a.attisdropped;
  IF actual.atttypid IS DISTINCT FROM to_regtype(spec.type) OR actual.attnotnull IS DISTINCT FROM spec.not_null
   OR actual.expression IS DISTINCT FROM spec.expression OR actual.atttypmod IS DISTINCT FROM -1
   OR actual.attndims IS DISTINCT FROM 0 OR actual.attidentity IS DISTINCT FROM '' OR actual.attgenerated IS DISTINCT FROM '' THEN
   RAISE EXCEPTION 'Firebase erasure column changed'; END IF;
 END LOOP;
END $qualify_firebase_erasure$;
"""


def replay_sql(entry) -> str:
    """Keep the exact successor instead of replacing it during419/437 replay."""
    from db.migration_authority import MigrationAuthorityError

    expected = HISTORICAL_SHA256.get(entry.migration_id)
    if (
        expected is None
        or entry.checksum_sha256 != expected
        or hashlib.sha256(entry.sql.encode()).hexdigest() != expected
    ):
        raise MigrationAuthorityError("Firebase erasure predecessor checksum changed")
    names = ["guard_account_generation_history"]
    if entry.migration_id == "419":
        names.append("retire_erased_account_generation")
    sql = entry.sql
    for name in names:
        pattern = rf"CREATE OR REPLACE FUNCTION public\.{name}\(\).*?\$\$;"
        matches = list(re.finditer(pattern, sql, flags=re.DOTALL))
        if len(matches) != 1:
            raise MigrationAuthorityError("Firebase erasure predecessor shape changed")
        body = matches[0].group()
        sql = sql.replace(
            body,
            f"""DO $preserve_firebase_erasure$ BEGIN
 IF {FOOTPRINT} THEN RETURN; END IF;
 EXECUTE $firebase_predecessor${body}$firebase_predecessor$;
END $preserve_firebase_erasure$;""",
            1,
        )
    sql = sql.replace("BEGIN;", "BEGIN;\n" + qualification_sql(), 1)
    before, after = sql.rsplit("COMMIT;", 1)
    return before + qualification_sql() + "COMMIT;" + after


def adoption_sql(sql: str) -> str:
    """420 admits only the complete exact new family and its three columns."""
    from db.migration_authority import MigrationAuthorityError

    anchors = {
        ") AS expected(t,col,typ,nn,def,ident,gen)": ",('account_deletion_tombstones','firebase_cleanup_project','text',false,NULL,'',''),('account_deletion_tombstones','firebase_erasure_authority','jsonb',false,NULL,'',''),('account_deletion_tombstones','firebase_erasure_checkpoint','jsonb',true,'''{}''::jsonb','','')) AS expected(t,col,typ,nn,def,ident,gen)",
        "('account_deletion_tombstones','account_shared_provider_authority'),": "('account_deletion_tombstones','account_shared_provider_authority'),('account_deletion_tombstones','account_firebase_erasure'),",
    }
    for anchor, replacement in anchors.items():
        if sql.count(anchor) != 1:
            raise MigrationAuthorityError("Firebase erasure420 inventory shape changed")
        sql = sql.replace(anchor, replacement, 1)
    sql = sql.replace("BEGIN;", "BEGIN;\n" + qualification_sql(), 1)
    before, after = sql.rsplit("COMMIT;", 1)
    return before + qualification_sql() + "COMMIT;" + after


def installation_sql(entry) -> str:
    from db.migration_authority import MigrationAuthorityError

    if (
        entry.filename != "987_account_firebase_erasure.sql"
        or entry.checksum_sha256 != SOURCE_SHA256
        or hashlib.sha256(entry.sql.encode()).hexdigest() != SOURCE_SHA256
    ):
        raise MigrationAuthorityError("Firebase erasure migration checksum changed")
    body = entry.sql.split("BEGIN;", 1)[1].rsplit("COMMIT;", 1)[0]
    return f"""BEGIN;
{qualification_sql()}
DO $install_firebase_erasure$ BEGIN
 IF {FOOTPRINT} THEN RETURN; END IF;
 EXECUTE $qualified_firebase_987${body}$qualified_firebase_987$;
END $install_firebase_erasure$;
{qualification_sql(required=True)}
COMMIT;
"""


PINS = {
    "guard_account_generation_history()": {
        "hash": "abb9a6535e8b94a26fd84d5d6c13d73c6e51466b39023e00574ecc719db24210",
        "provolatile": "v",
        "prosecdef": False,
        "prokind": "f",
        "proconfig": ["search_path=pg_catalog, public"],
        "publicExecute": True,
    },
    "retire_erased_account_generation()": {
        "hash": "c4f5858b9d2020bdb04e531fce9e38ab92d3ca309219f8ebe61cc31be83b491d",
        "provolatile": "v",
        "prosecdef": False,
        "prokind": "f",
        "proconfig": ["search_path=pg_catalog, public"],
        "publicExecute": True,
    },
    "account_firebase_erasure_contract_version()": {
        "hash": "95c84241a5b7977bfd95074bdcedb234863baf2c769c6785fad92ec9e3371b03",
        "provolatile": "i",
        "prosecdef": False,
        "prokind": "f",
        "proconfig": ["search_path=pg_catalog"],
        "publicExecute": False,
    },
    "account_firebase_erasure_qualified(public.account_deletion_tombstones)": {
        "hash": "85d4f3c325b77929eacd18e410f13428c3886639f2b4de3225ea79dae0852bd9",
        "provolatile": "i",
        "prosecdef": False,
        "prokind": "f",
        "proconfig": ["search_path=pg_catalog, public"],
        "publicExecute": False,
    },
    "guard_account_firebase_erasure()": {
        "hash": "7e2f2258232f39f1bf5505e2fc61c71b3f030c3b5795ef164062f48b94e03291",
        "provolatile": "v",
        "prosecdef": False,
        "prokind": "f",
        "proconfig": ["search_path=pg_catalog, public"],
        "publicExecute": False,
    },
    "account_legacy_cleanup_reference(text,integer)": {
        "hash": "727aff1e60214e302a50ac0b0a9e462ae99f33d01e6f81df2091e44b71ae8b7e",
        "provolatile": "i",
        "prosecdef": False,
        "prokind": "f",
        "proconfig": ["search_path=pg_catalog"],
        "publicExecute": False,
    },
    "account_legacy_provider_custody_absent(text)": {
        "hash": "e7adbd453ea2677c3c0b383ade0063a9a55247c6a9d200ac4fb69e820150b88a",
        "provolatile": "v",
        "prosecdef": False,
        "prokind": "f",
        "proconfig": ["search_path=pg_catalog, public"],
        "publicExecute": False,
    },
    "account_legacy_cleanup_settleable(public.account_generations)": {
        "hash": "64112e5c51743a6d218303832e9f9fccde15b2375a4bceca5a4c70b52b6efcaf",
        "provolatile": "v",
        "prosecdef": False,
        "prokind": "f",
        "proconfig": ["search_path=pg_catalog, public"],
        "publicExecute": False,
    },
    "settle_legacy_account_generation(text)": {
        "hash": "2808942c2f5dd9d9c40b07717baea88cc47ad3ddee91e21d6fe61601838b876e",
        "provolatile": "v",
        "prosecdef": False,
        "prokind": "f",
        "proconfig": ["search_path=pg_catalog, public"],
        "publicExecute": False,
    },
    "account_provider_cleanup_qualified(jsonb,jsonb,text,uuid)": {
        "hash": "e51c3dfb7150215f4f8c223e90ccbf9937bd054c66553d11dce73ec0a46d5b30",
        "provolatile": "i",
        "prosecdef": False,
        "prokind": "f",
        "proconfig": ["search_path=pg_catalog, public"],
        "publicExecute": True,
    },
    "guard_account_provider_cleanup_phase()": {
        "hash": "bb89dfb545d9c7da56159866bc259329dfd1bd6a5d64200413984e8d6ddb9e9a",
        "provolatile": "v",
        "prosecdef": False,
        "prokind": "f",
        "proconfig": ["search_path=pg_catalog, public"],
        "publicExecute": True,
    },
    "account_provider_cleanup_contract_version()": {
        "hash": "fa80a7519c272438cc2bd54a0468a361c14687f465b12e5a07c54ce0a618e2ad",
        "provolatile": "i",
        "prosecdef": False,
        "prokind": "f",
        "proconfig": None,
        "publicExecute": True,
    },
}
TRIGGERS = [
    {
        "relname": "account_deletion_tombstones",
        "tgname": "account_firebase_erasure",
        "hash": "5e1968d63298961542fb64869d34aae5fc7df4e6d224afe4702696bf21104111",
    },
    {
        "relname": "account_deletion_tombstones",
        "tgname": "account_generation_retirement",
        "hash": "d203d0b89efb0abc9213dc9eb3fb5691f80631a4c704ad629969e3749e7c6aca",
    },
    {
        "relname": "account_generations",
        "tgname": "account_generation_history",
        "hash": "52c0e47c1afdf8478d5afbc3fe10534c30d5dda7cf0e68921c3bf7b1d45ad9dd",
    },
]
SOURCE_SHA256 = "4bc5e466f787ff388ccdcf9abde5899b9fbf4ee2e781735671b91fd232439248"
HISTORICAL_SHA256 = {
    "419": "80ef582856e88fde3c0eaff882575e3b31d9252e54f2979ab133597a30c7af5e",
    "437": "ec88c716ba150978c605fb8b90c97526c89fbcea77a1a99abae829b1ed91638d",
}
