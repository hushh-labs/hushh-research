"""Direct, app-role Files API. This router is never mounted in the shared hub."""

from __future__ import annotations

import asyncio
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response
from pydantic import BaseModel, Field

from api.routes.one.pod_session import verified_session
from hushh_mcp.services.pod_files.library import CHUNK_BYTES, FilesRefused
from hushh_mcp.services.pod_files.model_binding import (
    organization_model_binding,
    organization_model_status,
)
from hushh_mcp.services.pod_files.runtime import (
    files_access,
    operation,
    require_files_access,
    wiki_operation,
)
from hushh_mcp.services.pod_session_authority import ROLE_APP, PodSessionRefused
from hushh_mcp.services.wiki_memory.contracts import WikiRefused

router = APIRouter(prefix="/api/one/pod/files", tags=["personal-agent"])


async def access(authorization: str | None = Header(default=None)):
    authority, claims = verified_session(authorization, role=ROLE_APP, scope="files.read")

    async def check() -> None:
        verified_session(authorization, role=ROLE_APP, scope="files.read")
        try:
            await authority.require_held()
        except PodSessionRefused as exc:
            raise FilesRefused(exc.code, exc.status) from None

    async def manage() -> None:
        verified_session(authorization, role=ROLE_APP, scope="files.manage")
        await check()

    with files_access(check, manage=manage):
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
    from hushh_mcp.services.pod_files.completion import complete_upload

    try:
        async with operation() as library:
            return await complete_upload(library, body.file_id, mutation=operation(mutation=True))
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
    from hushh_mcp.services.pod_files.runtime import custody_key_reference

    try:
        async with operation() as library:
            settings = await library.settings()
            return {
                **settings,
                **organization_model_status(),
                "retention": await library.store.verify_bucket(custody_key_reference()),
            }
    except FilesRefused as exc:
        raise refusal(exc) from exc


@router.put("/settings")
async def update_settings(body: AnalysisSettings, owner: Owner):
    try:
        async with operation(mutation=True) as library:
            if body.analysis and body.automatic:
                from hushh_mcp.services.pod_files.model_binding import (
                    hosted_files_analysis_disabled,
                )

                if hosted_files_analysis_disabled():
                    raise FilesRefused("FILES_MODEL_UNAVAILABLE", 503)
                current = await library.settings()
                # Withdrawing access must work even after provider loss. Keeping
                # automatic analysis may only preserve or tighten an existing grant.
                restrictive = (
                    current["analysis"]
                    and current["automatic"]
                    and set(body.excluded).issuperset(current["excluded"])
                )
                if not restrictive:
                    organization_model_binding()
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
    request_id: str = Field(default="", max_length=128)
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
                prepared = await prepare_delivery(
                    library, file_id=body.file_id, request_id=body.request_id
                )
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


def wiki_refusal(exc: WikiRefused | FilesRefused) -> HTTPException:
    return HTTPException(status_code=exc.status, detail={"code": exc.code})


class WikiOptInBody(BaseModel):
    enabled: bool


class WikiSavePageBody(BaseModel):
    page_id: str = Field(min_length=4, max_length=64)
    expected_revision: int = Field(ge=1)
    title: str = Field(min_length=1, max_length=120)
    tldr: str = Field(default="", max_length=600)
    body: str = Field(default="", max_length=64000)
    request_id: str = Field(min_length=8, max_length=128)


class WikiConfirmCandidateBody(BaseModel):
    receipt_id: str = Field(min_length=4, max_length=64)
    request_id: str = Field(min_length=8, max_length=128)


class WikiForgetClaimBody(BaseModel):
    page_id: str = Field(min_length=4, max_length=64)
    claim_id: str = Field(min_length=4, max_length=64)
    replacement_statement: str | None = Field(default=None, max_length=1000)
    request_id: str = Field(min_length=8, max_length=128)


class WikiRollbackBody(BaseModel):
    request_id: str = Field(min_length=8, max_length=128)


_SOURCE_KIND_LABELS = {
    "chat_turn": "Conversation",
    "file_object": "Uploaded file",
    "pkm_record": "Saved profile",
    "live_activity": "Live session",
    "owner_direct": "Direct note",
}


@router.get("/wiki/overview")
async def read_wiki_overview(owner: Owner):
    from hushh_mcp.services.wiki_memory import WikiOwnerMigrator

    try:
        async with wiki_operation() as wiki:
            migrator = WikiOwnerMigrator(wiki)
            cp = await wiki.read_capture_checkpoint()
            mig = await migrator.get_migration_status()
            pages = await wiki.list_pages()
            receipts = await wiki.list_projection_receipts()
            candidates: list[dict[str, object]] = []
            for rec in receipts:
                if rec["state"] not in {"private_candidate", "conflicted", "stale"}:
                    continue
                stmt = ""
                try:
                    pdoc = await wiki.read_page(rec["page_id"])
                    found = next(
                        (c for c in pdoc["claims"] if c["claim_id"] == rec["claim_id"]), None
                    )
                    stmt = str(found["statement"]) if found else ""
                except WikiRefused:
                    stmt = ""
                candidates.append(
                    {
                        "receiptId": rec["receipt_id"],
                        "pageId": rec["page_id"],
                        "claimId": rec["claim_id"],
                        "domain": rec["domain"],
                        "statement": stmt,
                        "state": rec["state"],
                    }
                )
            return {
                "captureOptIn": cp.capture_opt_in,
                "migrationState": mig["state"],
                "migrationRevision": mig["migration_revision"],
                "pages": [
                    {
                        "pageId": p["page_id"],
                        "title": p["title"],
                        "folder": p["folder"],
                        "tldr": str(p.get("tldr") or ""),
                        "revision": p["revision"],
                        "updatedAt": p["updated_at"],
                    }
                    for p in pages
                ],
                "candidateReceipts": candidates,
            }
    except (WikiRefused, FilesRefused) as exc:
        raise wiki_refusal(exc) from exc


