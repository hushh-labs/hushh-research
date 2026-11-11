"""Exact successor pins for immutable private-agent adoption guards."""

from __future__ import annotations

import hashlib
import re

from db.hosted_custody_qualification import QUALIFIED_FAMILY_SETTING

_WORKER_EVENT_SUCCESSOR_SHA256 = "460ee7e26e2e65acd6937e29284f5d5f0c38013829337e8aa5ec03c27173a91c"


def _qualify_vm_publication_successor(sql: str) -> str:
    """Admit the exact host-binding VM proof only behind the complete family gate."""
    from db.migration_authority import MigrationAuthorityError

    anchor = (
        "ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN "
        "('5329963e73fc583df179883023536066a523583372c6ebd860d40df84107b918') THEN"
    )
    replacement = (
        "ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN "
        "('5329963e73fc583df179883023536066a523583372c6ebd860d40df84107b918') "
        "AND NOT ((current_setting('"
        + QUALIFIED_FAMILY_SETTING
        + "',true)='true') IS TRUE AND encode(sha256(convert_to(actual,'UTF8')),'hex')="
        "'1748051f173f41e3fdbed624b30a1027658a4448ae8592e6287196bc15bdc4fb') THEN"
    )
    if sql.count(anchor) != 1:
        raise MigrationAuthorityError("Private-agent Azure VM publication guard shape changed")
    return sql.replace(anchor, replacement, 1)


def _qualify_erasure_substrate_successor(sql: str) -> str:
    """Admit the exact 979 substrate validator only behind the complete family gate."""
    from db.migration_authority import MigrationAuthorityError

    anchor = (
        "ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN "
        "('9f42b37fa525127a5d18761ab6efbac6b00230627e4901aeac4d2fe467d85205') THEN"
    )
    replacement = (
        "ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN "
        "('9f42b37fa525127a5d18761ab6efbac6b00230627e4901aeac4d2fe467d85205') "
        "AND NOT ((current_setting('"
        + QUALIFIED_FAMILY_SETTING
        + "',true)='true') IS TRUE AND encode(sha256(convert_to(actual,'UTF8')),'hex')="
        "'a46891a22a5a07be0de6edcaa8e195b26f47951b8abf5fa5bfddec2b2b60c3ba') THEN"
    )
    if sql.count(anchor) != 1:
        raise MigrationAuthorityError("Private-agent erasure substrate guard shape changed")
    return sql.replace(anchor, replacement, 1)


def _qualify_worker_event_successor(sql: str) -> str:
    """Admit the measured worker-event successor behind the complete family gate."""
    from db.migration_authority import MigrationAuthorityError

    anchor = (
        "ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN "
        "('95233dcf09e1b7a056cf3d846beb562e157ebf5be907ba33592e96cd45654cb4') THEN"
    )
    successor = _WORKER_EVENT_SUCCESSOR_SHA256
    replacement = (
        "ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN "
        "('95233dcf09e1b7a056cf3d846beb562e157ebf5be907ba33592e96cd45654cb4') "
        "AND NOT ((current_setting('"
        + QUALIFIED_FAMILY_SETTING
        + "',true)='true') IS TRUE AND encode(sha256(convert_to(actual,'UTF8')),'hex')="
        f"'{successor}') THEN"
    )
    if sql.count(anchor) != 1:
        raise MigrationAuthorityError("Private-agent Azure worker-event guard shape changed")
    return sql.replace(anchor, replacement, 1)


def qualify_private_agent_successors(sql: str) -> str:
    """Accept only measured successor validators under the full custody-family GUC."""
    sql = _qualify_vm_publication_successor(sql)
    sql = _qualify_erasure_substrate_successor(sql)
    return _qualify_worker_event_successor(sql)


FOOTPRINT = """EXISTS(SELECT 1 FROM pg_attribute
 WHERE attrelid=to_regclass('public.personal_agent_cloud_removals')
 AND attname='retirement_handoff' AND NOT attisdropped)
 OR to_regprocedure('public.account_cloud_retirement_contract_version()') IS NOT NULL"""


