"""Document-feed stream protocol: v2 typed frames, v1 long-poll, admission caps, entry points."""

import asyncio
import json
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from api import consent_listener
from api.routes import document_feed_stream as stream
from api.routes import sse as sse_routes
from api.routes.document_feed_stream import (
    PayoutChangeCoalescer,
    StreamAdmission,
    StreamTiming,
    document_feed_event_generator,
    doorbell_kinds,
    negotiate_version,
    open_document_feed_stream,
    stream_lifetime_seconds,
    web_stream_enabled,
)
from api.routes.one import feed_events
from hushh_mcp.services.payout_doorbell import PAYOUT_KINDS

REQUEST = "11111111-2222-4333-8444-555555555555"
OTHER_REQUEST = "22222222-3333-4444-8555-666666666666"
EVENT = "33333333-4444-4555-8666-777777777777"
RESET = {"event": "feed_reset", "data": "{}"}
# Real protocol ratios, scaled down so the suite runs in well under a second per case.
FAST = StreamTiming(
    heartbeat_seconds=5.0,
    v1_heartbeat_seconds=5.0,
    coalesce_debounce_seconds=0.05,
    coalesce_max_wait_seconds=0.2,
    v1_close_after_frame_seconds=0.05,
)
CONNECTED = SimpleNamespace(is_disconnected=lambda: asyncio.sleep(0, result=False))


@pytest.fixture
def owner_queue(monkeypatch):
    queue: asyncio.Queue = asyncio.Queue()
    calls: list[tuple[str, str]] = []

    async def subscribe(user_id, *, snapshot_resets=False):
        # Feed streams understand whole-snapshot resets on queue overflow.
        assert snapshot_resets
        calls.append(("subscribe", user_id))
        return queue

    async def unsubscribe(user_id, _queue):
        calls.append(("unsubscribe", user_id))

    monkeypatch.setattr(consent_listener, "subscribe_consent_queue", subscribe)
    monkeypatch.setattr(consent_listener, "unsubscribe_consent_queue", unsubscribe)
    return SimpleNamespace(queue=queue, calls=calls)


def _doorbell(kinds=None, request_id=None):
    body = {"type": "bank_payout_changed", "user_id": "owner"}
    if kinds is not None:
        body["kinds"] = kinds
    if request_id is not None:
        body["request_id"] = request_id
    return body


async def _next(frames, timeout=1.0):
    return await asyncio.wait_for(anext(frames), timeout=timeout)


async def _rest(frames, timeout=2.0):
    async def collect():
        return [frame async for frame in frames]

    return await asyncio.wait_for(collect(), timeout=timeout)


def _payload(frame):
    return json.loads(frame["data"])


# --- negotiation and lifetime -------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "version"),
    [(None, 1), ("", 1), ("1", 1), ("2", 2), ("3", 2), ("x", 1), ("²", 1), ("-2", 1)],
)
def test_only_an_explicit_v2_opts_into_typed_frames(raw, version):
    assert negotiate_version(raw) == version


def test_lifetimes_stay_inside_the_contract():
    v2 = [stream_lifetime_seconds(2) for _ in range(300)]
    v1 = [stream_lifetime_seconds(1) for _ in range(300)]
    proxied = [stream_lifetime_seconds(version, proxied=True) for version in (1, 2) * 150]
    # 840 s +/- 60 s, strictly below the iOS stream plugin's 900 s resource timeout.
    assert all(780 <= value < 900 for value in v2)
    assert max(v2) - min(v2) > 30
    assert all(110 <= value <= 120 for value in v1)
    # Through the Next proxy: closed by the server before the web server's
    # 120 s production request timeout, so the stream rotates cleanly.
    assert all(90 <= value <= 110 for value in proxied)
    assert max(proxied) - min(proxied) > 5


# --- coalescing (pure, explicit clock) ----------------------------------------


def test_coalescer_waits_for_quiet_but_never_past_the_max_wait():
    batch = PayoutChangeCoalescer(debounce_seconds=0.5, max_wait_seconds=2.0)
    assert batch.due_at() is None
    batch.add(frozenset({"wallet"}), None, 10.0)
    assert batch.due_at() == 10.5
    batch.add(frozenset({"earnings"}), REQUEST, 10.4)
    assert batch.due_at() == pytest.approx(10.9)
    # A doorbell every 400 ms never goes quiet; the first doorbell caps the wait.
    for at in (10.8, 11.2, 11.6, 11.9):
        batch.add(frozenset({"wallet"}), REQUEST, at)
    assert batch.due_at() == 12.0
    assert batch.take() == (["wallet", "earnings"], [REQUEST])
    assert batch.due_at() is None


