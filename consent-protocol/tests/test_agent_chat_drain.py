"""An agent-chat stream cut by server shutdown still ends with a terminal event.

Cloud Run sends SIGTERM on every deploy and scale-down. sse-starlette then
cancels open event streams, and before this guard the private agent's turn just
stopped mid-stream with no RUN_FINISHED or RUN_ERROR.
"""

from __future__ import annotations

import asyncio
import json
import threading

import pytest
from sse_starlette import sse
from starlette.applications import Starlette
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.routing import Route

from api.middlewares.agent_chat_drain import AgentChatDrainMiddleware

PATH = "/api/one/agent-chat"
RUN_STARTED = '{"type":"RUN_STARTED","threadId":"t","runId":"r"}'


@pytest.fixture(autouse=True)
def _fresh_shutdown_state(monkeypatch):
    # sse-starlette keeps its shutdown watcher per thread; give each test its own.
    monkeypatch.setattr(sse, "_thread_state", threading.local())
    monkeypatch.setattr(sse.AppStatus, "should_exit", False)


def _scope(path: str = PATH) -> dict:
    return {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "root_path": "",
        "headers": [(b"accept", b"text/event-stream")],
        "client": ("127.0.0.1", 1),
        "server": ("test", 80),
    }


def _stream_endpoint(started: asyncio.Event, *, terminal: str | None = None):
    async def events():
        yield sse.ServerSentEvent(data=RUN_STARTED, sep="\n")
        if terminal is not None:
            yield sse.ServerSentEvent(data=terminal, sep="\n")
        started.set()
        await asyncio.Event().wait()  # A model call still in flight.

    async def endpoint(_request: Request):
        return sse.EventSourceResponse(events())

    return endpoint


async def _serve_until_shutdown(app, started: asyncio.Event, *, path: str = PATH) -> list[dict]:
    sent: list[dict] = []
    connected = asyncio.Event()

    async def receive() -> dict:
        if not connected.is_set():
            connected.set()
            return {"type": "http.request", "body": b"{}", "more_body": False}
        await asyncio.Event().wait()  # The client stays connected.
        return {"type": "http.disconnect"}

    async def send(message: dict) -> None:
        sent.append(message)

    task = asyncio.create_task(app(_scope(path), receive, send))
    await asyncio.wait_for(started.wait(), 5)
    sse.AppStatus.should_exit = True  # What uvicorn's SIGTERM handler sets.
    await asyncio.wait_for(task, 5)
    return sent


def _events(sent: list[dict]) -> list[dict]:
    body = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
    return [
        json.loads(line[len("data: ") :])
        for line in body.decode().splitlines()
        if line.startswith("data: ")
    ]


def _closed(sent: list[dict]) -> bool:
    last = sent[-1]
    return last["type"] == "http.response.body" and not last.get("more_body", False)


def _app(started: asyncio.Event, *, base_http: bool = False, terminal: str | None = None):
    app = Starlette(
        routes=[Route(PATH, _stream_endpoint(started, terminal=terminal), methods=["POST"])]
    )
    if base_http:
        # server.py has BaseHTTPMiddleware layers; they close a cancelled stream cleanly.
        async def passthrough(request, call_next):
            return await call_next(request)

        app.add_middleware(BaseHTTPMiddleware, dispatch=passthrough)
    return app


@pytest.mark.parametrize("base_http", [False, True])
async def test_shutdown_mid_stream_ends_with_retryable_restart_error(base_http):
    started = asyncio.Event()

    sent = await _serve_until_shutdown(
        AgentChatDrainMiddleware(_app(started, base_http=base_http)), started
    )

    events = _events(sent)
    assert [event["type"] for event in events] == ["RUN_STARTED", "RUN_ERROR"]
    assert events[-1]["code"] == "SERVER_RESTARTING"
    assert events[-1]["metadata"] == {"retryable": True}
    assert _closed(sent)


@pytest.mark.parametrize("base_http", [False, True])
async def test_without_the_guard_shutdown_leaves_no_terminal_event(base_http):
    """Negative control: the defect this guard exists for."""
    started = asyncio.Event()

    sent = await _serve_until_shutdown(_app(started, base_http=base_http), started)

    assert [event["type"] for event in _events(sent)] == ["RUN_STARTED"]


async def test_a_turn_that_already_ended_gets_no_second_terminal_event():
    started = asyncio.Event()
    finished = '{"type":"RUN_FINISHED","threadId":"t","runId":"r"}'

    sent = await _serve_until_shutdown(
        AgentChatDrainMiddleware(_app(started, terminal=finished)), started
    )

    assert [event["type"] for event in _events(sent)] == ["RUN_STARTED", "RUN_FINISHED"]


async def test_a_client_disconnect_is_not_reported_as_a_restart():
    started = asyncio.Event()
    sent: list[dict] = []
    calls = 0

    async def receive() -> dict:
        nonlocal calls
        calls += 1
        if calls == 1:
            return {"type": "http.request", "body": b"{}", "more_body": False}
        await started.wait()
        return {"type": "http.disconnect"}

    async def send(message: dict) -> None:
        sent.append(message)

    await asyncio.wait_for(AgentChatDrainMiddleware(_app(started))(_scope(), receive, send), 5)

    assert [event["type"] for event in _events(sent)] == ["RUN_STARTED"]