def qualification_sql(*, required: bool = False) -> str:
    rows = []
    for signature, p in PINS.items():
        configuration = "ARRAY[" + ",".join("'" + c + "'" for c in p["config"]) + "]::text[]"
        rows.append(
            f"('{signature}','{p['hash']}','{p['volatility']}',"
            f"{str(p['securityDefiner']).lower()},{configuration},{str(p['publicExecute']).lower()})"
        )
    missing = "RAISE EXCEPTION 'Cloud retirement contract is absent';" if required else "RETURN;"
    constraints = ",".join(
        "('" + name + "','" + value.replace("'", "''") + "')" for name, value in CONSTRAINTS.items()
    )
    return f"""DO $qualify_cloud_retirement$
DECLARE spec record; actual record; owner_oid oid; service_oid oid; observed oid[]; expected oid[]; expected_hash text;
BEGIN
 IF NOT ({FOOTPRINT}) THEN {missing} END IF;
 SELECT relowner INTO owner_oid FROM pg_class WHERE oid='public.personal_agent_cloud_removals'::regclass;
 SELECT oid INTO service_oid FROM pg_roles WHERE rolname='service_role';
 IF current_user<>session_user OR owner_oid<>(SELECT oid FROM pg_roles WHERE rolname=current_user) THEN
  RAISE EXCEPTION 'Cloud retirement requires the qualified database owner'; END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND (p.proname LIKE 'account_cloud_retirement_%'
   OR p.proname IN (SELECT split_part(signature,'(',1) FROM (VALUES {",".join(rows)}) q(signature,h,v,s,c,a)))
  AND NOT EXISTS(SELECT 1 FROM (VALUES {",".join(rows)}) q(signature,h,v,s,c,a)
   WHERE p.oid=to_regprocedure('public.'||q.signature))) THEN
  RAISE EXCEPTION 'Cloud retirement overload changed'; END IF;
 FOR spec IN SELECT * FROM (VALUES {",".join(rows)}) q(signature,h,v,s,c,a) LOOP
  expected_hash:=CASE WHEN spec.signature='guard_personal_agent_erasure_registry()'
    AND to_regclass('public.hosted_files_executor_976_rollback_source') IS NOT NULL
    THEN '{NATIVE_REGISTRY_HASH}' ELSE spec.h END;
  SELECT p.*,encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex') AS hash
   INTO actual FROM pg_proc p WHERE p.oid=to_regprocedure('public.'||spec.signature);
  IF NOT FOUND OR actual.hash IS DISTINCT FROM expected_hash OR actual.proowner IS DISTINCT FROM owner_oid
   OR actual.prokind IS DISTINCT FROM 'f' OR actual.provolatile::text IS DISTINCT FROM spec.v
   OR actual.prosecdef IS DISTINCT FROM spec.s OR actual.proconfig IS DISTINCT FROM spec.c
   OR actual.proleakproof OR actual.proretset THEN
   RAISE EXCEPTION 'Cloud retirement function changed: %',spec.signature; END IF;
  SELECT array_agg(grantee ORDER BY grantee) INTO observed
   FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner)));
  SELECT array_agg(v ORDER BY v) INTO expected FROM unnest(
   ARRAY[owner_oid]||CASE WHEN spec.a THEN ARRAY[0::oid] ELSE ARRAY[]::oid[] END
   ||CASE WHEN service_oid IS NOT NULL AND spec.signature IN ({SERVICE_SIGNATURES}) THEN ARRAY[service_oid] ELSE ARRAY[]::oid[] END) v;
  IF observed IS DISTINCT FROM expected OR EXISTS(
   SELECT 1 FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) a
    WHERE a.grantor IS DISTINCT FROM owner_oid OR a.privilege_type<>'EXECUTE' OR a.is_grantable) THEN
   RAISE EXCEPTION 'Cloud retirement ACL changed: %',spec.signature; END IF;
 END LOOP;
 FOR spec IN SELECT * FROM (VALUES {constraints}) q(name,definition) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.personal_agent_cloud_removals'::regclass
   AND conname=spec.name AND contype='c' AND convalidated AND conislocal AND NOT condeferrable
   AND NOT condeferred AND coninhcount=0 AND pg_get_constraintdef(oid,true)=spec.definition) THEN
   RAISE EXCEPTION 'Cloud retirement constraint changed: %',spec.name; END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
  WHERE a.attrelid='public.personal_agent_cloud_removals'::regclass AND a.attname='retirement_handoff'
   AND NOT a.attisdropped AND a.atttypid='jsonb'::regtype AND a.atttypmod=-1 AND NOT a.attnotnull
   AND NOT a.atthasdef AND d.oid IS NULL AND a.attidentity='' AND a.attgenerated='' AND a.attndims=0) THEN
  RAISE EXCEPTION 'Cloud retirement column changed'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_cloud_removals'::regclass
  AND tgname='account_retired_generation_update' AND tgenabled='O' AND NOT tgisinternal AND tgtype=19
  AND tgfoid='public.reject_retired_account_update()'::regprocedure AND tgnargs=1
  AND encode(tgargs,'hex')=encode(convert_to('user_id','UTF8'),'hex')||'00'
  AND tgqual IS NULL AND tgattr::text='' AND tgparentid=0 AND tgconstraint=0
  AND NOT tgdeferrable AND NOT tginitdeferred AND tgoldtable IS NULL AND tgnewtable IS NULL) THEN
  RAISE EXCEPTION 'Cloud retirement generation guard changed'; END IF;
END $qualify_cloud_retirement$;
"""


