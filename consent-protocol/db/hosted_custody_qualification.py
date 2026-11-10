"""Pure SQL builders for the reviewed installed 979/980/981 custody family."""

from __future__ import annotations

import json
import os
from collections.abc import Mapping, Set
from dataclasses import dataclass

from db.hosted_custody_acl import (
    NATIVE_ACL_PROFILE_SETTING,
    NATIVE_PUBLIC_SIGNATURES,
    QUALIFIED_FAMILY_SETTING,
    family_acl_profile_sql,
)

ROLLBACK_SOURCE_TABLE = "hosted_files_executor_976_rollback_source"
UPGRADE_HOST_TRIGGER = "zz_personal_agent_upgrade_lease_host_binding"
UPGRADE_HOST_TRIGGER_SHA256 = "7ff4229943ee886ec56f561f6aa2c1f0423305c6fe06badb1bab5ad0b7ba56ac"
PROJECT_GRANT_TRIGGER = "zx_project_grant_registry"
PROJECT_GRANT_TRIGGER_SHA256 = "97497b99a3ff0971b2d6facdf88e2385e913e2b6da3abcf752557c17befdbd21"
ERASURE_REGISTRY_TRIGGER = "zz_personal_agent_erasure_registry"
ERASURE_REGISTRY_TRIGGER_SHA256 = "4812dbadfde3e0f4682839f476fedf4b53814e14cfc90f4442a870946f66a573"

ROLLBACK_SOURCE_PREIMAGES = {
    "guard_personal_agent_erasure_registry()": "1e2357c1d4d76fd6e78b16137734bf59cfa18f4229200c653cce9bc3315db0d1",
    "guard_project_grant_registry_admission()": "38822c10a774c8c8602cf8b2788436a83958167b7bcfb302d37eef3bcb9e3d54",
    "personal_agent_erasure_archive(jsonb,jsonb)": "9a7a7b1bb39aa33c5f397eb0e42848aeeaceb16931e043fc9ccc7f8f20ddbee8",
    "personal_agent_erasure_complete(text)": "7f28101ba074765abb5699bf8dd42668e8449e77229ec43033d511fc3a217467",
    "valid_erasure_substrate_inventory(jsonb,jsonb)": "9f42b37fa525127a5d18761ab6efbac6b00230627e4901aeac4d2fe467d85205",
}

MEASURED_PUBLIC_SIGNATURES = frozenset(
    {
        "personal_agent_upgrade_lease_host_binding(jsonb)",
        "guard_personal_agent_upgrade_lease_host_binding()",
    }
)

_LEGACY_SERVICE_ROLE_NAMES = frozenset(
    {
        "expected_erasure_bootstrap_release",
        "guard_personal_agent_erasure_registry",
        "guard_project_grant_registry_admission",
        "personal_agent_erasure_archive",
        "personal_agent_erasure_archived",
        "personal_agent_erasure_complete",
        "project_grant_release_is_exclusive",
        "reserve_erasure_grant_release",
        "reserve_personal_agent_erasure",
        "valid_erasure_files_receipt",
        "valid_erasure_gcp_files_upgrade_observation",
        "valid_erasure_grant_release",
        "valid_erasure_kms_receipt",
        "valid_erasure_mail_receipt",
        "valid_erasure_memory_binding",
        "valid_erasure_repository_grant_receipt",
        "valid_erasure_repository_inventory",
        "valid_erasure_secret_receipt",
        "valid_erasure_substrate_inventory",
        "valid_erasure_writer_receipt",
    }
)

_NEW_UPGRADE_HOST_SIGNATURES = frozenset(
    {
        "personal_agent_upgrade_lease_host_binding(jsonb)",
        "guard_personal_agent_upgrade_lease_host_binding()",
    }
)

_PREDECESSOR_HASHES = {
    "valid_erasure_memory_binding(jsonb,jsonb)": "3e6f72daf26d7532d6764d190cb6337410e3c97f845dbe9dfd10907dc5d5a8dd",
    "valid_byoc_azure_worker_event(text,text,jsonb,jsonb,text,text)": "95233dcf09e1b7a056cf3d846beb562e157ebf5be907ba33592e96cd45654cb4",
    "valid_erasure_substrate_inventory(jsonb,jsonb)": "9f42b37fa525127a5d18761ab6efbac6b00230627e4901aeac4d2fe467d85205",
    "azure_vm_image_publication_proven(personal_agent_registry,personal_agent_registry)": "5329963e73fc583df179883023536066a523583372c6ebd860d40df84107b918",
}

