# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Forward SQL migration governance and frozen ``parked/`` split-brain gate.

Enforces three repository-wide schema invariants:
1. ``db/migrations/parked/`` and ``dev_migration_manifest.json`` are frozen to
   the existing 82-entry burn-down set (graduation/removal allowed; net-new
   split-brain ``9xx`` files or release deferrals forbidden).
2. Every manifested migration honors ``-- migration: transactional=false`` at
   byte 0 whenever top-level ``CONCURRENTLY`` DDL is used, and every entry
   produces a valid ledger execution envelope.
3. Canonical migrations above ``458`` (``>= 459``) omit redundant outer
   ``BEGIN;`` / ``COMMIT;`` wrappers and do not add ``REFERENCES vault_keys``
   foreign keys outside reviewed vault-state surfaces.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Iterable

try:
    from db.migration_sql_envelope import (
        is_outer_transaction_control,
        prepare_execution_sql,
        scan_top_level_sql_statements,
        strip_sql_comments_and_literals,
    )
except ModuleNotFoundError:  # pragma: no cover - bare system python3 CLI path
    from migration_sql_envelope import (  # type: ignore[no-redef]
        is_outer_transaction_control,
        prepare_execution_sql,
        scan_top_level_sql_statements,
        strip_sql_comments_and_literals,
    )

FORWARD_GOVERNANCE_FLOOR = 459
_NON_TRANSACTIONAL_HEADER = "-- migration: transactional=false\n"
_DIRECTIVE_COMMENT_RE = re.compile(r"^[ \t]*--[ \t]*migration[ \t]*:", re.IGNORECASE | re.MULTILINE)
_VAULT_KEYS_FK_RE = re.compile(
    r"\bREFERENCES\s+(?:public\s*\.\s*)?\"?vault_keys\"?\b",
    re.IGNORECASE,
)

FROZEN_VAULT_KEYS_FK_ALLOWLIST: frozenset[str] = frozenset()
FROZEN_DEFERRED_RELEASE_MIGRATIONS: frozenset[str] = frozenset(
    {"249_one_chat_history_legacy_cutover.sql"}
)
FROZEN_PARKED_MIGRATIONS: frozenset[str] = frozenset(
    {
        "900_personal_agent_registry.sql",
        "901_agent_prompt_versions.sql",
        "902_personal_agent_tombstone_hushh_id_index.sql",
        "903_webauthn_credentials.sql",
        "904_consent_audit_receipts.sql",
        "905_personal_agent_liveness.sql",
        "906_personal_agent_user_cloud.sql",
        "907_pod_lifecycle_events.sql",
        "908_personal_agent_tombstone_metadata.sql",
        "909_byoc_setup_jobs.sql",
        "910_personal_agent_status_needs_reinit.sql",
        "911_pod_migration_jobs.sql",
        "912_personal_agent_status_migrating.sql",
        "913_consent_audit_receipts_ledger.sql",
        "914_personal_agent_billing_space_id.sql",
        "915_personal_agent_renewal_authority.sql",
        "916_personal_agent_erasure_admission.sql",
        "917_personal_agent_provision_admission.sql",
        "918_personal_agent_erasure_memory_binding.sql",
        "919_personal_agent_compute_erasure.sql",
        "920_personal_agent_substrate_inventory.sql",
        "921_personal_agent_writer_revocation.sql",
        "922_personal_agent_bucket_erasure.sql",
        "923_personal_agent_mail_erasure.sql",
        "924_personal_agent_kms_erasure.sql",
        "925_personal_agent_secret_erasure.sql",
        "926_personal_agent_runtime_account_erasure.sql",
        "927_personal_agent_project_grant_fence.sql",
        "928_byoc_authorization_receipts.sql",
        "929_personal_agent_runtime_grant_erasure.sql",
        "930_personal_agent_repository_grant_erasure.sql",
        "931_personal_agent_repository_inventory.sql",
        "932_personal_agent_repository_retention.sql",
        "933_personal_agent_bootstrap_grant_erasure.sql",
        "934_personal_agent_erasure_resource_coverage.sql",
        "935_personal_agent_erasure_finalization.sql",
        "936_personal_agent_stale_erasure_recovery.sql",
        "940_personal_agent_erasure_guard_composition.sql",
        "941_personal_agent_files_erasure.sql",
        "942_personal_agent_erasure_validation_cost.sql",
        "943_personal_agent_files_upgrade_evidence.sql",
        "944_one_chat_history_legacy_cutover.sql",
        "945_pod_mcp_action_authority.sql",
        "946_personal_agent_files_provision_admission.sql",
        "947_pod_request_signing.sql",
        "948_personal_agent_user_azure.sql",
        "949_personal_agent_owner_access_erasure.sql",
        "950_personal_agent_standby_placements.sql",
        "951_byoc_setup_job_azure_admission.sql",
        "952_personal_agent_provision_after_detach.sql",
        "953_personal_agent_key_pull_during_attach.sql",
        "954_personal_agent_never_hosted_erasure.sql",
        "955_one_hosting_choice.sql",
        "956_personal_agent_notification_checkpoint.sql",
        "957_personal_agent_azure_files_upgrade.sql",
        "958_one_shared_legacy_continuity.sql",
        "959_shared_files_storage_lifecycle.sql",
        "960_owner_erasure_provider_outcomes.sql",
        "961_azure_setup_erasure_binding.sql",
        "962_azure_owner_cleanup_admission.sql",
        "963_personal_agent_operator_mail_custody.sql",
        "964_personal_agent_runtime_quota_grant.sql",
        "965_one_inferred_shared_correction.sql",
        "966_pod_browser_action_authority.sql",
        "967_azure_vm_power_admission.sql",
        "968_azure_vm_image_update_admission.sql",
        "969_gcp_browser_update_admission.sql",
        "970_azure_browser_update_admission.sql",
        "971_private_action_channel_continuity.sql",
        "972_personal_agent_cloud_removal.sql",
        "973_hosted_pod_pilot_admission.sql",
        "974_hosted_pod_custody.sql",
        "975_hosted_bucket_reconciliation.sql",
        "976_gcp_notification_account_id_limit.sql",
        "979_hosted_files_executor.sql",
        "980_personal_agent_upgrade_host_binding.sql",
        "981_hosted_native_location_contract.sql",
        "985_legacy_cloud_removal_recovery.sql",
        "986_legacy_cloud_removal_resume.sql",
        "987_account_firebase_erasure.sql",
        "988_account_cloud_retirement.sql",
        "989_pkm_answer_processing_runtime.sql",
    }
)


