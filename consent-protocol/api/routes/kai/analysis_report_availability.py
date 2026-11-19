"""Exact Shared ciphertext acknowledgement; report contents remain browser encrypted."""

from contextlib import asynccontextmanager

from fastapi import HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from api.routes.one import shared_files
from hushh_mcp.services.pod_files.contracts import FilesRefused
from hushh_mcp.services.shared_files import registry


class CompletionProof(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    version: int = Field(ge=1, le=1)
    ciphertext: str = Field(min_length=1, max_length=4096)
    iv: str = Field(min_length=1, max_length=128)
    algorithm: str = Field(pattern=r"^aes-256-gcm-aad-v1$")


class SharedObjectReceipt(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    libraryId: str = Field(pattern=r"^[a-f0-9-]{36}$")
    namespace: str = Field(pattern=r"^[a-f0-9]{64}$")
    objectId: str = Field(pattern=r"^[a-f0-9]{64}$")
    generation: str = Field(pattern=r"^[1-9][0-9]{0,30}$")
    leaseId: str = Field(pattern=r"^[a-f0-9-]{36}$")


class SharedReportReceipt(SharedObjectReceipt):
    reportTicker: str = Field(min_length=1, max_length=64)
    viewedInFinance: bool = False
    completionProof: CompletionProof | None = None


@asynccontextmanager
async def confirmed_report_object(request: Request, owner: str, receipt: SharedObjectReceipt):
    store, row = await shared_files._store(owner, receipt.libraryId, create=False)
    try:
        async with registry.locked_lease(owner, receipt.libraryId, receipt.leaseId) as connection:
            await shared_files._security(store, row)
            data, generation = await store.get_bounded_with_generation(
                receipt.namespace + "/" + receipt.objectId,
                max_bytes=shared_files.MAX_CIPHERTEXT_BYTES,
            )
            if data is None or generation != receipt.generation:
                raise HTTPException(status_code=409, detail="Saved report changed")
            await shared_files._fresh_owner(request, owner)
            yield connection
    except FilesRefused as exc:
        raise HTTPException(status_code=exc.status, detail={"code": exc.code}) from None


class ReportReadReceipt(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    completionProof: CompletionProof | None = None


async def confirmed_completion_ticker(get_run, completed_source, owner, run_id, proof):
    """One completion authority for publication and exact read acknowledgements."""
    from starlette.concurrency import run_in_threadpool

    from hushh_mcp.services.kai_completion_proof import verify_completion_proof

    run = await get_run(run_id)
    if run is not None:
        if run.user_id != owner:
            raise HTTPException(status_code=404, detail="Analysis run not found")
        if run.status != "completed":
            raise HTTPException(status_code=409, detail="Analysis run has not completed")
        return run.ticker
    if proof is not None:
        try:
            return verify_completion_proof(owner, run_id, proof.model_dump())
        except ValueError:
            pass  # A separately retained source may confirm a rotated-key proof.
    try:
        ticker = await run_in_threadpool(completed_source, owner, run_id)
    except Exception:
        raise HTTPException(
            status_code=503, detail="Analysis source could not be checked"
        ) from None
    if ticker is None:
        raise HTTPException(status_code=404, detail="Analysis source not found")
    return ticker
