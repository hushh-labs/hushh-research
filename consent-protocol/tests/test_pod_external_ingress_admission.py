"""A pod with public-by-construction ingress is admitted to owner-direct chat on a beat.

Live, 2026-10-05: the first Azure agent was active and healthy, yet One chat refused
with POD_DIRECT_NOT_READY. The endpoint is published only with `directReadiness`,
which nothing in the product ever wrote (the Google pilot's was an operator step),
and the Azure row recorded `ingress: external`, which no direct check accepts.
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from api.routes.one import pod_heartbeat
from hushh_mcp.services import pod_external_ingress_admission as admission
from hushh_mcp.services.pod_wall import POD_WALL_NOT_FOUND_BODY

ORIGIN = "https://dev.one.hushh.ai"
URL = "https://ca-hussh-one-pod.example.eastus2.azurecontainerapps.io"


def _row(**overrides: Any) -> dict:
    row = {
        "user_id": "owner",
        "hushh_id": "ha1_owner",
        "status": "provisioned",
        "deployment_target": "user_azure",
        "pod_key_id": "pod_key_1",
        "pod_pubkey": "cHVibGlj",
        "backend_metadata": {"ingress": "external", "url": URL, "serviceUid": "svc-1"},
    }
    row.update(overrides)
    return row


def _pod(wall: int = 404, allow_origin: str | None = ORIGIN, preflight: int = 200):
    seen: list[tuple[str, str]] = []

    def handle(request: httpx.Request) -> httpx.Response:
        seen.append((request.method, request.url.path))
        if request.method == "GET" and request.url.path == "/pod/info":
            return httpx.Response(wall, content=POD_WALL_NOT_FOUND_BODY)
        if request.method == "GET" and request.url.path == "/health":
            return httpx.Response(200)
        if request.method == "OPTIONS":
            headers = {"access-control-allow-origin": allow_origin} if allow_origin else {}
            return httpx.Response(preflight, headers=headers)
        return httpx.Response(500)

    return httpx.AsyncClient(transport=httpx.MockTransport(handle)), seen


@pytest.fixture
def recorded(monkeypatch):
    calls: list[dict] = []

    async def promote(_db, **fields):
        calls.append(fields)
        return True

    monkeypatch.setattr(
        "hushh_mcp.services.personal_agent_direct_admission.promote_external_ingress", promote
    )
    return calls


async def test_a_verified_external_pod_is_promoted_to_direct(recorded):
    client, seen = _pod()
    assert await admission.admit_external_ingress_if_due(
        _row(), client=client, db=object(), origin=ORIGIN
    )
    assert seen == [
        ("GET", "/pod/info"),
        ("GET", "/health"),
        ("OPTIONS", "/api/one/pod/session/challenge"),
    ]
    [fields] = recorded
    assert {k: fields[k] for k in ("user_id", "hushh_id", "pod_key_id", "service_uid", "url")} == {
        "user_id": "owner",
        "hushh_id": "ha1_owner",
        "pod_key_id": "pod_key_1",
        "service_uid": "svc-1",
        "url": URL,
    }
    assert fields["verified_at"]


@pytest.mark.parametrize(
    ("pod", "why"),
    [
        ({"wall": 200}, "a pod that serves machine routes to anyone"),
        ({"wall": 500}, "a pod whose wall cannot be told"),
        ({"allow_origin": "https://elsewhere.example"}, "a different origin echoed"),
        ({"allow_origin": None}, "no origin echoed"),
        ({"preflight": 400}, "a refused preflight"),
    ],
)
async def test_a_failed_check_records_nothing(recorded, pod, why):
    client, _ = _pod(**pod)
    assert not await admission.admit_external_ingress_if_due(
        _row(), client=client, db=object(), origin=ORIGIN
    ), why
    assert recorded == []


@pytest.mark.parametrize(
    "row",
    [
        _row(backend_metadata={"ingress": "internal", "url": URL, "serviceUid": "svc-1"}),
        _row(backend_metadata={"ingress": "direct", "url": URL, "serviceUid": "svc-1"}),
        _row(status="connecting"),
        _row(pod_pubkey=None),
        _row(deployment_target="gcp"),
        _row(backend_metadata={"ingress": "external", "url": "http://plain", "serviceUid": "s"}),
        _row(backend_metadata={"ingress": "external", "url": URL + "/", "serviceUid": "svc-1"}),
        _row(
            backend_metadata={
                "ingress": "external",
                "url": URL,
                "serviceUid": "svc-1",
                "erasure": {},
            }
        ),
    ],
)
async def test_a_pod_not_due_is_never_contacted(recorded, row):
    client, seen = _pod()
    assert not await admission.admit_external_ingress_if_due(
        row, client=client, db=object(), origin=ORIGIN
    )
    assert seen == [] and recorded == []


async def test_without_an_app_origin_nothing_is_contacted(recorded):
    client, seen = _pod()
    assert not await admission.admit_external_ingress_if_due(
        _row(), client=client, db=object(), origin=""
    )
    assert seen == [] and recorded == []


async def test_an_unreachable_pod_is_left_for_the_next_beat(recorded):
    def refuse(_request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("asleep")

    client = httpx.AsyncClient(transport=httpx.MockTransport(refuse))
    assert not await admission.admit_external_ingress_if_due(
        _row(), client=client, db=object(), origin=ORIGIN
    )
    assert recorded == []


async def test_a_beat_offers_its_row_for_admission(monkeypatch):
    row = _row()

    class _Registry:
        async def record_heartbeat(self, **_kwargs):
            return row

    async def verified(_request, _authorization):
        return type("V", (), {"hushh_id": "ha1_owner"})()

    async def nothing(*_args, **_kwargs):
        return []

    offered: list[dict] = []

    async def admitter(candidate):
        offered.append(candidate)
        return True

    monkeypatch.setattr(pod_heartbeat, "personal_agent_enabled", lambda: True)
    monkeypatch.setattr(pod_heartbeat, "verify_pod_request", verified)
    monkeypatch.setattr(pod_heartbeat, "_read_self_report", nothing)
    monkeypatch.setattr(pod_heartbeat, "_collect_pending_tombstones", nothing)
    result = await pod_heartbeat.record_pod_heartbeat(
        object(), "Bearer t", registry=_Registry(), admitter=admitter
    )
    assert result["recorded"] is True
    assert offered == [row]
