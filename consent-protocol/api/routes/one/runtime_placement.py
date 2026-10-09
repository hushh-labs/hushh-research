"""Placement helpers for the One runtime routes: the Shared choice and setup status.

Kept beside ``runtime.py`` (which is over its size budget) rather than in it. The
routes stay there; what they decide lives here so it can be read and tested alone.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any, Literal

from fastapi import HTTPException

from hushh_mcp.services.placement_observation import PlacementReader, read_optional_placement

if TYPE_CHECKING:
    from hushh_mcp.services.user_cloud_service import UserCloud

logger = logging.getLogger(__name__)

#: Stage entries ``owner_cloud_attach`` appends to a recorded setup job.
ATTACH_BLOCKED_STAGE = "attach_blocked"
ATTACH_STARTED_STAGE = "attach_started"


async def observe_managed_cloud(
    repo: PlacementReader, user_id: str
) -> tuple[dict | None, UserCloud | None]:
    """Observe placement before managed readiness; uncertainty never selects a host."""
    from api.routes.one import runtime

    try:
        observed = runtime.registry_host_snapshot(
            await read_optional_placement(repo, user_id, table="personal_agent_registry")
        )
    except Exception:  # noqa: BLE001 - unreadable placement is not absent placement
        raise runtime._cloud_status_unavailable() from None
    cloud = await runtime.resolve_user_cloud(user_id, registry_row=observed)
    if cloud is not None and cloud.lookup_failed:
        raise runtime._cloud_status_unavailable()
    return observed, cloud


async def require_setup_intent(
    user_id: str, *, provider: Literal["gcp", "azure"], project: str = ""
) -> None:
    """Both provider consent routes require the same durable pending admission."""
    from hushh_mcp.services.byoc_setup_intent import record_or_observe_intent

    if not await record_or_observe_intent(user_id, provider=provider, project=project):
        raise _refuse(
            503, "BYOC_SETUP_UNRECORDED", "Cloud setup could not be saved. Please try again."
        )


def _refuse(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message})


async def _placement(user_id: str) -> str:
    from api.routes.one import personal_agent

    status = await personal_agent.resolve_personal_agent_status(user_id=user_id)
    return str(status.get("hostingMode") or "unknown")


async def select_shared(user_id: str) -> None:
    """Record the explicit Shared choice, or refuse without changing anything.

    Shared is admitted for a person with no placement (``unplaced``) or already on
    Shared. A begun own-cloud setup whose sign-in never came back is only an intent,
    so choosing Shared clears it; any real placement or setup job is preserved.
    """
    from api.routes.one import runtime
    from hushh_mcp.services import byoc_setup_intent
    from hushh_mcp.services.owner_hosting_choice import HostingChoiceRepo

    mode = await _placement(user_id)
    if mode == "pending":
        try:
            cleared = await byoc_setup_intent.clear_intent(user_id)
        except Exception as exc:  # noqa: BLE001 - an unreadable intent is not Shared
            raise _hosting_unavailable() from exc
        if cleared:
            mode = await _placement(user_id)
    if mode == "unknown":
        raise _hosting_unavailable()
    if mode not in {"shared", "unplaced"}:
        raise _refuse(
            409,
            "POD_ASSIGNMENT_PRESERVED",
            "Your existing or in-progress pod setup is unchanged. Finish or move it "
            "through its dedicated setup flow before choosing Shared.",
        )
    if mode == "unplaced":
        try:
            await HostingChoiceRepo().record_shared(user_id)
        except Exception as exc:  # noqa: BLE001 - an unrecorded choice is not Shared
            logger.warning("shared_select.record_failed err=%s", type(exc).__name__)
            raise _refuse(
                503,
                "HOSTING_CHOICE_UNAVAILABLE",
                "We could not save your choice. Nothing changed; try again.",
            ) from exc
    await runtime._write_cloud_setup_marker(user_id)


def _hosting_unavailable() -> HTTPException:
    return _refuse(
        503,
        "HOSTING_STATUS_UNAVAILABLE",
        "We could not confirm your current pod setup. Try again.",
    )


def attach_blocked(stages: list[Any]) -> str | None:
    """The typed reason the last automatic attach stopped, or None once one started."""
    for entry in reversed(stages):
        if not isinstance(entry, dict):
            continue
        if entry.get("stage") == ATTACH_STARTED_STAGE:
            return None
        if entry.get("stage") == ATTACH_BLOCKED_STAGE:
            code = str(entry.get("code") or "").strip()
            return code or "ATTACH_BLOCKED"
    return None


def setup_status_fields(row: dict) -> dict[str, Any]:
    """The setup-status response for one job row, intent rows included."""
    from hushh_mcp.services import byoc_setup_job_service as jobs
    from hushh_mcp.services.byoc_setup_intent import intent_entry

    stages = list(row.get("stages") or [])
    intent = intent_entry(row) or {}
    return {
        "status": str(row.get("status") or ""),
        "stage": str(row.get("stage") or ""),
        "stages": stages,
        "projectId": str(row.get("project_id") or intent.get("project") or ""),
        "jobId": str(row.get("job_id") or ""),
        "errorCode": row.get("error_code"),
        "errorMessage": row.get("error_message"),
        "stale": jobs.is_stale(row),
        "updatedAt": str(row.get("updated_at") or "") or None,
        "attachBlocked": attach_blocked(stages),
    }


__all__ = ["attach_blocked", "select_shared", "setup_status_fields"]
