from __future__ import annotations

import asyncio
import importlib.util
import json
import sys
import uuid
from pathlib import Path
from typing import Any


def _load_run_manager_module():
    module_name = "kai_run_manager_test_module"
    module_path = Path(__file__).resolve().parents[1] / "api" / "routes" / "kai" / "run_manager.py"
    spec = importlib.util.spec_from_file_location(module_name, module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Unable to load run_manager module for tests")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


def _frame(
    seq: int, event: str, payload: dict[str, Any], *, terminal: bool = False
) -> dict[str, str]:
    return {
        "event": event,
        "id": str(seq),
        "data": json.dumps(
            {
                "schema_version": "1.0",
                "stream_id": "run_test",
                "stream_kind": "stock_analyze",
                "seq": seq,
                "event": event,
                "terminal": terminal,
                "payload": payload,
            }
        ),
    }


class _FakeRequest:
    def __init__(self) -> None:
        self._disconnected = False

    async def is_disconnected(self) -> bool:
        return self._disconnected


class _NoopFeedService:
    def record_event(self, **_kwargs: Any) -> None:
        return None


def test_run_manager_start_conflict_and_cancel() -> None:
    run_manager_module = _load_run_manager_module()
    run_manager_module.FeedService = _NoopFeedService
    KaiAnalyzeRunManager = run_manager_module.KaiAnalyzeRunManager

    async def _scenario() -> None:
        manager = KaiAnalyzeRunManager(retention_seconds=300)
        consent_token = f"consent_{uuid.uuid4().hex}"

        async def slow_generator(
            ticker: str,
            user_id: str,
            consent_token: str,
            risk_profile: str,
            context: dict[str, Any] | None,
            request: Any,
        ):
            yield _frame(1, "start", {"ticker": ticker, "message": "starting"})
            await asyncio.sleep(0.3)
            yield _frame(
                2,
                "decision",
                {
                    "ticker": ticker,
                    "decision": "buy",
                    "confidence": 0.7,
                    "consensus_reached": True,
                },
                terminal=True,
            )

        state_1, run_1 = await manager.start_or_get_active(
            user_id="user_a",
            debate_session_id="sess_a",
            ticker="AAPL",
            risk_profile="balanced",
            context={},
            consent_token=consent_token,
            generator_factory=slow_generator,
        )
        assert state_1 == "started"
        assert run_1.status == "running"

        state_2, run_2 = await manager.start_or_get_active(
            user_id="user_a",
            debate_session_id="sess_a",
            ticker="AAPL",
            risk_profile="balanced",
            context={},
            consent_token=consent_token,
            generator_factory=slow_generator,
        )
        assert state_2 == "active"
        assert run_2.run_id == run_1.run_id

        cancelled = await manager.cancel_run(run_id=run_1.run_id, user_id="user_a")
        assert cancelled is not None

        if run_1.worker_task is not None:
            await asyncio.wait_for(run_1.worker_task, timeout=2)

        refreshed = await manager.get_run(run_1.run_id)
        assert refreshed is not None
        assert refreshed.status in {"canceled", "completed"}

    asyncio.run(_scenario())


def test_run_manager_stream_resume_replays_and_continues() -> None:
    run_manager_module = _load_run_manager_module()
    run_manager_module.FeedService = _NoopFeedService
    KaiAnalyzeRunManager = run_manager_module.KaiAnalyzeRunManager

    async def _scenario() -> None:
        manager = KaiAnalyzeRunManager(retention_seconds=300)
        consent_token = f"consent_{uuid.uuid4().hex}"

        async def deterministic_generator(
            ticker: str,
            user_id: str,
            consent_token: str,
            risk_profile: str,
            context: dict[str, Any] | None,
            request: Any,
        ):
            yield _frame(1, "start", {"ticker": ticker, "message": "starting"})
            yield _frame(
                2,
                "decision",
                {
                    "ticker": ticker,
                    "decision": "hold",
                    "confidence": 0.61,
                    "consensus_reached": True,
                },
                terminal=True,
            )

        _, run = await manager.start_or_get_active(
            user_id="user_b",
            debate_session_id="sess_b",
            ticker="MSFT",
            risk_profile="balanced",
            context={},
            consent_token=consent_token,
            generator_factory=deterministic_generator,
        )

        if run.worker_task is not None:
            await asyncio.wait_for(run.worker_task, timeout=2)

        request = _FakeRequest()
        replay = []
        async for frame in manager.stream_run_events(run=run, start_cursor=0, request=request):
            replay.append(frame)

        assert any(frame.get("event") == "start" for frame in replay)
        assert any(frame.get("event") == "decision" for frame in replay)

        replay_from_cursor = []
        async for frame in manager.stream_run_events(run=run, start_cursor=1, request=request):
            replay_from_cursor.append(frame)

        assert replay_from_cursor
        assert all(frame.get("event") != "start" for frame in replay_from_cursor)
        assert any(frame.get("event") == "decision" for frame in replay_from_cursor)

    asyncio.run(_scenario())


def test_kai_completion_feed_projection_is_source_idempotent_and_terminal_is_immutable() -> None:
    run_manager_module = _load_run_manager_module()
    feed_calls: list[dict[str, Any]] = []

    class _FeedRecorder:
        def record_event(self, **kwargs: Any) -> None:
            feed_calls.append(kwargs)

    run_manager_module.FeedService = _FeedRecorder
    manager = run_manager_module.KaiAnalyzeRunManager(retention_seconds=300, store=False)
    run = run_manager_module.AnalyzeRunRecord(
        run_id="run_stable",
        user_id="user_feed",
        debate_session_id="session_feed",
        ticker="AAPL",
        risk_profile="balanced",
        context={},
        consent_token=f"consent_{uuid.uuid4().hex}",
    )

    async def _scenario() -> None:
        decision = {"ticker": "AAPL", "decision": "hold", "confidence": 0.7}
        await manager._append_frame(run, _frame(1, "decision", decision, terminal=True))
        await manager._append_frame(run, _frame(2, "decision", decision, terminal=True))
        await manager._append_frame(
            run,
            _frame(3, "error", {"code": "LATE_ERROR"}, terminal=True),
        )

    asyncio.run(_scenario())

    assert run.status == "completed"
    assert run.terminal_event == "decision"
    assert run.terminal_payload is not None
    assert run.terminal_payload["decision"] == "hold"
    assert len(feed_calls) == 1
    assert feed_calls[0] == {
        "user_id": "user_feed",
        "source_domain": "kai",
        "event_type": "kai_analysis_completed",
        "actor_label": "Kai",
        "metadata": {"ticker": "AAPL"},
        "source_row_id": "run_stable",
    }