def installation_sql(entry) -> str:
    from db.migration_authority import MigrationAuthorityError

    if (
        entry.filename != "988_account_cloud_retirement.sql"
        or entry.checksum_sha256 != SOURCE_SHA256
        or hashlib.sha256(entry.sql.encode()).hexdigest() != SOURCE_SHA256
    ):
        raise MigrationAuthorityError("Cloud retirement migration changed")
    body = entry.sql.split("BEGIN;", 1)[1].rsplit("COMMIT;", 1)[0]
    return f"""BEGIN;
{qualification_sql()}
DO $install_cloud_retirement$ BEGIN
 IF {FOOTPRINT} THEN RETURN; END IF;
 EXECUTE $reviewed_cloud_retirement${body}$reviewed_cloud_retirement$;
END $install_cloud_retirement$;
{qualification_sql(required=True)}
COMMIT;
"""


def preserve_definitions(sql: str) -> str:
    """Preserve exact successor bodies without skipping the rest of a replay."""
    for signature in PINS:
        name = signature.split("(", 1)[0]
        pattern = rf"CREATE OR REPLACE FUNCTION public\.{name}\([^;]*?\)\s*RETURNS.*?(?:\$\$|\$function\$);"
        matches = list(re.finditer(pattern, sql, flags=re.DOTALL))
        if not matches:
            continue
        if len(matches) != 1:
            raise ValueError(f"Cloud retirement predecessor shape changed: {name}")
        body = matches[0].group()
        sql = sql.replace(
            body,
            f"""DO $preserve_cloud_retirement$ BEGIN
 IF {FOOTPRINT} THEN RETURN; END IF;
 EXECUTE $cloud_retirement_predecessor${body}$cloud_retirement_predecessor$;
END $preserve_cloud_retirement$;""",
            1,
        )
    sql = sql.replace("BEGIN;", "BEGIN;\n" + qualification_sql(), 1)
    before, after = sql.rsplit("COMMIT;", 1)
    return before + qualification_sql() + "COMMIT;" + after