# Dev retains the 95233 worker-event body, while the independently reviewed 961
# lineage retains the 460ee body. No other worker-event definition is accepted.
_ALTERNATE_FAMILY_HASHES = {
    "valid_byoc_azure_worker_event(text,text,jsonb,jsonb,text,text)": (
        "460ee7e26e2e65acd6937e29284f5d5f0c38013829337e8aa5ec03c27173a91c",
    ),
}

CUSTODY_PROFILE_ENV = "HUSHH_HOSTED_CUSTODY_PROFILE"
STRICT_CUSTODY_PROFILE = "strict"
DEV_CONTROL_PLANE_OWNER_PROFILE = "dev_control_plane_owner"
DEV_CUSTODY_PROJECT_ID = "hushh-pda-dev"
DEV_CUSTODY_INSTANCE = "hushh-pda-dev:us-central1:hushh-dev-pg"
DEV_CUSTODY_DATABASE = "postgres"
DEV_CUSTODY_PRINCIPAL = "hushh_uat_app"
DEV_CUSTODY_SYSTEM_IDENTIFIER_SHA256 = (
    "320fe60c039c7a44aa11e7b670de5e3576d9c4ab7e95de76657719b6c56810b0"
)


@dataclass(frozen=True)
class HostedCustodyProfile:
    """One explicit profile used by runtime readiness and migration replay."""

    name: str
    system_identifier_sha256: str | None = None

    @property
    def is_dev_control_plane_owner(self) -> bool:
        return self.name == DEV_CONTROL_PLANE_OWNER_PROFILE


STRICT_PROFILE = HostedCustodyProfile(STRICT_CUSTODY_PROFILE)


def hosted_custody_profile_from_environment(
    environment: Mapping[str, str] | None = None,
) -> HostedCustodyProfile:
    """Resolve the explicit Dev profile from the same DB connection settings as runtime."""
    values = os.environ if environment is None else environment
    requested = str(values.get(CUSTODY_PROFILE_ENV) or "")
    if requested in ("", STRICT_CUSTODY_PROFILE):
        return STRICT_PROFILE
    if requested != DEV_CONTROL_PLANE_OWNER_PROFILE:
        raise ValueError("Unsupported hosted custody profile selection")

    expected = {
        "ENVIRONMENT": "dev",
        "DEV_TARGET": "shared-dev",
        "GCP_PROJECT_ID": DEV_CUSTODY_PROJECT_ID,
        "GOOGLE_CLOUD_PROJECT": DEV_CUSTODY_PROJECT_ID,
        "CLOUDSQL_INSTANCE_CONNECTION_NAME": DEV_CUSTODY_INSTANCE,
        "DB_NAME": DEV_CUSTODY_DATABASE,
        "DB_USER": DEV_CUSTODY_PRINCIPAL,
    }
    mismatches = [name for name, value in expected.items() if str(values.get(name) or "") != value]
    if mismatches:
        raise ValueError(
            "Dev hosted custody profile requires exact shared-Dev configuration: "
            + ", ".join(mismatches)
        )
    return HostedCustodyProfile(
        DEV_CONTROL_PLANE_OWNER_PROFILE,
        DEV_CUSTODY_SYSTEM_IDENTIFIER_SHA256,
    )


def _profile_identity_sql(profile: HostedCustodyProfile) -> str:
    if not profile.is_dev_control_plane_owner:
        return ""
    system_identifier_hash = profile.system_identifier_sha256
    if system_identifier_hash != DEV_CUSTODY_SYSTEM_IDENTIFIER_SHA256:
        raise ValueError("Dev hosted custody profile has an unreviewed PostgreSQL identity")
    return f"""
 IF current_database() IS DISTINCT FROM '{DEV_CUSTODY_DATABASE}'
  OR current_user IS DISTINCT FROM '{DEV_CUSTODY_PRINCIPAL}'
  OR session_user IS DISTINCT FROM '{DEV_CUSTODY_PRINCIPAL}'
  OR NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner
   WHERE c.oid=to_regclass('public.personal_agent_registry') AND c.relkind='r'
    AND r.rolname='{DEV_CUSTODY_PRINCIPAL}')
  OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role')
  OR (SELECT encode(sha256(convert_to(system_identifier::text,'UTF8')),'hex')
      FROM pg_control_system()) IS DISTINCT FROM '{system_identifier_hash}' THEN
  RAISE EXCEPTION 'Unqualified managed 979/980/981 custody family: Dev database identity';
 END IF;
"""


