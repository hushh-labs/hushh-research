"""Durable owner-pod delegated task routes.

The hub remains the courier and consent authority. The pod owns execution and
stores task snapshots in its existing sealed commit log. A replacement marks an
unfinished task interrupted; it never replays an uncertain turn.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Optional

from fastapi import APIRouter, Body, Header, HTTPException, Path, Query
from pydantic import BaseModel, ConfigDict, Field

from api.routes.one.pod_turn import (
    PodTurnRequest,
    _bounded_turn,
    _require_enabled,
    run_pod_turn,
)
from hushh_mcp.constants import ConsentScope
from hushh_mcp.services.pod_consent_client import require_owner_scope
from hushh_mcp.services.pod_task_store import (
    MAX_TASK_ID_CHARS,
    PodTask,
    PodTaskConflict,
    PodTaskInvalid,
    PodTaskNotFound,
    PodTaskStore,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/one/pod", tags=["personal-agent"])

_RUNNING: dict[str, asyncio.Task[None]] = {}


class PodTaskCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    owner_id: str = Field(..., alias="ownerId", min_length=1, max_length=128)
    agent_id: str = Field(..., alias="agentId", min_length=1, max_length=256)
    message: str = Field(..., min_length=1, max_length=8000)
    conversation_id: str = Field(default="consumer-mcp", alias="conversationId", max_length=128)
    timezone: Optional[str] = Field(default=None, max_length=64)
    runtime_provider: Optional[str] = Field(default=None, alias="runtimeProvider", max_length=32)
    puppy_device_id: Optional[str] = Field(default=None, alias="puppyDeviceId", max_length=128)
    idempotency_key: str = Field(default="", alias="idempotencyKey", max_length=128)


def _store(verdict: Any, *, agent_id: str) -> PodTaskStore:
    from hushh_mcp.services.pod_memory_service import _resolve_log  # noqa: PLC0415

    log = _resolve_log()
    if log is None:
        raise HTTPException(status_code=503, detail="durable pod task storage unavailable")
    return PodTaskStore(
        log,
        owner_user_id=str(verdict.user_id),
        hushh_id=str(verdict.hushh_id),
        # The PKM read grant is deliberately issued to the pod's personal-agent
        # principal. Task snapshots are instead owned by the already-admitted
        # external client principal, which is rechecked on every lifecycle call.
        agent_id=agent_id,
    )


def _task_payload(task: PodTask) -> dict[str, Any]:
    return {
        "execution_target": "owner_pod",
        **task.safe_projection(),
    }


async def _run_task(task: PodTask, *, store: PodTaskStore, consent_token: str) -> None:
    try:
        started = await store.transition(task.task_id, expected={"queued"}, state="running")
        payload = PodTurnRequest(
            message=started.message,
            conversationId=started.conversation_id,
            timezone=started.timezone,
            runtimeProvider=started.runtime_provider,
            puppyDeviceId=started.puppy_device_id,
        )
        result = await _bounded_turn(run_pod_turn(payload=payload, consent_token=consent_token))
        current = await store.get(task.task_id)
        if current.state == "cancel_requested":
            await store.transition(
                task.task_id,
                expected={"cancel_requested"},
                state="cancelled",
                error_code="TASK_CANCELLED",
            )
            return
        text = str(result.get("text") or result.get("response") or "").strip()
        if not text:
            await store.transition(
                task.task_id,
                expected={"running"},
                state="failed",
                error_code="EMPTY_POD_RESULT",
            )
            return
        await store.transition(
            task.task_id,
            expected={"running"},
            state="completed",
            result=text[:16_000],
        )
    except asyncio.CancelledError:
        try:
            await store.transition(
                task.task_id,
                expected={"running", "cancel_requested"},
                state="cancelled",
                error_code="TASK_CANCELLED",
            )
        except (PodTaskConflict, PodTaskNotFound, PodTaskInvalid):
            pass
        raise
    except HTTPException as exc:
        try:
            await store.transition(
                task.task_id,
                expected={"running", "cancel_requested"},
                state="failed",
                error_code=(
                    "POD_TASK_UNAVAILABLE" if exc.status_code >= 500 else "POD_TASK_REFUSED"
                ),
            )
        except (PodTaskConflict, PodTaskNotFound, PodTaskInvalid):
            pass
    except Exception as exc:  # noqa: BLE001 - never persist provider details
        logger.info("pod_task.failed reason=%s", type(exc).__name__)
        try:
            await store.transition(
                task.task_id,
                expected={"running", "cancel_requested"},
                state="failed",
                error_code="POD_TASK_FAILED",
            )
        except (PodTaskConflict, PodTaskNotFound, PodTaskInvalid):
            pass
    finally:
        _RUNNING.pop(task.task_id, None)


async def _admit_task(
    *,
    token: str,
    owner_id: str,
    agent_id: str,
) -> Any:
    if not token:
        raise HTTPException(status_code=403, detail="task invocation grant required")
    try:
        return await require_owner_scope(
            token,
            expected_scope=ConsentScope.CAP_ONE_INVOKE.value,
            user_id=owner_id,
            expected_agent_id=agent_id,
        )
    except PermissionError as exc:
        raise HTTPException(
            status_code=403, detail="task invocation grant is not valid here"
        ) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail="consent authority is unavailable") from exc


@router.post("/tasks")
async def create_pod_task_route(
    payload: PodTaskCreateRequest = Body(...),
    x_consent_token: Optional[str] = Header(default=None, alias="X-Consent-Token"),
    x_one_invoke_token: Optional[str] = Header(default=None, alias="X-One-Invoke-Token"),
) -> dict[str, Any]:
    """Queue one owner-approved task and return its durable task reference."""
    _require_enabled()
    await _admit_task(
        token=str(x_one_invoke_token or "").strip(),
        owner_id=payload.owner_id,
        agent_id=payload.agent_id,
    )
    if not str(x_consent_token or "").strip():
        raise HTTPException(status_code=403, detail="pod execution grant required")
    try:
        execution_verdict = await require_owner_scope(
            str(x_consent_token),
            expected_scope=ConsentScope.PKM_READ.value,
            user_id=payload.owner_id,
        )
        store = _store(execution_verdict, agent_id=payload.agent_id)
        task = await store.create(
            arguments={
                "message": payload.message,
                "conversation_id": payload.conversation_id,
                "timezone": payload.timezone,
                "runtime_provider": payload.runtime_provider,
                "puppy_device_id": payload.puppy_device_id,
                "idempotency_key": payload.idempotency_key,
            }
        )
    except PodTaskConflict as exc:
        raise HTTPException(status_code=409, detail="task idempotency conflict") from exc
    except PodTaskInvalid as exc:
        raise HTTPException(status_code=422, detail="invalid task request") from exc
    if task.task_id not in _RUNNING and task.state == "queued":
        running = asyncio.create_task(
            _run_task(task, store=store, consent_token=str(x_consent_token))
        )
        _RUNNING[task.task_id] = running
    return _task_payload(task)


async def _load_task(
    *, task_id: str, owner_id: str, agent_id: str, token: str
) -> tuple[PodTaskStore, PodTask]:
    _require_enabled()
    verdict = await _admit_task(token=token, owner_id=owner_id, agent_id=agent_id)
    store = _store(verdict, agent_id=agent_id)
    try:
        task = await store.get(task_id)
    except PodTaskNotFound as exc:
        raise HTTPException(status_code=404, detail="task not found") from exc
    return store, task


@router.get("/tasks/{task_id}")
async def get_pod_task_route(
    task_id: str = Path(..., min_length=37, max_length=MAX_TASK_ID_CHARS),
    owner_id: str = Query(..., alias="ownerId", min_length=1, max_length=128),
    agent_id: str = Query(..., alias="agentId", min_length=1, max_length=256),
    x_one_invoke_token: Optional[str] = Header(default=None, alias="X-One-Invoke-Token"),
) -> dict[str, Any]:
    store, task = await _load_task(
        task_id=task_id, owner_id=owner_id, agent_id=agent_id, token=str(x_one_invoke_token or "")
    )
    if task.state in {"running", "cancel_requested"} and task.task_id not in _RUNNING:
        try:
            task = await store.mark_interrupted(task.task_id)
        except PodTaskConflict:
            task = await store.get(task.task_id)
    return _task_payload(task)


@router.post("/tasks/{task_id}/cancel")
async def cancel_pod_task_route(
    task_id: str = Path(..., min_length=37, max_length=MAX_TASK_ID_CHARS),
    owner_id: str = Query(..., alias="ownerId", min_length=1, max_length=128),
    agent_id: str = Query(..., alias="agentId", min_length=1, max_length=256),
    x_one_invoke_token: Optional[str] = Header(default=None, alias="X-One-Invoke-Token"),
) -> dict[str, Any]:
    store, _ = await _load_task(
        task_id=task_id, owner_id=owner_id, agent_id=agent_id, token=str(x_one_invoke_token or "")
    )
    try:
        task = await store.request_cancel(task_id)
    except PodTaskConflict as exc:
        raise HTTPException(status_code=409, detail="task state changed") from exc
    running = _RUNNING.get(task_id)
    if running is not None and not running.done():
        running.cancel()
    return _task_payload(task)


__all__ = [
    "PodTaskCreateRequest",
    "cancel_pod_task_route",
    "create_pod_task_route",
    "get_pod_task_route",
    "router",
]