def adoption_sql(entry, sql: str) -> str:
    """419/420 keep every unrelated check and admit only this closed successor."""
    from db.migration_authority import MigrationAuthorityError

    if entry.migration_id in {"419", "421"}:
        return preserve_definitions(sql)
    if entry.migration_id != "420":
        return sql
    anchors = {
        ") AS expected(t,col,typ,nn,def,ident,gen)": ",('personal_agent_cloud_removals','retirement_handoff','jsonb',false,NULL,'','')) AS expected(t,col,typ,nn,def,ident,gen)",
        ") expected(t,name,definition,validated)": ","
        + ",".join(
            "('personal_agent_cloud_removals','"
            + name
            + "','"
            + value.replace("'", "''")
            + "',true)"
            for name, value in CONSTRAINTS.items()
            if name.startswith("cloud_removal_retir")
        )
        + ") expected(t,name,definition,validated)",
    }
    for anchor, replacement in anchors.items():
        if sql.count(anchor) != 1:
            raise MigrationAuthorityError("Cloud retirement420 inventory changed")
        sql = sql.replace(anchor, replacement, 1)
    for signature, p in PINS.items():
        name = signature.split("(", 1)[0]
        pattern = (
            rf"(NOT IN \([^)]*)\)( THEN\n  RAISE EXCEPTION 'Unqualified schema drift: {name}')"
        )
        sql, count = re.subn(pattern, rf"\g<1>,'{p['hash']}')\g<2>", sql)
        if count > 1:
            raise MigrationAuthorityError("Cloud retirement420 function preimage changed")
        if signature == "guard_personal_agent_erasure_registry()" and count == 1:
            anchor = f",'{p['hash']}') THEN\n  RAISE EXCEPTION 'Unqualified schema drift: {name}'"
            sql = sql.replace(
                anchor,
                anchor.replace(f",'{p['hash']}')", f",'{p['hash']}','{NATIVE_REGISTRY_HASH}')"),
                1,
            )
    blocks = [
        m.group()
        for m in re.finditer(r"DO \$object_guard\$.*?END\n\$object_guard\$;", sql, re.DOTALL)
        if 'ADD CONSTRAINT "personal_agent_cloud_removals_check2"' in m.group()
    ]
    if len(blocks) != 1:
        raise MigrationAuthorityError("Cloud retirement completion-constraint predecessor changed")
    body = blocks[0]
    sql = sql.replace(
        body,
        f"""DO $preserve_retirement_constraint$ BEGIN
 IF {FOOTPRINT} THEN RETURN; END IF;
 EXECUTE $original_retirement_constraint${body}$original_retirement_constraint$;
END $preserve_retirement_constraint$;""",
        1,
    )
    sql = sql.replace("BEGIN;", "BEGIN;\n" + qualification_sql(), 1)
    before, after = sql.rsplit("COMMIT;", 1)
    return before + qualification_sql() + "COMMIT;" + after


