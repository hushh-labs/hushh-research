"""Qualify the exact Dev legacy-removal successor during historical replay."""

from __future__ import annotations

import hashlib

BOUNDED = "CHECK (recovery IS NULL OR jsonb_typeof(recovery) = 'object'::text AND octet_length(recovery::text) <= 2097152)"
FOOTPRINT = """EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.personal_agent_cloud_removals') AND attname='recovery' AND NOT attisdropped)
 OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
 AND (p.proname LIKE 'legacy_cloud_removal_%' OR p.proname='retain_legacy_cloud_removal'))"""


SOURCE_985_SHA256 = "8988d4fce12de68a9ed821575757a85697f12424e4e6569e10e53c6490da60e4"
PINS = {
    "assert_project_grant_admission(text)": "2d702143880933dad5bfa7e2e24edd02691f964e45b0f6b64ded12bfb3862a36",
    "guard_personal_agent_cloud_removal()": "b4ce03f6eca358014dd92ec8aa563451ad46661546bf8627d9bb611780359516",
    "finalize_personal_agent_cloud_removal(text,text,text)": "4b903616500da196c1bc2dc6972104a44a5618500ce4e2cd5d61f6a844e99dad",
    "legacy_cloud_removal_plan_valid(jsonb,jsonb)": "f23c1739d33b901c89723bdd39d5824665b7b4850317559812ad1321ff90bd2c",
    "legacy_cloud_removal_event_valid(jsonb,jsonb)": "e6de60a2c14524b1602fc47d414cae3f6e8f4704b210245d3371114734043c2d",
    "legacy_cloud_removal_append_valid(jsonb,jsonb,jsonb)": "d86f32b42ea86407c1688fd9c9a436e2e2c0ac6edbbd350da29d3bbfa578ad90",
    "legacy_cloud_removal_complete(text,text)": "e3742d02c03e82dd34bf414fd08875dbdae2deba500b5e444e01756af80d4c70",
    "legacy_cloud_removal_archive(jsonb,jsonb,jsonb)": "0d1de7d26bdadaf53c3d221544d158ce779875528d56b951d1247774e53d3b03",
    "retain_legacy_cloud_removal(text,text,text,jsonb,jsonb)": "f9b107acd715896cad1ae56acadee2732ca2385915d78c6c9bda1626c7aec07d",
}
FOOTPRINT += f""" OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname IN ('guard_personal_agent_cloud_removal','finalize_personal_agent_cloud_removal','assert_project_grant_admission')
 AND encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex') IN
 ('{PINS["guard_personal_agent_cloud_removal()"]}','{PINS["finalize_personal_agent_cloud_removal(text,text,text)"]}','{PINS["assert_project_grant_admission(text)"]}'))"""


def qualification_sql() -> str:
    """All bodies, authority, overloads, column, bound and guard must agree."""
    values = ",".join(f"('{signature}','{digest}')" for signature, digest in PINS.items())
    constraint = BOUNDED.replace("'", "''")
    return f"""DO $legacy_removal_qualified$
DECLARE spec record; installed record; owner_oid oid; service_oid oid;
BEGIN
 IF NOT ({FOOTPRINT}) THEN RETURN; END IF;
 LOCK TABLE public.personal_agent_cloud_removals IN SHARE UPDATE EXCLUSIVE MODE;
 SELECT relowner INTO owner_oid FROM pg_class WHERE oid='public.personal_agent_cloud_removals'::regclass;
 SELECT oid INTO service_oid FROM pg_roles WHERE rolname='service_role';
 IF NOT EXISTS(SELECT 1 FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
  WHERE a.attrelid='public.personal_agent_cloud_removals'::regclass AND a.attname='recovery' AND NOT a.attisdropped
   AND a.atttypid='jsonb'::regtype AND a.atttypmod=-1 AND NOT a.attnotnull AND NOT a.atthasdef
   AND a.attidentity='' AND a.attgenerated='' AND d.oid IS NULL)
 OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.personal_agent_cloud_removals'::regclass
  AND conname='cloud_removal_recovery_bounded' AND contype='c' AND convalidated AND conislocal
  AND NOT condeferrable AND NOT condeferred AND coninhcount=0 AND pg_get_constraintdef(oid,true)='{constraint}')
 THEN RAISE EXCEPTION 'Unqualified legacy removal schema'; END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND (p.proname LIKE 'legacy_cloud_removal_%' OR p.proname IN (SELECT split_part(signature,'(',1) FROM (VALUES {values}) x(signature,digest)))
   AND NOT EXISTS(SELECT 1 FROM (VALUES {values}) x(signature,digest) WHERE to_regprocedure('public.'||x.signature)=p.oid))
 THEN RAISE EXCEPTION 'Unqualified legacy removal overload'; END IF;
 FOR spec IN SELECT * FROM (VALUES {values}) x(signature,digest) LOOP
  SELECT p.*,pg_get_functiondef(p.oid) AS definition INTO installed FROM pg_proc p
   WHERE p.oid=to_regprocedure('public.'||spec.signature);
  IF NOT FOUND OR installed.proowner IS DISTINCT FROM owner_oid OR installed.prosecdef OR installed.proleakproof
   OR installed.prokind<>'f' OR installed.proconfig IS DISTINCT FROM ARRAY['search_path=public']::text[]
   OR encode(sha256(convert_to(installed.definition,'UTF8')),'hex') IS DISTINCT FROM spec.digest
   OR EXISTS(SELECT 1 FROM aclexplode(coalesce(installed.proacl,acldefault('f',installed.proowner))) a
    WHERE a.grantor IS DISTINCT FROM owner_oid OR a.privilege_type<>'EXECUTE'
     OR (a.grantee<>owner_oid AND (service_oid IS NULL OR a.grantee<>service_oid
       OR spec.signature NOT IN ('guard_personal_agent_cloud_removal()','finalize_personal_agent_cloud_removal(text,text,text)','assert_project_grant_admission(text)')
       OR a.is_grantable))) THEN RAISE EXCEPTION 'Unqualified legacy removal function: %',spec.signature; END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_cloud_removals'::regclass
  AND tgname='zz_personal_agent_cloud_removal' AND tgenabled='O' AND NOT tgisinternal AND tgtype=31
  AND tgnargs=0 AND tgqual IS NULL AND tgattr::text='' AND tgparentid=0 AND tgconstraint=0
  AND NOT tgdeferrable AND NOT tginitdeferred AND tgoldtable IS NULL AND tgnewtable IS NULL
  AND tgfoid=to_regprocedure('public.guard_personal_agent_cloud_removal()')::oid)
 THEN RAISE EXCEPTION 'Unqualified legacy removal trigger'; END IF;
END $legacy_removal_qualified$;
"""


