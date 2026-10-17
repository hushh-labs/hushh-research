"""Exercise lifecycle authority through the real pod ingress and route boundary."""

from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middlewares import pod_ingress
from api.routes.one.pod_session import router
from hushh_mcp.services import pod_upgrade_admission


@pytest.fixture
def lifecycle(monkeypatch):
    monkeypatch.setenv("HUSSH_ID", "ha1-owner")
    monkeypatch.setenv("K_REVISION", "pod-rev-1")
    monkeypatch.setenv("HUSSH_POD_HUB_CALLER_EMAILS", "hub@example.iam.gserviceaccount.com")
    monkeypatch.delenv("HUSSH_POD_TICK_ALLOWED_EMAILS", raising=False)
    # The inverse pod-to-hub verifier must not be needed for this direction.
    monkeypatch.setenv("POD_HUB_IDENTITY_AUTH_ENABLED", "false")

    def verify(token, audience):
        if token != "hub-token" or audience != "https://pod.example":
            raise ValueError("unverified token or wrong audience")
        return {
            "email": "hub@example.iam.gserviceaccount.com",
            "email_verified": True,
            "sub": "hub-service-account",
        }

    monkeypatch.setattr(pod_ingress, "identity_verifier", verify)
    admission = AsyncMock()
    admission.status.return_value = {"state": "accepting"}
    admission.prepare.return_value = {"state": "draining"}
    admission.release.return_value = {"state": "accepting"}
    monkeypatch.setattr(pod_upgrade_admission, "ADMISSION", admission)
    app = FastAPI()
    app.include_router(router)
    app.add_middleware(pod_ingress.PodIngressPolicy)
    with TestClient(app, base_url="https://pod.example") as client:
        yield client, admission


def test_verified_hub_can_control_only_its_target_pod(lifecycle):
    client, admission = lifecycle
    headers = {"Authorization": "Bearer hub-token", "X-Hushh-Pod-Id": "ha1-owner"}
    payload = {"operationId": "operation-123", "incarnation": "pod-rev-1"}
    for verb in ("prepare", "release"):
        response = client.post(f"/api/one/pod/upgrade/{verb}", headers=headers, json=payload)
        assert response.status_code == 200
        getattr(admission, verb).assert_awaited_once_with(
            operation_id="operation-123", incarnation="pod-rev-1"
        )
    assert client.get("/api/one/pod/upgrade/status", headers=headers).status_code == 200
    admission.status.assert_awaited_once_with(incarnation="pod-rev-1")


@pytest.mark.parametrize("asserted", [None, "ha1-other"])
@pytest.mark.parametrize("verb", ["status", "prepare", "release"])
def test_missing_or_wrong_pod_binding_refuses_before_admission(lifecycle, asserted, verb):
    client, admission = lifecycle
    headers = {"Authorization": "Bearer hub-token"}
    if asserted is not None:
        headers["X-Hushh-Pod-Id"] = asserted
    path = f"/api/one/pod/upgrade/{verb}"
    response = (
        client.get(path, headers=headers)
        if verb == "status"
        else client.post(
            path, headers=headers, json={"operationId": "operation-123", "incarnation": "pod-rev-1"}
        )
    )
    assert response.status_code == 403
    assert not admission.mock_calls


@pytest.mark.parametrize("token", ["owner-session", "unverified-token"])
def test_upgrade_door_stays_machine_only(lifecycle, token):
    client, admission = lifecycle
    response = client.get(
        "/api/one/pod/upgrade/status",
        headers={"Authorization": f"Bearer {token}", "X-Hushh-Pod-Id": "ha1-owner"},
    )
    assert response.status_code == 404
    assert not admission.mock_calls


def test_missing_local_identity_refuses(lifecycle, monkeypatch):
    monkeypatch.delenv("HUSSH_ID")
    client, admission = lifecycle
    response = client.get(
        "/api/one/pod/upgrade/status",
        headers={"Authorization": "Bearer hub-token", "X-Hushh-Pod-Id": "ha1-owner"},
    )
    assert response.status_code == 403
    assert not admission.mock_calls
