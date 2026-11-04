"""Explicit strict/shared-Dev hosted custody profiles."""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass

_DEV_ALTERNATE_FAMILY_HASHES = {
    "personal_agent_erasure_archive(jsonb,jsonb)": (
        "aef9e2ea2a5757e2601c3853c062625c56a2df889b29e6aac3d7d192367a466a",
    ),
    "hosted_pod_cleanup_admitted(text,text,jsonb)": (
        "a240e2346c02137441ec68b5597807df8ef0646cb82c3abde1e1573e5fb881f5",
    ),
    "hosted_preparation_cleanup_admitted(text,text,jsonb)": (
        "9b35795e390939c4c2a3c5aab207e19d057a0fd4855689cd4cf4fa4463018426",
    ),
    "valid_managed_preparation_cleanup(jsonb,text,jsonb)": (
        "9f684aec984b39aa47ce1d52b7d200269a033aa1c4b230c0ccef9b6325284522",
    ),
    "valid_erasure_managed_project_retirement(jsonb,text,jsonb)": (
        "fd94f3bd8a45790f4177fbdfc496a186ed18824c1c75ebadca0ce8862966640e",
    ),
    "hosted_prefix_abort_admitted(text,text,jsonb)": (
        "8ea7a69c33a0b33e5c7ddbd640966a059dbcc9a74723e79af754e3ce5469e65c",
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
