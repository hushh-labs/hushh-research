"""Every hub content route admits only Shared owners, and the inventory proves it.

Three checks over the real ``server.app`` route table (``/api/one``, ``/api/kai``,
``/api/pkm``):

1. every route is classified exactly once in ``api/hub_route_classes.py`` and the
   inventory names no route that no longer exists;
2. every ``CONTENT`` route carries the guard, as a dependency anywhere in its
   dependency tree or as the inline mark of a websocket/ticket handler, and every
   route still waiting on another lane is unguarded (so the ledger only shrinks);
3. each guarded ``CONTENT`` route, called as an own-cloud owner, answers 409
   ``AGENT_PRIVATE_RUNTIME_REQUIRED`` and its handler body never runs.

The guard's own decisions (anonymous, Shared, unknown, private, pod process) are
pinned at the bottom.
"""

from __future__ import annotations

import inspect
from collections.abc import Iterator
from typing import Any
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.routing import APIRoute, APIWebSocketRoute
from fastapi.testclient import TestClient

from api.hub_route_classes import (
    CONTENT_GUARD_PENDING,
    ROUTE_CLASSES,
    WEBSOCKET,
    RouteClass,
    is_hub_route,
)
from api.middleware import require_firebase_auth, require_vault_owner_token
from api.middlewares.chat_key import require_vault_owner_chat_key
from hushh_mcp.services import owner_placement_guard as guard

OWNER = "owner-byoc-1"
PLACEHOLDER = "00000000-0000-4000-8000-000000000001"
OWNER_TOKEN = {"user_id": OWNER, "token": "HCT:synthetic", "agent_id": "self"}
REFUSED = "AGENT_PRIVATE_RUNTIME_REQUIRED"
INLINE_ROUTES = {
    ("POST", "/api/one/a2a/message"),
    ("POST", "/api/one/email/information-requests/scan-enabled"),
    ("POST", "/api/one/pod/specialist/{name}/read"),
    (WEBSOCKET, "/api/one/puppy/relay"),
    ("POST", "/api/one/agent-chat"),
    ("POST", "/api/one/voice/sessions"),
    (WEBSOCKET, "/api/one/voice/live"),
}


@pytest.fixture(scope="module")
def hub_routes() -> list[tuple[str, str, Any]]:
    from server import app

    rows: list[tuple[str, str, Any]] = []
    for route in app.routes:
        path = getattr(route, "path", "")
        if not is_hub_route(path):
            continue
        if isinstance(route, APIWebSocketRoute):
            rows.append((WEBSOCKET, path, route))
        elif isinstance(route, APIRoute):
            rows.extend((method, path, route) for method in sorted(route.methods))
    return rows


def _dependency_calls(dependant: Any) -> Iterator[Any]:
    for child in dependant.dependencies:
        yield child.call
        yield from _dependency_calls(child)


def _guarded(route: Any) -> bool:
    if getattr(route.endpoint, guard.INLINE_GUARD_ATTRIBUTE, None):
        return True
    return any(
        call in guard.HUB_CONTENT_DEPENDENCIES for call in _dependency_calls(route.dependant)
    )


def _content_routes(rows: list[tuple[str, str, Any]]) -> list[tuple[str, str, Any]]:
    return [row for row in rows if ROUTE_CLASSES.get((row[0], row[1])) is RouteClass.CONTENT]


# --- 1. inventory -------------------------------------------------------------------


def test_every_hub_route_is_classified(hub_routes):
    unclassified = sorted({(m, p) for m, p, _ in hub_routes if (m, p) not in ROUTE_CLASSES})
    assert unclassified == [], f"classify these in api/hub_route_classes.py: {unclassified}"


def test_the_inventory_names_only_live_routes(hub_routes):
    live = {(m, p) for m, p, _ in hub_routes}
    stale = sorted(key for key in ROUTE_CLASSES if key not in live)
    assert stale == [], f"remove these from api/hub_route_classes.py: {stale}"