_FAMILY_SQL = r"""DO $hosted_custody_full_family$
DECLARE family jsonb := convert_from(decode('@FAMILY_JSON_HEX@','hex'),'UTF8')::jsonb;
 preimages jsonb := convert_from(decode('@PREIMAGES_JSON_HEX@','hex'),'UTF8')::jsonb;
 alternate_hashes jsonb := convert_from(decode('@ALTERNATE_HASHES_JSON_HEX@','hex'),'UTF8')::jsonb;
 family_names text[]; family_footprint boolean; marker_oid oid; registry_owner oid;
 service_role_oid oid; marker record; marker_signature_attnum smallint;
 canonical_acl_profile boolean; native_acl_profile boolean;
 owner_canonical_acl_profile boolean; owner_native_acl_profile boolean;
 expected_count integer := @FAMILY_COUNT@; actual_count integer;
BEGIN
 PERFORM set_config('@SETTING@','false',true);
 PERFORM set_config('@NATIVE_SETTING@','',true);
 @PROFILE_IDENTITY_SQL@
 SELECT array_agg(DISTINCT f.proname ORDER BY f.proname)
  INTO family_names FROM jsonb_to_recordset(family) AS f(
   signature text,proname text,expected_hash text,base_hash text,files_hash text,
   upgrade_hash text,native_contract_hash text,direct_service boolean,service_required boolean,
   public_required boolean,introduced boolean,function_path text);
 marker_oid:=to_regclass('public.@MARKER@')::oid;
 SELECT marker_oid IS NOT NULL
  OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname=ANY(ARRAY(
    SELECT f.proname FROM jsonb_to_recordset(family) AS f(
     signature text,proname text,expected_hash text,base_hash text,files_hash text,
     upgrade_hash text,native_contract_hash text,direct_service boolean,service_required boolean,
     public_required boolean,introduced boolean,function_path text) WHERE f.introduced)))
  OR EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
   JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND t.tgname='@TRIGGER@')
  OR EXISTS(SELECT 1 FROM jsonb_to_recordset(family) AS f(
   signature text,proname text,expected_hash text,base_hash text,files_hash text,
   upgrade_hash text,native_contract_hash text,direct_service boolean,service_required boolean,
   public_required boolean,introduced boolean,function_path text)
   JOIN pg_proc p ON p.oid=to_regprocedure('public.'||f.signature)
   WHERE (f.files_hash<>'' AND f.files_hash<>f.base_hash
      AND encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex')=f.files_hash)
    OR (f.upgrade_hash<>'' AND f.upgrade_hash<>f.base_hash
      AND encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex')=f.upgrade_hash)
    OR (f.native_contract_hash<>'' AND f.native_contract_hash<>f.base_hash
      AND encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex')=f.native_contract_hash))
 INTO family_footprint;
 IF family_footprint IS NOT TRUE THEN
  IF @REQUIRE_FAMILY@ THEN
   RAISE EXCEPTION 'Unqualified managed 979/980/981 custody family: required family absent';
  END IF;
  RETURN;
 END IF;
 IF marker_oid IS NULL THEN
  RAISE EXCEPTION 'Unqualified managed 979/980/981 custody family: missing rollback marker';
 END IF;

 SELECT c.* INTO marker FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.oid=marker_oid;
 IF NOT FOUND OR marker.relkind<>'r' OR marker.relpersistence<>'p' THEN
  RAISE EXCEPTION 'Unqualified managed 979/980/981 custody family: rollback marker relation';
 END IF;
 SELECT c.relowner INTO registry_owner FROM pg_class c
  WHERE c.oid=to_regclass('public.personal_agent_registry') AND c.relkind='r';
 SELECT r.oid INTO service_role_oid FROM pg_roles r WHERE r.rolname='service_role';
 IF registry_owner IS NULL THEN
  RAISE EXCEPTION 'Unqualified managed 979/980/981 custody family: owner roles';
 END IF;
 IF '@PROFILE@'='dev_control_plane_owner' THEN
  IF service_role_oid IS NOT NULL THEN
   RAISE EXCEPTION 'Unqualified managed 979/980/981 custody family: Dev service role';
  END IF;
 ELSIF service_role_oid IS NULL OR service_role_oid=registry_owner THEN
  RAISE EXCEPTION 'Unqualified managed 979/980/981 custody family: owner roles';
 END IF;
 IF marker.relowner<>registry_owner THEN
  RAISE EXCEPTION 'Unqualified managed 979/980/981 custody family: rollback marker owner';
 END IF;

 SELECT a.attnum INTO marker_signature_attnum FROM pg_attribute a
  WHERE a.attrelid=marker_oid AND a.attname='signature' AND a.attnum>0 AND NOT a.attisdropped;
 IF (SELECT count(*) FROM pg_attribute a WHERE a.attrelid=marker_oid
     AND a.attnum>0 AND NOT a.attisdropped)<>2
  OR marker_signature_attnum IS NULL
  OR NOT EXISTS(SELECT 1 FROM pg_attribute a LEFT JOIN pg_attrdef d
    ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid=marker_oid AND a.attname='signature' AND a.attnum>0
     AND NOT a.attisdropped AND a.atttypid='pg_catalog.text'::regtype
     AND a.atttypmod=-1 AND a.attndims=0 AND a.attnotnull AND a.attidentity=''
     AND a.attgenerated='' AND d.oid IS NULL)
  OR NOT EXISTS(SELECT 1 FROM pg_attribute a LEFT JOIN pg_attrdef d
    ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid=marker_oid AND a.attname='definition' AND a.attnum>0
     AND NOT a.attisdropped AND a.atttypid='pg_catalog.text'::regtype
     AND a.atttypmod=-1 AND a.attndims=0 AND a.attnotnull AND a.attidentity=''
     AND a.attgenerated='' AND d.oid IS NULL)
  OR (SELECT count(*) FROM pg_constraint k WHERE k.conrelid=marker_oid)<>1
  OR NOT EXISTS(SELECT 1 FROM pg_constraint k WHERE k.conrelid=marker_oid
    AND k.contype='p' AND k.conkey=ARRAY[marker_signature_attnum]::smallint[]
    AND k.convalidated AND NOT k.condeferrable AND NOT k.condeferred
    AND k.connoinherit AND k.conislocal AND k.coninhcount=0 AND k.conparentid=0)
  OR (SELECT count(*) FROM pg_index i WHERE i.indrelid=marker_oid)<>1
  OR NOT EXISTS(SELECT 1 FROM pg_index i JOIN pg_constraint k ON k.conindid=i.indexrelid
    WHERE i.indrelid=marker_oid AND k.conrelid=marker_oid AND k.contype='p'
     AND i.indisunique AND i.indisvalid AND i.indisready AND i.indislive AND i.indisprimary
     AND NOT i.indisexclusion AND i.indnatts=1 AND i.indnkeyatts=1
     AND i.indexprs IS NULL AND i.indpred IS NULL
     AND i.indkey::text=marker_signature_attnum::text)
  OR EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=marker_oid AND NOT t.tgisinternal)
  OR EXISTS(SELECT 1 FROM aclexplode(COALESCE(marker.relacl,
      acldefault('r',marker.relowner))) a
    WHERE a.grantee<>marker.relowner OR a.grantor<>marker.relowner OR a.is_grantable)
  OR EXISTS(SELECT 1 FROM aclexplode(COALESCE(marker.relacl,
      acldefault('r',marker.relowner))) a WHERE NOT EXISTS(
    SELECT 1 FROM aclexplode(acldefault('r',marker.relowner)) d
    WHERE (d.grantee,d.grantor,d.privilege_type,d.is_grantable)=
      (a.grantee,a.grantor,a.privilege_type,a.is_grantable)))
  OR EXISTS(SELECT 1 FROM aclexplode(acldefault('r',marker.relowner)) d
    WHERE NOT EXISTS(SELECT 1 FROM aclexplode(COALESCE(marker.relacl,
      acldefault('r',marker.relowner))) a
      WHERE (a.grantee,a.grantor,a.privilege_type,a.is_grantable)=
       (d.grantee,d.grantor,d.privilege_type,d.is_grantable))) THEN
  RAISE EXCEPTION 'Unqualified managed 979/980/981 custody family: rollback marker shape or ACL';
 END IF;
 IF (SELECT count(*) FROM public.@MARKER@)<>5
  OR EXISTS(SELECT 1 FROM jsonb_to_recordset(preimages) AS e(
   signature text,definition_hash text)
   LEFT JOIN public.@MARKER@ s ON s.signature=e.signature
   WHERE s.signature IS NULL OR encode(sha256(convert_to(s.definition,'UTF8')),'hex')
      IS DISTINCT FROM e.definition_hash)
  OR EXISTS(SELECT 1 FROM public.@MARKER@ s WHERE NOT EXISTS(
   SELECT 1 FROM jsonb_to_recordset(preimages) AS e(signature text,definition_hash text)
   WHERE e.signature=s.signature)) THEN
  RAISE EXCEPTION 'Unqualified managed 979/980/981 custody family: rollback preimages';
 END IF;

 SELECT count(*) INTO actual_count FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname=ANY(family_names);
 IF actual_count<>expected_count OR EXISTS(SELECT 1 FROM pg_proc p
   JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname=ANY(family_names)
    AND NOT EXISTS(SELECT 1 FROM jsonb_to_recordset(family) AS f(
     signature text,proname text,expected_hash text,base_hash text,files_hash text,
     upgrade_hash text,native_contract_hash text,direct_service boolean,service_required boolean,
     public_required boolean,introduced boolean,function_path text)
     WHERE to_regprocedure('public.'||f.signature)=p.oid)) THEN
  RAISE EXCEPTION 'Unqualified managed 979/980/981 custody family: overload or missing function';
 END IF;
 IF EXISTS(SELECT 1 FROM jsonb_to_recordset(family) AS f(
   signature text,proname text,expected_hash text,base_hash text,files_hash text,
   upgrade_hash text,native_contract_hash text,direct_service boolean,service_required boolean,
   public_required boolean,introduced boolean,function_path text)
   LEFT JOIN pg_proc p ON p.oid=to_regprocedure('public.'||f.signature)
   WHERE p.oid IS NULL
    OR (
      encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex')<>f.expected_hash
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(
       COALESCE(alternate_hashes->f.signature,'[]'::jsonb)) allowed(hash)
       WHERE allowed.hash=encode(
        sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex'))
    )
    OR p.proowner<>registry_owner OR p.prosecdef IS TRUE OR p.proparallel<>'u'
    OR p.proleakproof IS TRUE OR p.proisstrict IS TRUE OR p.proretset IS TRUE
    OR p.prokind<>'f' OR p.proargmodes IS NOT NULL OR p.provariadic<>0
    OR p.procost<>100 OR p.prorows<>0
    OR p.proconfig IS DISTINCT FROM ARRAY['search_path='||f.function_path]::text[]) THEN
  RAISE EXCEPTION 'Unqualified managed 979/980/981 custody family: function vector or metadata';
 END IF;

 @ACL_PROFILE_SQL@
 IF '@PROFILE@'='dev_control_plane_owner' THEN
  IF owner_canonical_acl_profile IS NOT TRUE AND owner_native_acl_profile IS NOT TRUE THEN
   RAISE EXCEPTION 'Unqualified managed 979/980/981 custody family: owner-only function ACL';
  END IF;
 ELSIF canonical_acl_profile IS NOT TRUE AND native_acl_profile IS NOT TRUE THEN
  RAISE EXCEPTION 'Unqualified managed 979/980/981 custody family: function ACL';
 END IF;

 IF (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
   JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND t.tgname='@TRIGGER@')<>1
  OR NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
   JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND c.oid=to_regclass('public.personal_agent_registry')
    AND t.tgname='@TRIGGER@' AND t.tgenabled IN ('O','A') AND t.tgtype=23
    AND t.tgfoid=to_regprocedure('public.guard_personal_agent_upgrade_lease_host_binding()')
    AND NOT t.tgisinternal AND t.tgnargs=0 AND encode(t.tgargs,'hex')=''
    AND t.tgattr::text='' AND t.tgconstraint=0 AND NOT t.tgdeferrable
    AND NOT t.tginitdeferred AND t.tgqual IS NULL AND t.tgoldtable IS NULL
    AND t.tgnewtable IS NULL AND t.tgparentid=0
    AND encode(sha256(convert_to(pg_get_triggerdef(t.oid,true),'UTF8')),'hex')
      ='@TRIGGER_SHA@') THEN
  RAISE EXCEPTION 'Unqualified managed 979/980/981 custody family: upgrade host trigger';
 END IF;
 IF (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND t.tgname='@PROJECT_GRANT_TRIGGER@')<>1
  OR NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.oid=to_regclass('public.personal_agent_registry')
      AND t.tgname='@PROJECT_GRANT_TRIGGER@' AND t.tgenabled IN ('O','A') AND t.tgtype=23
      AND t.tgfoid=to_regprocedure('public.guard_project_grant_registry_admission()')
      AND NOT t.tgisinternal AND t.tgnargs=0 AND encode(t.tgargs,'hex')=''
      AND t.tgattr::text='' AND t.tgconstraint=0 AND NOT t.tgdeferrable
      AND NOT t.tginitdeferred AND t.tgqual IS NULL AND t.tgoldtable IS NULL
      AND t.tgnewtable IS NULL AND t.tgparentid=0
      AND encode(sha256(convert_to(pg_get_triggerdef(t.oid,true),'UTF8')),'hex')
       ='@PROJECT_GRANT_TRIGGER_SHA@') THEN
  RAISE EXCEPTION 'Unqualified managed 979/980/981 custody family: project grant trigger';
 END IF;
 IF (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND t.tgname='@ERASURE_REGISTRY_TRIGGER@')<>1
  OR NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.oid=to_regclass('public.personal_agent_registry')
      AND t.tgname='@ERASURE_REGISTRY_TRIGGER@' AND t.tgenabled IN ('O','A') AND t.tgtype=27
      AND t.tgfoid=to_regprocedure('public.guard_personal_agent_erasure_registry()')
      AND NOT t.tgisinternal AND t.tgnargs=0 AND encode(t.tgargs,'hex')=''
      AND t.tgattr::text='' AND t.tgconstraint=0 AND NOT t.tgdeferrable
      AND NOT t.tginitdeferred AND t.tgqual IS NULL AND t.tgoldtable IS NULL
      AND t.tgnewtable IS NULL AND t.tgparentid=0
      AND encode(sha256(convert_to(pg_get_triggerdef(t.oid,true),'UTF8')),'hex')
       ='@ERASURE_REGISTRY_TRIGGER_SHA@') THEN
  RAISE EXCEPTION 'Unqualified managed 979/980/981 custody family: erasure registry trigger';
 END IF;
 IF native_acl_profile IS TRUE
  OR ('@PROFILE@'='dev_control_plane_owner'
      AND (owner_canonical_acl_profile IS TRUE OR owner_native_acl_profile IS TRUE)) THEN
  PERFORM set_config('@NATIVE_SETTING@','true',true);
 END IF;
 PERFORM set_config('@SETTING@','true',true);
END
$hosted_custody_full_family$;
"""


