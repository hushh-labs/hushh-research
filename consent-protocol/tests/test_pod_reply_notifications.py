"""Durable metadata courier boundaries, using the real encrypted commit log."""

from __future__ import annotations

import asyncio
import hashlib
import time
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from api.routes.one import pod_reply_notifications as route
from hushh_mcp.services import pod_reply_notifications as courier
from hushh_mcp.services.pod_commit_log import LocalObjectStore, PodCommitLog, PodLogTampered


def _hold_owner(monkeypatch, origin="https://pod.example.com"):
    from hushh_mcp.services import pod_upgrade_admission

    monkeypatch.setattr(pod_upgrade_admission, "pod_incarnation", lambda: "current")
    trust = SimpleNamespace(version=1, binding={"pod_key_id": "key", "url": origin})
    authority = SimpleNamespace(
        pod_key_id="key",
        store=SimpleNamespace(subject=lambda _: SimpleNamespace(state="trusted", trust=trust)),
    )
    return SimpleNamespace(
        owner="owner",
        authority=authority,
        claims={"subject_id": "app", "version": 1, "exp": time.time() + 60},
        authorization="Bearer synthetic",
        require_access=AsyncMock(),
    )


async def test_hold_attachment_is_exclusive_before_slow_validation_and_rolls_back(monkeypatch):
    from hushh_mcp.one_adk import pod_chat_hold as holds

    owner = _hold_owner(monkeypatch)
    hold = holds._Hold(owner.owner, owner.authority, owner.claims, "current", time.monotonic() + 30)
    monkeypatch.setattr(holds, "_HOLDS", {"a" * 32: hold})
    with pytest.raises(HTTPException):
        await holds.serve_hold("unknown", owner)
    foreign = SimpleNamespace(**{**vars(owner), "owner": "other"})
    with pytest.raises(HTTPException):
        await holds.serve_hold("a" * 32, foreign)
    entered, release = asyncio.Event(), asyncio.Event()

    async def validate():
        entered.set()
        await release.wait()
        raise PermissionError("synthetic revocation")

    owner.require_access = validate
    first = asyncio.create_task(holds.serve_hold("a" * 32, owner))
    await entered.wait()
    with pytest.raises(HTTPException):
        await holds.serve_hold("a" * 32, owner)
    release.set()
    with pytest.raises(PermissionError):
        await first
    assert not hold.attached


@pytest.mark.parametrize("failure", ["expiry", "revocation", "incarnation", "finished"])
async def test_real_hold_stream_revalidates_authority_and_original_expiry(monkeypatch, failure):
    from hushh_mcp.one_adk import pod_chat_hold as holds

    owner = _hold_owner(monkeypatch)
    hold = holds._Hold(owner.owner, owner.authority, owner.claims, "current", time.monotonic() + 30)
    monkeypatch.setattr(holds, "_HOLDS", {"a" * 32: hold})
    response = await holds.serve_hold("a" * 32, owner)
    stream = response.body_iterator
    assert await anext(stream) == b"ready\n"
    if failure == "expiry":
        hold.deadline = time.monotonic() - 1
        with pytest.raises(TimeoutError):
            await anext(stream)
    elif failure == "revocation":
        owner.require_access = AsyncMock(side_effect=PermissionError("synthetic revocation"))
        with pytest.raises(PermissionError):
            await anext(stream)
    elif failure == "incarnation":
        hold.incarnation = "changed"
        with pytest.raises(RuntimeError):
            await anext(stream)
    else:
        hold.finished.set()
        assert await anext(stream) == b"finished\n"
        with pytest.raises(StopAsyncIteration):
            await anext(stream)
    assert not hold.attached


