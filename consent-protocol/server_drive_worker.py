"""Minimal, private Drive work-drain ingress for the scanner-equipped service.

The ordinary API image has the same code and query model but no scanner
sidecar. Only this server is allowed to run the document/permission outbox.
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from hushh_mcp.runtime_settings import hydrate_runtime_environment
from mcp_modules.log_redaction import install_sensitive_log_filter

# Drive job timing lines are INFO and carry only codes, counts and timings.
# Without this the root logger keeps Python's WARNING default and drops them.
# Same setup as server.py: the redaction filter also covers this handler.
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
install_sensitive_log_filter()
hydrate_runtime_environment()

from fastapi import FastAPI, HTTPException  # noqa: E402

from api.routes.drive_work_drain import router  # noqa: E402
from hushh_mcp.services.connector_feature_admission import (  # noqa: E402
    connector_feature_owner_cohort,
)
from hushh_mcp.services.drive_document_processor import (  # noqa: E402
    ClamAvScanner,
    IsolatedDocumentEmbedding,
)
from hushh_mcp.services.embedding_client_leaf import BAKED_MODEL_DIR  # noqa: E402
from hushh_mcp.services.google_drive_adapter import DriveReadError  # noqa: E402

# Leave headroom inside the worker's 220s Gunicorn / 240s startup-probe bounds.
# Model admission, its single retry and scanner attestation share this budget.
STARTUP_TIMEOUT_SECONDS = 180


def _indexing_active() -> bool:
    return connector_feature_owner_cohort("drive_document_indexing") != ()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    if not _indexing_active():
        yield
        return
    if not Path(BAKED_MODEL_DIR).is_dir():
        raise RuntimeError("Drive worker image is missing its pinned local model")
    # This is synthetic content only. Failure keeps the candidate revision
    # unready and prevents the scheduler from being retargeted to it.
    try:
        async with asyncio.timeout(STARTUP_TIMEOUT_SECONDS):
            embedding = IsolatedDocumentEmbedding()
            try:
                await embedding.query("synthetic statement")
            except DriveReadError as error:
                # A cold local model can hit its existing child deadline. The
                # failed child is reaped by the processor before retrying; keep
                # all per-query isolation and resource limits unchanged.
                if not error.retryable or str(error) != "processing_timeout":
                    raise
                await embedding.query("synthetic statement")
            scanner = ClamAvScanner()
            while True:
                try:
                    await scanner.check_ready()
                    break
                except DriveReadError:
                    await asyncio.sleep(3)
    except TimeoutError:
        raise RuntimeError("Drive worker exceeded its startup readiness budget") from None
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
    if not _indexing_active():
        return {"status": "ready"}
    try:
        await ClamAvScanner().check_ready()
    except Exception:
        raise HTTPException(status_code=503, detail="Drive worker unavailable") from None
    return {"status": "ready"}