def test_pending_entries_are_content_routes():
    assert CONTENT_GUARD_PENDING == {}, "all BYOC hub-content exceptions must be closed"


# --- 2. structural guard ------------------------------------------------------------


def test_every_content_route_carries_the_guard(hub_routes):
    missing = sorted(
        (m, p, route.endpoint.__module__)
        for m, p, route in _content_routes(hub_routes)
        if (m, p) not in CONTENT_GUARD_PENDING and not _guarded(route)
    )
    assert missing == [], f"CONTENT routes without hub_content_* or the inline mark: {missing}"


def test_a_guarded_pending_route_leaves_the_ledger(hub_routes):
    stale = sorted(
        (m, p)
        for m, p, route in _content_routes(hub_routes)
        if (m, p) in CONTENT_GUARD_PENDING and _guarded(route)
    )
    assert stale == [], f"now guarded: drop @pending from api/hub_route_classes.py: {stale}"


def test_inline_marks_are_exactly_the_known_handlers(hub_routes):
    marked = {
        (m, p)
        for m, p, route in hub_routes
        if getattr(route.endpoint, guard.INLINE_GUARD_ATTRIBUTE, None)
    }
    assert marked == INLINE_ROUTES


# --- 3. behaviour: a private owner is refused before the handler --------------------


@pytest.fixture
def byoc_owner(monkeypatch):
    from api.routes.one import agent_chat, voice

    placement = AsyncMock(return_value="byoc")
    for module in (guard, agent_chat, voice):
        monkeypatch.setattr(module, "get_owner_hosting_mode", placement)
    monkeypatch.setattr(guard, "pod_mode", lambda: False)
    return placement


@pytest.fixture
def signed_in(monkeypatch):
    """Authentication is not under test: every credential names OWNER. A route keeps
    the override provider it was built with, so the overrides go on the real app."""
    from server import app

    overrides = app.dependency_overrides
    monkeypatch.setitem(overrides, require_vault_owner_token, lambda: dict(OWNER_TOKEN))
    monkeypatch.setitem(overrides, require_vault_owner_chat_key, lambda: dict(OWNER_TOKEN))
    monkeypatch.setitem(overrides, require_firebase_auth, lambda: OWNER)


def _single_route_app(route: Any) -> FastAPI:
    """Only this route, so a path another router registered first cannot shadow it."""
    app = FastAPI()
    app.router.routes.append(route)
    return app


def _url(route: Any) -> str:
    return route.path_format.format(**{name: PLACEHOLDER for name in route.param_convertors})


def _sentinel(route: Any, calls: list[str]):
    if inspect.iscoroutinefunction(route.dependant.call):

        async def handler_async(**_kwargs):
            calls.append(route.path)

        return handler_async

    def handler(**_kwargs):
        calls.append(route.path)

    return handler


def _assert_refused(response) -> None:
    assert response.status_code == 409, response.text
    detail = response.json()["detail"]
    assert detail["code"] == REFUSED and detail["hostingMode"] == "byoc"


def test_every_dependency_guarded_content_route_refuses_a_private_owner(
    hub_routes, byoc_owner, signed_in, monkeypatch
):
    checked = 0
    refused_by_pod_process: set[tuple[str, str]] = set()
    for method, path, route in _content_routes(hub_routes):
        if (method, path) in CONTENT_GUARD_PENDING or (method, path) in INLINE_ROUTES:
            continue
        calls: list[str] = []
        monkeypatch.setattr(route.dependant, "call", _sentinel(route, calls))
        client = TestClient(_single_route_app(route), raise_server_exceptions=False)
        body = None if method in {"GET", "DELETE"} else {}
        response = client.request(method, _url(route), json=body)
        assert response.status_code == 409, f"{method} {path}: {response.text}"
        detail = response.json()["detail"]
        assert detail["code"] == REFUSED, f"{method} {path}: {detail}"
        if "hostingMode" not in detail:
            refused_by_pod_process.add((method, path))
        else:
            assert detail["hostingMode"] == "byoc"
        assert calls == [], f"{method} {path} ran its handler"
        checked += 1
    assert checked >= 70  # a floor, so a filter bug cannot skip the walk silently
    # Model search runs only inside a pod process; it refuses every hub caller first.
    assert refused_by_pod_process == {("POST", "/api/one/actions/search")}