@pytest.mark.parametrize("loss", [False, True])
async def test_authenticated_hold_readiness_original_deadline_and_request_loss(monkeypatch, loss):
    from hushh_mcp.one_adk import pod_chat_hold as holds
    from hushh_mcp.services.chat_key import RequestChatKey, bind_request_chat_key

    owner = _hold_owner(monkeypatch)
    monkeypatch.setattr(holds, "_HOLDS", {})
    failed = asyncio.Event()
    trace = []

    class Response:
        def raise_for_status(self):
            pass

        async def aiter_lines(self):
            trace.append("ready")
            yield "ready"
            if loss:
                await failed.wait()
            else:
                await next(iter(holds._HOLDS.values())).finished.wait()
                yield "finished"

    class Client:
        def __init__(self, **kwargs):
            assert kwargs["follow_redirects"] is False

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            pass

        @asynccontextmanager
        async def stream(self, method, url, headers):
            assert method == "POST" and url.startswith(
                "https://pod.example.com/api/one/pod/agent-chat/holds/"
            )
            assert headers == {"Authorization": "Bearer synthetic"}
            yield Response()

    monkeypatch.setattr(holds.httpx, "AsyncClient", Client)
    key = RequestChatKey(b"k" * 32, max_seconds=10)
    key.bind_owner("owner")
    deadline = time.monotonic() + key.remaining_seconds
    with bind_request_chat_key(key):

        async def work():
            async with holds.retain_turn_request(owner):
                assert trace == ["ready"]
                assert next(iter(holds._HOLDS.values())).deadline <= deadline + 0.01
                trace.append("work")
                if loss:
                    failed.set()
                    await asyncio.Event().wait()

        if loss:
            with pytest.raises(RuntimeError, match="request lost"):
                await asyncio.wait_for(work(), 2)
        else:
            await work()
    assert not holds._HOLDS and not key.bound


@pytest.mark.parametrize(
    "origin",
    [
        "http://pod.example.com",
        "https://pod.example.com/path",
        "https://evil@pod.example.com",
        "https://pod.example.com?x=1",
    ],
)
async def test_hold_refuses_unqualified_destinations_before_network(monkeypatch, origin):
    from hushh_mcp.one_adk import pod_chat_hold as holds

    owner = _hold_owner(monkeypatch, origin)
    client = AsyncMock()
    monkeypatch.setattr(holds.httpx, "AsyncClient", client)
    with pytest.raises(RuntimeError):
        async with holds.retain_turn_request(owner):
            pytest.fail("unqualified origin admitted")
    client.assert_not_called()


@pytest.fixture
def log(tmp_path):
    return PodCommitLog(LocalObjectStore(str(tmp_path)), b"s" * 32, owner_id="ha1_owner")


class Hub:
    def __init__(self, settled=True):
        self.signals = []
        self.settled = settled

    def post(self, path, *, json):
        assert path == "/api/one/pod/reply-notifications"
        self.signals.append(json)
        return SimpleNamespace(status_code=200, json=lambda: {"settled": self.settled})


async def test_cold_recovery_and_retry_preserve_one_signal_and_no_answer_or_key(log):
    box = courier.PodReplyOutbox(log)
    await box.enqueue(conversation_id="conversation_1", run_id="run_1")
    await box.enqueue(conversation_id="conversation_1", run_id="run_1")
    hub = Hub()
    recovered = courier.PodReplyOutbox(log)
    assert await recovered.drain(client=hub) == {"outcome": "drained", "accepted": 1}
    assert await recovered.drain(client=hub) == {"outcome": "drained", "accepted": 0}
    assert len(hub.signals) == 1
    assert set(hub.signals[0]) == {
        "eventId",
        "conversationId",
        "runId",
        "createdAt",
        "expiresAt",
        "read",
    }
    raw, _ = await log._store.get_bounded_with_generation(
        key=courier.KEY,
        max_bytes=courier.MAX_BYTES,
    )
    assert b"conversation_1" not in raw


async def test_pending_retries_do_not_starve_later_signals(log, monkeypatch):
    now = int(time.time())
    monkeypatch.setattr(courier.time, "time", lambda: now)
    box = courier.PodReplyOutbox(log)
    for index in range(11):
        await box.enqueue(conversation_id=f"conversation_{index}", run_id="run_1")
    hub = Hub(settled=False)
    await box.drain(client=hub)
    assert len(hub.signals) == 10
    now += 60
    await courier.PodReplyOutbox(log).drain(client=hub)
    assert hub.signals[10]["conversationId"] == "conversation_10"