def _once(sql: str, old: str, new: str) -> str:
    from db.migration_authority import MigrationAuthorityError

    if sql.count(old) != 1:
        raise MigrationAuthorityError("Legacy cloud-removal replay source shape changed")
    return sql.replace(old, new, 1)


def preserve_successor(entry, sql: str) -> str:
    """Adapt existing immutable420/421 only after qualifying the complete successor."""
    qualification = qualification_sql()
    if entry.migration_id == "420":
        sql = _once(
            sql,
            ") AS expected(t,col,typ,nn,def,ident,gen)",
            ",('personal_agent_cloud_removals','recovery','jsonb',false,NULL,'','')) AS expected(t,col,typ,nn,def,ident,gen)",
        )
        definition = BOUNDED.replace("'", "''")
        sql = _once(
            sql,
            ") expected(t,name,definition,validated)",
            f",('personal_agent_cloud_removals','cloud_removal_recovery_bounded','{definition}',true)) expected(t,name,definition,validated)",
        )
        for name, predecessors in {
            "assert_project_grant_admission": "'7809762b1a8f4e0703ca6d070c89fdec1d2ac30e2cd33298628d2dced7c72182'",
            "guard_personal_agent_cloud_removal": "'8a40a11e26b479b3666b9627036671aa1ed8b34de209f094270de1ae69fcb80a','eb565a365d386bd85d2409c33edb11dadd152981ab8407a30dae40fadebd53b7'",
            "finalize_personal_agent_cloud_removal": "'da5f9deff4c3a6c0175639f40373bef33595e681390274561280b65117d88b30'",
        }.items():
            signature = next(key for key in PINS if key.startswith(name + "("))
            anchor = f"NOT IN ({predecessors}) THEN\n  RAISE EXCEPTION 'Unqualified schema drift: {name}'"
            sql = _once(
                sql,
                anchor,
                anchor.replace(f"({predecessors})", f"({predecessors},'{PINS[signature]}')"),
            )
    elif entry.migration_id == "421":
        anchor = "CREATE OR REPLACE FUNCTION public.guard_personal_agent_cloud_removal()"
        start = sql.index(anchor)
        end = sql.index("$$;", start) + 3
        body = sql[start:end]
        replacement = f"""DO $retain_legacy_removal$ BEGIN
 IF {FOOTPRINT} THEN RETURN; END IF;
 EXECUTE $reviewed_cloud_guard${body}$reviewed_cloud_guard$;
END $retain_legacy_removal$;"""
        sql = _once(sql, body, replacement)
    else:
        return sql
    sql = _once(sql, "BEGIN;", "BEGIN;\n" + qualification)
    before, after = sql.rsplit("COMMIT;", 1)
    return before + qualification + "COMMIT;" + after


def installation_sql(entry) -> str:
    """A matching reapplication verifies the whole family instead of replacing it."""
    from db.migration_authority import MigrationAuthorityError

    if (
        entry.filename != "985_legacy_cloud_removal_recovery.sql"
        or entry.checksum_sha256 != SOURCE_985_SHA256
        or hashlib.sha256(entry.sql.encode()).hexdigest() != SOURCE_985_SHA256
    ):
        raise MigrationAuthorityError("Legacy cloud-removal source checksum changed")
    body = entry.sql.split("BEGIN;", 1)[1].rsplit("COMMIT;", 1)[0]
    return f"""BEGIN;
{qualification_sql()}
DO $legacy_install$ BEGIN
 IF {FOOTPRINT} THEN RETURN; END IF;
 EXECUTE $reviewed_985${body}$reviewed_985$;
END $legacy_install$;
{qualification_sql()}
COMMIT;
"""
