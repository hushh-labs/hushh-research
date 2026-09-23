"""Minimal, private Drive work-drain ingress for the scanner-equipped service.

The ordinary API image has the same code and query model but no scanner
sidecar. Only this server is allowed to run the document/permission outbox.
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from pathlib import Path

from hushh_mcp.runtime_settings import hydrate_runtime_environment
from mcp_modules.log_redaction import install_sensitive_log_filter

install_sensitive_log_filter()
hydrate_runtime_environment()

from fastapi import FastAPI, HTTPException  # noqa: E402

from api.routes.drive_work_drain import router  # noqa: E402
from hushh_mcp.services.drive_document_processor import (  # noqa: E402
    ClamAvScanner,
    IsolatedDocumentEmbedding,
)
from hushh_mcp.services.embedding_client_leaf import BAKED_MODEL_DIR  # noqa: E402
from hushh_mcp.services.google_drive_adapter import DriveReadError  # noqa: E402


@asynccontextmanager
async def lifespan(_app: FastAPI):
    if not Path(BAKED_MODEL_DIR).is_dir():
        raise RuntimeError("Drive worker image is missing its pinned local model")
    # This is synthetic content only. Failure keeps the candidate revision
    # unready and prevents the scheduler from being retargeted to it.
    await IsolatedDocumentEmbedding().query("synthetic statement")
    scanner = ClamAvScanner()
    deadline = asyncio.get_running_loop().time() + 200
    while True:
        try:
            await scanner.check_ready()
            break
        except DriveReadError:
            if asyncio.get_running_loop().time() >= deadline:
                raise RuntimeError("Drive scanner failed its startup check") from None
            await asyncio.sleep(3)
    yield


app = FastAPI(
    title="Drive Work Drain",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
    lifespan=lifespan,
)
app.include_router(router)


@app.get("/ready", include_in_schema=False)
async def ready() -> dict[str, str]:
    try:
        await ClamAvScanner().check_ready()
    except Exception:
        raise HTTPException(status_code=503, detail="Drive worker unavailable") from None
    return {"status": "ready"}
