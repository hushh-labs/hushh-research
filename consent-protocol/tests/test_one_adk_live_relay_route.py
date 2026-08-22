"""Drives the real `/live` WebSocket route handler end to end.

Every other test of this relay imports pure helper functions out of
adk_live.py -- none calls `one_adk_live_relay` itself. That leaves the pump
wiring, the exception-handling boundary between the two concurrent tasks,
directive issuance against a live queue, and session teardown structurally
untested: a bug in any of them could ship with the whole suite green.

This does not stand up a real ASGI server. `one_adk_live_relay` only ever
calls a small, fixed surface on its `websocket` argument
(`accept`/`receive_text`/`send_text`/`close`/`query_params`) and on the
runner `build_one_live_runner` returns, so a minimal fake for each -- the
same style `_BootstrapSocket`/`_CloseSocket` already use in
test_one_adk_live_protocol.py, just enough wider to drive the whole
function -- reaches the real code with far less machinery than a live
websocket server would need, and without leaving a stray process behind.
"""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import WebSocketDisconnect

from api.routes.one import adk_live


class _FakeQueryParams(dict):
    def get(self, key, default=None):  # noqa: D102 - dict.get is enough
        return super().get(key, default)


class _FakeRelayWebSocket:
    """Feeds `inbound` to receive_text() one frame at a time, then raises
    WebSocketDisconnect -- the same shape a browser tab closing produces."""

    def __init__(self, inbound: list[dict], *, relay_ticket: str = "ticket_1"):
        self.query_params = _FakeQueryParams(relay_ticket=relay_ticket)
        self._inbound = [json.dumps(frame) for frame in inbound]
        self._pos = 0
        self.sent: list[dict] = []
        self.close_calls: list[tuple[int, str]] = []
        self.accepted = False

    async def accept(self) -> None:
        self.accepted = True

    async def receive_text(self) -> str:
        if self._pos >= len(self._inbound):
            raise WebSocketDisconnect(code=1000)
        raw = self._inbound[self._pos]
        self._pos += 1
        return raw

    async def send_text(self, raw: str) -> None:
        self.sent.append(json.loads(raw))

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.close_calls.append((code, reason))


def _fake_session():
    return SimpleNamespace(id="session_1", state={})


class _FakeSessionService:
    def __init__(self):
        self.create_session = AsyncMock(return_value=_fake_session())
        self.append_event = AsyncMock(return_value=None)
        self.delete_session = AsyncMock(return_value=None)


class _FakeRunner:
    """`run_live` yields one turn, then idles until cancelled -- a real
    provider stream does not end on its own either; only the socket closing
    (here: the browser running out of queued frames) ends the session."""

    def __init__(self, events: list[SimpleNamespace]):
        self.session_service = _FakeSessionService()
        self._events = events

    async def run_live(self, **_kwargs):
        for event in self._events:
            yield event
        try:
            await asyncio.sleep(3600)
        except asyncio.CancelledError:
            return
        # Unreachable except in the (test-only) case the sleep above is
        # somehow skipped; keeps this a well-formed async generator either
        # way.
        if False:  # pragma: no cover
            yield SimpleNamespace()


def _turn_complete_event() -> SimpleNamespace:
    # getattr(event, "x", default) is how every field is read in adk_live.py,
    # so a plain namespace only needs the attributes actually exercised --
    # nothing else needs to exist for those reads to fall through to their
    # documented defaults.
    return SimpleNamespace(
        turn_complete=True,
        interrupted=False,
        input_transcription=None,
        output_transcription=None,
        content=None,
        actions=None,
        go_away=None,
        live_session_resumption_update=None,
    )


@pytest.fixture(autouse=True)
def _relay_dependencies(monkeypatch):
    monkeypatch.setattr(adk_live, "one_voice_enabled", lambda: True)
    monkeypatch.setattr(
        adk_live,
        "consume_relay_ticket_shared",
        AsyncMock(return_value=(True, "user_1", "signed_unlocked")),
    )


