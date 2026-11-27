"""Transactional absence proof for private-agent account erasure.

The account service retains transaction ownership and compatibility entrypoints.
Missing or uncertain cloud receipts refuse erasure; no cloud resources are deleted here.
"""

from collections.abc import Mapping
from typing import Any, Callable

from sqlalchemy import text

from hushh_mcp.services.byoc_setup_intent import is_untouched_intent
from hushh_mcp.services.hosted_ace_placement import has_hosted_ace_evidence
from hushh_mcp.services.personal_agent_standby_guard import standby_present

_USER_CLOUD_COORDINATE_FIELDS = (
    "user_cloud_project",
    "user_cloud_region",
    "user_cloud_bootstrap_sa",
    "user_cloud_authorized_at",
    "user_cloud_tenant_id",
    "user_cloud_subscription_id",
    "user_cloud_resource_group",
)


def _has_user_cloud_coordinates(row: Mapping[str, Any]) -> bool:
    return any(
        row.get(field_name) not in (None, "", {}, [])
        for field_name in _USER_CLOUD_COORDINATE_FIELDS
    )


def _entry_is_pooled_ace_only(entry: Any) -> bool:
    if not isinstance(entry, Mapping):
        return False
    if _has_user_cloud_coordinates(entry):
        return False
    target = (
        str(entry.get("deployment_target") or entry.get("deploymentTarget") or "").strip().lower()
    )
    backend = str(entry.get("backend") or "").strip().lower()
    return target == "ace" and (backend in {"", "ace"}) and has_hosted_ace_evidence(entry)


def _has_unretired_external_source_pod(meta: Mapping[str, Any]) -> bool:
    retirements = meta.get("sourcePodRetirements")
    if not isinstance(retirements, Mapping):
        return False
    for item in retirements.values():
        if not isinstance(item, Mapping):
            return True
        source_target = str(item.get("sourceTarget") or "").strip().lower()
        status = str(item.get("status") or "").strip().lower()
        if source_target != "ace" and not status.startswith("retired_"):
            return True
    return False


def _detached_placements_are_ace_only(meta: Mapping[str, Any]) -> bool:
    detached = meta.get("detachedPlacements")
    if detached in (None, []):
        return True
    if not isinstance(detached, list):
        return False
    return all(_entry_is_pooled_ace_only(item) for item in detached)


def is_pure_pooled_ace_registry_state(registry: Mapping[str, Any]) -> bool:
    """True when the registry row holds only Hussh-pooled ACE state with zero external cloud resources."""
    if not registry or _has_user_cloud_coordinates(registry):
        return False
    raw_meta = registry.get("backend_metadata")
    meta: Mapping[str, Any] = raw_meta if isinstance(raw_meta, Mapping) else {}
    if (
        "erasure" in meta
        or meta.get("upgradeLease")
        or meta.get("hostedFilesExecutor")
        or _has_unretired_external_source_pod(meta)
        or not _detached_placements_are_ace_only(meta)
    ):
        return False
    attempt = meta.get("provisionAttempt")
    if isinstance(attempt, Mapping) and str(attempt.get("phase") or "") != "provisioned":
        return False

    status = str(registry.get("status") or "").strip().lower()
    target = str(registry.get("deployment_target") or "").strip().lower()
    backend = str(registry.get("backend") or "").strip().lower()
    if (
        status == "provisioned"
        and target == "ace"
        and backend == "ace"
        and has_hosted_ace_evidence(registry)
    ):
        return True
    if (
        status == "unprovisioned"
        and not registry.get("external_agent_id")
        and not registry.get("deployment_target")
        and not registry.get("backend")
        and not registry.get("attestation_ref")
        and not registry.get("pod_pubkey")
        and not registry.get("region")
        and bool(meta.get("detachedPlacements"))
        and set(meta.keys()) <= {"detachedPlacements"}
    ):
        return True
    return False