OWNER_CONTROLS = {
    ("DELETE", "/api/one/agent-chat/conversations/{conversation_id}"),
    ("GET", "/api/one/agent-chat/runs/{conversation_id}/queue"),
    ("DELETE", "/api/one/agent-chat/runs/{conversation_id}/queue/{client_message_id}"),
    ("POST", "/api/one/agent-chat/runs/{conversation_id}/stop"),
}


def test_an_owner_whose_agent_moved_still_erases_and_stops_hub_records(
    hub_routes, byoc_owner, signed_in, monkeypatch
):
    """Erase, withdraw, status and stop read and return no content, so a private owner
    keeps them for the hub records left from their Shared days, and no placement is read."""
    reached = set()
    for method, path, route in hub_routes:
        if (method, path) not in OWNER_CONTROLS:
            continue
        assert ROUTE_CLASSES[(method, path)] is RouteClass.AUTHORITY
        calls: list[str] = []
        monkeypatch.setattr(route.dependant, "call", _sentinel(route, calls))
        client = TestClient(_single_route_app(route), raise_server_exceptions=False)
        response = client.request(method, _url(route))
        assert response.status_code == 200, f"{method} {path}: {response.text}"
        assert calls == [path]
        reached.add((method, path))
    assert reached == OWNER_CONTROLS
    byoc_owner.assert_not_awaited()


def test_the_agent_chat_intro_head_refuses_a_firebase_only_private_owner(
    hub_routes, byoc_owner, signed_in, monkeypatch
):
    from api.routes.one import agent_chat

    monkeypatch.setattr(agent_chat, "verify_firebase_bearer", lambda _header: OWNER)
    sessions = AsyncMock(side_effect=AssertionError("must not open a hub session"))
    monkeypatch.setattr(agent_chat._intro_session_service, "create_session", sessions)
    route = next(r for m, p, r in hub_routes if (m, p) == ("POST", "/api/one/agent-chat"))
    client = TestClient(_single_route_app(route), raise_server_exceptions=False)
    response = client.post(
        "/api/one/agent-chat",
        json={
            "threadId": "t",
            "runId": "r",
            "state": {},
            "messages": [{"id": "m", "role": "user", "content": "my private words"}],
            "tools": [],
            "context": [],
            "forwardedProps": {},
        },
        headers={"authorization": "Bearer synthetic-firebase"},
    )
    _assert_refused(response)
    byoc_owner.assert_awaited_with(OWNER)
    sessions.assert_not_awaited()


def test_an_anonymous_intro_visitor_is_still_admitted(byoc_owner):
    from starlette.requests import Request

    from api.routes.one import agent_chat

    request = Request({"type": "http", "headers": [], "client": ("127.0.0.1", 1)})
    from ag_ui.core import RunAgentInput

    data = RunAgentInput(
        thread_id="t", run_id="r", state={}, messages=[], tools=[], context=[], forwarded_props={}
    )
    import asyncio

    asyncio.run(agent_chat._extract_state(request, data))
    byoc_owner.assert_not_awaited()


def _voice_env(monkeypatch) -> None:
    monkeypatch.setenv("ONE_VOICE_LIVE_ENABLED", "true")
    monkeypatch.setenv("VERTEX_LIVE_MODEL_ID", "gemini-live-2.5-flash-preview-native-audio")
    monkeypatch.setenv("VERTEX_LIVE_LOCATION", "us-central1")