class _EnvelopeEntryView:
    __slots__ = ("filename", "transactional")

    def __init__(self, filename: str, transactional: bool) -> None:
        self.filename = filename
        self.transactional = transactional


def inspect_migration_sql_governance(
    filename: str,
    sql: str,
    *,
    numeric_version: int | None,
    enforce_forward_rules: bool,
) -> list[str]:
    """Validate directive syntax, ledger envelope, and forward ``>= 459`` rules."""

    violations: list[str] = []
    transactional = not sql.startswith(_NON_TRANSACTIONAL_HEADER)
    directive_matches = list(_DIRECTIVE_COMMENT_RE.finditer(sql))
    if directive_matches:
        if len(directive_matches) > 1 or not sql.startswith(_NON_TRANSACTIONAL_HEADER):
            violations.append(f"invalid_migration_directive:{filename}")

    entry = _EnvelopeEntryView(filename=filename, transactional=transactional)
    try:
        statements = scan_top_level_sql_statements(sql, filename=filename)
        prepare_execution_sql(entry, sql, mode_value="ledger")
    except Exception as exc:  # noqa: BLE001 - report structured violation
        violations.append(f"invalid_ledger_sql_envelope:{filename}:{exc}")
        return violations

    has_concurrent_ddl = any("CONCURRENTLY" in stmt.keywords for stmt in statements)
    if has_concurrent_ddl and (transactional or len(statements) != 1):
        violations.append(f"concurrent_ddl_requires_single_nontransactional_migration:{filename}")

    if (
        enforce_forward_rules
        and numeric_version is not None
        and numeric_version >= FORWARD_GOVERNANCE_FLOOR
    ):
        if any(is_outer_transaction_control(stmt.keywords) for stmt in statements):
            violations.append(f"forward_migration_outer_transaction_forbidden:{filename}")
        executable = strip_sql_comments_and_literals(sql)
        if (
            filename not in FROZEN_VAULT_KEYS_FK_ALLOWLIST
            and _VAULT_KEYS_FK_RE.search(executable) is not None
        ):
            violations.append(f"forward_migration_actor_spine_violation:{filename}")

    return violations


def verify_parked_lane_freeze(
    dev_manifest_path: Path,
    parked_dir: Path,
) -> list[str]:
    """Verify ``parked/`` and ``dev_migration_manifest.json`` only shrink or stay equal."""

    violations: list[str] = []
    payload = json.loads(dev_manifest_path.read_text(encoding="utf-8"))
    ordered = [str(item).strip() for item in payload.get("ordered_migrations", [])]
    on_disk = sorted(path.name for path in parked_dir.glob("*.sql") if path.is_file())

    unapproved = sorted((set(ordered) | set(on_disk)) - FROZEN_PARKED_MIGRATIONS)
    if unapproved:
        violations.append("parked_lane_frozen_new_entries_forbidden:" + ",".join(unapproved))

    deferred = {
        str(item.get("filename") or "").strip()
        for item in payload.get("deferred_release_migrations", [])
        if isinstance(item, dict)
    }
    unapproved_deferred = sorted(deferred - FROZEN_DEFERRED_RELEASE_MIGRATIONS)
    if unapproved_deferred:
        violations.append(
            "dev_manifest_new_deferred_release_migration_forbidden:" + ",".join(unapproved_deferred)
        )

    for name in on_disk:
        sql = (parked_dir / name).read_text(encoding="utf-8")
        violations.extend(
            inspect_migration_sql_governance(
                name,
                sql,
                numeric_version=None,
                enforce_forward_rules=False,
            )
        )
    return violations


def verify_forward_and_parked_governance(
    migrations_dir: Path,
    dev_manifest_path: Path,
    canonical_entries: Iterable[str],
) -> list[str]:
    """Run canonical SQL governance + ``parked/`` freeze checks for repo tooling."""

    parked_dir = migrations_dir / "parked"
    violations = (
        verify_parked_lane_freeze(dev_manifest_path, parked_dir)
        if dev_manifest_path.is_file()
        else [f"dev_manifest_missing:{dev_manifest_path.name}"]
    )
    for name in canonical_entries:
        path = migrations_dir / name
        if not path.is_file():
            continue
        prefix = name.split("_", 1)[0]
        version = int(prefix) if prefix.isdigit() else None
        sql = path.read_text(encoding="utf-8")
        violations.extend(
            inspect_migration_sql_governance(
                name,
                sql,
                numeric_version=version,
                enforce_forward_rules=True,
            )
        )
    return violations