@router.get("/wiki/page")
async def read_wiki_page_detail(owner: Owner, page_id: str):
    try:
        async with wiki_operation() as wiki:
            page = await wiki.read_page(page_id)
            source_labels: dict[str, str] = {}
            for sid in page["source_ids"]:
                try:
                    src = await wiki.get_source(sid)
                    label = _SOURCE_KIND_LABELS.get(str(src.get("kind") or ""), "Saved source")
                    obs = str(src.get("observed_at") or "")[:10]
                    source_labels[sid] = f"{label} · {obs}" if obs else label
                except WikiRefused:
                    source_labels[sid] = "Saved source"
            return {
                "pageId": page["page_id"],
                "title": page["title"],
                "folder": page["folder"],
                "tldr": page["tldr"],
                "body": page["body"],
                "revision": page["revision"],
                "statusAsOf": page["status_as_of"],
                "claims": [
                    {
                        "claimId": c["claim_id"],
                        "statement": c["statement"],
                        "status": c["status"],
                        "observedAt": c["observed_at"],
                        "origins": [
                            source_labels.get(sid, "Saved source")
                            for sid in c.get("source_ids", [])
                        ],
                    }
                    for c in page["claims"]
                ],
            }
    except (WikiRefused, FilesRefused) as exc:
        raise wiki_refusal(exc) from exc


@router.post("/wiki/opt-in")
async def update_wiki_opt_in(body: WikiOptInBody, owner: Owner):
    from hushh_mcp.services.wiki_memory import WikiKnowledgeWriter

    try:
        async with wiki_operation(mutation=True) as wiki:
            writer = WikiKnowledgeWriter(wiki)
            res = await writer.set_capture_opt_in(body.enabled)
            return {"captureOptIn": bool(res["capture_opt_in"])}
    except (WikiRefused, FilesRefused) as exc:
        raise wiki_refusal(exc) from exc


@router.post("/wiki/page")
async def save_wiki_page_detail(body: WikiSavePageBody, owner: Owner):
    from hushh_mcp.services.wiki_memory import WikiKnowledgeWriter, WikiProjectionEngine

    try:
        async with wiki_operation(mutation=True) as wiki:
            updated = await wiki.edit_page(
                body.page_id,
                expected_revision=body.expected_revision,
                idempotency_key=body.request_id,
                title=body.title,
                tldr=body.tldr,
                body=body.body,
            )
            await WikiProjectionEngine(wiki).sync_page_lifecycle(body.page_id)
            await wiki.rebuild_indexes()
            await WikiKnowledgeWriter(wiki).refresh_hot_digest()
            return {"pageId": updated["page_id"], "revision": updated["revision"]}
    except (WikiRefused, FilesRefused) as exc:
        raise wiki_refusal(exc) from exc


@router.post("/wiki/confirm")
async def confirm_wiki_candidate(body: WikiConfirmCandidateBody, owner: Owner):
    from hushh_mcp.services.wiki_memory import WikiProjectionEngine

    try:
        async with wiki_operation(mutation=True) as wiki:
            saved = await WikiProjectionEngine(wiki).confirm_candidate_projection(
                body.receipt_id, idempotency_key=body.request_id
            )
            return {"receiptId": saved["receipt_id"], "state": saved["state"]}
    except (WikiRefused, FilesRefused) as exc:
        raise wiki_refusal(exc) from exc


@router.post("/wiki/forget")
async def forget_wiki_claim(body: WikiForgetClaimBody, owner: Owner):
    from hushh_mcp.services.wiki_memory import WikiOwnerMigrator

    try:
        async with wiki_operation(mutation=True) as wiki:
            res = await WikiOwnerMigrator(wiki).propagate_forget_and_correction(
                page_id=body.page_id,
                claim_id=body.claim_id,
                idempotency_key=body.request_id,
                replacement_statement=body.replacement_statement,
                destroy_page_key=True,
                delete_retired_blobs=True,
            )
            return {
                "pageId": res["page_id"],
                "revision": res["revision"],
                "outcomes": res["outcomes"],
            }
    except (WikiRefused, FilesRefused) as exc:
        raise wiki_refusal(exc) from exc


@router.post("/wiki/rollback")
async def rollback_wiki_to_classic(body: WikiRollbackBody, owner: Owner):
    from hushh_mcp.services.wiki_memory import WikiOwnerMigrator

    _ = body.request_id
    try:
        async with wiki_operation(mutation=True) as wiki:
            res = await WikiOwnerMigrator(wiki).rollback_to_v1_markdown()
            return {"migrationState": res["state"], "migrationRevision": res["migration_revision"]}
    except (WikiRefused, FilesRefused) as exc:
        raise wiki_refusal(exc) from exc
