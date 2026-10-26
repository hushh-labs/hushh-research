"""Placement helpers for the One runtime routes: the Shared choice and setup status.

Kept beside ``runtime.py`` (which is over its size budget) rather than in it. The
routes stay there; what they decide lives here so it can be read and tested alone.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any, Literal

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, StrictBool

from hushh_mcp.services.placement_observation import PlacementReader, read_optional_placement

if TYPE_CHECKING:
    from hushh_mcp.services.user_cloud_service import UserCloud

logger = logging.getLogger(__name__)


class SharedHostingSelectionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    recovery: StrictBool = False
    expected_owner_id: str | None = Field(
        default=None, alias="expectedOwnerId", min_length=1, max_length=128
    )


class SharedHostingSelectResponse(BaseModel):
    hostingMode: str
    nextStep: str


async def select_shared_request(user_id: str, body: SharedHostingSelectionRequest | None) -> None:
    if body is not None and body.recovery:
        if body.expected_owner_id != user_id:
            raise HTTPException(status_code=409, detail={"code": "SHARED_RECOVERY_OWNER_CHANGED"})
        await select_shared_recovery(user_id)
    else:
        await select_shared(user_id)


def require_byoc_setup_enabled() -> None:
    """Reader schema availability never authorizes owner-cloud mutations."""
    from hushh_mcp.runtime_settings import personal_agent_enabled

    if not personal_agent_enabled():
        raise _refuse(503, "BYOC_UNAVAILABLE", "Cloud setup is not available in this environment.")


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
    from hushh_mcp.services.pod_files.contracts import FilesRefused
    from hushh_mcp.services.shared_files.registry import protect_placement_change

    try:
        async with protect_placement_change(user_id):
            recorded = await record_or_observe_intent(user_id, provider=provider, project=project)
    except FilesRefused as exc:
        raise _refuse(
            exc.status,
            exc.code,
            "Your Files library is unchanged. Moving it to a private agent is not available yet.",
        ) from None
    if not recorded:
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
    from hushh_mcp.services import byoc_setup_intent

    mode = await _placement(user_id)
    if mode == "pending":
        try:
            cleared = await byoc_setup_intent.clear_intent(user_id)
        except Exception as exc:  # noqa: BLE001 - an unreadable intent is not Shared
            raise _hosting_unavailable() from exc
        if cleared:
            mode = await _placement(user_id)
    await _commit_shared_choice(user_id, mode)


async def _commit_shared_choice(user_id: str, mode: str) -> None:
    from api.routes.one import runtime
    from hushh_mcp.services.owner_hosting_choice import HostingChoiceRepo

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


async def select_shared_recovery(user_id: str) -> None:
    """Honor an explicit Shared recovery click without cancelling another setup.

    Both provider setup starts use the same placement lock. Re-observe inside it:
    a stale Shared-first screen cannot clear a consent intent or adopt a private home.
    Existing Shared libraries do not move or need a new hosting decision.
    """
    from hushh_mcp.runtime_settings import shared_experience_recovery_enabled
    from hushh_mcp.services.pod_files.contracts import FilesRefused
    from hushh_mcp.services.shared_files.registry import protect_placement_change

    if not shared_experience_recovery_enabled():
        raise _refuse(404, "SHARED_RECOVERY_UNAVAILABLE", "Shared setup is unavailable.")
    mode = await _placement(user_id)
    if mode == "shared":
        await _commit_shared_choice(user_id, mode)
        return
    if mode != "unplaced":
        await _commit_shared_choice(user_id, mode)  # Refuses without clearing an intent.
        return
    try:
        async with protect_placement_change(user_id):
            await _commit_shared_choice(user_id, await _placement(user_id))
    except FilesRefused as exc:
        raise _refuse(
            exc.status, exc.code, "Your existing Files and cloud setup are unchanged."
        ) from None


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


__all__ = ["attach_blocked", "select_shared", "select_shared_recovery", "setup_status_fields"]


async def _require_unassigned_byoc(user_id: str) -> None:
    """First-time cloud setup cannot migrate or replace an active owner pod."""
    from api.routes.one.runtime_placement import require_byoc_setup_enabled
    from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo

    require_byoc_setup_enabled()
    try:
        row = await PersonalAgentRegistryRepo().get(user_id)
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail={
                "code": "POD_ASSIGNMENT_UNVERIFIED",
                "message": "Cloud setup could not verify your existing agent.",
            },
        ) from exc
    if row and (
        row.get("external_agent_id")
        or row.get("status") in {"provisioning", "connecting", "provisioned"}
    ):
        raise HTTPException(
            status_code=409,
            detail={
                "code": "POD_ASSIGNMENT_PRESERVED",
                "message": "Your existing pod is preserved. Cloud moves need a separate migration.",
            },
        )
