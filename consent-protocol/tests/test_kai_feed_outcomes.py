"""Feed must reflect one canonical outcome, without implying saved information."""

import asyncio
import json
import uuid
from contextvars import ContextVar

import pytest
from fastapi import HTTPException

from api.routes.kai import import_run_manager, run_manager, stream


class Request:
    async def is_disconnected(self):
        return False


def frame(event, terminal=True):
    return {
        "event": event,
        "id": "1",
        "data": json.dumps(
            {"event": event, "terminal": terminal, "payload": {"private": "never-in-feed"}}
        ),
    }


def setup_run(monkeypatch, importing):
    module = import_run_manager if importing else run_manager
    calls = []

    class Feed:
        def record_event(self, **kwargs):
            calls.append(kwargs)

    monkeypatch.setattr(module, "FeedService", Feed, raising=False)
    if importing:
        manager = module.KaiPortfolioImportRunManager(store=False)
        run = module.PortfolioImportRunRecord(
            run_id="run",
            user_id="owner",
            filename="private.pdf",
            content=b"private",
            is_csv_upload=False,
        )
    else:
        manager = module.KaiAnalyzeRunManager(store=False)
        run = module.AnalyzeRunRecord(
            run_id="run",
            user_id="owner",
            debate_session_id="session",
            ticker="AAPL",
            risk_profile="balanced",
            context=None,
            consent_token=f"consent_{uuid.uuid4().hex}",
        )
    return manager, run, calls, module


@pytest.mark.parametrize("importing", [False, True])
def test_first_terminal_is_delivered_once_and_end_cursor_is_not_delivery(monkeypatch, importing):
    manager, run, calls, _ = setup_run(monkeypatch, importing)

    async def scenario():
        await manager._append_frame(run, frame("complete" if importing else "decision"))
        await manager._append_frame(run, frame("error"))
        assert run.status == "completed" and len(run.events) == 1
        assert [
            f async for f in manager.stream_run_events(run=run, start_cursor=1, request=Request())
        ] == []
        assert not run.terminal_delivered and calls == []
        assert (
            len(
                [
                    f
                    async for f in manager.stream_run_events(
                        run=run, start_cursor=0, request=Request()
                    )
                ]
            )
            == 1
        )
        assert (
            len(
                [
                    f
                    async for f in manager.stream_run_events(
                        run=run, start_cursor=0, request=Request()
                    )
                ]
            )
            == 1
        )

    asyncio.run(scenario())
    assert run.terminal_delivered and calls == []


@pytest.mark.parametrize("importing", [False, True])
@pytest.mark.parametrize("outcome", ["error", "aborted", "missing", "crash", "unknown"])
def test_worker_terminal_outcome_without_an_attached_stream(monkeypatch, importing, outcome):
    manager, run, calls, _ = setup_run(monkeypatch, importing)

    async def generator(*args):
        if outcome == "crash":
            raise RuntimeError("private-provider-error")
        if outcome != "missing":
            yield frame(outcome)

    asyncio.run(manager._run_worker(run, generator))
    expected = "canceled" if outcome == "aborted" else "failed"
    assert run.status == expected and run.terminal_frame is not None
    assert calls == []


@pytest.mark.parametrize("importing", [False, True])
def test_completion_wins_over_cancel_intent_and_late_generator_error(monkeypatch, importing):
    manager, run, calls, _ = setup_run(monkeypatch, importing)
    run.cancel_event.set()
    context = ContextVar("worker_context")
    cleanup = []

    async def generator(*args):
        token = context.set("owner")
        try:
            yield frame("complete" if importing else "decision")
            raise RuntimeError("late-private-error")
        finally:
            context.reset(token)
            cleanup.append(True)

    asyncio.run(manager._run_worker(run, generator))
    assert run.status == "completed" and len(run.events) == 1 and calls == []
    assert cleanup == [True]


@pytest.mark.asyncio
async def test_feed_result_checks_run_owner_and_completed_state(monkeypatch):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock, Mock

    run = SimpleNamespace(user_id="owner", run_id="run-1", status="completed", ticker="AAPL")
    monkeypatch.setattr(stream._RUN_MANAGER, "get_run", AsyncMock(return_value=run))
    record = Mock()
    monkeypatch.setattr(stream, "FeedService", lambda: SimpleNamespace(record_event=record))

    def owner_token(*, user_id, token_data):
        assert token_data["user_id"] == user_id

    monkeypatch.setattr(stream, "_require_stream_owner_token", owner_token)
    with pytest.raises(HTTPException) as wrong_owner:
        await stream.analyze_run_feed_result("run-1", "other", {"user_id": "other"})
    assert wrong_owner.value.status_code == 404
    run.status = "failed"
    with pytest.raises(HTTPException) as failed:
        await stream.analyze_run_feed_result("run-1", "owner", {"user_id": "owner"})
    assert failed.value.status_code == 409
    record.assert_not_called()

    run.status = "completed"
    await stream.analyze_run_feed_result("run-1", "owner", {"user_id": "owner"})
    record.assert_called_once_with(
        user_id="owner",
        source_domain="kai",
        event_type="kai_analysis_saved",
        actor_label="Kai",
        metadata={"ticker": "AAPL", "run_id": "run-1"},
        source_row_id="run-1",
    )