# Measured on disposable PostgreSQL16; never infer these pins from source text.
SOURCE_SHA256 = "e644fde14b9c542239644aafbe0f841063bcab57ee8551b142152ce48736b91e"
SERVICE_SIGNATURES = "'guard_byoc_authorization_attempts()','guard_personal_agent_erasure_registry()','guard_personal_agent_cloud_removal()','finalize_personal_agent_cloud_removal(text,text,text)','assert_project_grant_admission(text)'"
PINS = {
    "account_cloud_retirement_contract_version()": {
        "hash": "46ebf928a464716775dbb84ceca792d562792fa8f18691c6f4d28b042f0406d8",
        "volatility": "i",
        "securityDefiner": False,
        "config": ["search_path=public"],
        "publicExecute": False,
    },
    "account_cloud_retirement_handoff_valid(text,jsonb)": {
        "hash": "3fb6bfc2963fd3a7bb5741ba70db020890d8f2a9e4bff431f66569a73b7d70a6",
        "volatility": "s",
        "securityDefiner": False,
        "config": ["search_path=public"],
        "publicExecute": False,
    },
    "account_cloud_retirement_local_erasure_ready(text)": {
        "hash": "edc44eee732a394c9b5268d6db2b813efb105701021d91cb0330defbf564a382",
        "volatility": "s",
        "securityDefiner": False,
        "config": ["search_path=public"],
        "publicExecute": False,
    },
    "account_cloud_retirement_quiescent(text,text)": {
        "hash": "f1046f6f233b2ea1bf5be76dad685a94cbf7379a41d65afbd961696fdd92601a",
        "volatility": "s",
        "securityDefiner": False,
        "config": ["search_path=public"],
        "publicExecute": False,
    },
    "account_cloud_retirement_ready(text,text)": {
        "hash": "bddc407b8b4601b3f2b2d9241b399c313c5d220adb474c901796ddf4d23b87fd",
        "volatility": "s",
        "securityDefiner": False,
        "config": ["search_path=public"],
        "publicExecute": False,
    },
    "account_cloud_retirement_reservation(text,text)": {
        "hash": "28bb5f9a9653e44402a0e6986ae86ff1f315f2311c9e52cee30d310c77689f9a",
        "volatility": "s",
        "securityDefiner": False,
        "config": ["search_path=public"],
        "publicExecute": False,
    },
    "account_cloud_retirement_retained(text)": {
        "hash": "bd41c7655c4262350d3daf85d80ff74a720bf89db8ef291d54dbf77b31ffcde3",
        "volatility": "s",
        "securityDefiner": False,
        "config": ["search_path=public"],
        "publicExecute": False,
    },
    "account_cloud_retirement_transition_valid(jsonb,jsonb)": {
        "hash": "732ef5d93c3258b232c2709f9a0a6f1698a7931d52735641807d7d441cfd475c",
        "volatility": "s",
        "securityDefiner": False,
        "config": ["search_path=public"],
        "publicExecute": False,
    },
    "assert_project_grant_admission(text)": {
        "hash": "def10fe282d76a5b2ee1f786814ad668d941cb6ea165c2935ef97390a24298d4",
        "volatility": "v",
        "securityDefiner": False,
        "config": ["search_path=public"],
        "publicExecute": False,
    },
    "finalize_personal_agent_cloud_removal(text,text,text)": {
        "hash": "3a4924b44171ed93b15cfbf72d2f8eec167238376e922b38ec6539f82dbb2538",
        "volatility": "v",
        "securityDefiner": False,
        "config": ["search_path=public"],
        "publicExecute": False,
    },
    "guard_byoc_authorization_attempts()": {
        "hash": "5574fdb823d5654cee87c3b575b162a2f69fe79cc53293ff80251cb635283d91",
        "volatility": "v",
        "securityDefiner": False,
        "config": ["search_path=public"],
        "publicExecute": False,
    },
    "guard_personal_agent_cloud_removal()": {
        "hash": "0bcfb2a1762919ea62d9338d42e5d43a70bfa1b18cffc6faaf282a011257de76",
        "volatility": "v",
        "securityDefiner": False,
        "config": ["search_path=public"],
        "publicExecute": False,
    },
    "guard_personal_agent_erasure_registry()": {
        "hash": "30ddd268197a981d164f9ffba1dfb93ebb1ccef3aab8dc97925a0230a3874e99",
        "volatility": "v",
        "securityDefiner": False,
        "config": ["search_path=public"],
        "publicExecute": False,
    },
    "legacy_cloud_removal_complete(text,text)": {
        "hash": "c9a20c7143e9ada82bb9537803b742abb7e73df02a4c71151a483cc831b27b38",
        "volatility": "s",
        "securityDefiner": False,
        "config": ["search_path=public"],
        "publicExecute": False,
    },
    "legacy_cloud_removal_event_valid(jsonb,jsonb)": {
        "hash": "2d4afe0d0c6e1d62b22b7d7ea24c2311134090ad13f65119c0782a36ad2dfbfc",
        "volatility": "v",
        "securityDefiner": False,
        "config": ["search_path=public"],
        "publicExecute": False,
    },
    "reject_retired_account_update()": {
        "hash": "46ddbd3725e9d3ac0770d47257a99cace061e48c6d0e2aa6447a08e495a0a7d1",
        "volatility": "v",
        "securityDefiner": True,
        "config": ["search_path=pg_catalog, public, pg_temp"],
        "publicExecute": True,
    },
    "retain_account_cloud_retirement(text,uuid,text)": {
        "hash": "24a723475c31ae163e773e4ad6e60d9a8d4d6510012af9f6a33206d1c47ed63c",
        "volatility": "v",
        "securityDefiner": False,
        "config": ["search_path=public"],
        "publicExecute": False,
    },
    "retain_legacy_cloud_removal(text,text,text,jsonb,jsonb)": {
        "hash": "ec6753e784e56f1cfa4d212627f662227081206b1f421ae7642dea6515988f60",
        "volatility": "v",
        "securityDefiner": False,
        "config": ["search_path=public"],
        "publicExecute": False,
    },
}

