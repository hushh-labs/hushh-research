# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Regression tests for Edge Gateway single-origin CORS headers and cutover endpoint floors."""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi.testclient import TestClient

from hushh_mcp.services.agent_sandbox.edge_gateway_app import (
    SANDBOX_HYDRATION_FAILED_CODE,
    ActiveOwnerLease,
    SandboxActivationError,
    SandboxEdgeGatewayManager,
    create_sandbox_edge_gateway_app,
)
from hushh_mcp.services.personal_agent_direct_admission import _next_endpoint
from hushh_mcp.services.pooled_sandbox_cutover import ensure_pooled_sandbox_placement


class _StubClaimClient:
    def create_and_wait_claim(self, **_kwargs: Any) -> Any:
        raise AssertionError("pre-seeded lease should be used")

    def delete_claim(self, _name: str) -> None:
        return None


def test_schedule_worker_requires_owner_bound_oidc_before_lease_claim(monkeypatch):
    from hushh_mcp.services import scheduler_identity

    edge = "https://sandbox-edge.example.test"
    worker = "sandbox-schedule@hushh-pda-dev.iam.gserviceaccount.com"
    manager = SandboxEdgeGatewayManager(
        claim_client=_StubClaimClient(),
        master_seed=b"m" * 32,
        deploy_env="dev",
        pod_url_base=edge,
        schedule_worker_email=worker,
    )
    wake = AsyncMock(side_effect=TimeoutError)
    monkeypatch.setattr(manager, "ensure_owner_lease", wake)

    def verify(_token, audience):
        if audience != f"{edge}/u/owner-a":
            raise ValueError("wrong audience")
        return {"email": worker, "email_verified": True}

    monkeypatch.setattr(scheduler_identity, "_verify_google_id_token", verify)
    app = create_sandbox_edge_gateway_app(manager, enable_reaper=False)
    route = "/api/one/pod/tasks/worker"
    with TestClient(app) as client:
        assert client.post(f"/u/owner-a{route}").status_code == 403
        headers = {"Authorization": "Bearer synthetic"}
        assert client.post(f"/u/owner-b{route}", headers=headers).status_code == 403
        wake.assert_not_awaited()
        assert client.post(f"/u/owner-a{route}", headers=headers).status_code == 503
        wake.assert_awaited_once_with("owner-a")


def test_edge_gateway_deduplicates_upstream_lowercase_cors_headers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager = SandboxEdgeGatewayManager(
        claim_client=_StubClaimClient(),
        master_seed=b"m" * 32,
        allowed_app_origins="https://dev.one.hussh.ai",
    )
    hushh_id = "ha1_testowner1234567890"
    manager._leases[hushh_id] = ActiveOwnerLease(
        hushh_id=hushh_id,
        lease_id="lease_1",
        claim_name="claim-1",
        sandbox_name="sbx-1",
        pod_ip="10.0.0.9",
        port=8080,
        pod_key_id="podk_edge123",
        pod_public_key="pub_edge123",
        last_activity_s=100.0,
    )

    async def _fake_send(
        self: httpx.AsyncClient, request: httpx.Request, **_kw: Any
    ) -> httpx.Response:
        return httpx.Response(
            status_code=200,
            headers=[
                ("content-type", "application/json"),
                ("access-control-allow-origin", "https://dev.one.hussh.ai"),
                ("access-control-expose-headers", "X-Browser-Pod-Incarnation"),
                ("vary", "Origin"),
                ("x-hussh-pod-key-id", "podk_stale"),
            ],
            json={"challengeId": "psc_ok"},
            request=request,
        )

    monkeypatch.setattr(httpx.AsyncClient, "send", _fake_send)
    app = create_sandbox_edge_gateway_app(manager, enable_reaper=False)
    with TestClient(app) as client:
        resp = client.post(
            f"/u/{hushh_id}/api/one/pod/session/challenge",
            headers={"Origin": "https://dev.one.hussh.ai"},
            json={"subjectId": "tdv_1"},
        )

    assert resp.status_code == 200
    raw_names = [name.decode("latin-1").lower() for name, _ in resp.headers.raw]
    assert raw_names.count("access-control-allow-origin") == 1
    assert raw_names.count("access-control-expose-headers") == 1
    assert raw_names.count("vary") == 1
    assert raw_names.count("x-hussh-pod-key-id") == 1
    assert resp.headers["X-Hussh-Pod-Key-Id"] == "podk_edge123"


