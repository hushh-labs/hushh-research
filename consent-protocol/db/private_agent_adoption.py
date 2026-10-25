"""Qualify reviewed predecessor states before immutable lifecycle adoption.

Column, constraint and index predecessors have canonical/parked SQL lineage.
Retained guards come from peer migrations 938/939 (253e89abe8/ac86743508).
Their exact reviewed definitions are compatibility evidence, not new product consent.
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
 IF found_count=0
  AND to_regclass('public.consumer_mcp_connections') IS NULL
  AND to_regprocedure('public.guard_consumer_memory_consent()') IS NULL
  AND to_regprocedure('public.preserve_consumer_memory_consent()') IS NULL
 THEN RETURN; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_class
   WHERE oid=to_regclass('public.consumer_mcp_connections')
    AND relkind='r' AND relpersistence='p') THEN
  RAISE EXCEPTION 'Missing legacy consumer consent relation';
 END IF;
 IF found_count<>2 THEN RAISE EXCEPTION 'Incomplete legacy consumer consent guards'; END IF;
 FOR spec IN SELECT * FROM (VALUES {values})
  AS expected(name,function_name,kind,trigger_hash,function_hash,configuration) LOOP
  SELECT t.*,p.prosecdef,p.proconfig,p.proname,p.proowner,p.proleakproof,
   n.nspname AS function_schema,
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
   OR installed.proleakproof OR installed.proowner IS DISTINCT FROM
     (SELECT relowner FROM pg_class WHERE oid='public.consent_audit'::regclass)
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


HISTORY_CHECK = "byoc_setup_authorization_history_object"
HISTORY_DEFINITION = "CHECK (jsonb_typeof(authorization_attempts) = 'object'::text) NOT VALID"


def _authorization_attempts_sql() -> str:
    """Retain SQLNULL as JSONnull, with unknown histories immutable on reuse."""
    return """DO $authorization_attempts_adoption$
DECLARE relation regclass; column_state record; retained record; has_check boolean;
BEGIN
 relation:=to_regclass('public.byoc_setup_jobs');
 IF relation IS NULL THEN RETURN; END IF;
 LOCK TABLE public.byoc_setup_jobs IN SHARE UPDATE EXCLUSIVE MODE;
 SELECT a.attnum,a.atttypid,a.atttypmod,a.attndims,a.attnotnull,a.attidentity,a.attgenerated,
  d.oid AS default_oid,pg_get_expr(d.adbin,d.adrelid,true) AS default_expression
  INTO column_state FROM pg_attribute a
  LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
  WHERE a.attrelid=relation AND a.attname='authorization_attempts'
   AND a.attnum>0 AND NOT a.attisdropped;
 IF NOT FOUND THEN RETURN; END IF;
 IF column_state.atttypid<>'pg_catalog.jsonb'::regtype OR column_state.atttypmod<>-1
  OR column_state.attndims<>0 OR column_state.attidentity<>''
  OR column_state.attgenerated<>'' THEN
  RAISE EXCEPTION 'Unqualified legacy authorization_attempts column';
 END IF;
 SELECT k.*,pg_get_constraintdef(k.oid,true) AS definition INTO retained
  FROM pg_constraint k WHERE k.conrelid=relation AND k.conname='@CHECK@';
 has_check:=FOUND;
 IF has_check AND (retained.contype<>'c' OR retained.convalidated
  OR retained.condeferrable OR retained.condeferred OR retained.connoinherit
  OR NOT retained.conislocal OR retained.coninhcount<>0 OR retained.conparentid<>0
  OR retained.conkey IS DISTINCT FROM ARRAY[column_state.attnum]::smallint[]
  OR retained.definition IS DISTINCT FROM $definition$@DEFINITION@$definition$) THEN
  RAISE EXCEPTION 'Unqualified authorization_attempts retention check';
 END IF;
 IF column_state.attnotnull AND column_state.default_expression=$empty_default$'{}'::jsonb$empty_default$ THEN
  IF NOT has_check AND EXISTS(SELECT 1 FROM public.byoc_setup_jobs
   WHERE authorization_attempts='null'::jsonb) THEN
   RAISE EXCEPTION 'Missing authorization_attempts retention check';
  END IF;
  RETURN;
 END IF;
 IF column_state.attnotnull OR column_state.default_oid IS NOT NULL THEN
  RAISE EXCEPTION 'Unqualified legacy authorization_attempts column';
 END IF;
 -- Installed row guards retain authority. Their refusal aborts, never bypasses.
 LOCK TABLE public.byoc_setup_jobs IN ACCESS EXCLUSIVE MODE;
 UPDATE public.byoc_setup_jobs SET authorization_attempts='null'::jsonb
  WHERE authorization_attempts IS NULL;
 ALTER TABLE public.byoc_setup_jobs ALTER COLUMN authorization_attempts
  SET DEFAULT '{}'::jsonb, ALTER COLUMN authorization_attempts SET NOT NULL;
 IF NOT has_check THEN
  ALTER TABLE public.byoc_setup_jobs ADD CONSTRAINT @CHECK@
   CHECK(jsonb_typeof(authorization_attempts)='object') NOT VALID;
 END IF;
