"""The hub never carries an own-cloud owner's turn.

An agent in the person's own cloud (``user_gcp``, ``user_azure``) is chatted with
browser to agent. The old relay doors (``/turn`` and conversation close) accepted the
message, history, decrypted records and model key in plaintext, so for those owners
they must refuse BEFORE a grant is minted or a pod is dialled. At the route, the hub
content guard (``hub_content_firebase``) now refuses every private placement, Hussh
Pods (``gcp``) included: Hussh Pods chat is direct only. The core functions below keep
their row-level refusal as a backstop.
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from api.routes.one import pod_relay
from api.routes.one.pod_relay import (
    PodConversationCloseRelayRequest,
    PodTurnRelayRequest,
    relay_pod_conversation_close,
    relay_pod_memory_status,
    relay_pod_turn,
)
from hushh_mcp.services.pod_access_audit import PodAccessDenied

POD_URL = "https://one-pod-abc-uc.a.run.app"
OWN_CLOUD = ("user_gcp", "user_azure")
REFUSAL = {"code": "AGENT_PRIVATE_RUNTIME_REQUIRED"}


def _row(target: str) -> dict:
    return {
        "user_id": "u1",
        "status": "active",
        "deployment_target": target,
        "backend_metadata": {"url": POD_URL},
    }


class _Registry:
    def __init__(self, target: str) -> None:
        self.row = _row(target)

    async def get(self, _user_id):
        return self.row


class _Audit:
    def __init__(self, *, denied: bool = False) -> None:
        self.denied = denied

    async def authorize_owner_read(self, **_kwargs):
        if self.denied:
            raise PodAccessDenied("not the owner")
        return True


class _Grants:
    def __init__(self) -> None:
        self.minted = 0

    async def __call__(self, _user_id):
        self.minted += 1
        return {"token": "standing-pkm-read"}


class _Pod:
    def __init__(self) -> None:
        self.calls: list[str] = []

    def _answer(self, url):
        self.calls.append(url)

        class _R:
            status_code = 200

            def json(self_inner):
                return {"text": "hello", "memory": {"written": 1}}

        return _R()

    def post(self, url, json=None, headers=None, timeout=None, allow_redirects=True):
        return self._answer(url)

    def get(self, url, headers=None, timeout=None, allow_redirects=True):
        return self._answer(url)


async def _no_door_grants(_user_id, **_kwargs):
    return {}


@pytest.fixture(autouse=True)
def _enabled(monkeypatch):
    monkeypatch.setattr(pod_relay, "personal_agent_enabled", lambda: True)
    monkeypatch.setattr(pod_relay, "_identity_token", lambda _audience: "hub-id-token")
    monkeypatch.setattr(pod_relay, "issue_pod_data_door_grants", _no_door_grants)


async def _turn(target: str, *, grants: _Grants, pod: _Pod, audit: _Audit | None = None):
    return await relay_pod_turn(
        hushh_id="ha1owner",
        user_id="u1",
        payload=PodTurnRelayRequest(
            message="my private words",
            runtimeCredential="owner-model-key",
            pkmContext="decrypted records",
        ),
        registry=_Registry(target),
        audit=audit or _Audit(),
        grants=grants,
        session=pod,
    )


async def _close(target: str, *, grants: _Grants, pod: _Pod):
    return await relay_pod_conversation_close(
        hushh_id="ha1owner",
        user_id="u1",
        conversation_id="conv-1",
        payload=PodConversationCloseRelayRequest(runtime_credential="owner-model-key"),
        registry=_Registry(target),
        audit=_Audit(),
        grants=grants,
        session=pod,
    )


@pytest.mark.parametrize("target", OWN_CLOUD)
async def test_an_own_cloud_turn_is_refused_before_any_grant_or_dial(target):
    grants, pod = _Grants(), _Pod()
    with pytest.raises(HTTPException) as exc:
        await _turn(target, grants=grants, pod=pod)
    assert exc.value.status_code == 409
    assert exc.value.detail == REFUSAL
    assert grants.minted == 0
    assert pod.calls == []


@pytest.mark.parametrize("target", OWN_CLOUD)
async def test_an_own_cloud_close_is_refused_before_any_grant_or_dial(target):
    grants, pod = _Grants(), _Pod()
    with pytest.raises(HTTPException) as exc:
        await _close(target, grants=grants, pod=pod)
    assert exc.value.status_code == 409
    assert exc.value.detail == REFUSAL
    assert grants.minted == 0
    assert pod.calls == []


async def test_a_non_owner_still_gets_the_single_not_authorized_answer():
    """Ownership is decided first, so the refusal is never an oracle for placement."""
    with pytest.raises(HTTPException) as exc:
        await _turn("user_gcp", grants=_Grants(), pod=_Pod(), audit=_Audit(denied=True))
    assert exc.value.status_code == 403


def test_the_turn_and_close_routes_admit_through_the_hub_content_guard():
    """Route level: Hussh Pods owners are refused here too (409 with hostingMode
    ``hussh_pods``); tests/test_hub_content_routes_guarded.py calls each route."""
    from fastapi.routing import APIRoute

    from hushh_mcp.services.owner_placement_guard import hub_content_firebase

    for endpoint in (pod_relay.relay_pod_turn_route, pod_relay.relay_pod_conversation_close_route):
        route = next(r for r in pod_relay.router.routes if getattr(r, "endpoint", None) is endpoint)
        assert isinstance(route, APIRoute)
        assert hub_content_firebase in [d.call for d in route.dependant.dependencies]


async def test_the_core_relay_backstop_is_specific_to_own_cloud_rows():
    """The core function's row backstop refuses only own-cloud targets; a ``gcp`` row
    passes it. The route never reaches this for a Hussh Pods owner (guard above)."""
    grants, pod = _Grants(), _Pod()
    result = await _turn("gcp", grants=grants, pod=pod)
    assert result["text"] == "hello"
    assert pod.calls == [f"{POD_URL}/api/one/pod/turn"]

    closed = await _close("gcp", grants=grants, pod=pod)
    assert closed["memory"] == {"written": 1}
    assert pod.calls[-1] == f"{POD_URL}/api/one/pod/conversation/conv-1/close"


@pytest.mark.parametrize("target", OWN_CLOUD)
async def test_the_content_free_memory_status_door_stays_open(target):
    """Counts and words only, no conversation content: not part of this refusal."""
    pod = _Pod()
    result = await relay_pod_memory_status(
        hushh_id="ha1owner",
        user_id="u1",
        registry=_Registry(target),
        audit=_Audit(),
        grants=_Grants(),
        session=pod,
    )
    assert result["hushhId"] == "ha1owner"
    assert pod.calls == [f"{POD_URL}/api/one/pod/memory/status"]