@pytest.mark.asyncio
async def test_ensure_pooled_sandbox_placement_preserves_endpoint_version_floor(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "1")
    monkeypatch.setenv("HUSSH_AGENT_SANDBOX_CUTOVER_ENABLED", "1")
    monkeypatch.setenv(
        "HUSSH_SANDBOX_EDGE_PUBLIC_URL",
        "https://sandbox-edge-gateway-aqahj4iyha-uc.a.run.app",
    )
    monkeypatch.setenv("HUSSH_SANDBOX_IDENTITY_MASTER_KEY", "s" * 48)

    prior_row = {
        "user_id": "uid_cutover_floor",
        "hushh_id": "ha1_cutoverfloor123",
        "status": "unprovisioned",
        "deployment_target": None,
        "backend": None,
        "backend_metadata": {
            "endpoint": {
                "version": 3,
                "url": "https://old-azure-pod.hussh.ai",
                "podKeyId": "podk_oldazure",
            },
            "endpointVersion": 1,
        },
    }

    class _MemRepo:
        def __init__(self) -> None:
            self.saved: dict[str, Any] | None = None

        async def get(self, _uid: str) -> dict[str, Any] | None:
            return self.saved or prior_row

        async def upsert(self, **kwargs: Any) -> None:
            self.saved = dict(kwargs)

    class _NoopJobs:
        async def _current(self, _uid: str) -> None:
            return None

    class _NoopGrants:
        issue_or_reuse_standing_pkm_read = AsyncMock(return_value=None)

    repo = _MemRepo()
    updated = await ensure_pooled_sandbox_placement(
        user_id="uid_cutover_floor",
        existing_row=prior_row,
        registry=repo,
        job_repo=_NoopJobs(),
        grant_service=_NoopGrants(),
        allow_non_ace_hosted_cutover=True,
    )

    assert updated is not None
    meta = updated["backend_metadata"]
    assert meta["endpoint"]["version"] == 3
    next_ep = _next_endpoint(
        meta["endpoint"],
        url=meta["url"],
        pod_key_id=updated["pod_key_id"],
    )
    assert next_ep is not None
    assert next_ep["version"] == 4


def test_edge_gateway_fails_fast_with_unavailable_on_terminal_hydration_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager = SandboxEdgeGatewayManager(
        claim_client=_StubClaimClient(),
        master_seed=b"m" * 32,
        allowed_app_origins="https://dev.one.hussh.ai",
    )

    async def _fail_activation(_hushh_id: str) -> ActiveOwnerLease:
        raise SandboxActivationError(
            "Hub storage gateway returned 503",
            code=SANDBOX_HYDRATION_FAILED_CODE,
            phase="unlocking",
        )

    monkeypatch.setattr(manager, "ensure_owner_lease", _fail_activation)
    app = create_sandbox_edge_gateway_app(manager, enable_reaper=False)
    with TestClient(app) as client:
        resp = client.get(
            "/u/ha1_testowner1234567890/health",
            headers={"Origin": "https://dev.one.hussh.ai"},
        )

    assert resp.status_code == 503
    assert resp.headers.get("x-hussh-pod-state") == "unavailable"
    assert resp.headers.get("access-control-allow-origin") == "https://dev.one.hussh.ai"
    assert resp.json()["detail"]["code"] == SANDBOX_HYDRATION_FAILED_CODE
    assert resp.json()["detail"]["phase"] == "unlocking"