END
$authorization_attempts_adoption$;
""".replace("@CHECK@", HISTORY_CHECK).replace("@DEFINITION@", HISTORY_DEFINITION)


# Parked906/907/904 predecessors;420 retains the948/916/913 successors.
_PREDECESSORS = (
    (
        "personal_agent_registry",
        "personal_agent_registry_deployment_target_check",
        "c",
        "CHECK (deployment_target IS NULL OR (deployment_target = ANY (ARRAY['gcp'::text, 'user_gcp'::text, 'anypoint'::text, 'null'::text])))",
        "15c9243d622f15d2ca2690cb232af88e3e51b5d586e72042b9000177cc4cc300",
        "deployment_target",
    ),
    (
        "personal_agent_registry",
        "personal_agent_registry_model_credential_mode_check",
        "c",
        "CHECK (model_credential_mode IS NULL OR (model_credential_mode = ANY (ARRAY['user_adc'::text, 'byok_per_turn'::text, 'fleet_adc'::text])))",
        "03b2cc3705300b7115c1806556abb0ec275507605d4653efa52555c7e1d02ef3",
        "model_credential_mode",
    ),
    (
        "personal_agent_registry",
        "personal_agent_registry_status_check",
        "c",
        "CHECK (status = ANY (ARRAY['unprovisioned'::text, 'pending'::text, 'provisioning'::text, 'connecting'::text, 'provisioned'::text, 'provisioning_failed'::text, 'reaped'::text]))",
        "e95bfe7efd8c4c91b3f2ccc2d1defc567ad10a3dcc7734007d1828b9d333c18f",
        "status",
    ),
    (
        "consent_audit_receipts",
        "consent_audit_receipts_subject_id_hash_key",
        "u",
        "UNIQUE (subject_id, hash)",
        "",
        "subject_id,hash",
    ),
    (
        "consent_audit_receipts",
        "consent_audit_receipts_subject_id_seq_key",
        "u",
        "UNIQUE (subject_id, seq)",
        "",
        "subject_id,seq",
    ),
)


def _predecessor_constraints_sql() -> str:
    values = ",\n".join(
        "(" + ",".join("'" + value.replace("'", "''") + "'" for value in spec) + ")"
        for spec in _PREDECESSORS
    )
    return """DO $private_agent_predecessors$
