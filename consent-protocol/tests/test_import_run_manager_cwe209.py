"""
Regression tests for CWE-209 fix in import_run_manager.py SSE worker error payload.

CWE-209 -- Information Exposure Through Error Messages:
  import_run_manager.py echoed raw str(exc) into the IMPORT_RUN_WORKER_FAILED SSE
  event payload that is flushed directly to connected browser clients.

Attach point:
  GET /api/kai/import/run/{run_id}/stream  (import_run_manager.py worker)
"""

from __future__ import annotations

import asyncio
import json

from api.routes.kai.import_run_manager import (
    KaiPortfolioImportRunManager,
    PortfolioImportRunRecord,
)

_SENTINEL = "INTERNAL_SECRET_zP3mQw7nRk_LEAK_MARKER"


class TestImportRunManagerWorkerExceptionLeak:
    """KaiPortfolioImportRunManager._run_worker must not echo exc detail in SSE payload."""

    def test_worker_crash_does_not_echo_exception_detail(self):
        manager = KaiPortfolioImportRunManager()

        run = PortfolioImportRunRecord(
            run_id="test-import-run-001",
            user_id="user_test",
            filename="test.csv",
            content=b"",
            is_csv_upload=True,
        )

        async def _crashing_factory(run, req):
            raise RuntimeError(_SENTINEL)
            yield  # pragma: no cover -- make it an async generator

        async def _run():
            await manager._run_worker(run, _crashing_factory)

        asyncio.run(_run())

        assert run.status == "failed"

        for frame in run.events:
            data_str = frame.get("data", "")
            assert _SENTINEL not in data_str, (
                f"Internal exception detail leaked into import SSE frame: {data_str!r}"
            )

        all_data = json.dumps([f.get("data", "") for f in run.events])
        assert _SENTINEL not in all_data
