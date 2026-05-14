#!/usr/bin/env python3
"""
Mirror the local Kai test surface into the localhost email/password reviewer user.

This is local-only operational tooling. It copies the reviewer-facing PKM + profile
surface from the canonical Kai test UID into a separate Firebase password user so
Playwright / local reviewer login can behave like the Kai account without mutating
the original user.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
from dataclasses import dataclass
from uuid import uuid4

import asyncpg
import firebase_admin
from dotenv import dotenv_values
from firebase_admin import auth, credentials

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROTOCOL_DIR = os.path.dirname(SCRIPT_DIR)
DEFAULT_ENV_PATH = os.path.join(PROTOCOL_DIR, ".env")


def _require(config: dict[str, str | None], key: str) -> str:
    value = str(config.get(key) or os.getenv(key) or "").strip()
    if not value:
        raise RuntimeError(f"Missing required config: {key}")
    return value


def _optional(config: dict[str, str | None], key: str) -> str:
    return str(config.get(key) or os.getenv(key) or "").strip()


def _log(message: str) -> None:
    print(f"[local-reviewer-sync] {message}")


def _init_firebase_admin(config: dict[str, str | None]) -> None:
    if firebase_admin._apps:  # type: ignore[attr-defined]
        return
    service_account_json = _require(config, "FIREBASE_ADMIN_CREDENTIALS_JSON")
    firebase_admin.initialize_app(credentials.Certificate(json.loads(service_account_json)))


@dataclass(frozen=True)
class MirrorUsers:
    source_uid: str
    target_uid: str
    target_email: str
    source_display_name: str
    source_photo_url: str


def _resolve_users(
    config: dict[str, str | None], source_uid: str, target_email: str, target_password: str
) -> MirrorUsers:
    _init_firebase_admin(config)
    source_user = auth.get_user(source_uid)
    target_user = auth.get_user_by_email(target_email)

    auth.update_user(
        target_user.uid,
        display_name=source_user.display_name or "Kai Test Reviewer",
        photo_url=source_user.photo_url,
        password=target_password,
    )

    _log(
        f"Firebase target user ready: target_uid={target_user.uid} display_name={source_user.display_name or 'Kai Test Reviewer'}"
    )

    return MirrorUsers(
        source_uid=source_user.uid,
        target_uid=target_user.uid,
        target_email=target_user.email or target_email,
        source_display_name=source_user.display_name or "Kai Test Reviewer",
        source_photo_url=source_user.photo_url or "",
    )


async def _connect_db(config: dict[str, str | None]) -> asyncpg.Connection:
    return await asyncpg.connect(
        host=_optional(config, "DB_HOST") or "127.0.0.1",
        port=int(_optional(config, "DB_PORT") or "6543"),
        database=_optional(config, "DB_NAME") or "postgres",
        user=_optional(config, "DB_USER") or "postgres",
        password=_optional(config, "DB_PASSWORD"),
    )


DELETE_TARGET_SQL = [
    "DELETE FROM pkm_scope_registry WHERE user_id = $1",
    "DELETE FROM pkm_manifest_paths WHERE user_id = $1",
    "DELETE FROM pkm_manifests WHERE user_id = $1",
    "DELETE FROM pkm_blobs WHERE user_id = $1",
    "DELETE FROM pkm_index WHERE user_id = $1",
    "DELETE FROM ria_profiles WHERE user_id = $1",
    "DELETE FROM marketplace_public_profiles WHERE user_id = $1",
    "DELETE FROM runtime_persona_state WHERE user_id = $1",
    "DELETE FROM actor_profiles WHERE user_id = $1",
    "DELETE FROM vault_key_wrappers WHERE user_id = $1",
    "DELETE FROM vault_keys WHERE user_id = $1",
]


async def _mirror_local_surface(conn: asyncpg.Connection, users: MirrorUsers) -> None:
    async with conn.transaction():
        for statement in DELETE_TARGET_SQL:
            await conn.execute(statement, users.target_uid)

        await conn.execute(
            """
            INSERT INTO vault_keys (
              user_id,
              vault_status,
              vault_key_hash,
              primary_method,
              primary_wrapper_id,
              recovery_encrypted_vault_key,
              recovery_salt,
              recovery_iv,
              first_login_at,
              last_login_at,
              login_count,
              pre_onboarding_completed,
              pre_onboarding_skipped,
              pre_onboarding_completed_at,
              pre_nav_tour_completed_at,
              pre_nav_tour_skipped_at,
              pre_state_updated_at,
              created_at,
              updated_at,
              user_email
            )
            SELECT
              $2,
              vault_status,
              vault_key_hash,
              primary_method,
              primary_wrapper_id,
              recovery_encrypted_vault_key,
              recovery_salt,
              recovery_iv,
              first_login_at,
              last_login_at,
              login_count,
              pre_onboarding_completed,
              pre_onboarding_skipped,
              pre_onboarding_completed_at,
              pre_nav_tour_completed_at,
              pre_nav_tour_skipped_at,
              pre_state_updated_at,
              created_at,
              updated_at,
              $3
            FROM vault_keys
            WHERE user_id = $1
            """,
            users.source_uid,
            users.target_uid,
            users.target_email,
        )

        await conn.execute(
            """
            INSERT INTO vault_key_wrappers (
              user_id,
              method,
              wrapper_id,
              encrypted_vault_key,
              salt,
              iv,
              passkey_credential_id,
              passkey_prf_salt,
              passkey_rp_id,
              passkey_provider,
              passkey_device_label,
              passkey_last_used_at,
              created_at,
              updated_at
            )
            SELECT
              $2,
              method,
              wrapper_id,
              encrypted_vault_key,
              salt,
              iv,
              passkey_credential_id,
              passkey_prf_salt,
              passkey_rp_id,
              passkey_provider,
              passkey_device_label,
              passkey_last_used_at,
              created_at,
              updated_at
            FROM vault_key_wrappers
            WHERE user_id = $1
            """,
            users.source_uid,
            users.target_uid,
        )

        await conn.execute(
            """
            INSERT INTO pkm_index (
              user_id,
              available_domains,
              domain_summaries,
              computed_tags,
              activity_score,
              last_active_at,
              total_attributes,
              created_at,
              updated_at,
              model_version,
              last_upgraded_at
            )
            SELECT
              $2,
              available_domains,
              domain_summaries,
              computed_tags,
              activity_score,
              last_active_at,
              total_attributes,
              created_at,
              updated_at,
              model_version,
              last_upgraded_at
            FROM pkm_index
            WHERE user_id = $1
            """,
            users.source_uid,
            users.target_uid,
        )

        await conn.execute(
            """
            INSERT INTO pkm_blobs (
              user_id,
              domain,
              segment_id,
              ciphertext,
              iv,
              tag,
              algorithm,
              content_revision,
              manifest_revision,
              size_bytes,
              created_at,
              updated_at
            )
            SELECT
              $2,
              domain,
              segment_id,
              ciphertext,
              iv,
              tag,
              algorithm,
              content_revision,
              manifest_revision,
              size_bytes,
              created_at,
              updated_at
            FROM pkm_blobs
            WHERE user_id = $1
            """,
            users.source_uid,
            users.target_uid,
        )

        await conn.execute(
            """
            INSERT INTO pkm_manifests (
              user_id,
              domain,
              manifest_version,
              structure_decision,
              summary_projection,
              top_level_scope_paths,
              externalizable_paths,
              segment_ids,
              path_count,
              externalizable_path_count,
              last_structured_at,
              last_content_at,
              created_at,
              updated_at,
              domain_contract_version,
              readable_summary_version,
              upgraded_at
            )
            SELECT
              $2,
              domain,
              manifest_version,
              structure_decision,
              summary_projection,
              top_level_scope_paths,
              externalizable_paths,
              segment_ids,
              path_count,
              externalizable_path_count,
              last_structured_at,
              last_content_at,
              created_at,
              updated_at,
              domain_contract_version,
              readable_summary_version,
              upgraded_at
            FROM pkm_manifests
            WHERE user_id = $1
            """,
            users.source_uid,
            users.target_uid,
        )

        await conn.execute(
            """
            INSERT INTO pkm_manifest_paths (
              user_id,
              domain,
              json_path,
              parent_path,
              path_type,
              segment_id,
              scope_handle,
              exposure_eligibility,
              consent_label,
              sensitivity_label,
              source_agent,
              created_at,
              updated_at
            )
            SELECT
              $2,
              domain,
              json_path,
              parent_path,
              path_type,
              segment_id,
              scope_handle,
              exposure_eligibility,
              consent_label,
              sensitivity_label,
              source_agent,
              created_at,
              updated_at
            FROM pkm_manifest_paths
            WHERE user_id = $1
            """,
            users.source_uid,
            users.target_uid,
        )

        await conn.execute(
            """
            INSERT INTO pkm_scope_registry (
              user_id,
              domain,
              scope_handle,
              scope_label,
              segment_ids,
              sensitivity_tier,
              scope_kind,
              exposure_enabled,
              manifest_version,
              summary_projection,
              created_at,
              updated_at
            )
            SELECT
              $2,
              domain,
              scope_handle,
              scope_label,
              segment_ids,
              sensitivity_tier,
              scope_kind,
              exposure_enabled,
              manifest_version,
              summary_projection,
              created_at,
              updated_at
            FROM pkm_scope_registry
            WHERE user_id = $1
            """,
            users.source_uid,
            users.target_uid,
        )

        await conn.execute(
            """
            INSERT INTO actor_profiles (
              user_id,
              personas,
              last_active_persona,
              investor_marketplace_opt_in,
              created_at,
              updated_at,
              user_email
            )
            SELECT
              $2,
              personas,
              last_active_persona,
              investor_marketplace_opt_in,
              created_at,
              updated_at,
              $3
            FROM actor_profiles
            WHERE user_id = $1
            """,
            users.source_uid,
            users.target_uid,
            users.target_email,
        )

        await conn.execute(
            """
            INSERT INTO marketplace_public_profiles (
              user_id,
              profile_type,
              display_name,
              headline,
              location_hint,
              strategy_summary,
              verification_badge,
              metadata,
              is_discoverable,
              created_at,
              updated_at
            )
            SELECT
              $2,
              profile_type,
              display_name,
              headline,
              location_hint,
              strategy_summary,
              verification_badge,
              metadata,
              is_discoverable,
              created_at,
              updated_at
            FROM marketplace_public_profiles
            WHERE user_id = $1
            """,
            users.source_uid,
            users.target_uid,
        )

        await conn.execute(
            """
            INSERT INTO ria_profiles (
              id,
              user_id,
              display_name,
              legal_name,
              finra_crd,
              sec_iard,
              verification_status,
              verification_provider,
              verification_expires_at,
              bio,
              strategy,
              disclosures_url,
              created_at,
              updated_at,
              requested_capabilities,
              advisory_status,
              brokerage_status,
              advisory_provider,
              brokerage_provider,
              advisory_verification_expires_at,
              brokerage_verification_expires_at,
              individual_legal_name,
              individual_crd,
              advisory_firm_legal_name,
              advisory_firm_iapd_number,
              broker_firm_legal_name,
              broker_firm_crd
            )
            SELECT
              $3::uuid,
              $2,
              display_name,
              legal_name,
              finra_crd,
              sec_iard,
              verification_status,
              verification_provider,
              verification_expires_at,
              bio,
              strategy,
              disclosures_url,
              created_at,
              updated_at,
              requested_capabilities,
              advisory_status,
              brokerage_status,
              advisory_provider,
              brokerage_provider,
              advisory_verification_expires_at,
              brokerage_verification_expires_at,
              individual_legal_name,
              individual_crd,
              advisory_firm_legal_name,
              advisory_firm_iapd_number,
              broker_firm_legal_name,
              broker_firm_crd
            FROM ria_profiles
            WHERE user_id = $1
            """,
            users.source_uid,
            users.target_uid,
            str(uuid4()),
        )

        await conn.execute(
            """
            INSERT INTO runtime_persona_state (
              user_id,
              last_active_persona,
              updated_at,
              user_email
            )
            SELECT
              $2,
              last_active_persona,
              updated_at,
              $3
            FROM runtime_persona_state
            WHERE user_id = $1
            """,
            users.source_uid,
            users.target_uid,
            users.target_email,
        )


async def _print_counts(conn: asyncpg.Connection, users: MirrorUsers) -> None:
    for table in [
        "vault_keys",
        "vault_key_wrappers",
        "actor_profiles",
        "pkm_index",
        "pkm_blobs",
        "pkm_manifests",
        "pkm_manifest_paths",
        "pkm_scope_registry",
        "marketplace_public_profiles",
        "ria_profiles",
        "runtime_persona_state",
    ]:
        count = await conn.fetchval(
            f"SELECT COUNT(*) FROM {table} WHERE user_id = $1", users.target_uid
        )
        _log(f"{table}: {count}")


async def _run(args: argparse.Namespace) -> int:
    config = dotenv_values(DEFAULT_ENV_PATH)
    source_uid = (
        args.source_uid
        or str(config.get("REVIEWER_UID") or os.getenv("REVIEWER_UID") or "").strip()
        or _require(config, "KAI_TEST_USER_ID")
    )
    target_email = args.target_email
    users = _resolve_users(config, source_uid, target_email, args.target_password)
    conn = await _connect_db(config)
    try:
        await _mirror_local_surface(conn, users)
        _log(
            f"Mirrored local Kai surface from {users.source_uid} -> {users.target_uid} ({users.target_email})"
        )
        await _print_counts(conn, users)
    finally:
        await conn.close()
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source-uid",
        default="",
        help="Source Firebase UID to mirror from. Defaults to REVIEWER_UID from consent-protocol/.env.",
    )
    parser.add_argument(
        "--target-email",
        default="test@hushh.ai",
        help="Target Firebase email/password user to mirror into.",
    )
    parser.add_argument(
        "--target-password",
        default="12345678",
        help="Password to set on the target Firebase reviewer user.",
    )
    args = parser.parse_args()
    return asyncio.run(_run(args))


if __name__ == "__main__":
    raise SystemExit(main())
