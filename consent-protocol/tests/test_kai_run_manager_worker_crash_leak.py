"""
Tests: CWE-209 -- run manager worker crash must not leak exception detail.

KaiAnalyzeRunManager._run_worker() and the import run manager both catch
bare Exception and previously forwarded str(exc) in the synthetic terminal
event payload, which exposes internal crash details to SSE subscribers.
"""

from __future__ import annotations

from typing import Any

import pytest


def _make_run_record(ticker: str = "AAPL") -> Any:
    from api.routes.kai.run_manager import AnalyzeRunRecord

    return AnalyzeRunRecord(
        run_id="run-test-001",
        user_id="uid1",
        debate_session_id="sess1",
        ticker=ticker,
        risk_profile="moderate",
        context=None,
        consent_token="tok",  # noqa: S106
    )


class TestRunManagerWorkerCrashDoesNotLeak:
    """Worker crash must produce an opaque error message in the terminal event."""

    @pytest.mark.asyncio
    async def test_worker_crash_omits_exception_text(self):
        """
        When the worker crashes, str(exc) must not appear in terminal_payload.
        """
        from api.routes.kai.run_manager import KaiAnalyzeRunManager

        internal_error = "DB host=internal-db.prod:5432 auth=failed"  # noqa: S105
        manager = KaiAnalyzeRunManager()
        run = _make_run_record()

        # Register the run so _run_worker can find it
        async with manager._lock:
            manager._runs_by_id[run.run_id] = run
            manager._active_by_session[
                (run.user_id, run.debate_session_id)
            ] = run.run_id

        def _crashing_factory(*_args, **_kwargs):
            raise RuntimeError(internal_error)

        await manager._run_worker(run, _crashing_factory)

        # The terminal payload must be set (run failed)
        assert run.status == "failed"
        assert run.terminal_payload is not None

        # The raw exception text must not appear in the terminal payload
        payload_str = str(run.terminal_payload)
        assert internal_error not in payload_str
        assert "internal-db" not in payload_str
        assert "auth=failed" not in payload_str

    @pytest.mark.asyncio
    async def test_worker_crash_terminal_has_opaque_message(self):
        """terminal_payload message must be a user-facing generic string."""
        from api.routes.kai.run_manager import KaiAnalyzeRunManager

        manager = KaiAnalyzeRunManager()
        run = _make_run_record()

        async with manager._lock:
            manager._runs_by_id[run.run_id] = run
            manager._active_by_session[
                (run.user_id, run.debate_session_id)
            ] = run.run_id

        def _crashing_factory(*_a, **_kw):
            raise ValueError("private_key=sk-abc123")

        await manager._run_worker(run, _crashing_factory)

        payload_str = str(run.terminal_payload)
        assert "private_key" not in payload_str
        assert "sk-abc123" not in payload_str

    @pytest.mark.asyncio
    async def test_worker_crash_preserves_run_id_and_ticker(self):
        """run_id and ticker must remain in the terminal payload for client correlation."""
        from api.routes.kai.run_manager import KaiAnalyzeRunManager

        manager = KaiAnalyzeRunManager()
        run = _make_run_record(ticker="TSLA")

        async with manager._lock:
            manager._runs_by_id[run.run_id] = run
            manager._active_by_session[
                (run.user_id, run.debate_session_id)
            ] = run.run_id

        def _crashing_factory(*_a, **_kw):
            raise OSError("socket timeout")

        await manager._run_worker(run, _crashing_factory)

        payload_str = str(run.terminal_payload)
        assert "run-test-001" in payload_str
        assert "TSLA" in payload_str
        # The raw OS error must not be included
        assert "socket timeout" not in payload_str
