"""Minimal, private Drive work-drain ingress for the scanner-equipped service.

The ordinary API image has the same code and query model but no scanner
sidecar. Only this server is allowed to run the document/permission outbox.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from time import monotonic

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
    connector_feature_enabled,
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
logger = logging.getLogger(__name__)


def _indexing_active() -> bool:
    return connector_feature_owner_cohort("drive_document_indexing") != ()


def _scanner_active() -> bool:
    # This synthetic identity evaluates configuration only; it grants no owner
    # access and does not widen the indexing cohort.
    return _indexing_active() or connector_feature_enabled(
        "protected_document_delivery", "connector-scope-check"
    )


async def _admit_embedding() -> None:
    embedding = IsolatedDocumentEmbedding()
    try:
        await embedding.admit()
    except DriveReadError as error:
        # The failed child is reaped before its one eligible retry. Preserve
        # the existing per-query isolation, deadline and resource limits.
        if not error.retryable or str(error) != "processing_timeout":
            raise
        with suppress(Exception):
            logger.info(
                "drive_worker_startup stage=embedding outcome=retry reason=processing_timeout"
            )
        await embedding.admit()


async def _admit_scanner() -> None:
    scanner = ClamAvScanner()
    while True:
        try:
            await scanner.check_ready()
            return
        except DriveReadError:
            await asyncio.sleep(3)


async def _timed_admission(stage: str, check: Callable[[], Awaitable[None]]) -> None:
    started = monotonic()
    outcome = "failed"
    try:
        await check()
        outcome = "ready"
    except asyncio.CancelledError:
        outcome = "cancelled"
        raise
    finally:
        logger.info(
            "drive_worker_startup stage=%s outcome=%s duration_ms=%d",
            stage,
            outcome,
            round((monotonic() - started) * 1000),
        )


@asynccontextmanager
async def lifespan(_app: FastAPI):
    indexing = _indexing_active()
    if not _scanner_active():
        yield
        return
    if indexing and not Path(BAKED_MODEL_DIR).is_dir():
        raise RuntimeError("Drive worker image is missing its pinned local model")
    # This is synthetic content only. Failure keeps the candidate revision
    # unready and prevents the scheduler from being retargeted to it.
    tasks: list[asyncio.Task[None]] = []
    try:
        async with asyncio.timeout(STARTUP_TIMEOUT_SECONDS):
            # Scanner reload/freshness and isolated model admission are
            # independent. Both must finish within the same startup budget.
            tasks = [asyncio.create_task(_timed_admission("scanner", _admit_scanner))]
            if indexing:
                tasks.append(asyncio.create_task(_timed_admission("embedding", _admit_embedding)))
            await asyncio.gather(*tasks)
    except TimeoutError:
        raise RuntimeError("Drive worker exceeded its startup readiness budget") from None
    finally:
        # Disarm the admission deadline before teardown, so a hard failure near
        # it cannot interrupt child reaping or replace the original failure.
        for task in tasks:
            if not task.done() and not task.cancelling():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
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
    if not _scanner_active():
        return {"status": "ready"}
    try:
        await ClamAvScanner().check_ready()
    except Exception:
        raise HTTPException(status_code=503, detail="Drive worker unavailable") from None
    return {"status": "ready"}