async def test_capacity_refuses_before_log_write_and_expired_cold_recovery_is_bounded(
    log, monkeypatch
):
    monkeypatch.setattr(courier, "MAX_ENTRIES", 2)
    now = int(time.time())
    monkeypatch.setattr(courier.time, "time", lambda: now)
    box = courier.PodReplyOutbox(log)
    for index in range(2):
        await box.enqueue(conversation_id=f"conversation_{index}", run_id="run")
    before = len(await log.replay())
    with pytest.raises(RuntimeError, match="capacity"):
        await box.enqueue(conversation_id="conversation_3", run_id="run")
    assert len(await log.replay()) == before
    now += courier.TTL_SECONDS + 1
    await box.enqueue(conversation_id="conversation_3", run_id="run")
    await log._store.delete(courier.KEY)
    hub = Hub()
    await courier.PodReplyOutbox(log).drain(client=hub)
    assert [signal["conversationId"] for signal in hub.signals] == ["conversation_3"]


async def test_invalid_sealed_receipt_and_standby_cannot_originate_delivery(log, monkeypatch):
    await log.append(courier.KIND, {"eventId": "wrong", "private": "do not send"})
    with pytest.raises(PodLogTampered):
        await courier.PodReplyOutbox(log).drain(client=Hub())
    monkeypatch.setattr(
        log, "read_role", AsyncMock(return_value=SimpleNamespace(is_standby=True)), raising=False
    )
    hub = Hub()
    assert (await courier.PodReplyOutbox(log).drain(client=hub))["outcome"] == "standby"
    assert hub.signals == []


@pytest.mark.parametrize("signed,standby", [(False, False), (True, True)])
def test_hub_rejects_unsigned_and_standby_completion(signed, standby, monkeypatch):
    monkeypatch.setattr(route, "personal_agent_enabled", lambda: True)
    monkeypatch.setattr(
        route,
        "verify_pod_request",
        AsyncMock(return_value=SimpleNamespace(signed=signed, standby=standby)),
    )
    app = FastAPI()
    app.include_router(route.router)
    now = int(time.time())
    response = TestClient(app).post(
        "/api/one/pod/reply-notifications",
        json={
            "eventId": "a" * 64,
            "conversationId": "conversation_1",
            "runId": "run",
            "createdAt": now,
            "expiresAt": now + 100,
        },
    )
    assert response.status_code == 401


@pytest.mark.parametrize(
    "target,key,serving",
    [
        ("managed", "key", "ha1_owner"),
        ("user_gcp", "other", "ha1_owner"),
        ("user_gcp", "key", "ha1_other"),
    ],
)
async def test_hub_refuses_non_owner_cloud_changed_key_or_inactive_pod(
    monkeypatch, target, key, serving
):
    from hushh_mcp.services import pod_access_audit

    monkeypatch.setattr(
        pod_access_audit, "resolve_serving_owner_hushh_id", AsyncMock(return_value=serving)
    )
    registry = SimpleNamespace(
        get_by_hushh_id=AsyncMock(
            return_value={
                "user_id": "owner",
                "pod_signing_key_id": key,
                "deployment_target": target,
            }
        )
    )
    with pytest.raises(HTTPException) as error:
        await route.resolve_owner(SimpleNamespace(hushh_id="ha1_owner", key_id="key"), registry)
    assert error.value.status_code == 403


def test_completion_contract_refuses_recipient_copy_and_invalid_ids():
    from pydantic import ValidationError

    now = int(time.time())
    base = {
        "eventId": hashlib.sha256(b"event").hexdigest(),
        "conversationId": "conversation_1",
        "runId": "run",
        "createdAt": now,
        "expiresAt": now + 100,
    }
    for extra in (
        {"recipient": "stranger"},
        {"body": "private answer"},
        {"conversationId": "../evil"},
        {"createdAt": True},
    ):
        with pytest.raises(ValidationError):
            route.ReplySignal(**{**base, **extra})
