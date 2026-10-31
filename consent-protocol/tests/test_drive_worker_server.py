"""Startup/readiness contract for the isolated, scanner-equipped ingress."""

import asyncio
import logging
import threading
import time
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from hushh_mcp.services.google_drive_adapter import DriveReadError


@pytest.fixture(autouse=True)
def enable_selected_indexing_for_worker_readiness(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("DRIVE_DOCUMENT_INDEXING", "true")
    monkeypatch.setenv("PROTECTED_DOCUMENT_DELIVERY_ENABLED", "false")
    monkeypatch.setenv("CONNECTOR_INTERNAL_OWNER_COHORT", "owner")
    import server_drive_worker as worker

    # Admission tests stub the request planner warm-up; its own tests replace it.
    monkeypatch.setattr(worker, "warm_semantic_request_planner", lambda: None)


@pytest.mark.asyncio
async def test_worker_without_indexing_needs_no_model_or_scanner(monkeypatch, tmp_path):
    import server_drive_worker as worker

    monkeypatch.setenv("DRIVE_DOCUMENT_INDEXING", "false")
    monkeypatch.setattr(worker, "BAKED_MODEL_DIR", str(tmp_path / "missing"))
    query = AsyncMock()
    check_ready = AsyncMock()
    monkeypatch.setattr(worker.IsolatedDocumentEmbedding, "admit", query)
    monkeypatch.setattr(worker.ClamAvScanner, "check_ready", check_ready)

    async with worker.lifespan(worker.app):
        assert await worker.ready() == {"status": "ready"}
    query.assert_not_awaited()
    check_ready.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("scanner_fails", [False, True])
async def test_protected_intake_requires_scanner_without_enabling_indexing(
    monkeypatch, tmp_path, scanner_fails
):
    import server_drive_worker as worker

    monkeypatch.setenv("DRIVE_DOCUMENT_INDEXING", "false")
    monkeypatch.setenv("PROTECTED_DOCUMENT_DELIVERY_ENABLED", "true")
    monkeypatch.setattr(worker, "BAKED_MODEL_DIR", str(tmp_path / "missing"))
    monkeypatch.setattr(worker, "STARTUP_TIMEOUT_SECONDS", 0.01)
    embedding = AsyncMock()
    scanner = AsyncMock(
        side_effect=DriveReadError("scanner_unavailable") if scanner_fails else None
    )
    monkeypatch.setattr(worker.IsolatedDocumentEmbedding, "admit", embedding)
    monkeypatch.setattr(worker.ClamAvScanner, "check_ready", scanner)
    if scanner_fails:
        with pytest.raises(RuntimeError, match="startup readiness budget"):
            async with worker.lifespan(worker.app):
                pytest.fail("Protected intake admitted an unavailable scanner")
        with pytest.raises(HTTPException) as error:
            await worker.ready()
        assert error.value.status_code == 503
    else:
        async with worker.lifespan(worker.app):
            assert await worker.ready() == {"status": "ready"}
        assert scanner.await_count == 2
    embedding.assert_not_awaited()
    assert scanner.await_count > 0


@pytest.mark.asyncio
async def test_worker_startup_fails_closed_without_baked_model(monkeypatch, tmp_path):
    import server_drive_worker as worker

    query = AsyncMock()
    monkeypatch.setattr(worker, "BAKED_MODEL_DIR", str(tmp_path / "missing"))
    monkeypatch.setattr(worker.IsolatedDocumentEmbedding, "admit", query)
    with pytest.raises(RuntimeError, match="missing its pinned local model"):
        async with worker.lifespan(worker.app):
            pass
    query.assert_not_awaited()


@pytest.mark.asyncio
async def test_worker_waits_for_scanner_then_only_becomes_ready(monkeypatch, tmp_path):
    import server_drive_worker as worker

    query = AsyncMock(return_value=[0.0] * 384)
    check_ready = AsyncMock(side_effect=[DriveReadError("scanner_unavailable"), None, None])
    sleep = AsyncMock()
    monkeypatch.setattr(worker, "BAKED_MODEL_DIR", str(tmp_path))
    monkeypatch.setattr(worker.IsolatedDocumentEmbedding, "admit", query)
    monkeypatch.setattr(worker.ClamAvScanner, "check_ready", check_ready)
    monkeypatch.setattr(worker.asyncio, "sleep", sleep)
    async with worker.lifespan(worker.app):
        assert await worker.ready() == {"status": "ready"}
    query.assert_awaited_once_with(timeout=170)
    assert check_ready.await_count == 3
    sleep.assert_awaited_once_with(3)


@pytest.mark.asyncio
async def test_worker_readiness_fails_closed_when_scanner_degrades(monkeypatch):
    import server_drive_worker as worker

    monkeypatch.setattr(
        worker.ClamAvScanner,
        "check_ready",
        AsyncMock(side_effect=DriveReadError("scanner_unavailable")),
    )
    with pytest.raises(HTTPException) as error:
        await worker.ready()
    assert error.value.status_code == 503
    assert error.value.detail == "Drive worker unavailable"


@pytest.mark.asyncio
@pytest.mark.feature_drive_packets
@pytest.mark.trace_loop
async def test_worker_keeps_one_cold_admission_child_and_requires_scanner_attestation(
    monkeypatch, tmp_path
):
    import server_drive_worker as worker
    from hushh_mcp.services import drive_document_processor as processor

    async def cold_child(*_args, timeout, **_kwargs):
        # A 120s cold initialization cannot finish in the former 100s child.
        # Restarting it repeats that work with only ~80s of startup left.
        await asyncio.sleep(0)
        if timeout < 120:
            raise DriveReadError("processing_timeout", retryable=True)
        return {"profile": processor.PROFILE, "embedding": [1.0] + [0.0] * 383}

    child = AsyncMock(side_effect=cold_child)
    check_ready = AsyncMock()
    monkeypatch.setattr(worker, "BAKED_MODEL_DIR", str(tmp_path))
    monkeypatch.setattr(processor, "_private_process", child)
    monkeypatch.setattr(worker.ClamAvScanner, "check_ready", check_ready)
    async with worker.lifespan(worker.app):
        child.assert_awaited_once()
        assert child.await_args.args[:2] == ("embedding", "admit")
        assert child.await_args.kwargs["timeout"] == 170
        check_ready.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.feature_drive_packets
@pytest.mark.trace_loop
@pytest.mark.parametrize(
    "errors",
    [
        [DriveReadError("processor_unavailable")],
        [DriveReadError("processing_timeout")],
        [DriveReadError("processor_unavailable", retryable=True)],
        [DriveReadError("processing_timeout", retryable=True)],
    ],
)
async def test_worker_model_failures_never_admit(monkeypatch, tmp_path, errors):
    import server_drive_worker as worker

    query = AsyncMock(side_effect=errors)
    check_ready = AsyncMock()
    monkeypatch.setattr(worker, "BAKED_MODEL_DIR", str(tmp_path))
    monkeypatch.setattr(worker.IsolatedDocumentEmbedding, "admit", query)
    monkeypatch.setattr(worker.ClamAvScanner, "check_ready", check_ready)
    with pytest.raises(DriveReadError):
        async with worker.lifespan(worker.app):
            pytest.fail("Failed model check admitted the worker")
    assert query.await_count == len(errors)


@pytest.mark.asyncio
@pytest.mark.feature_drive_packets
@pytest.mark.trace_loop
@pytest.mark.parametrize("blocked_stage", ["embedding", "scanner"])
async def test_worker_total_budget_cancels_unfinished_readiness(
    monkeypatch, tmp_path, blocked_stage
):
    import server_drive_worker as worker

    cancelled = asyncio.Event()

    async def never_ready(*_args, **_kwargs):
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    query = AsyncMock(side_effect=never_ready if blocked_stage == "embedding" else None)
    check_ready = AsyncMock(side_effect=never_ready if blocked_stage == "scanner" else None)
    monkeypatch.setattr(worker, "BAKED_MODEL_DIR", str(tmp_path))
    monkeypatch.setattr(worker, "STARTUP_TIMEOUT_SECONDS", 0.01)
    monkeypatch.setattr(worker.IsolatedDocumentEmbedding, "admit", query)
    monkeypatch.setattr(worker.ClamAvScanner, "check_ready", check_ready)
    with pytest.raises(RuntimeError, match="exceeded its startup readiness budget"):
        async with worker.lifespan(worker.app):
            pytest.fail("Unfinished readiness check admitted the worker")
    assert cancelled.is_set()


@pytest.mark.asyncio
async def test_worker_timeout_waits_for_async_child_cleanup(monkeypatch, tmp_path):
    import server_drive_worker as worker

    cleaning = asyncio.Event()
    release_cleanup = asyncio.Event()
    reaped = asyncio.Event()

    async def model(*_args, **_kwargs):
        try:
            await asyncio.Event().wait()
        finally:
            cleaning.set()
            await release_cleanup.wait()
            reaped.set()

    async def scanner():
        await asyncio.Event().wait()

    async def enter():
        with pytest.raises(RuntimeError, match="exceeded its startup readiness budget"):
            async with worker.lifespan(worker.app):
                pytest.fail("Timed out readiness admitted the worker")

    monkeypatch.setattr(worker, "BAKED_MODEL_DIR", str(tmp_path))
    monkeypatch.setattr(worker, "STARTUP_TIMEOUT_SECONDS", 0.01)
    monkeypatch.setattr(worker.IsolatedDocumentEmbedding, "admit", AsyncMock(side_effect=model))
    monkeypatch.setattr(worker.ClamAvScanner, "check_ready", AsyncMock(side_effect=scanner))
    startup = asyncio.create_task(enter())
    try:
        async with asyncio.timeout(2):
            await cleaning.wait()
            # Let gather surface the scanner's cancellation while the model is
            # still reaping its child. The supervisor must not cancel it again.
            await asyncio.sleep(0)
            await asyncio.sleep(0)
            assert not startup.done()
            release_cleanup.set()
            await startup
            assert reaped.is_set()
    finally:
        release_cleanup.set()
        if not startup.done():
            startup.cancel()
        await asyncio.gather(startup, return_exceptions=True)


@pytest.mark.asyncio
@pytest.mark.parametrize("last_stage", ["embedding", "scanner"])
async def test_worker_overlaps_readiness_but_joins_both_before_admission(
    monkeypatch, tmp_path, last_stage
):
    import server_drive_worker as worker

    started = {stage: asyncio.Event() for stage in ("embedding", "scanner")}
    release = {stage: asyncio.Event() for stage in started}
    finished = {stage: asyncio.Event() for stage in started}
    admitted = asyncio.Event()

    async def check(stage):
        started[stage].set()
        # Old sequential admission cannot satisfy this handshake.
        await asyncio.gather(*(event.wait() for event in started.values()))
        await release[stage].wait()
        finished[stage].set()

    async def enter():
        async with worker.lifespan(worker.app):
            admitted.set()

    async def model(*_args, **_kwargs):
        await check("embedding")

    async def scanner():
        await check("scanner")

    monkeypatch.setattr(worker, "BAKED_MODEL_DIR", str(tmp_path))
    monkeypatch.setattr(worker.IsolatedDocumentEmbedding, "admit", AsyncMock(side_effect=model))
    monkeypatch.setattr(worker.ClamAvScanner, "check_ready", AsyncMock(side_effect=scanner))
    startup = asyncio.create_task(enter())
    try:
        async with asyncio.timeout(2):
            await asyncio.gather(*(event.wait() for event in started.values()))
            assert not admitted.is_set()
            first_stage = "scanner" if last_stage == "embedding" else "embedding"
            release[first_stage].set()
            await finished[first_stage].wait()
            assert not admitted.is_set()
            release[last_stage].set()
            await startup
            assert admitted.is_set()
    finally:
        startup.cancel()
        await asyncio.gather(startup, return_exceptions=True)


@pytest.mark.asyncio
@pytest.mark.parametrize("failed_stage", ["embedding", "scanner"])
async def test_worker_failure_cancels_and_settles_sibling(monkeypatch, tmp_path, failed_stage):
    import server_drive_worker as worker

    sibling_started = asyncio.Event()
    sibling_settled = asyncio.Event()

    async def blocked(*_args, **_kwargs):
        sibling_started.set()
        try:
            await asyncio.Event().wait()
        finally:
            sibling_settled.set()

    async def failed(*_args, **_kwargs):
        await sibling_started.wait()
        raise RuntimeError("synthetic admission failure")

    monkeypatch.setattr(worker, "BAKED_MODEL_DIR", str(tmp_path))
    monkeypatch.setattr(
        worker.IsolatedDocumentEmbedding,
        "admit",
        AsyncMock(side_effect=failed if failed_stage == "embedding" else blocked),
    )
    monkeypatch.setattr(
        worker.ClamAvScanner,
        "check_ready",
        AsyncMock(side_effect=failed if failed_stage == "scanner" else blocked),
    )
    async with asyncio.timeout(2):
        with pytest.raises(RuntimeError, match="synthetic admission failure"):
            async with worker.lifespan(worker.app):
                pytest.fail("Failed readiness check admitted the worker")
    assert sibling_settled.is_set()


@pytest.mark.asyncio
async def test_worker_hard_failure_disarms_deadline_before_child_cleanup(monkeypatch, tmp_path):
    import server_drive_worker as worker

    started, cleaning, release_cleanup, settled = (asyncio.Event() for _ in range(4))
    real_timeout = asyncio.timeout
    deadlines = []
    cancellation_counts = []

    def timeout(seconds):
        deadline = real_timeout(seconds)
        deadlines.append(deadline)
        return deadline

    async def model(*_args, **_kwargs):
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            cleaning.set()
            await release_cleanup.wait()
            cancellation_counts.append(asyncio.current_task().cancelling())
            settled.set()

    async def scanner():
        await started.wait()
        raise RuntimeError("synthetic admission failure")

    async def enter():
        with pytest.raises(RuntimeError, match="synthetic admission failure"):
            async with worker.lifespan(worker.app):
                pytest.fail("Failed admission entered the worker")

    monkeypatch.setattr(worker, "BAKED_MODEL_DIR", str(tmp_path))
    monkeypatch.setattr(worker.asyncio, "timeout", timeout)
    monkeypatch.setattr(worker.IsolatedDocumentEmbedding, "admit", AsyncMock(side_effect=model))
    monkeypatch.setattr(worker.ClamAvScanner, "check_ready", AsyncMock(side_effect=scanner))
    startup = asyncio.create_task(enter())
    try:
        await asyncio.wait_for(cleaning.wait(), timeout=2)
        try:
            # Fire the real deadline precisely during asynchronous cleanup.
            # Correct ownership has already exited it, refusing rescheduling.
            deadlines[0].reschedule(asyncio.get_running_loop().time())
        except RuntimeError:
            pass
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        release_cleanup.set()
        await asyncio.wait_for(startup, timeout=2)
        assert settled.is_set()
        assert cancellation_counts == [1]
    finally:
        release_cleanup.set()
        if not startup.done():
            startup.cancel()
        await asyncio.gather(startup, return_exceptions=True)


def test_worker_process_logs_info_lines_through_the_redaction_filter():
    """Job timing lines are INFO; a fresh worker process must not drop them."""
    import os
    import subprocess
    import sys
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    probe = (
        "import logging\n"
        "import server_drive_worker  # noqa: F401\n"
        "logging.getLogger('hushh_mcp.services.drive_ingestion_service').info(\n"
        "    'drive_extraction_job status=%s pages=%d fetch_ms=%d extract_ms=%d total_ms=%d',\n"
        "    'ready', 3, 120, 340, 470)\n"
        "logging.getLogger('hushh_mcp.services.drive_packet_worker').info(\n"
        "    'drive_probe owner=%s', 'synthetic.owner@example.invalid')\n"
    )
    result = subprocess.run(  # noqa: S603 - this interpreter, fixed synthetic probe
        [sys.executable, "-c", probe],
        cwd=root,
        env={**os.environ, "PYTHONPATH": str(root)},
        capture_output=True,
        text=True,
        timeout=180,
        check=True,
    )
    assert (
        "drive_extraction_job status=ready pages=3 fetch_ms=120 extract_ms=340 total_ms=470"
        in result.stderr
    )
    assert "drive_probe owner=[REDACTED]" in result.stderr
    assert "synthetic.owner@example.invalid" not in result.stderr


@pytest.mark.asyncio
async def test_worker_loads_the_request_planner_before_taking_drain_work(monkeypatch):
    import server_drive_worker as worker

    # 2026-10-30: a new instance loaded the planner inside an allowed request's
    # 90 s search budget, was cancelled twice, and the search started 5 min late.
    monkeypatch.setenv("DRIVE_DOCUMENT_INDEXING", "false")
    loaded = threading.Event()

    def warm():
        time.sleep(0.05)
        loaded.set()

    monkeypatch.setattr(worker, "warm_semantic_request_planner", warm)
    async with worker.lifespan(worker.app):
        assert loaded.is_set()


@pytest.mark.asyncio
@pytest.mark.parametrize("outcome", ["failed", "timeout"])
async def test_planner_warmup_never_decides_worker_readiness(monkeypatch, caplog, outcome):
    import server_drive_worker as worker

    monkeypatch.setenv("DRIVE_DOCUMENT_INDEXING", "false")
    # Only the timeout case races its bound; a failure must report as a failure.
    monkeypatch.setattr(
        worker, "PLANNER_WARMUP_TIMEOUT_SECONDS", 0.05 if outcome == "timeout" else 5
    )
    release = threading.Event()

    def warm():
        if outcome == "failed":
            raise RuntimeError("synthetic planner load failure")
        release.wait(5)

    monkeypatch.setattr(worker, "warm_semantic_request_planner", warm)
    try:
        with caplog.at_level(logging.INFO, logger=worker.logger.name):
            async with asyncio.timeout(2), worker.lifespan(worker.app):
                assert await worker.ready() == {"status": "ready"}
    finally:
        release.set()
    assert f"stage=planner outcome={outcome}" in caplog.text


@pytest.mark.asyncio
async def test_failed_admission_does_not_wait_for_the_planner(monkeypatch, tmp_path):
    import server_drive_worker as worker

    release = threading.Event()
    monkeypatch.setattr(worker, "BAKED_MODEL_DIR", str(tmp_path / "missing"))
    monkeypatch.setattr(worker, "warm_semantic_request_planner", lambda: release.wait(5))
    try:
        async with asyncio.timeout(2):
            with pytest.raises(RuntimeError, match="missing its pinned local model"):
                async with worker.lifespan(worker.app):
                    pytest.fail("A worker without its model was admitted")
    finally:
        release.set()