def test_the_voice_ticket_refuses_a_private_owner_before_issuing(
    hub_routes, byoc_owner, signed_in, monkeypatch
):
    from api.routes.one import voice

    _voice_env(monkeypatch)
    monkeypatch.setattr(voice, "issue_ticket", Mock(side_effect=AssertionError("no ticket")))
    route = next(r for m, p, r in hub_routes if (m, p) == ("POST", "/api/one/voice/sessions"))
    client = TestClient(_single_route_app(route), raise_server_exceptions=False)
    _assert_refused(client.post("/api/one/voice/sessions", json={"conversation_id": PLACEHOLDER}))


def test_the_voice_socket_refuses_a_private_owner_before_a_session(
    hub_routes, byoc_owner, signed_in, monkeypatch
):
    from api.routes.one import voice
    from hushh_mcp.one_voice.tickets import issue_ticket, parse_ticket

    _voice_env(monkeypatch)
    ticket, _ = issue_ticket(user_id=OWNER, session_id="synthetic", conversation_id=PLACEHOLDER)
    monkeypatch.setattr(voice, "consume_ticket", AsyncMock(return_value=parse_ticket(ticket)))
    monkeypatch.setattr(voice, "VoiceSession", Mock(side_effect=AssertionError("no session")))
    route = next(r for m, p, r in hub_routes if (m, p) == (WEBSOCKET, "/api/one/voice/live"))
    client = TestClient(_single_route_app(route))
    with client.websocket_connect("/api/one/voice/live?ticket=" + ticket) as socket:
        assert socket.receive_json()["code"] == REFUSED
    byoc_owner.assert_awaited_with(OWNER)


ADK_LIVE_PATHS = {("POST", "/api/one/adk/relay-session"), (WEBSOCKET, "/api/one/adk/live")}


def test_the_hub_answers_the_adk_live_paths_only_with_retired_responders(hub_routes):
    """On the hub these two paths are ``retired_voice`` (410 / close, no content read),
    which is why they are SUPPORT. ``adk_live.router`` is not mounted there; if it ever
    is, reclass both as CONTENT and add them to INLINE_ROUTES (its handlers carry the
    inline mark and refuse private owners, pinned by the two tests below)."""
    owners = {(m, p): r.endpoint.__module__ for m, p, r in hub_routes if (m, p) in ADK_LIVE_PATHS}
    assert owners == dict.fromkeys(ADK_LIVE_PATHS, "api.routes.one.retired_voice")
    assert all(ROUTE_CLASSES[key] is RouteClass.SUPPORT for key in ADK_LIVE_PATHS)


def _adk_live_route(path: str) -> Any:
    from api.routes.one import adk_live

    route = next(r for r in adk_live.router.routes if getattr(r, "path", "") == path)
    assert getattr(route.endpoint, guard.INLINE_GUARD_ATTRIBUTE, None)
    return route


def test_the_adk_relay_ticket_refuses_a_private_owner_before_issuing(byoc_owner, monkeypatch):
    from api.routes.one import adk_live, pod_live_relay

    monkeypatch.setattr(adk_live, "one_voice_enabled", lambda: True)
    monkeypatch.setattr(adk_live, "resolve_optional_uid", AsyncMock(return_value=OWNER))
    monkeypatch.setattr(adk_live, "issue_relay_ticket", Mock(side_effect=AssertionError("ticket")))
    courier = AsyncMock(side_effect=AssertionError("must refuse before pod admission"))
    monkeypatch.setattr(pod_live_relay, "admit_private_live", courier)
    route = _adk_live_route("/api/one/adk/relay-session")
    client = TestClient(_single_route_app(route), raise_server_exceptions=False)
    response = client.post("/api/one/adk/relay-session", headers={"authorization": "Bearer x"})
    _assert_refused(response)
    byoc_owner.assert_awaited_with(OWNER)
    courier.assert_not_awaited()


