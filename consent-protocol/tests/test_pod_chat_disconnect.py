"""Installed SDK persistence through a real suspended ASGI send/disconnect."""

import asyncio

import pytest

from tests.test_agui_turn_timing import (
    CHAT_KEY,
    DETACHED_ANSWER,
    THREAD_ID,
    USER_ID,
    _owner_input,
    _slow_answer_agent,
    _stored_texts,
    agui_turn_timing,
)


def _retained_agent(monkeypatch):
    from contextlib import asynccontextmanager, nullcontext
    from unittest.mock import AsyncMock

    from google.adk.sessions import InMemorySessionService

    from hushh_mcp.one_adk import pod_agui_lifetime as pod
    from hushh_mcp.one_adk.agui_factory import build_authenticated_agui
    from hushh_mcp.services.chat_key import (
        RequestChatKey,
        request_has_chat_key,
    )
    from hushh_mcp.services.pod_upgrade_admission import PodUpgradeAdmission

    monkeypatch.setattr(agui_turn_timing, "supersede_unanswered_reviews", AsyncMock())
    admission = PodUpgradeAdmission(log_resolver=lambda: None)
    monkeypatch.setattr(pod, "ADMISSION", admission)
    monkeypatch.setattr(pod, "pod_incarnation", lambda: "test-pod")
    store = InMemorySessionService()
    saved = asyncio.Event()
    notified = []
    held = []

    @asynccontextmanager
    async def hold():
        held.append(True)
        try:
            yield
        finally:
            held.pop()

    async def after_run(input):
        assert request_has_chat_key(USER_ID)
        assert DETACHED_ANSWER in await _stored_texts(store)
        saved.set()

    async def completed(input):
        assert held and saved.is_set() and request_has_chat_key(USER_ID)
        notified.append(input.thread_id)

    agent = build_authenticated_agui(
        _slow_answer_agent(0.15),
        store,
        app_name="one_detach_probe",
        user_id_extractor=lambda _: USER_ID,
        agent_class=pod.PodTimedADKAgent,
    )
    agent.configure_pod_turn(
        require_access=AsyncMock(),
        runtime_scope=nullcontext,
        after_run=after_run,
        detached_completion=completed,
        request_lifetime=hold,
        mcp_owner_admission=AsyncMock(return_value=True),
    )
    holder = RequestChatKey(CHAT_KEY)
    holder.bind_owner(USER_ID)
    return agent, holder, saved, notified, held, admission


@pytest.mark.asyncio
@pytest.mark.parametrize("leave", [False, True])
async def test_pod_retained_pump_saves_after_asgi_disconnect_without_duplicate_notice(
    monkeypatch, leave
):
    """Real installed SDK and SSE disconnect; no provider or cloud credentials."""
    from contextlib import aclosing

    from api.routes.one.pod_agent_chat import PodChatResponse
    from hushh_mcp.services.chat_key import bind_request_chat_key

    agent, holder, saved, notified, held, admission = _retained_agent(monkeypatch)
    disconnected = asyncio.Event()
    first_request = True

    async def receive():
        nonlocal first_request
        if first_request:
            first_request = False
            return {"type": "http.request", "body": b"", "more_body": False}
        await disconnected.wait()
        return {"type": "http.disconnect"}

    async def send(message):
        if leave and b"RUN_STARTED" in message.get("body", b""):
            disconnected.set()
            # A broken connection can leave ASGI suspended in send, outside
            # the iterator. Its response must close the iterator explicitly.
            await asyncio.Event().wait()

    async def events():
        async with aclosing(agent.run(_owner_input())) as stream:
            async for event in stream:
                yield {"data": event.model_dump_json()}

    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "method": "POST",
        "path": "/",
        "headers": [],
        "http_version": "1.1",
    }
    with bind_request_chat_key(holder):
        await asyncio.wait_for(PodChatResponse(events())(scope, receive, send), 10)
    assert disconnected.is_set() is leave
    await asyncio.wait_for(saved.wait(), 3)
    for _ in range(100):
        if not held:
            break
        await asyncio.sleep(0.01)
    assert notified == ([THREAD_ID] if leave else [])
    assert not held and not holder.bound
    assert (await admission.status(incarnation="test-pod"))["activeWork"] == 0
