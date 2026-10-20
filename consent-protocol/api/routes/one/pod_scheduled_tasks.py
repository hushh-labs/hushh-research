"""Owner controls and one authenticated clock door; no generic agent executor."""

from __future__ import annotations

import asyncio
import os
from typing import Literal

from fastapi import APIRouter, Header, HTTPException, Response
from pydantic import Field

from api.routes.one.pod_browser import PrivateBrowserRoute
from api.routes.one.pod_session import verified_session
from hushh_mcp.services.pod_browser.contracts import StrictContract
from hushh_mcp.services.pod_scheduled_runtime import active_scheduled_tasks
from hushh_mcp.services.pod_scheduled_tasks import ScheduleRefused, ScheduleRequest
from hushh_mcp.services.pod_session_authority import ROLE_APP


def no_store(response: Response):
    response.headers["Cache-Control"] = "no-store, private"


class PrivateScheduleRoute(PrivateBrowserRoute):
    validation_refusal_code = "SCHEDULE_REQUEST_INVALID"


router = APIRouter(
    prefix="/api/one/pod/tasks", tags=["personal-agent"], route_class=PrivateScheduleRoute
)


def refused(exc: ScheduleRefused):
    status = (
        403
        if "GRANT" in exc.code
        else 503
        if any(
            x in exc.code
            for x in ("UNAVAILABLE", "UNQUALIFIED", "NOT_CONFIGURED", "UNCONFIRMED", "FAILED")
        )
        else 409
    )
    return HTTPException(status, detail={"code": exc.code})


def owner(authorization, *, write=False):
    authority, claims = verified_session(
        authorization, role=ROLE_APP, scope="pod.act" if write else "pod.status"
    )
    runtime = active_scheduled_tasks()
    if claims["user_id"] != runtime.access.owner_id or authority.hushh_id != runtime.access.pod_id:
        raise HTTPException(403, detail={"code": "SCHEDULE_OWNER_REFUSED"})

    async def caller_check():
        current, fresh = verified_session(
            authorization, role=ROLE_APP, scope="pod.act" if write else "pod.status"
        )
        if current is not authority or any(
            fresh.get(key) != claims.get(key) for key in ("user_id", "subject_id", "version")
        ):
            raise HTTPException(403, detail={"code": "SCHEDULE_CALLER_CHANGED"})

    return runtime, claims, caller_check


@router.get("")
async def list_tasks(response: Response, authorization: str | None = Header(default=None)):
    no_store(response)
    try:
        runtime, claims, caller_check = owner(authorization)
        code = None
        authorization_limit_at = None
        try:
            runtime.delivery.require_ready()
            authorization_limit_at = await runtime.check_grant(
                {
                    "subject_id": claims["subject_id"],
                    "version": claims["version"],
                    "scopes": ["pod.act"],
                }
            )
        except ScheduleRefused as exc:
            code = exc.code
        tasks = await runtime.list()
        await caller_check()
        return {
            "available": code is None,
            "code": code,
            "templates": ["agent_files.organize_file.v1"] if code is None else [],
            "authorization_limit_at": authorization_limit_at,
            "tasks": tasks,
        }
    except ScheduleRefused as exc:
        raise refused(exc) from None


@router.post("")
async def create_task(
    body: ScheduleRequest, response: Response, authorization: str | None = Header(default=None)
):
    no_store(response)
    try:
        runtime, claims, caller_check = owner(authorization, write=True)
        result = await runtime.create(
            body,
            grant={"subject_id": claims["subject_id"], "version": claims["version"]},
            caller_check=caller_check,
        )
        await caller_check()
        return result
    except ScheduleRefused as exc:
        raise refused(exc) from None


class Control(StrictContract):
    schedule_id: str = Field(pattern=r"^schedule_[a-f0-9]{32}$")
    revision: int = Field(ge=1)
    operation: Literal["pause", "resume", "cancel"]
    confirmed: bool = False


@router.post("/control")
async def control_task(
    body: Control, response: Response, authorization: str | None = Header(default=None)
):
    no_store(response)
    try:
        runtime, claims, caller_check = owner(authorization, write=True)
        result = await runtime.control(
            **body.model_dump(),
            caller_check=caller_check,
            caller_grant={"subject_id": claims["subject_id"], "version": claims["version"]},
        )
        await caller_check()
        return result
    except ScheduleRefused as exc:
        raise refused(exc) from None


class Wake(StrictContract):
    schedule_id: str = Field(pattern=r"^schedule_[a-f0-9]{32}$")
    revision: int = Field(ge=1)
    occurrence_id: str = Field(pattern=r"^[a-f0-9]{32}$")


@router.post("/worker")
async def task_worker(
    body: Wake, response: Response, authorization: str | None = Header(default=None)
):
    from hushh_mcp.services.pod_files.jobs import worker_origin
    from hushh_mcp.services.scheduler_identity import (
        SchedulerIdentityError,
        verify_scheduler_request,
    )

    no_store(response)
    try:
        await asyncio.to_thread(
            verify_scheduler_request,
            authorization_header=authorization,
            audience=worker_origin(),
            allowed_emails=(os.getenv("POD_FILES_WORKER_SERVICE_ACCOUNT", ""),),
        )
        return await active_scheduled_tasks().run(
            body.schedule_id, body.revision, body.occurrence_id
        )
    except SchedulerIdentityError:
        raise HTTPException(403, detail={"code": "SCHEDULE_WORKER_REFUSED"}) from None
    except ScheduleRefused as exc:
        raise refused(exc) from None