def test_the_adk_live_socket_refuses_a_private_owner_before_the_courier(byoc_owner, monkeypatch):
    from starlette.websockets import WebSocketDisconnect

    from api.routes.one import adk_live, pod_live_relay

    monkeypatch.setattr(adk_live, "one_voice_enabled", lambda: True)
    ticket = AsyncMock(return_value=(True, OWNER, "signed_unlocked"))
    monkeypatch.setattr(adk_live, "consume_relay_ticket_shared", ticket)
    courier = AsyncMock(side_effect=AssertionError("must refuse before the courier"))
    monkeypatch.setattr(pod_live_relay, "relay_private_live", courier)
    route = _adk_live_route("/api/one/adk/live")
    client = TestClient(_single_route_app(route))
    with client.websocket_connect("/api/one/adk/live?relay_ticket=t") as socket:
        with pytest.raises(WebSocketDisconnect) as closed:
            socket.receive_text()
    assert (closed.value.code, closed.value.reason) == (1008, REFUSED)
    byoc_owner.assert_awaited_with(OWNER)
    courier.assert_not_awaited()


async def test_the_live_courier_is_closed_to_a_private_owner(byoc_owner, monkeypatch):
    from api.routes.one import pod_live_relay

    monkeypatch.setattr(pod_live_relay, "_require_enabled", lambda: None)
    monkeypatch.setattr(
        pod_live_relay,
        "PersonalAgentRegistryRepo",
        Mock(side_effect=AssertionError("must refuse before the registry")),
    )
    with pytest.raises(HTTPException) as refused:
        await pod_live_relay.admit_private_live(OWNER)
    assert refused.value.status_code == 409


# --- the guard's decisions ----------------------------------------------------------


@pytest.mark.parametrize(
    "mode,status",
    [
        ("byoc", 409),
        ("pending", 409),
        ("hussh_pods", 409),
        ("unplaced", 409),
        ("unknown", 503),
        ("something-new", 503),
        (None, 503),
    ],
)
async def test_every_placement_but_shared_is_refused(monkeypatch, mode, status):
    monkeypatch.setattr(guard, "pod_mode", lambda: False)
    monkeypatch.setattr(guard, "get_owner_hosting_mode", AsyncMock(return_value=mode))
    with pytest.raises(HTTPException) as refused:
        await guard.admit_hub_content(OWNER, "test")
    assert refused.value.status_code == status
    if status == 409:
        assert refused.value.detail["hostingMode"] == mode


async def test_an_unreadable_placement_is_unavailable_and_says_nothing(monkeypatch):
    monkeypatch.setattr(guard, "pod_mode", lambda: False)
    reader = AsyncMock(side_effect=RuntimeError("db secret detail"))
    monkeypatch.setattr(guard, "get_owner_hosting_mode", reader)
    with pytest.raises(HTTPException) as refused:
        await guard.admit_hub_content(OWNER, "test")
    assert refused.value.status_code == 503
    assert "secret" not in str(refused.value.detail)


async def test_shared_and_anonymous_are_admitted_and_pods_run_their_own(monkeypatch):
    monkeypatch.setattr(guard, "pod_mode", lambda: False)
    reader = AsyncMock(return_value="shared")
    monkeypatch.setattr(guard, "get_owner_hosting_mode", reader)
    assert await guard.admit_hub_content(OWNER, "test") == "shared"
    assert await guard.admit_hub_content("", "test") == "anonymous"
    assert await guard.hub_content_owner(dict(OWNER_TOKEN)) == OWNER_TOKEN
    assert await guard.hub_content_firebase(OWNER) == OWNER
    monkeypatch.setattr(guard, "pod_mode", lambda: True)
    reader.reset_mock()
    assert await guard.admit_hub_content(OWNER, "test") == "pod_process"
    reader.assert_not_awaited()