def test_coalescer_bounds_request_ids_and_widens_unknown_kinds():
    batch = PayoutChangeCoalescer(debounce_seconds=0.5, max_wait_seconds=2.0)
    ids = [str(uuid4()) for _ in range(20)]
    for at, request_id in enumerate(ids):
        batch.add(frozenset({"earnings"}), request_id, at / 100)
    assert batch.take() == (["earnings"], ids)
    for at, request_id in enumerate([*ids, str(uuid4())]):
        batch.add(frozenset({"earnings"}), request_id, at / 100)
    # More than 20 requests is "not request-specific", never a silent truncation.
    assert batch.take() == (["earnings"], [])
    batch.add(None, None, 0.0)
    assert batch.take() == (list(PAYOUT_KINDS), [])


@pytest.mark.parametrize(
    ("raw", "kinds"),
    [
        (None, None),
        ([], None),
        ("wallet", None),
        (["wallet", "brand_new_kind"], None),
        (["wallet", 7], None),
        (["bank_payouts", "wallet", "wallet"], frozenset({"bank_payouts", "wallet"})),
    ],
)
def test_missing_or_unknown_doorbell_kinds_mean_every_kind(raw, kinds):
    assert doorbell_kinds(raw) == kinds


# --- v2 frames ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_v2_says_hello_then_one_typed_payout_frame_per_burst(owner_queue):
    frames = document_feed_event_generator(
        "owner", CONNECTED, version=2, lifetime_seconds=30, timing=FAST
    )
    hello = await _next(frames)
    assert hello["event"] == "hello"
    assert _payload(hello) == {
        "v": 2,
        "heartbeat_ms": 5000,
        "max_lifetime_ms": 30000,
        "live": False,
    }
    assert await _next(frames) == RESET

    owner_queue.queue.put_nowait(_doorbell(["wallet"]))
    owner_queue.queue.put_nowait(_doorbell(["earnings", "wallet"], REQUEST))
    owner_queue.queue.put_nowait(_doorbell(["bank_payouts"], REQUEST.upper()))
    owner_queue.queue.put_nowait({"type": "location_settings_changed", "setting": "x"})
    payout = await _next(frames)
    assert payout == {
        "event": "payout_changed",
        "data": json.dumps(
            {"kinds": ["wallet", "earnings", "bank_payouts"], "request_ids": [REQUEST]},
            separators=(",", ":"),
        ),
    }

    # A legacy doorbell (no kinds) and an unknown kind both mean every kind.
    owner_queue.queue.put_nowait(_doorbell())
    assert _payload(await _next(frames)) == {"kinds": list(PAYOUT_KINDS), "request_ids": []}
    owner_queue.queue.put_nowait(_doorbell(["wallet", "brand_new_kind"]))
    assert _payload(await _next(frames))["kinds"] == list(PAYOUT_KINDS)

    # Drive doorbells stay opaque and immediate.
    owner_queue.queue.put_nowait(
        {
            "type": "document_share_feed_changed",
            "event_id": EVENT,
            "request_id": REQUEST,
            "file_name": "private.pdf",
        }
    )
    assert await _next(frames) == {
        "event": "feed_changed",
        "id": EVENT,
        "data": json.dumps({"request_id": REQUEST}),
    }
    await frames.aclose()
    assert owner_queue.calls == [("subscribe", "owner"), ("unsubscribe", "owner")]


@pytest.mark.asyncio
async def test_v2_payout_max_wait_applies_while_doorbells_remain_queued(owner_queue):
    # Exact debounce/cap arithmetic is proved above with an explicit clock.
    # Here, prove the generator actually applies that cap without relying on
    # a producer being scheduled every 30 ms on a shared developer machine.
    timing = StreamTiming(coalesce_debounce_seconds=30, coalesce_max_wait_seconds=0)
    frames = document_feed_event_generator(
        "owner", CONNECTED, version=2, lifetime_seconds=30, timing=timing
    )
    await _next(frames)
    await _next(frames)
    for _ in range(3):
        owner_queue.queue.put_nowait(_doorbell(["wallet"]))
    assert (await _next(frames))["event"] == "payout_changed"
    assert owner_queue.queue.qsize() == 2
    await frames.aclose()