DECLARE spec record; relation regclass; retained record; backing record; columns text[];
BEGIN
 FOR spec IN SELECT * FROM (VALUES @VALUES@)
  AS expected(table_name,name,kind,definition,successor_hash,columns) LOOP
  relation:=to_regclass(format('public.%I',spec.table_name));
  IF relation IS NULL THEN CONTINUE; END IF;
  EXECUTE format('LOCK TABLE public.%I IN SHARE UPDATE EXCLUSIVE MODE',spec.table_name);
  SELECT k.*,pg_get_constraintdef(k.oid,true) AS definition INTO retained
   FROM pg_constraint k WHERE k.conrelid=relation AND k.conname=spec.name;
  IF NOT FOUND THEN CONTINUE; END IF;
  SELECT array_agg(a.attname::text ORDER BY x.position) INTO columns
   FROM unnest(retained.conkey) WITH ORDINALITY x(attribute,position)
   JOIN pg_attribute a ON a.attrelid=relation AND a.attnum=x.attribute;
  IF retained.contype::text<>spec.kind OR NOT retained.convalidated
   OR retained.condeferrable OR retained.condeferred
   OR retained.connoinherit IS DISTINCT FROM (spec.kind='u')
   OR NOT retained.conislocal OR retained.coninhcount<>0 OR retained.conparentid<>0
   OR columns IS DISTINCT FROM string_to_array(spec.columns,',') THEN
   RAISE EXCEPTION 'Unqualified private-agent predecessor: %',spec.name;
  END IF;
  IF retained.definition IS DISTINCT FROM spec.definition THEN
   IF encode(sha256(convert_to(retained.definition,'UTF8')),'hex')=spec.successor_hash THEN
    CONTINUE;
   END IF;
   RAISE EXCEPTION 'Unqualified private-agent predecessor: %',spec.name;
  END IF;
  IF spec.kind='u' THEN
   SELECT i.*,pg_get_indexdef(i.indexrelid) AS definition INTO backing
    FROM pg_index i WHERE i.indexrelid=retained.conindid AND i.indrelid=relation;
   IF NOT FOUND OR NOT backing.indisunique OR NOT backing.indisvalid
    OR NOT backing.indisready OR NOT backing.indislive OR backing.indisprimary
    OR backing.indisexclusion OR backing.indisreplident OR backing.indisclustered
    OR backing.indnatts<>2 OR backing.indnkeyatts<>2
    OR backing.indexprs IS NOT NULL OR backing.indpred IS NOT NULL
    OR backing.indkey::text<>array_to_string(retained.conkey,' ')
    OR backing.definition IS DISTINCT FROM format(
     'CREATE UNIQUE INDEX %I ON public.%I USING btree (%s)',
     spec.name,spec.table_name,replace(spec.columns,',',', ')) THEN
    RAISE EXCEPTION 'Unqualified private-agent predecessor index: %',spec.name;
   END IF;
  END IF;
  EXECUTE format('LOCK TABLE public.%I IN ACCESS EXCLUSIVE MODE',spec.table_name);
  IF spec.name='personal_agent_registry_deployment_target_check'
   AND EXISTS(SELECT 1 FROM public.personal_agent_registry WHERE deployment_target='anypoint') THEN
   RAISE EXCEPTION 'Unqualified anypoint placement before private-agent adoption';
  END IF;
  EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I',spec.table_name,spec.name);
 END LOOP;
END
$private_agent_predecessors$;
""".replace("@VALUES@", values)


def _predecessor_index_sql() -> str:
    return """DO $private_agent_receipt_index$
DECLARE relation regclass; retained record; signature text;
BEGIN
 relation:=to_regclass('public.idx_consent_audit_receipts_subject');
 IF relation IS NULL THEN RETURN; END IF;
 LOCK TABLE public.consent_audit_receipts IN SHARE UPDATE EXCLUSIVE MODE;
 SELECT i.*,pg_get_indexdef(i.indexrelid) AS definition INTO retained
  FROM pg_index i WHERE i.indexrelid=relation
   AND i.indrelid='public.consent_audit_receipts'::regclass;
 IF NOT FOUND THEN RAISE EXCEPTION 'Unqualified private-agent receipt index'; END IF;
 signature:=encode(sha256(convert_to(retained.definition,'UTF8')),'hex');
 IF NOT retained.indisvalid OR NOT retained.indisready OR NOT retained.indislive
  OR retained.indisunique OR retained.indisprimary OR retained.indisexclusion
  OR retained.indisreplident OR retained.indisclustered OR retained.indexprs IS NOT NULL
  OR retained.indpred IS NOT NULL OR retained.indnatts<>retained.indnkeyatts
  OR EXISTS(SELECT 1 FROM pg_constraint WHERE conindid=relation) THEN
  RAISE EXCEPTION 'Unqualified private-agent receipt index';
 END IF;
 IF signature='d9c1519f6ac0529791dfa55dd00d62de8a6a9b4de6a9bf7bd264bc8bc0debbb5' THEN RETURN; END IF;
 IF signature<>'ceef0869d7a7093723742f8eb018a34a78b18a1af11a797ea3a2769a1858c3dd' THEN
  RAISE EXCEPTION 'Unqualified private-agent receipt index';
 END IF;
 LOCK TABLE public.consent_audit_receipts IN ACCESS EXCLUSIVE MODE;
 DROP INDEX public.idx_consent_audit_receipts_subject;