def collect_pooled_ace_hushh_ids(registry: Mapping[str, Any] | None) -> list[str]:
    """Collect deterministic ACE hushh_ids from active or detached pooled rows for post-commit prefix purge."""
    if not isinstance(registry, Mapping):
        return []
    found: list[str] = []

    def _add(raw_id: Any) -> None:
        val = str(raw_id or "").strip()
        if val.startswith("ha1_") and val not in found:
            found.append(val)

    if str(registry.get("deployment_target") or "").strip().lower() == "ace":
        _add(registry.get("hushh_id"))
    raw_meta = registry.get("backend_metadata")
    if isinstance(raw_meta, Mapping):
        detached = raw_meta.get("detachedPlacements")
        if isinstance(detached, list):
            for item in detached:
                if _entry_is_pooled_ace_only(item):
                    _add(item.get("hushh_id"))
    return found


async def purge_pooled_ace_storage_prefixes_best_effort(hushh_ids: list[str]) -> int:
    """Best-effort post-commit purge of encrypted ACE owner prefixes from the Hub storage gateway store."""
    if not hushh_ids:
        return 0
    try:
        from api.routes.one.pod_prefix_storage_gateway import (
            _READ_ADMISSION_CACHE,
            _list_prefix_items,
            _resolve_store,
        )
        from hushh_mcp.services.pod_capability_broker import validated_pod_prefix

        for hid in hushh_ids:
            stale_keys = [key for key in list(_READ_ADMISSION_CACHE) if key[1] == hid]
            for key in stale_keys:
                _READ_ADMISSION_CACHE.pop(key, None)

        store = _resolve_store()
        if store is None:
            return 0
        deleted = 0
        for hid in hushh_ids:
            prefix = validated_pod_prefix(hid)
            base = prefix.rstrip("/") + "/"
            all_rels: list[str] = []
            cursor = ""
            for _ in range(50):
                items, cursor = await _list_prefix_items(
                    store,
                    pod_prefix=prefix,
                    target_prefix=prefix.rstrip("/"),
                    cursor=cursor,
                    limit=200,
                )
                all_rels.extend(items)
                if not cursor:
                    break
            for rel in all_rels:
                if await store.delete(f"{base}{rel}"):
                    deleted += 1
        return deleted
    except Exception:  # noqa: BLE001 - post-commit object purge is best-effort; tombstone already blocks reads
        return 0


PERSONAL_AGENT_DEPROVISION_REQUIRED_CODE = (
    "ACCOUNT_DELETION_EXTERNAL_RESOURCES_REQUIRE_DEPROVISIONING"
)
PERSONAL_AGENT_DEPROVISION_REQUIRED_MESSAGE = (
    "Your private agent or cloud setup must be removed before the account can be "
    "deleted. Please try again later or contact support."
)


class PersonalAgentDeprovisioningRequiredError(RuntimeError):
    """Account deletion cannot safely orphan external personal-agent resources."""


def _read_locked_state(conn, params: dict[str, Any], table_exists: Callable):
    state_tables = (
        "byoc_setup_jobs",
        "pod_lifecycle_events",
        "personal_agent_registry",
        "pod_migration_jobs",
    )
    table_presence = {table_name: table_exists(conn, table_name) for table_name in state_tables}
    registry_row = None
    if table_presence["personal_agent_registry"]:
        registry_row = (
            conn.execute(
                text(
                    """
                    SELECT to_jsonb(registry) AS registry
                    FROM personal_agent_registry AS registry
                    WHERE registry.user_id = :user_id
                    FOR UPDATE
                    """
                ),
                params,
            )
            .mappings()
            .first()
        )
    byoc_row = None
    if table_presence["byoc_setup_jobs"]:
        byoc_row = (
            conn.execute(
                text(
                    """
                    SELECT to_jsonb(job) AS job FROM byoc_setup_jobs AS job
                    WHERE job.user_id = :user_id
                    FOR UPDATE
                    """
                ),
                params,
            )
            .mappings()
            .first()
        )
    lifecycle_row = None
    if table_presence["pod_lifecycle_events"]:
        lifecycle_row = (
            conn.execute(
                text(
                    "SELECT TRUE AS present FROM pod_lifecycle_events "
                    "WHERE user_id = :user_id LIMIT 1 FOR UPDATE"
                ),
                params,
            )
            .mappings()
            .first()
        )

    migration_row = None
    if table_presence["pod_migration_jobs"]:
        migration_row = conn.execute(
            text("SELECT TRUE FROM pod_migration_jobs WHERE user_id = :user_id LIMIT 1 FOR UPDATE"),
            params,
        ).first()

    return table_presence, registry_row, byoc_row, lifecycle_row, migration_row


