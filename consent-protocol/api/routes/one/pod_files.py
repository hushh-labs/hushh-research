"""Direct, app-role Files API. This router is never mounted in the shared hub."""

from __future__ import annotations

import asyncio
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response
from pydantic import BaseModel, Field

from api.routes.one.pod_session import verified_session
from hushh_mcp.services.pod_files.library import CHUNK_BYTES, FilesRefused
from hushh_mcp.services.pod_files.runtime import files_access, operation, require_files_access
from hushh_mcp.services.pod_session_authority import ROLE_APP, PodSessionRefused

router = APIRouter(prefix="/api/one/pod/files", tags=["personal-agent"])


async def access(authorization: str | None = Header(default=None)):
    authority, claims = verified_session(authorization, role=ROLE_APP, scope="files.manage")

    async def check() -> None:
        verified_session(authorization, role=ROLE_APP, scope="files.manage")
        try:
            await authority.require_held()
        except PodSessionRefused as exc:
            raise FilesRefused(exc.code, exc.status) from None

    with files_access(check):
        yield claims


_receivers = asyncio.Semaphore(2)


Owner = Annotated[dict, Depends(access)]


class CreateFile(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    parent: str = "root"
    size: int = Field(default=0, ge=0)
    request_id: str = Field(min_length=8, max_length=128)
    folder: bool = False


class EntryRequest(BaseModel):
    file_id: str = Field(min_length=32, max_length=32)


class Mutation(EntryRequest):
    revision: int = Field(ge=1)
    operation: Literal["rename", "move", "trash", "restore", "undo"]
    name: str = ""
    parent: str = ""
    confirmed: bool = False


def refusal(exc: FilesRefused) -> HTTPException:
    return HTTPException(status_code=exc.status, detail={"code": exc.code})


@router.get("/list")
async def list_files(owner: Owner, parent: str = "root", cursor: str = "", trash: bool = False):
    try:
        async with operation() as library:
            return await library.list_folder(parent, cursor, trash=trash)
    except FilesRefused as exc:
        raise refusal(exc) from exc


@router.get("/entry")
async def file_status(owner: Owner, file_id: str):
    try:
        async with operation() as library:
            return await library.stat(file_id)
    except FilesRefused as exc:
        raise refusal(exc) from exc


@router.post("/create")
async def create_file(body: CreateFile, owner: Owner):
    try:
        async with operation(mutation=True) as library:
            return await library.create(**body.model_dump())
    except FilesRefused as exc:
        raise refusal(exc) from exc


@router.put("/chunk")
async def upload_chunk(request: Request, owner: Owner, file_id: str, index: int):
    try:
        async with _receivers, operation():
            data = bytearray()
            async with asyncio.timeout(30):
                async for part in request.stream():
                    if len(data) + len(part) > CHUNK_BYTES:
                        raise FilesRefused("FILES_CHUNK_TOO_LARGE", 413)
                    data.extend(part)
            async with operation(mutation=True) as library:
                await require_files_access()
                return await library.put_chunk(file_id, index, bytes(data))
    except TimeoutError:
        raise HTTPException(408, detail={"code": "FILES_UPLOAD_TIMEOUT"}) from None
    except FilesRefused as exc:
        raise refusal(exc) from exc


@router.get("/chunk")
async def download_chunk(owner: Owner, file_id: str, index: int):
    try:
        async with operation() as library:
            data = await library.read_chunk(file_id, index)
            return Response(
                data, media_type="application/octet-stream", headers={"Cache-Control": "no-store"}
            )
    except FilesRefused as exc:
        raise refusal(exc) from exc


@router.post("/complete")
async def complete_file(body: EntryRequest, owner: Owner):
    from hushh_mcp.services.pod_files.jobs import deliver, prepare_delivery

    try:
        async with operation() as library:
            prepared = None
            async with operation(mutation=True):
                result = await library.complete(body.file_id)
                settings = await library.settings()
                if settings["automatic"]:
                    prepared = await prepare_delivery(library, file_id=body.file_id, automatic=True)
            if prepared is not None:
                try:
                    result["organization"] = await deliver(library, prepared)
                except FilesRefused:
                    result["organization"] = {
                        "state": "pending_delivery",
                        "code": "FILES_JOB_DELIVERY_UNCONFIRMED",
                    }
            return result
    except FilesRefused as exc:
        raise refusal(exc) from exc


@router.post("/mutate")
async def mutate_file(body: Mutation, owner: Owner):
    try:
        async with operation(mutation=True) as library:
            return await library.mutate(**body.model_dump())
    except FilesRefused as exc:
        raise refusal(exc) from exc


class AnalysisSettings(BaseModel):
    revision: int = Field(ge=0)
    analysis: bool
    automatic: bool
    excluded: list[str] = Field(default_factory=list, max_length=1000)


@router.get("/settings")
async def read_settings(owner: Owner):
    import os

    try:
        async with operation() as library:
            settings = await library.settings()
            return {
                **settings,
                "backgroundAvailable": bool(
                    os.getenv("POD_FILES_TASK_QUEUE")
                    and os.getenv("POD_FILES_WORKER_SERVICE_ACCOUNT")
                ),
                "backgroundProvider": "Google Vertex AI in your cloud project",
                "retention": await library.store.verify_bucket(os.getenv("HUSSH_POD_KMS_KEY", "")),
            }
    except FilesRefused as exc:
        raise refusal(exc) from exc


@router.put("/settings")
async def update_settings(body: AnalysisSettings, owner: Owner):
    import os

    try:
        if body.automatic and not (
            os.getenv("POD_FILES_TASK_QUEUE") and os.getenv("POD_FILES_WORKER_SERVICE_ACCOUNT")
        ):
            raise FilesRefused("FILES_BACKGROUND_NOT_CONFIGURED", 503)
        async with operation(mutation=True) as library:
            return await library.configure(**body.model_dump())
    except FilesRefused as exc:
        raise refusal(exc) from exc


@router.get("/usage")
async def read_usage(owner: Owner, cursor: str = ""):
    try:
        async with operation() as library:
            return await library.usage_page(cursor)
    except FilesRefused as exc:
        raise refusal(exc) from exc


class OrganizationRequest(EntryRequest):
    cancel: bool = False


class IndexRepairRequest(BaseModel):
    cursor: str = Field(default="", max_length=4096)


@router.post("/repair-index")
async def repair_index(body: IndexRepairRequest, owner: Owner):
    try:
        async with operation(mutation=True) as library:
            return await library.rebuild_index_page(body.cursor)
    except FilesRefused as exc:
        raise refusal(exc) from exc


@router.get("/jobs")
async def job_status(owner: Owner, file_id: str = "", cursor: str = ""):
    from hushh_mcp.services.pod_files.jobs import history_page, status

    try:
        async with operation() as library:
            return (
                await status(library, file_id) if file_id else await history_page(library, cursor)
            )
    except FilesRefused as exc:
        raise refusal(exc) from exc


@router.post("/jobs")
async def organize(body: OrganizationRequest, owner: Owner):
    from hushh_mcp.services.pod_files.jobs import deliver, prepare_delivery, status

    try:
        async with operation() as library:
            async with operation(mutation=True):
                if body.cancel:
                    return await status(library, body.file_id, cancel=True)
                prepared = await prepare_delivery(library, file_id=body.file_id)
            return await deliver(library, prepared)
    except FilesRefused as exc:
        raise refusal(exc) from exc


class WorkerRequest(BaseModel):
    job_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    delivery: str = Field(pattern=r"^[a-f0-9]{32}$")


@router.post("/worker")
async def organization_worker(
    body: WorkerRequest, authorization: str | None = Header(default=None)
):
    import os

    from hushh_mcp.services.pod_files.jobs import run_job, worker_origin
    from hushh_mcp.services.scheduler_identity import (
        SchedulerIdentityError,
        verify_scheduler_request,
    )

    try:
        email = os.getenv("POD_FILES_WORKER_SERVICE_ACCOUNT", "")
        if not email:
            raise FilesRefused("FILES_BACKGROUND_NOT_CONFIGURED", 503)
        await asyncio.to_thread(
            verify_scheduler_request,
            authorization_header=authorization,
            audience=worker_origin(),
            allowed_emails=(email,),
        )
        return await run_job(body.job_id, body.delivery)
    except SchedulerIdentityError:
        raise HTTPException(403, detail={"code": "FILES_WORKER_REFUSED"}) from None
    except FilesRefused as exc:
        raise refusal(exc) from exc