@pytest.mark.asyncio
async def test_v2_heartbeat_is_time_based_and_carries_listener_health(owner_queue, monkeypatch):
    monkeypatch.setattr(consent_listener, "_listener_active", True)
    timing = StreamTiming(
        heartbeat_seconds=0.1,
        coalesce_debounce_seconds=0.05,
        coalesce_max_wait_seconds=0.2,
    )
    frames = document_feed_event_generator(
        "owner", CONNECTED, version=2, lifetime_seconds=30, timing=timing
    )
    assert _payload(await _next(frames))["live"] is True
    await _next(frames)

    async def chatter():
        # Unrelated doorbells keep the queue busy; an idle-based heartbeat would starve.
        for _ in range(20):
            owner_queue.queue.put_nowait({"type": "direct_message", "message_id": str(uuid4())})
            await asyncio.sleep(0.02)

    talker = asyncio.create_task(chatter())
    heartbeat = await _next(frames, timeout=0.5)
    assert heartbeat["event"] == "heartbeat"
    assert _payload(heartbeat)["live"] is True
    assert isinstance(_payload(heartbeat)["ts"], int)
    monkeypatch.setattr(consent_listener, "_listener_active", False)
    assert _payload(await _next(frames, timeout=0.5)) == {
        "ts": pytest.approx(_payload(heartbeat)["ts"], abs=1000),
        "live": False,
    }
    await talker
    await frames.aclose()


@pytest.mark.asyncio
async def test_v2_ends_with_a_reconnect_hint_at_its_lifetime(owner_queue):
    frames = document_feed_event_generator(
        "owner", CONNECTED, version=2, lifetime_seconds=0.15, timing=FAST
    )
    events = await _rest(frames)
    assert [event["event"] for event in events] == ["hello", "feed_reset", "reconnect"]
    assert 0 <= _payload(events[-1])["after_ms"] <= 2000
    assert owner_queue.calls[-1] == ("unsubscribe", "owner")


@pytest.mark.asyncio
@pytest.mark.parametrize("reason", [None, "history_mutated", "private headline"])
async def test_general_feed_writes_ring_a_content_free_feed_changed(owner_queue, reason):
    frames = document_feed_event_generator(
        "owner", CONNECTED, version=2, lifetime_seconds=30, timing=FAST
    )
    await _next(frames)
    await _next(frames)
    owner_queue.queue.put_nowait(
        {"type": "feed_changed", "user_id": "owner", "title": "private headline", "reason": reason}
    )
    event = await _next(frames)
    assert event["event"] == "feed_changed"
    assert _payload(event) == ({"reason": "history_mutated"} if reason == "history_mutated" else {})
    await frames.aclose()


# --- v1 protection for installed builds ------------------------------------------


@pytest.mark.asyncio
async def test_v1_long_poll_closes_soon_after_its_first_change(owner_queue):
    loop = asyncio.get_running_loop()
    frames = document_feed_event_generator("owner", CONNECTED, timing=FAST)
    assert await _next(frames) == RESET
    changed = {"type": "document_share_feed_changed", "event_id": EVENT, "request_id": REQUEST}
    owner_queue.queue.put_nowait(changed)
    owner_queue.queue.put_nowait({**changed, "request_id": OTHER_REQUEST})
    started = loop.time()
    events = await _rest(frames)
    # Changes that arrive inside the short window ride along; then the body ends.
    assert [_payload(event)["request_id"] for event in events] == [REQUEST, OTHER_REQUEST]
    assert loop.time() - started < FAST.v1_close_after_frame_seconds + 0.15
    assert owner_queue.calls[-1] == ("unsubscribe", "owner")


@pytest.mark.asyncio
async def test_v1_long_poll_is_not_cut_short_by_general_feed_hints(owner_queue):
    # Installed builds cannot read a general hint, so it must not cost them a
    # reconnect (and the full reread that follows); their lifetime still applies.
    frames = document_feed_event_generator("owner", CONNECTED, lifetime_seconds=0.3, timing=FAST)
    assert await _next(frames) == RESET
    owner_queue.queue.put_nowait({"type": "feed_changed", "user_id": "owner"})
    assert await _next(frames) == {"event": "feed_changed", "data": "{}"}
    started = asyncio.get_running_loop().time()
    assert await _rest(frames) == []
    assert asyncio.get_running_loop().time() - started > FAST.v1_close_after_frame_seconds + 0.05


@pytest.mark.asyncio
async def test_v1_lifetime_is_capped_without_new_frame_types(owner_queue):
    frames = document_feed_event_generator("owner", CONNECTED, lifetime_seconds=0.1, timing=FAST)
    assert await _rest(frames) == [RESET]


# --- LISTEN recovery ----------------------------------------------------------------