def _require_retained_erasure(
    conn, params: dict[str, Any], table_exists: Callable, finalize_erasure: bool
) -> None:
    # Parked private migrations must never become a prerequisite for the
    # shared runtime's ordinary unprovisioned-account deletion path.
    available = conn.execute(
        text(
            "SELECT to_regprocedure('public.personal_agent_erasure_complete(text)') "
            "IS NOT NULL AND "
            "to_regprocedure('public.finalize_personal_agent_erasure(text)') IS NOT NULL"
        )
    ).scalar()
    if available is True and not standby_present(conn, params, table_exists):
        statement = (
            "SELECT public.finalize_personal_agent_erasure(:user_id)"
            if finalize_erasure
            else "SELECT public.personal_agent_erasure_complete(:user_id)"
        )
        if conn.execute(text(statement), params).scalar() is True:
            return
    raise PersonalAgentDeprovisioningRequiredError(PERSONAL_AGENT_DEPROVISION_REQUIRED_CODE)


def _has_external_coordinates(registry: dict) -> bool:
    external_coordinate_fields = (
        "space_id",
        "external_agent_id",
        "a2a_route",
        "backend",
        "backend_metadata",
        "attestation_ref",
        "pod_pubkey",
        "pod_key_id",
        "pod_key_wrapping_alg",
        "region",
        "provisioned_at",
        "deployment_target",
        "user_cloud_project",
        "user_cloud_region",
        "user_cloud_bootstrap_sa",
        "user_cloud_authorized_at",
    )
    has_external_coordinates = any(
        registry.get(field_name) not in (None, "", {}, [])
        for field_name in external_coordinate_fields
    )
    return has_external_coordinates


def _pending_deprovision(
    conn, params: dict[str, Any], registry: dict, table_exists: Callable
) -> bool:
    has_pending_deprovision = False
    hushh_id = str(registry.get("hushh_id") or "").strip()
    if hushh_id and table_exists(conn, "personal_agent_deletion_tombstones"):
        has_pending_deprovision = (
            conn.execute(
                text(
                    """
                    SELECT TRUE
                    FROM personal_agent_deletion_tombstones
                    WHERE hushh_id = :hushh_id
                    LIMIT 1
                    FOR UPDATE
                    """
                ),
                {"hushh_id": hushh_id},
            ).first()
            is not None
        )

    return has_pending_deprovision


def _azure_setup_has_no_effects(
    conn,
    params: dict[str, Any],
    *,
    byoc_row,
    registry_row,
    erasure,
    has_pending_deprovision: bool,
    has_external_coordinates: bool,
) -> bool:
    # Positive joined, zero-request Azure history is read-only setup, not
    # external resources. Serialize with its worker before account erasure.
    if (
        byoc_row is not None
        and registry_row is not None
        and not erasure
        and str((byoc_row.get("job") or {}).get("project_id") or "").startswith("/subscriptions/")
        and not has_pending_deprovision
        and not has_external_coordinates
    ):
        available = conn.execute(
            text("SELECT to_regprocedure('public.azure_setup_no_effects(text)') IS NOT NULL")
        ).scalar()
        if (
            available is True
            and conn.execute(
                text(
                    "SELECT pg_try_advisory_xact_lock(hashtextextended(:user_id,206)) "
                    "AND public.azure_setup_no_effects(:user_id)"
                ),
                params,
            ).scalar()
            is True
        ):
            return True
    return False