END
$private_agent_receipt_index$;
"""


def _receipt_ledger_sql() -> str:
    """Expand the reviewed 904 receipt table using the additive 913 successor."""
    return """DO $private_agent_receipt_ledger$
BEGIN
 IF to_regclass('public.consent_audit_receipts') IS NULL THEN RETURN; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_attribute
   WHERE attrelid='public.consent_audit_receipts'::regclass AND attname='ledger'
    AND attnum>0 AND NOT attisdropped) THEN
  ALTER TABLE public.consent_audit_receipts
   ADD COLUMN ledger TEXT NOT NULL DEFAULT 'consent';
 END IF;
 -- Existing columns remain subject to the immutable foundation inventory.
END
$private_agent_receipt_ledger$;
"""


def _retention_inventory_sql(sql: str) -> str:
    from db.migration_authority import MigrationAuthorityError

    lines = [
        line
        for line in sql.splitlines()
        if line.startswith(" IF EXISTS(SELECT 1 FROM pg_constraint k JOIN pg_class c")
        and line.endswith(
            "THEN RAISE EXCEPTION 'Unqualified private-agent constraint drift'; END IF;"
        )
    ]
    anchor = ") expected(t,name,definition,validated)"
    if len(lines) != 1 or lines[0].count(anchor) != 1:
        raise MigrationAuthorityError("Private-agent adoption constraint inventory changed")
    definition = HISTORY_DEFINITION.replace("'", "''")
    extra = f",('byoc_setup_jobs','{HISTORY_CHECK}','{definition}',false)"
    return sql.replace(lines[0], lines[0].replace(anchor, extra + anchor), 1)


def private_agent_adoption_sql(entry: MigrationManifestEntryV2) -> str:
    """Retain immutable history while qualifying reviewed adoption states."""
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
    column_anchor = "DO $pod_414$\nBEGIN\n IF EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_class c"
    if entry.sql.count(column_anchor) != 1:
        raise MigrationAuthorityError("Private-agent adoption column inventory changed")
    preparation = (
        _authorization_attempts_sql()
        + _predecessor_constraints_sql()
        + _predecessor_index_sql()
        + _receipt_ledger_sql()
    )
    sql = entry.sql.replace(column_anchor, preparation + column_anchor, 1)
    sql = _retention_inventory_sql(sql)
    qualified = block.replace(_ANCHOR, _ANCHOR + additions)
    if not entry.sql.rstrip().endswith("COMMIT;"):
        raise MigrationAuthorityError("Private-agent adoption transaction source changed")
    adapted = sql.replace(block, _qualification_sql() + qualified, 1)
    before_commit, commit = adapted.rsplit("COMMIT;", 1)
    return before_commit + _qualification_sql() + "COMMIT;" + commit


def execution_sql(
    entry: MigrationManifestEntryV2,
    *,
    replay: Callable[[MigrationManifestEntryV2], str] | None = None,
) -> str:
    """Adapt pending420 in either executing mode; caller keeps observe/skip gates."""
    if entry.migration_id == "420":
        return private_agent_adoption_sql(entry)
    return replay(entry) if replay is not None else entry.sql
