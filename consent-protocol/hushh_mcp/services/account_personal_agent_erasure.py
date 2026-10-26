"""Transactional absence proof for private-agent account erasure.

The account service retains transaction ownership and compatibility entrypoints.
Missing or uncertain cloud receipts refuse erasure; no cloud resources are deleted here.
"""

from typing import Any, Callable

from sqlalchemy import text

from hushh_mcp.services.byoc_setup_intent import is_untouched_intent
from hushh_mcp.services.personal_agent_standby_guard import standby_present

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
    conn, *, params: dict[str, Any], table_exists: Callable, finalize_erasure: bool = False
) -> dict[str, bool]:
    from hushh_mcp.services.phone_transfer_service import assert_erasure_ready

    assert_erasure_ready(conn, params["user_id"], table_exists)
    table_presence, registry_row, byoc_row, lifecycle_row, migration_row = _read_locked_state(
        conn, params, table_exists
    )
    if not any(table_presence.values()):
        return table_presence
    registry = dict((registry_row or {}).get("registry") or {})
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
    demonstrably_unprovisioned = (registry_row is None and lifecycle_row is None) or (
        registry_row is not None
        and lifecycle_row is None
        and status == "unprovisioned"
        and not has_external_coordinates
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
            "DELETE FROM personal_agent_cloud_removals WHERE user_id = :user_id"
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