def _family_rows(
    base_family: Mapping[str, str],
    files_family: Mapping[str, str],
    upgrade_family: Mapping[str, str],
    native_contract_family: Mapping[str, str],
    service_role_signatures: Set[str],
    introduced_signatures: Set[str],
) -> list[dict[str, object]]:
    final_family = {**base_family, **files_family, **upgrade_family, **native_contract_family}
    service_names = {signature.partition("(")[0] for signature in service_role_signatures}
    direct_names = service_names - {
        "personal_agent_upgrade_lease_host_binding",
        "guard_personal_agent_upgrade_lease_host_binding",
    }
    direct_names.update(_LEGACY_SERVICE_ROLE_NAMES)
    rows = []
    for signature, digest in sorted(final_family.items()):
        name = signature.partition("(")[0]
        rows.append(
            {
                "signature": signature,
                "proname": name,
                "expected_hash": digest,
                "base_hash": base_family.get(signature, _PREDECESSOR_HASHES.get(signature, "")),
                "files_hash": files_family.get(signature, ""),
                "upgrade_hash": upgrade_family.get(signature, ""),
                "native_contract_hash": native_contract_family.get(signature, ""),
                "direct_service": name in direct_names,
                "service_required": name in service_names,
                "public_required": signature in MEASURED_PUBLIC_SIGNATURES,
                "native_direct_service": signature not in NATIVE_PUBLIC_SIGNATURES,
                "native_public_required": signature in NATIVE_PUBLIC_SIGNATURES,
                "introduced": signature in introduced_signatures,
                "function_path": (
                    "pg_catalog"
                    if signature
                    in {
                        "managed_prefix_resource_name(jsonb,jsonb)",
                        "managed_prefix_resource_step(text)",
                    }
                    else "public"
                ),
            }
        )
    return rows


