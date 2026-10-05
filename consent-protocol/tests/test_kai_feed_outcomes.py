"""Feed must reflect one canonical outcome, without implying saved information."""

import asyncio
import json
import threading
import uuid
from contextvars import ContextVar

import pytest

from api.routes.kai import import_run_manager, run_manager


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

    monkeypatch.setattr(module, "FeedService", Feed)
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
    assert len(calls) == 1
    assert calls[0]["event_type"] == (
        "kai_import_completed" if importing else "kai_analysis_completed"
    )
    assert calls[0]["user_id"] == "owner" and calls[0]["source_row_id"] == "run"
    assert "private" not in json.dumps(calls)


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
    assert len(calls) == 1
    assert calls[0]["event_type"] == f"kai_{'import' if importing else 'analysis'}_{expected}"
    assert "private" not in json.dumps(calls)


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


@pytest.mark.parametrize("importing", [False, True])
def test_feed_constructor_failure_does_not_abort_worker_cleanup(monkeypatch, importing):
    manager, run, _, module = setup_run(monkeypatch, importing)

    class BrokenFeed:
        def __init__(self):
            raise RuntimeError("feed down")

    monkeypatch.setattr(module, "FeedService", BrokenFeed)
    if importing:
        manager._active_by_user[run.user_id] = run.run_id
    else:
        manager._active_by_session[(run.user_id, run.debate_session_id)] = run.run_id

    async def generator(*args):
        yield frame("error")

    asyncio.run(manager._run_worker(run, generator))
    assert run.status == "failed" and run.completed_at is not None
    assert not (manager._active_by_user if importing else manager._active_by_session)


@pytest.mark.parametrize("importing", [False, True])
def test_slow_feed_runs_after_authoritative_terminal_receipt(monkeypatch, importing):
    manager, run, _, module = setup_run(monkeypatch, importing)
    release = threading.Event()
    entered = threading.Event()
    receipts = []

    class SlowFeed:
        def record_event(self, **kwargs):
            entered.set()
            release.wait(timeout=5)

    class Store:
        async def persist_terminal(self, **kwargs):
            receipts.append(kwargs)

        async def get(self, **kwargs):
            return None

    async def noop(*args, **kwargs):
        return None

    monkeypatch.setattr(module, "FeedService", SlowFeed)
    monkeypatch.setattr(module.run_store, "owner_heartbeat", noop)
    monkeypatch.setattr(module.run_store, "serve_relay", noop)
    manager._store = Store()
    if importing:
        manager._active_by_user[run.user_id] = run.run_id
    else:
        manager._active_by_session[(run.user_id, run.debate_session_id)] = run.run_id

    async def generator(*args):
        yield frame("error")

    async def scenario():
        worker = asyncio.create_task(manager._run_worker(run, generator))
        try:
            assert await asyncio.to_thread(entered.wait, 3)
            assert receipts[0]["status"] == "failed"
            assert not (manager._active_by_user if importing else manager._active_by_session)
        finally:
            release.set()
            await worker

    asyncio.run(scenario())
