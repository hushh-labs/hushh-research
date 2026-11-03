"""Pure SQL builders for the reviewed installed 979/980/981 custody family."""

from __future__ import annotations

import json
from collections.abc import Mapping, Set

from db.hosted_custody_acl import (
    NATIVE_ACL_PROFILE_SETTING,
    NATIVE_PUBLIC_SIGNATURES,
    QUALIFIED_FAMILY_SETTING,
    family_acl_profile_sql,
)
from db.hosted_custody_family_sql import _FAMILY_SQL
from db.hosted_custody_profiles import (
    _DEV_ALTERNATE_FAMILY_HASHES,
    CUSTODY_PROFILE_ENV,
    DEV_CONTROL_PLANE_OWNER_PROFILE,
    DEV_CUSTODY_DATABASE,
    DEV_CUSTODY_INSTANCE,
    DEV_CUSTODY_PRINCIPAL,
    DEV_CUSTODY_PROJECT_ID,
    DEV_CUSTODY_SYSTEM_IDENTIFIER_SHA256,
    STRICT_CUSTODY_PROFILE,
    STRICT_PROFILE,
    HostedCustodyProfile,
)
from db.hosted_custody_profiles import (
    hosted_custody_profile_from_environment as _profile_from_environment,
)
from db.hosted_provider_account_custody import (
    _provider_transition_family_qualification_sql,
    append_provider_account_qualification_sql,
)

__all__ = [
    "DEV_CONTROL_PLANE_OWNER_PROFILE",
    "DEV_CUSTODY_DATABASE",
    "DEV_CUSTODY_INSTANCE",
    "DEV_CUSTODY_PRINCIPAL",
    "DEV_CUSTODY_PROJECT_ID",
    "DEV_CUSTODY_SYSTEM_IDENTIFIER_SHA256",
    "CUSTODY_PROFILE_ENV",
    "STRICT_CUSTODY_PROFILE",
    "STRICT_PROFILE",
    "HostedCustodyProfile",
    "UPGRADE_HOST_TRIGGER",
    "hosted_custody_profile_from_environment",
    "_provider_transition_family_qualification_sql",
]

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


def hosted_custody_profile_from_environment(
    environment: Mapping[str, str] | None = None,
) -> HostedCustodyProfile:
    """Resolve the profile through this module's reviewed identity constants."""
    profile = _profile_from_environment(environment)
    if profile.is_dev_control_plane_owner:
        return HostedCustodyProfile(profile.name, DEV_CUSTODY_SYSTEM_IDENTIFIER_SHA256)
    return profile


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


# The archive successor is accepted only under the explicit shared-Dev profile.


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
    provider_transition_family: Mapping[str, str] | None = None,
    provider_transition_trigger: tuple[str, str] | None = None,
    provider_transition_archive_sha256: str | None = None,
    provider_transition_intent_successor_sha256: str | None = None,
    provider_account_resolution_family: Mapping[str, str] | None = None,
    provider_account_resolution_service_role_signatures: Set[str] = frozenset(),
) -> str:
    """Fail closed on partial family footprints and qualify exact installed metadata."""
    qualified_native_contract_family = dict(native_contract_family)
    introduced_signatures = (
        set(hosted_files_new_signatures)
        | _NEW_UPGRADE_HOST_SIGNATURES
        | set(native_contract_new_signatures)
    )
    rows = _family_rows(
        base_family,
        files_family,
        upgrade_family,
        qualified_native_contract_family,
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
    alternate_hashes = dict(_ALTERNATE_FAMILY_HASHES)
    if profile.is_dev_control_plane_owner:
        alternate_hashes.update(_DEV_ALTERNATE_FAMILY_HASHES)
    alternate_hashes_json = json.dumps(
        {signature: list(digests) for signature, digests in alternate_hashes.items()},
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
    return append_provider_account_qualification_sql(
        sql,
        profile=profile,
        provider_transition_family=provider_transition_family,
        provider_transition_trigger=provider_transition_trigger,
        provider_transition_archive_sha256=provider_transition_archive_sha256,
        provider_transition_intent_successor_sha256=provider_transition_intent_successor_sha256,
        provider_account_resolution_family=provider_account_resolution_family,
        provider_account_resolution_service_role_signatures=provider_account_resolution_service_role_signatures,
    )