def complete_family_qualification_sql(
    *,
    base_family: Mapping[str, str],
    files_family: Mapping[str, str],
    upgrade_family: Mapping[str, str],
    native_contract_family: Mapping[str, str],
    service_role_signatures: Set[str],
    hosted_files_new_signatures: Set[str],
    native_contract_new_signatures: Set[str],
    require_family: bool = False,
    profile: HostedCustodyProfile = STRICT_PROFILE,
) -> str:
    """Fail closed on partial family footprints and qualify exact installed metadata."""
    introduced_signatures = (
        set(hosted_files_new_signatures)
        | _NEW_UPGRADE_HOST_SIGNATURES
        | set(native_contract_new_signatures)
    )
    rows = _family_rows(
        base_family,
        files_family,
        upgrade_family,
        native_contract_family,
        service_role_signatures,
        introduced_signatures,
    )
    family_json = json.dumps(rows, separators=(",", ":"))
    preimages_json = json.dumps(
        [
            {"signature": signature, "definition_hash": digest}
            for signature, digest in sorted(ROLLBACK_SOURCE_PREIMAGES.items())
        ],
        separators=(",", ":"),
    )
    alternate_hashes_json = json.dumps(
        {signature: list(digests) for signature, digests in _ALTERNATE_FAMILY_HASHES.items()},
        separators=(",", ":"),
    )
    replacements = {
        "@FAMILY_JSON_HEX@": family_json.encode("utf-8").hex(),
        "@PREIMAGES_JSON_HEX@": preimages_json.encode("utf-8").hex(),
        "@ALTERNATE_HASHES_JSON_HEX@": alternate_hashes_json.encode("utf-8").hex(),
        "@FAMILY_COUNT@": str(len(rows)),
        "@SETTING@": QUALIFIED_FAMILY_SETTING,
        "@NATIVE_SETTING@": NATIVE_ACL_PROFILE_SETTING,
        "@ACL_PROFILE_SQL@": family_acl_profile_sql(),
        "@PROFILE@": profile.name,
        "@PROFILE_IDENTITY_SQL@": _profile_identity_sql(profile),
        "@MARKER@": ROLLBACK_SOURCE_TABLE,
        "@TRIGGER@": UPGRADE_HOST_TRIGGER,
        "@TRIGGER_SHA@": UPGRADE_HOST_TRIGGER_SHA256,
        "@PROJECT_GRANT_TRIGGER@": PROJECT_GRANT_TRIGGER,
        "@PROJECT_GRANT_TRIGGER_SHA@": PROJECT_GRANT_TRIGGER_SHA256,
        "@ERASURE_REGISTRY_TRIGGER@": ERASURE_REGISTRY_TRIGGER,
        "@ERASURE_REGISTRY_TRIGGER_SHA@": ERASURE_REGISTRY_TRIGGER_SHA256,
        "@REQUIRE_FAMILY@": "TRUE" if require_family else "FALSE",
    }
    sql = _FAMILY_SQL
    for token, value in replacements.items():
        sql = sql.replace(token, value)
    from db import account_cloud_retirement_adoption as retirement

    # Preserve the installed Files guard's full behavior. Its one qualified
    # retirement prefix is admissible only after the entire new contract passes;
    # every existing custody function, marker, preimage and ACL check still runs.
    extra = json.dumps(
        {"guard_personal_agent_erasure_registry()": [retirement.NATIVE_REGISTRY_HASH]},
        separators=(",", ":"),
    ).replace("'", "''")
    sql = sql.replace(
        "BEGIN\n",
        f"""BEGIN
 IF ({retirement.FOOTPRINT}) THEN
  alternate_hashes:=alternate_hashes||'{extra}'::jsonb;
 END IF;
""",
        1,
    )
    return retirement.qualification_sql() + sql