@pytest.mark.asyncio
async def test_listener_recovery_resyncs_every_local_stream():
    consent_listener._consent_notify_queues.clear()
    typed = document_feed_event_generator(
        "owner", CONNECTED, version=2, lifetime_seconds=30, timing=FAST
    )
    legacy = document_feed_event_generator("other", CONNECTED, timing=FAST)
    await _next(typed)
    assert await _next(typed) == RESET
    assert await _next(legacy) == RESET

    assert await consent_listener.broadcast_local_resync() == 2
    assert await _next(typed) == RESET
    assert await _rest(legacy) == [RESET]
    await typed.aclose()
    assert consent_listener._consent_notify_queues == {}


# --- admission ------------------------------------------------------------------------


def test_each_owner_keeps_at_most_three_streams_and_the_oldest_yields():
    admission = StreamAdmission()
    oldest, *_ = [admission.admit("owner", 1, 120) for _ in range(3)]
    assert oldest is not None
    oldest.queue = asyncio.Queue(maxsize=1)
    oldest.queue.put_nowait({"type": "bank_payout_changed"})

    newest = admission.admit("owner", 2, 840)
    assert newest is not None
    assert oldest.evicted and oldest not in admission.active()
    assert oldest.queue.get_nowait() == {"type": stream.EVICT_EVENT_TYPE}
    assert [lease.user_id for lease in admission.active()] == ["owner"] * 3


def test_a_full_worker_refuses_new_streams_with_retry_after():
    admission = StreamAdmission()
    for index in range(3):
        assert admission.admit(f"user-{index}", 2, 840) is not None
    owner = [admission.admit("owner", 1, 120) for _ in range(3)]
    assert len(admission.active()) == 6

    with pytest.raises(HTTPException) as exc:
        open_document_feed_stream("newcomer", CONNECTED, version=2, admission=admission)
    assert exc.value.status_code == 503
    assert exc.value.headers["Retry-After"] == "60"
    assert exc.value.detail["code"] == "FEED_STREAM_BUSY"
    with pytest.raises(HTTPException):
        open_document_feed_stream("newcomer", CONNECTED, version=1, admission=admission)

    # An owner at their own cap replaces their oldest stream even on a full worker.
    response = open_document_feed_stream("owner", CONNECTED, version=2, admission=admission)
    assert owner[0] is not None and owner[0].evicted
    assert len(admission.active()) == 6
    owner[1].release()
    assert len(admission.active()) == 5
    owner[1].release()
    assert len(admission.active()) == 5
    assert response.headers["cache-control"] == "no-cache, no-store"


def test_a_lease_whose_response_never_ran_expires():
    now = [0.0]
    admission = StreamAdmission(per_worker=1, clock=lambda: now[0])
    assert admission.admit("orphan", 1, 120) is not None
    assert admission.admit("owner", 2, 840) is None
    now[0] = 120 + stream.LEASE_GRACE_SECONDS
    assert admission.admit("owner", 2, 840) is not None


@pytest.mark.asyncio
async def test_an_evicted_stream_closes_without_a_reconnect_hint(owner_queue):
    admission = StreamAdmission()
    lease = admission.admit("owner", 2, 30)
    frames = document_feed_event_generator("owner", CONNECTED, version=2, lease=lease, timing=FAST)
    await _next(frames)
    await _next(frames)
    for _ in range(3):
        admission.admit("owner", 2, 30)
    assert await _rest(frames) == []
    assert lease not in admission.active()


@pytest.mark.asyncio
async def test_the_response_releases_its_slot_however_it_ends(owner_queue):
    admission = StreamAdmission()

    async def receive():
        return {"type": "http.disconnect"}

    async def send(_message):
        return None

    response = open_document_feed_stream("owner", CONNECTED, version=2, admission=admission)
    await asyncio.wait_for(response({"type": "http"}, receive, send), timeout=2)
    assert admission.active() == []

    # The client is gone before the headers: the generator never starts, so
    # only the response itself can free the slot.
    async def send_fails(_message):
        raise OSError("client went away")

    owner_queue.calls.clear()
    response = open_document_feed_stream("owner", CONNECTED, version=2, admission=admission)
    with pytest.raises((OSError, BaseExceptionGroup)):
        await asyncio.wait_for(response({"type": "http"}, receive, send_fails), timeout=2)
    assert owner_queue.calls == []
    assert admission.active() == []


