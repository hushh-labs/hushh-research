"""The pod's admission doors are limited per client, not per platform proxy.

``/api/one/pod/session/challenge`` and ``/session/admit`` carry no bearer, so the
shared limiter keyed them on the socket peer. Behind Cloud Run's front end and
Container Apps' Envoy that peer is the platform proxy: every stranger shared one
thirty-a-minute bucket with the owner and could lock the owner out of admission.

These tests pin the replacement key: the address the platform appended to
``X-Forwarded-For`` (the rightmost entry), never a caller-written entry, and the
socket peer when no platform front end exists to append anything.
"""

from __future__ import annotations

from collections.abc import Iterator, Sequence
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from starlette.requests import Request

from api.middlewares.rate_limit import limiter
from api.routes.one import pod_session
from hushh_mcp.services.pod_session_authority import PodSessionRefused

# The platform proxy every request arrives from, whoever sent it.
PROXY_PEER = "169.254.169.126"
OWNER_ADDRESS = "198.51.100.7"
STRANGER_ADDRESS = "203.0.113.5"
SPOOFED_ADDRESS = "192.0.2.66"

_PLATFORM_NAMES = ("K_SERVICE", "CONTAINER_APP_NAME")


def _on_platform(monkeypatch: pytest.MonkeyPatch, name: str | None) -> None:
    """Render exactly one platform's own service name, or none for off-platform."""
    for platform_name in _PLATFORM_NAMES:
        monkeypatch.delenv(platform_name, raising=False)
    if name:
        monkeypatch.setenv(name, "pod-test")


def _request(forwarded: Sequence[str] = (), *, peer: str = PROXY_PEER) -> Request:
    """An admission request as the pod receives it: one socket peer, any header lines."""
    headers = [(b"x-forwarded-for", line.encode()) for line in forwarded]
    return Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/api/one/pod/session/challenge",
            "query_string": b"",
            "headers": headers,
            "client": (peer, 443),
        }
    )


@pytest.fixture(params=_PLATFORM_NAMES, ids=["cloud_run", "container_apps"])
def platform(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch) -> str:
    _on_platform(monkeypatch, request.param)
    return str(request.param)


# -- the key --------------------------------------------------------------------------


def test_two_clients_behind_one_proxy_get_two_buckets(platform: str) -> None:
    owner = pod_session.admission_rate_key(_request([OWNER_ADDRESS]))
    stranger = pod_session.admission_rate_key(_request([STRANGER_ADDRESS]))

    assert owner == f"pod_admission:{OWNER_ADDRESS}"
    assert stranger == f"pod_admission:{STRANGER_ADDRESS}"
    assert owner != stranger


def test_a_spoofed_leftmost_entry_is_not_trusted(platform: str) -> None:
    """A caller can write any prefix; only what the platform appended counts."""
    spoofed = pod_session.admission_rate_key(
        _request([f"{SPOOFED_ADDRESS}, {OWNER_ADDRESS}, {STRANGER_ADDRESS}"])
    )

    assert spoofed == f"pod_admission:{STRANGER_ADDRESS}"
    # Claiming to be the owner does not move the stranger into the owner's bucket.
    assert spoofed != pod_session.admission_rate_key(_request([OWNER_ADDRESS]))


def test_a_caller_sent_line_cannot_stand_ahead_of_the_platform_line(platform: str) -> None:
    """Repeated header lines are one list in order; the last entry is the platform's.

    Reading only the first line (the previous helper) returned the caller's own
    line here, so a stranger could pick any bucket, the owner's included.
    """
    key = pod_session.admission_rate_key(_request([OWNER_ADDRESS, STRANGER_ADDRESS]))

    assert key == f"pod_admission:{STRANGER_ADDRESS}"


def test_off_platform_the_forwarded_header_is_only_the_callers_claim(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """With no front end to append an entry, the whole header is caller-written."""
    _on_platform(monkeypatch, None)

    key = pod_session.admission_rate_key(_request([OWNER_ADDRESS], peer="127.0.0.1"))

    assert key == "pod_admission:127.0.0.1"


# -- the doors ------------------------------------------------------------------------


class _Authority:
    """Just enough authority for the doors to answer; the limit runs before it."""

    async def require_held(self) -> None:
        return None

    def create_challenge(self, subject_id: str) -> dict[str, Any]:
        return {
            "challenge_id": f"challenge-{subject_id}",
            "nonce": "nonce",
            "epoch": 1,
            "pod_key_id": "podk_rate_test",
            "expires_at_ms": 0,
            "signing_payload": "payload",
        }

    async def admit(self, **_kwargs: Any) -> tuple[str, dict[str, Any]]:
        raise PodSessionRefused("binding_invalid", status=403)


@pytest.fixture
def doors(monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    """The session router with the shared limiter ENFORCING, on Cloud Run.

    The harness disables the limiter so route tests are not throttled, which is
    also why nothing else would notice these doors sharing one bucket.
    """
    _on_platform(monkeypatch, "K_SERVICE")
    monkeypatch.setattr(pod_session, "authority_or_503", lambda: _Authority())
    monkeypatch.setattr(limiter, "enabled", True)
    limiter.reset()
    app = FastAPI()
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
    app.include_router(pod_session.router)
    try:
        yield TestClient(app, raise_server_exceptions=False)
    finally:
        limiter.reset()


_ADMIT_BODY = {
    "binding": {},
    "signature": "sig",
    "challengeId": "challenge",
    "nonce": "nonce",
    "proof": "proof",
    "epoch": 1,
}
_DOORS = [
    ("/api/one/pod/session/challenge", {"subjectId": "subject-a"}),
    ("/api/one/pod/session/admit", _ADMIT_BODY),
]


@pytest.mark.parametrize(("path", "body"), _DOORS, ids=["challenge", "admit"])
def test_a_stranger_exhausting_the_door_does_not_lock_the_owner_out(
    doors: TestClient, path: str, body: dict[str, Any]
) -> None:
    """Every request comes from the same socket peer, as it does behind the proxy."""
    budget = int(pod_session._ADMISSION_RATE.split("/")[0])
    stranger = {"x-forwarded-for": f"{OWNER_ADDRESS}, {STRANGER_ADDRESS}"}

    statuses = [doors.post(path, json=body, headers=stranger).status_code for _ in range(budget)]
    assert 429 not in statuses, statuses
    assert doors.post(path, json=body, headers=stranger).status_code == 429

    owner = doors.post(path, json=body, headers={"x-forwarded-for": OWNER_ADDRESS})
    assert owner.status_code != 429, owner.text