@pytest.mark.asyncio
async def test_full_session_reaches_setup_complete_and_tears_down_on_disconnect(
    monkeypatch, caplog
):
    runner = _FakeRunner([_turn_complete_event()])
    monkeypatch.setattr(adk_live, "build_one_live_runner", lambda **_kw: runner)

    socket = _FakeRelayWebSocket(
        inbound=[
            {
                "type": "runtime_bootstrap",
                "runtime_credential_mode": "hushh_managed_vertex",
            },
            {"type": "app_context", "appContext": {"screen": "one_home"}},
        ],
    )

    with caplog.at_level("INFO", logger="api.routes.one.adk_live"):
        await adk_live.one_adk_live_relay(socket)  # type: ignore[arg-type]

    assert socket.accepted is True
    # The real point of this test: the route was driven start to finish
    # through actual code, not a helper called in isolation, and it reached
    # the point of announcing readiness to the browser.
    assert {"setupComplete": {}} in socket.sent
    assert runner.session_service.create_session.await_count == 1
    assert runner.session_service.delete_session.await_count == 1

    summary_lines = [
        record for record in caplog.records if record.getMessage().startswith(
            "one_adk_live_session_summary"
        )
    ]
    assert len(summary_lines) == 1
    summary = summary_lines[0].getMessage()
    assert "close_reason=client_disconnect" in summary
    assert "turn_count=1" in summary
    assert "pump_error_count=0" in summary


@pytest.mark.asyncio
async def test_rejects_a_bad_ticket_before_ever_touching_the_runner(monkeypatch):
    monkeypatch.setattr(
        adk_live,
        "consume_relay_ticket_shared",
        AsyncMock(return_value=(False, None, None)),
    )
    runner_factory = AsyncMock()
    monkeypatch.setattr(adk_live, "build_one_live_runner", runner_factory)

    socket = _FakeRelayWebSocket(inbound=[], relay_ticket="expired")

    await adk_live.one_adk_live_relay(socket)  # type: ignore[arg-type]

    assert socket.close_calls == [(1008, "Voice relay ticket is expired.")]
    runner_factory.assert_not_called()


class _BrowserPumpExplodesSocket(_FakeRelayWebSocket):
    """`receive_text()` raises something other than WebSocketDisconnect once
    the queued frames run out, standing in for a bug in the browser-message
    pump itself -- pump_browser_to_queue has no try/except of its own, so
    this reaches the OUTER catch-all in one_adk_live_relay, not the inner one
    _pump_live_events already had (and already had its own test coverage
    for)."""

    async def receive_text(self) -> str:
        if self._pos >= len(self._inbound):
            raise KeyError("browser_frame_missing_field")
        return await super().receive_text()


@pytest.mark.asyncio
async def test_a_browser_pump_failure_is_classified_and_told_to_the_browser(
    monkeypatch, caplog
):
    # A long-lived, uneventful run_live: this test's failure comes from the
    # OTHER concurrent task (pump_browser_to_queue), so run_live must still
    # be alive to be cancelled when that failure ends the session -- it must
    # not be the thing that ends it.
    runner = _FakeRunner([_turn_complete_event()])
    monkeypatch.setattr(adk_live, "build_one_live_runner", lambda **_kw: runner)

    socket = _BrowserPumpExplodesSocket(
        inbound=[
            {
                "type": "runtime_bootstrap",
                "runtime_credential_mode": "hushh_managed_vertex",
            },
            {"type": "app_context", "appContext": {"screen": "one_home"}},
        ],
    )

    with caplog.at_level("WARNING", logger="api.routes.one.adk_live"):
        await adk_live.one_adk_live_relay(socket)  # type: ignore[arg-type]

    ended = [frame for frame in socket.sent if "sessionEnded" in frame]
    assert len(ended) == 1
    # KeyError is one of classify_provider_error's own CANDIDATE_MISCONFIGURED
    # signatures ("ours to fix") -- not a provider outage, so not resumable.
    assert ended[0]["sessionEnded"]["reason"] == "runtime_error"
    assert ended[0]["sessionEnded"]["resumable"] is False
    assert any(
        "one_adk_live_relay_pump_failed" in record.getMessage()
        and "classification=candidate_misconfigured" in record.getMessage()
        for record in caplog.records
    )