@pytest.mark.asyncio
async def test_document_feed_route_negotiates_version_and_proxied_lifetime(monkeypatch):
    admission = StreamAdmission()
    monkeypatch.setattr(stream, "_ADMISSION", admission)
    monkeypatch.setattr(sse_routes, "verify_firebase_bearer", lambda _authorization: "owner")
    cases = (
        (None, None, 1, (110, 120)),
        ("2", None, 2, (780, 900)),
        # The Next proxy's fixed marker shortens the life of both versions.
        ("2", stream.STREAM_PROXY_VALUE, 2, (90, 110)),
        (None, stream.STREAM_PROXY_VALUE, 1, (90, 110)),
        # Anything else is a direct stream.
        ("2", "next-proxy-ish", 2, (780, 900)),
    )
    for raw, via, version, (low, high) in cases:
        response = await sse_routes.document_feed_events(
            "owner", CONNECTED, v=raw, authorization="Bearer token", stream_via=via
        )
        lease = admission.active()[-1]
        assert lease.version == version
        assert low <= lease.lifetime_seconds <= high
        await response.body_iterator.aclose()
        lease.release()


# --- web entry point -----------------------------------------------------------------


def _web_client():
    app = FastAPI()
    app.include_router(feed_events.router)
    return TestClient(app)


def test_web_stream_defaults_off_only_in_production(monkeypatch):
    monkeypatch.delenv("DOCUMENT_FEED_WEB_STREAM_ENABLED", raising=False)
    monkeypatch.setenv("ENVIRONMENT", "production")
    assert web_stream_enabled() is False
    monkeypatch.setenv("ENVIRONMENT", "uat")
    assert web_stream_enabled() is True
    monkeypatch.setenv("DOCUMENT_FEED_WEB_STREAM_ENABLED", "true")
    monkeypatch.setenv("ENVIRONMENT", "production")
    assert web_stream_enabled() is True
    monkeypatch.setenv("DOCUMENT_FEED_WEB_STREAM_ENABLED", "false")
    monkeypatch.setenv("ENVIRONMENT", "uat")
    assert web_stream_enabled() is False


def test_disabled_web_stream_is_404_before_any_token_check(monkeypatch):
    monkeypatch.setenv("DOCUMENT_FEED_WEB_STREAM_ENABLED", "false")

    async def must_not_verify(_authorization):
        raise AssertionError("a disabled endpoint must not verify tokens")

    monkeypatch.setattr(feed_events, "require_firebase_auth_read_only", must_not_verify)
    response = _web_client().get("/api/one/feed/events?v=2")
    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "FEED_STREAM_DISABLED"


def test_enabled_web_stream_requires_a_firebase_token(monkeypatch):
    monkeypatch.setenv("DOCUMENT_FEED_WEB_STREAM_ENABLED", "true")
    assert _web_client().get("/api/one/feed/events?v=2").status_code == 401


@pytest.mark.asyncio
async def test_web_stream_ends_once_its_token_stops_verifying(monkeypatch, owner_queue):
    monkeypatch.setenv("DOCUMENT_FEED_WEB_STREAM_ENABLED", "true")
    monkeypatch.setattr(stream, "_ADMISSION", StreamAdmission())
    monkeypatch.setattr(stream, "FEED_AUTH_RECHECK_SECONDS", 0.05)
    checks: list[str] = []

    async def verify(authorization):
        checks.append(authorization)
        if len(checks) > 1:
            raise HTTPException(status_code=401, detail="Token revoked")
        return "user-a"

    monkeypatch.setattr(feed_events, "require_firebase_auth_read_only", verify)
    response = await feed_events.document_feed_web_events(CONNECTED, authorization="Bearer a")
    frames = response.body_iterator
    assert [frame["event"] for frame in await _rest(frames, timeout=1.0)] == [
        "hello",
        "feed_reset",
    ]
    assert checks == ["Bearer a", "Bearer a"]
    assert owner_queue.calls == [("subscribe", "user-a"), ("unsubscribe", "user-a")]


@pytest.mark.asyncio
async def test_web_stream_owner_comes_only_from_the_verified_token(monkeypatch, owner_queue):
    monkeypatch.setenv("DOCUMENT_FEED_WEB_STREAM_ENABLED", "true")
    admission = StreamAdmission()
    monkeypatch.setattr(stream, "_ADMISSION", admission)

    async def verified(authorization):
        assert authorization == "Bearer token-for-a"
        return "user-a"

    monkeypatch.setattr(feed_events, "require_firebase_auth_read_only", verified)
    response = await feed_events.document_feed_web_events(
        CONNECTED, authorization="Bearer token-for-a"
    )
    assert [(lease.user_id, lease.version) for lease in admission.active()] == [("user-a", 2)]
    assert (await _next(response.body_iterator))["event"] == "hello"
    assert await _next(response.body_iterator) == RESET
    assert owner_queue.calls == [("subscribe", "user-a")]
    await response.body_iterator.aclose()