def assert_external_resources_absent(
    conn,
    *,
    params: dict[str, Any],
    table_exists: Callable,
    finalize_erasure: bool = False,
    erased_ace_hushh_ids_out: list[str] | None = None,
) -> dict[str, bool]:
    from hushh_mcp.services.phone_transfer_service import assert_erasure_ready

    assert_erasure_ready(conn, params["user_id"], table_exists)
    table_presence, registry_row, byoc_row, lifecycle_row, migration_row = _read_locked_state(
        conn, params, table_exists
    )
    if not any(table_presence.values()):
        return table_presence
    if finalize_erasure:
        from hushh_mcp.services.account_cloud_retirement import local_erasure_ready

        if local_erasure_ready(conn, params["user_id"]):
            return table_presence
    registry = dict((registry_row or {}).get("registry") or {})
    if erased_ace_hushh_ids_out is not None and registry_row is not None:
        erased_ace_hushh_ids_out.extend(collect_pooled_ace_hushh_ids(registry))
    status = str(registry.get("status") or "").strip().lower()
    erasure = (registry.get("backend_metadata") or {}).get("erasure")
    if isinstance(erasure, dict) and erasure:
        _require_retained_erasure(conn, params, table_exists, finalize_erasure)
        return table_presence
    # A completed cloud-only removal retains identity/history, not live cloud
    # coordinates. SQL must match its exact clean replacement before those
    # historical links can establish absence for a later account deletion.
    if (
        registry_row is not None
        and status == "unprovisioned"
        and (registry.get("backend_metadata") or {}).get("detachedPlacements")
        and byoc_row is None
        and lifecycle_row is None
        and migration_row is None
    ):
        available = conn.execute(
            text("SELECT to_regprocedure('public.personal_agent_cloud_removed(text)') IS NOT NULL")
        ).scalar()
        if available is True and not standby_present(conn, params, table_exists):
            if (
                conn.execute(
                    text("SELECT public.personal_agent_cloud_removed(:user_id)"), params
                ).scalar()
                is True
            ):
                return table_presence
    has_external_coordinates = _has_external_coordinates(registry)
    has_pending_deprovision = _pending_deprovision(conn, params, registry, table_exists)
    pure_pooled_ace = registry_row is not None and is_pure_pooled_ace_registry_state(registry)
    demonstrably_unprovisioned = (
        (registry_row is None and lifecycle_row is None)
        or pure_pooled_ace
        or (
            registry_row is not None
            and lifecycle_row is None
            and status == "unprovisioned"
            and not has_external_coordinates
        )
    )
    if _azure_setup_has_no_effects(
        conn,
        params,
        byoc_row=byoc_row,
        registry_row=registry_row,
        erasure=erasure,
        has_pending_deprovision=has_pending_deprovision,
        has_external_coordinates=has_external_coordinates,
    ):
        return table_presence
    if (
        (byoc_row is not None and not is_untouched_intent(byoc_row.get("job")))
        or migration_row is not None
        or has_pending_deprovision
        or not demonstrably_unprovisioned
        or standby_present(conn, params, table_exists)
    ):
        raise PersonalAgentDeprovisioningRequiredError(PERSONAL_AGENT_DEPROVISION_REQUIRED_CODE)
    return table_presence


def personal_agent_erasure_queries() -> dict:
    """Explicit owner-bound deletes; callers retain absence/tombstone authority."""
    return {
        "byoc_setup_jobs": text("DELETE FROM byoc_setup_jobs WHERE user_id = :user_id"),
        "pod_lifecycle_events": text("DELETE FROM pod_lifecycle_events WHERE user_id = :user_id"),
        "personal_agent_registry": text(
            "DELETE FROM personal_agent_registry WHERE user_id = :user_id"
        ),
        "personal_agent_cloud_removals": text(
            "DELETE FROM personal_agent_cloud_removals op WHERE user_id = :user_id "
            "AND coalesce(to_jsonb(op)->'retirement_handoff','null'::jsonb)='null'::jsonb"
        ),
    }


async def cloud_cleanup_required_result(user_id: str) -> dict:
    from hushh_mcp.services.account_service import PERSONAL_AGENT_DEPROVISION_REQUIRED_CODE, logger
    from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo

    provider = None
    try:
        registry = PersonalAgentRegistryRepo()
        owner = await registry.get(user_id)
        provider = (owner or {}).get("deployment_target")
        if provider not in {"user_gcp", "user_azure"} and owner:
            from hushh_mcp.services.azure_teardown_store import AzureTeardownStore

            if await AzureTeardownStore(registry).can_offer_failed_setup_cleanup(user_id, owner):
                provider = "user_azure"
    except Exception as exc:
        logger.warning("account_deletion.cloud_review_unavailable error=%s", type(exc).__name__)
    return {
        "success": False,
        "account_deleted": False,
        "error_code": PERSONAL_AGENT_DEPROVISION_REQUIRED_CODE,
        "error": PERSONAL_AGENT_DEPROVISION_REQUIRED_CODE,
        "cleanup_provider": provider,
    }
