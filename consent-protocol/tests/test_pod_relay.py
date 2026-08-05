"""The private relay: owner reaches their pod, nobody else, and the pod URL is ours.

This is the route that finally READS a2a_route's cousin -- the pod URL the hub
recorded in backend_metadata -- which was written and never consumed. The
guarantees under test:

* the owner reaches their own pod's /pod/info;
* a caller who owns a DIFFERENT hushh_id is refused (403), and the refusal shape
  does not distinguish "wrong owner" from "no such pod" -- no existence oracle;
* the address proxied to comes only from the registry row, never the request;
* a pod that has no URL yet (still connecting) is a clean 409, not a crash;
* every attempt is audited through PodAccessAuditService -- the guard that was
  built and tested with zero callers now has one.
"""

from __future__ import annotations

from typing import Any, Optional

import pytest

from api.routes.one.pod_relay import relay_pod_info
from hushh_mcp.services.pod_access_audit import PERSONAL_AGENT_ID, PodAccessDenied

_OWNER = "firebase-uid-owner-0123456789ab"
_HUSHH = "ha1ownerpod"
_POD_URL = "https://pod-owner-uc.a.run.app"


class _FakeRegistry:
    def __init__(self, rows: dict[str, dict]) -> None:
        self.rows = rows

    async def get(self, user_id: str) -> Optional[dict]:
        return self.rows.get(user_id)


class _RecordingAudit:
    """Stands in for PodAccessAuditService; records the ownership check."""

    def __init__(self, *, allow: bool) -> None:
        self.allow = allow
        self.calls: list[dict] = []

    async def authorize_owner_read(self, **kwargs: Any) -> dict:
        self.calls.append(kwargs)
        if not self.allow:
            raise PodAccessDenied("hushh_id_mismatch")
        return {"authorized": True, "hushhId": kwargs.get("hushh_id")}


class _Response:
    def __init__(self, status_code: int, body: Any) -> None:
        self.status_code = status_code
        self._body = body

    def json(self) -> Any:
        return self._body


class _Session:
    def __init__(self, response: _Response) -> None:
        self.response = response
        self.urls: list[str] = []

    def get(self, url: str, **_: Any) -> _Response:
        self.urls.append(url)
        return self.response


@pytest.fixture(autouse=True)
def _enabled(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "1")


@pytest.mark.asyncio
async def test_the_owner_reaches_their_pod_and_the_url_is_ours():
    registry = _FakeRegistry(
        {_OWNER: {"user_id": _OWNER, "hushh_id": _HUSHH, "backend_metadata": {"url": _POD_URL}}}
    )
    audit = _RecordingAudit(allow=True)
    session = _Session(_Response(200, {"role": "sovereign-pod", "hushhId": _HUSHH}))

    result = await relay_pod_info(
        hushh_id=_HUSHH, user_id=_OWNER, registry=registry, audit=audit, session=session
    )

    assert result["hushhId"] == _HUSHH
    assert result["pod"]["role"] == "sovereign-pod"
    # The address proxied to is the one the hub recorded, never caller-supplied.
    assert session.urls == [f"{_POD_URL}/pod/info"]
    # Ownership was checked with the pod agent id and a read scope.
    assert audit.calls[0]["agent_id"] == PERSONAL_AGENT_ID
    assert audit.calls[0]["hushh_id"] == _HUSHH


@pytest.mark.asyncio
async def test_a_non_owner_is_refused_and_never_reaches_a_pod():
    from fastapi import HTTPException

    registry = _FakeRegistry({_OWNER: {"user_id": _OWNER, "hushh_id": _HUSHH}})
    audit = _RecordingAudit(allow=False)
    session = _Session(_Response(200, {"should": "never be fetched"}))

    with pytest.raises(HTTPException) as exc:
        await relay_pod_info(
            hushh_id="ha1someoneelse",
            user_id="firebase-uid-attacker-0000000000",
            registry=registry,
            audit=audit,
            session=session,
        )

    assert exc.value.status_code == 403
    # The refusal happened BEFORE any network call to a pod.
    assert session.urls == []


@pytest.mark.asyncio
async def test_a_pod_with_no_url_yet_is_a_clean_409():
    from fastapi import HTTPException

    registry = _FakeRegistry({_OWNER: {"user_id": _OWNER, "hushh_id": _HUSHH}})  # no metadata
    audit = _RecordingAudit(allow=True)

    with pytest.raises(HTTPException) as exc:
        await relay_pod_info(hushh_id=_HUSHH, user_id=_OWNER, registry=registry, audit=audit)

    assert exc.value.status_code == 409


@pytest.mark.asyncio
async def test_a_non_https_recorded_url_is_refused_as_unreachable():
    from fastapi import HTTPException

    registry = _FakeRegistry(
        {_OWNER: {"user_id": _OWNER, "hushh_id": _HUSHH, "backend_metadata": {"url": "http://pod"}}}
    )
    audit = _RecordingAudit(allow=True)

    with pytest.raises(HTTPException) as exc:
        await relay_pod_info(hushh_id=_HUSHH, user_id=_OWNER, registry=registry, audit=audit)

    # A non-https recorded URL is treated as no reachable address.
    assert exc.value.status_code == 409


@pytest.mark.asyncio
async def test_a_pod_that_is_down_is_a_503_not_a_crash():
    from fastapi import HTTPException

    class _DeadSession:
        urls: list[str] = []

        def get(self, url: str, **_: Any) -> Any:
            raise ConnectionError("pod is down")

    registry = _FakeRegistry(
        {_OWNER: {"user_id": _OWNER, "hushh_id": _HUSHH, "backend_metadata": {"url": _POD_URL}}}
    )
    audit = _RecordingAudit(allow=True)

    with pytest.raises(HTTPException) as exc:
        await relay_pod_info(
            hushh_id=_HUSHH, user_id=_OWNER, registry=registry, audit=audit, session=_DeadSession()
        )

    assert exc.value.status_code == 503


@pytest.mark.asyncio
async def test_the_relay_404s_while_the_feature_is_off(monkeypatch: pytest.MonkeyPatch):
    from fastapi import HTTPException

    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "0")
    registry = _FakeRegistry({_OWNER: {"user_id": _OWNER, "hushh_id": _HUSHH}})

    with pytest.raises(HTTPException) as exc:
        await relay_pod_info(
            hushh_id=_HUSHH, user_id=_OWNER, registry=registry, audit=_RecordingAudit(allow=True)
        )

    assert exc.value.status_code == 404
