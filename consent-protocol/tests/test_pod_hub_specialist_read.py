"""The pod's egress to the data-door broker fails loud, never silent.

read_specialist is how a keyless pod reads a DB-backed specialist THROUGH the
hub. The one behaviour that must hold: a refusal or outage RAISES, so the
specialist degrades to runtime_unavailable (today's DB-wall). A swallowed failure
that returned empty state would make the pod answer "you share with nobody" for a
person who shares with many -- a confident wrong answer, the worst kind.
"""

from __future__ import annotations

from typing import Any, Optional

import pytest

from hushh_mcp.services.pod_hub_client import PodHubClient, PodHubUnavailable


class _Resp:
    def __init__(self, status_code: int, payload: Optional[dict] = None, *, bad_json: bool = False):
        self.status_code = status_code
        self._payload = payload or {}
        self._bad = bad_json

    def json(self) -> dict:
        if self._bad:
            raise ValueError("not json")
        return self._payload


class _TokenResp:
    """The metadata server's identity-token response the client fetches first."""

    status_code = 200
    text = "pod-id-token"


class _Session:
    def __init__(self, resp: Any = None, boom: Exception | None = None):
        self._resp = resp
        self._boom = boom
        self.calls: list[dict] = []

    def get(self, url, params=None, headers=None, timeout=None):
        # The pod fetches its own identity token from the metadata server first.
        return _TokenResp()

    def post(self, url, json=None, headers=None, timeout=None):
        self.calls.append({"url": url, "json": json, "headers": headers})
        if self._boom:
            raise self._boom
        return self._resp


def _client(session):
    return PodHubClient(base_url="https://hub.example", session=session)


def test_a_successful_read_returns_the_projection_state():
    projection = {"recipients": [{"userId": "friend"}], "circles": []}
    session = _Session(_Resp(200, {"name": "location", "state": projection}))
    state = _client(session).read_specialist("location", "scope-jwt")
    assert state == projection
    call = session.calls[0]
    assert call["url"].endswith("/api/one/pod/specialist/location/read")
    assert call["json"] == {"scopeToken": "scope-jwt"}


def test_a_refused_scope_raises_rather_than_returning_empty():
    session = _Session(_Resp(403, {"detail": "scope is not valid for this read"}))
    with pytest.raises(PodHubUnavailable):
        _client(session).read_specialist("location", "scope-jwt")


def test_an_unknown_door_raises():
    session = _Session(_Resp(404, {"detail": "no such specialist read"}))
    with pytest.raises(PodHubUnavailable):
        _client(session).read_specialist("vault", "scope-jwt")


def test_an_unreachable_hub_raises():
    session = _Session(boom=OSError("connection refused"))
    with pytest.raises(PodHubUnavailable):
        _client(session).read_specialist("location", "scope-jwt")


def test_a_missing_state_body_raises_not_returns_none():
    session = _Session(_Resp(200, {"name": "location"}))  # no 'state'
    with pytest.raises(PodHubUnavailable):
        _client(session).read_specialist("location", "scope-jwt")


def test_a_non_json_body_raises():
    session = _Session(_Resp(200, bad_json=True))
    with pytest.raises(PodHubUnavailable):
        _client(session).read_specialist("location", "scope-jwt")


def test_an_empty_scope_token_raises_before_any_call():
    session = _Session(_Resp(200, {"state": {}}))
    with pytest.raises(PodHubUnavailable):
        _client(session).read_specialist("location", "")
    assert session.calls == [], "must not call the hub without a scope token"
