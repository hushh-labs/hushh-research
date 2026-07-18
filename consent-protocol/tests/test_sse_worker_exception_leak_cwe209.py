"""
Regression tests for CWE-209 fix in run_manager.py SSE worker error payload.

CWE-209 -- Information Exposure Through Error Messages:
  run_manager.py echoed raw str(exc) into the ANALYZE_RUN_WORKER_FAILED SSE
  event payload that is flushed directly to connected browser clients.

Attach point:
  GET /api/kai/analyze/run/{run_id}/stream  (run_manager.py worker)
"""

from __future__ import annotations

import json

_SENTINEL = "INTERNAL_SECRET_zP3mQw7nRk_LEAK_MARKER"


class TestRunManagerWorkerExceptionLeak:
    """KaiAnalyzeRunManager._run_worker must not echo exc detail in SSE payload."""

    def test_worker_crash_does_not_echo_exception_detail(self):
        import asyncio

        from api.routes.kai.run_manager import AnalyzeRunRecord, KaiAnalyzeRunManager

        manager = KaiAnalyzeRunManager()

        run = AnalyzeRunRecord(
            run_id="test-run-001",
            user_id="user_test",
            debate_session_id="debate-sess-001",
            ticker="AAPL",
            risk_profile="balanced",
            context=None,
            consent_token="test-token",  # noqa: S106
        )

        async def _crashing_factory(ticker, user_id, consent_token, risk_profile, context, req):
            raise RuntimeError(_SENTINEL)
            yield  # pragma: no cover -- make it an async generator

        async def _run():
            await manager._run_worker(run, _crashing_factory)

        asyncio.run(_run())

        assert run.status == "failed"

        for frame in run.events:
            data_str = frame.get("data", "")
            assert _SENTINEL not in data_str, (
                f"Internal exception detail leaked into SSE frame: {data_str!r}"
            )

        assert run.terminal_payload is not None
        assert _SENTINEL not in json.dumps(run.terminal_payload)
        assert run.terminal_payload.get("code") == "ANALYZE_RUN_WORKER_FAILED"
