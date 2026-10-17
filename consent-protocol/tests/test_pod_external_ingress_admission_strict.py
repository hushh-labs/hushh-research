"""Admission believes only the pod's own wall, a public health answer and live IAM.

Before this, `/pod/info` answering 401, 403 or 404 counted as "the wall is present".
A Cloud Run IAM 403 is exactly that answer from a pod with no `allUsers` invoker,
which the owner's app can never reach, so a hub-only Google agent could be promoted
to direct and published to a browser that would then fail every call. The wall now
counts only as the pod's own 404 body (`POD_WALL_NOT_FOUND_BODY`), `/health` must
answer anonymously, and a Google row must show `allUsers` as invoker and ingress
`all` on the same service incarnation. Each failure leaves the row unchanged.
"""

from __future__ import annotations

import copy
from typing import Any

import httpx
import pytest

from api.middlewares import pod_ingress
from hushh_mcp.services import owner_direct_widen as widen
from hushh_mcp.services import pod_external_ingress_admission as admission
from hushh_mcp.services.pod_wall import POD_WALL_NOT_FOUND_BODY

ORIGIN = "https://dev.one.hushh.ai"
URL = "https://one-pod-ha1-owner-abc123-uc.a.run.app"
SERVICE = "one-pod-ha1-owner"
CLOUD_RUN_403 = b"<html><head><title>403 Forbidden</title></head><body>Error: Forbidden</body>"
GOOGLE_404 = b"<!DOCTYPE html><html><title>Error 404 (Not Found)!!1</title></html>"


def _row(target: str = "user_gcp") -> dict:
    return {
        "user_id": "owner",
        "hushh_id": "ha1_owner",
        "status": "provisioned",
        "deployment_target": target,
        "pod_key_id": "pod_key_1",
        "pod_pubkey": "cHVibGlj",
        "user_cloud_project": "owner-project",
        "user_cloud_bootstrap_sa": "one-bootstrap@owner-project.iam.gserviceaccount.com",
        "backend_metadata": {
            "ingress": "external",
            "url": URL,
            "service": SERVICE,
            "serviceUid": "svc-1",
        },
    }


def _pod(
    *, wall: int = 404, wall_body: bytes = POD_WALL_NOT_FOUND_BODY, health: int = 200
) -> httpx.AsyncClient:
    def handle(request: httpx.Request) -> httpx.Response:
        if request.method == "GET" and request.url.path == "/pod/info":
            return httpx.Response(wall, content=wall_body)
        if request.method == "GET" and request.url.path == "/health":
            return httpx.Response(health, json={"status": "ok"})
        if request.method == "OPTIONS":
            return httpx.Response(204, headers={"access-control-allow-origin": ORIGIN})
        return httpx.Response(500)

    return httpx.AsyncClient(transport=httpx.MockTransport(handle))


class _Run:
    """The bootstrap-identity read of the live Cloud Run service and its IAM policy."""

    def __init__(self, *, members=("allUsers",), ingress="all", uid="svc-1") -> None:
        self.members, self.ingress, self.uid = list(members), ingress, uid
        self.reads: list[str] = []

    def get_service(self, name: str) -> dict:
        self.reads.append(f"service:{name}")
        return {
            "metadata": {
                "uid": self.uid,
                "annotations": {"run.googleapis.com/ingress": self.ingress},
            }
        }

    def get_iam_policy(self, name: str) -> dict:
        self.reads.append(f"iam:{name}")
        return {"bindings": [{"role": "roles/run.invoker", "members": copy.copy(self.members)}]}


@pytest.fixture
def promoted(monkeypatch):
    calls: list[dict] = []

    async def promote(_db, **fields):
        calls.append(fields)
        return True

    monkeypatch.setattr(
        "hushh_mcp.services.personal_agent_direct_admission.promote_external_ingress", promote
    )
    return calls


def _cloud(run: _Run) -> Any:
    async def check(row, *, service, service_uid):
        return await widen.google_public_ingress_failure(
            row, service=service, service_uid=service_uid, client=run
        )

    return check


async def _admit(pod: httpx.AsyncClient, run: _Run, row: dict | None = None) -> bool:
    return await admission.admit_external_ingress_if_due(
        row or _row(), client=pod, db=object(), origin=ORIGIN, cloud_check=_cloud(run)
    )


def test_the_hub_and_the_pod_share_one_wall_body():
    assert pod_ingress._NOT_FOUND is POD_WALL_NOT_FOUND_BODY


async def test_a_google_pod_with_every_check_holding_is_promoted(promoted):
    run = _Run()
    assert await _admit(_pod(), run)
    assert run.reads == [f"service:{SERVICE}", f"iam:{SERVICE}"]
    assert [fields["service_uid"] for fields in promoted] == ["svc-1"]


@pytest.mark.parametrize(
    ("pod", "why"),
    [
        ({"wall": 403, "wall_body": CLOUD_RUN_403}, "Cloud Run IAM refusing at its front"),
        ({"wall": 401, "wall_body": POD_WALL_NOT_FOUND_BODY}, "a 401 is not the pod's wall"),
        ({"wall": 404, "wall_body": GOOGLE_404}, "a provider's 404 page, not the pod"),
        ({"wall": 404, "wall_body": b""}, "an empty 404"),
        ({"health": 403}, "health refused to an anonymous caller"),
        ({"health": 503}, "health not serving"),
    ],
)
async def test_an_answer_from_something_other_than_the_pod_leaves_the_row(promoted, pod, why):
    run = _Run()
    assert not await _admit(_pod(**pod), run), why
    assert promoted == [] and run.reads == []


@pytest.mark.parametrize(
    ("run", "why"),
    [
        (_Run(members=()), "no allUsers invoker"),
        (_Run(members=("serviceAccount:hub@x.iam.gserviceaccount.com",)), "hub-only invoker"),
        (_Run(ingress="internal"), "ingress still internal"),
        (_Run(ingress="internal-and-cloud-load-balancing"), "ingress not all"),
        (_Run(uid="svc-2"), "a different service incarnation"),
    ],
)
async def test_a_google_pod_whose_live_iam_does_not_hold_is_left(promoted, run, why):
    assert not await _admit(_pod(), run), why
    assert promoted == []


async def test_a_google_pod_with_no_bootstrap_client_is_left(promoted, monkeypatch):
    monkeypatch.setattr(widen, "bootstrap_run_client", lambda _row: None)
    assert not await admission.admit_external_ingress_if_due(
        _row(), client=_pod(), db=object(), origin=ORIGIN
    )
    assert promoted == []


async def test_an_unreadable_iam_policy_leaves_the_row(promoted):
    class _Broken(_Run):
        def get_iam_policy(self, name: str) -> dict:
            raise PermissionError("bootstrap lacks run.services.getIamPolicy")

    assert not await _admit(_pod(), _Broken())
    assert promoted == []


async def test_a_google_row_without_its_service_name_is_left(promoted):
    row = _row()
    row["backend_metadata"].pop("service")
    assert not await _admit(_pod(), _Run(), row)
    assert promoted == []


async def test_an_azure_pod_needs_no_google_iam_read(promoted):
    run = _Run(members=())
    assert await _admit(_pod(), run, _row("user_azure"))
    assert run.reads == [] and len(promoted) == 1