CONSTRAINTS = {
    "cloud_removal_cancel_inert": "CHECK (cancelled_at IS NULL OR approved_digest IS NULL AND "
    "execution_started_at IS NULL AND completed_at IS NULL)",
    "cloud_removal_dispatch_pair": "CHECK ((execution_started_at IS NULL) = (execution_digest IS "
    "NULL))",
    "cloud_removal_recovery_bounded": "CHECK (recovery IS NULL OR jsonb_typeof(recovery) = "
    "'object'::text AND octet_length(recovery::text) <= 2097152)",
    "cloud_removal_retired_completion": "CHECK (completed_at IS NULL AND released_identity IS NULL OR "
    "completed_at IS NOT NULL AND (retirement_handoff IS NULL AND "
    "released_identity IS NOT NULL OR retirement_handoff IS NOT "
    "NULL AND released_identity IS NULL))",
    "cloud_removal_retirement_handoff_bounded": "CHECK (retirement_handoff IS NULL OR "
    "jsonb_typeof(retirement_handoff) = 'object'::text "
    "AND octet_length(retirement_handoff::text) <= "
    "2097152)",
    "personal_agent_cloud_removals_approved_digest_check": "CHECK (approved_digest ~ "
    "'^[0-9a-f]{64}$'::text)",
    "personal_agent_cloud_removals_archive_check": "CHECK (archive IS NULL OR jsonb_typeof(archive) = "
    "'object'::text AND octet_length(archive::text) <= "
    "2097152)",
    "personal_agent_cloud_removals_check": "CHECK ((approved_digest IS NULL) = (approved_at IS NULL))",
    "personal_agent_cloud_removals_check1": "CHECK ((completed_at IS NULL) = (archive IS NULL))",
    "personal_agent_cloud_removals_execution_digest_check": "CHECK (execution_digest ~ "
    "'^[0-9a-f]{64}$'::text)",
    "personal_agent_cloud_removals_placement_epoch_check": "CHECK (placement_epoch >= 0)",
    "personal_agent_cloud_removals_snapshot_sha256_check": "CHECK (snapshot_sha256 ~ "
    "'^[0-9a-f]{64}$'::text)",
}

# A partial successor without its marker must refuse rather than look absent.
FOOTPRINT += (
    " OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f' AND encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex') IN ("
    + ",".join("'" + p["hash"] + "'" for p in PINS.values())
    + "))"
)

NATIVE_REGISTRY_HASH = "4e46d9cfe6449efa70120cf0f5bef34f60d3ee11fbd9e05e8ed21518321c2dfa"
FOOTPRINT += (
    " OR EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.guard_personal_agent_erasure_registry()') AND encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex')='"
    + NATIVE_REGISTRY_HASH
    + "')"
)
