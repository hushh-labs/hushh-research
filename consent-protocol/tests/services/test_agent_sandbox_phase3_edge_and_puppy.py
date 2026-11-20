# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Phase 3 tests: open adoption, Edge Gateway HTTP/WS Puppy relay, key unlink & continuity."""

from __future__ import annotations

import asyncio
import base64
import json
import os
import secrets
import socket
import threading
from collections.abc import Generator
from pathlib import Path
from typing import Any

import httpx
import pytest
import uvicorn
import websockets
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from hushh_mcp.operons.agent_sandbox.k8s_manifests import render_sandbox_network_policy
from hushh_mcp.services.ace_backend import AceComputeBackend
from hushh_mcp.services.agent_sandbox import (
    SANDBOX_INTERNAL_PATH_FORBIDDEN,
    HubSandboxSessionRouter,
    InMemorySandboxClaimClient,
    SandboxClaimPort,
    SandboxEdgeGatewayManager,
    create_sandbox_edge_gateway_app,
    derive_owner_pod_identity,
)
from hushh_mcp.services.agent_sandbox.k8s_claim_allocator import ClaimedSandboxEndpoint
from hushh_mcp.services.agent_sandbox.virgin_standby import VirginStandbyRuntime
from hushh_mcp.services.pod_self_registration import (
    pod_key_is_durable,
    pod_public_key_payload,
    reset_pod_keypair_cache_for_tests,
)


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


@pytest.fixture(autouse=True)
def _clean_pod_env() -> Generator[None, None, None]:
    tracked = (
        "HUSSH_POD_MODE",
        "HUSSH_POD_ID",
        "HUSSH_POD_PRIVATE_KEY",
        "HUSSH_POD_PRIVATE_KEY_FILE",
        "HUSSH_UNLINK_POD_PRIVATE_KEY_AFTER_LOAD",
        "HUSSH_ID",
        "HUSSH_OWNER_ID",
        "HUSSH_LEASE_ID",
        "POD_URL",
        "HUSSH_HUB_URL",
        "HUSSH_HUB_BASE_URL",
        "HUSHH_SCHEDULER_CALLER_EMAILS",
        "HUSSH_POD_HUB_CALLER_EMAILS",
        "APP_SIGNING_KEY",
        "POD_DURABLE_IDENTITY_ENABLED",
        "POD_STORAGE_PREFIX_TOKEN_URL",
        "POD_STORAGE_BACKEND",
        "HUSSH_POD_CUSTODY_MODE",
        "HUSSH_MODEL_GATEWAY_URL",
        "HUSSH_MODEL_GATEWAY_TOKEN",
        "HUSSH_SENTINEL_VERTEX_PROJECT",
        "HUSSH_SENTINEL_VERTEX_LOCATION",
        "CORS_ALLOWED_ORIGINS",
        "CONSENT_ED25519_PUBLIC_KEYS",
        "OWNER_FEED_ED25519_PUBLIC_KEYS",
        "HUSSH_POD_TURN_ENABLED",
        "POD_AGENT_MEMORY_ENABLED",
        "POD_DIRECTIVE_TRANSPORT_ENABLED",
        "HUSSH_POD_BROWSER_ENABLED",
        "POD_DATA_DOOR_ENABLED",
        "GOOGLE_GENAI_USE_VERTEXAI",
        "ACE_SANDBOX_ID",
        "ENVIRONMENT",
    )
    saved = {k: os.environ.get(k) for k in tracked}
    reset_pod_keypair_cache_for_tests()
    try:
        yield
    finally:
        reset_pod_keypair_cache_for_tests()
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def test_open_free_adoption_and_router_coalesces_active_owner() -> None:
    claim_client = InMemorySandboxClaimClient(forced_sandbox_sequence=["sbx-open-1", "sbx-open-2"])
    router: HubSandboxSessionRouter = AceComputeBackend().build_hub_sandbox_router(
        audit_hmac_key=b"M" * 32,
        edge_gateway_url="https://edge.dev.example",
    )
    router.claim_client = claim_client

    first = router.allocate_turn_sandbox(
        owner_id="brand_new_owner",
        workspace_id="ws_brand_new",
        billing_space_id="bs_brand_new",
        units=250,
    )
    second = router.allocate_turn_sandbox(
        owner_id="brand_new_owner",
        workspace_id="ws_brand_new",
        billing_space_id="bs_brand_new",
        units=250,
    )
    assert second.lease_id == first.lease_id
    assert second.sandbox_name == "sbx-open-1"
    assert len(claim_client.active_claims) == 1
    assert first.direct_endpoint_url == "https://edge.dev.example/u/ws_brand_new"

    receipt = router.teardown_turn_sandbox(first.lease_id, owner_id="brand_new_owner")
    assert receipt.sandbox_terminated is True

    third = router.allocate_turn_sandbox(
        owner_id="brand_new_owner",
        workspace_id="ws_brand_new",
        billing_space_id="bs_brand_new",
    )
    assert third.lease_id != first.lease_id
    assert third.sandbox_name == "sbx-open-2"


def test_pod_private_key_file_zeroed_and_unlinked_after_durable_load(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    raw = secrets.token_bytes(32)
    b64 = base64.b64encode(raw).decode("ascii")
    key_file = tmp_path / ".pod_key_once"
    key_file.write_text(b64, encoding="utf-8")

    monkeypatch.setenv("HUSSH_POD_PRIVATE_KEY_FILE", str(key_file))
    monkeypatch.setenv("HUSSH_UNLINK_POD_PRIVATE_KEY_AFTER_LOAD", "1")
    reset_pod_keypair_cache_for_tests()

    payload = pod_public_key_payload()
    assert pod_key_is_durable() is True
    assert payload["podKeyId"].startswith("podk_")
    assert not key_file.exists()


def test_network_policy_optional_edge_vpc_cidr() -> None:
    base_policy = render_sandbox_network_policy()
    assert len(base_policy["spec"]["ingress"][0]["from"]) == 1

    vpc_policy = render_sandbox_network_policy(edge_vpc_cidr="10.128.0.0/20")
    ingress_from = vpc_policy["spec"]["ingress"][0]["from"]
    assert len(ingress_from) == 2
    assert ingress_from[1] == {"ipBlock": {"cidr": "10.128.0.0/20"}}

    with pytest.raises(ValueError, match="AGENT_SANDBOX_MANIFEST_INVALID"):
        render_sandbox_network_policy(edge_vpc_cidr="not-a-cidr")


class _LocalStandbyClaimClient(SandboxClaimPort):
    """Spins up real VirginStandbyRuntime instances on loopback for full HTTP/WS tests."""

    def __init__(self, tmp_dir: Path, activation_guard: str) -> None:
        self.tmp_dir = tmp_dir
        self.activation_guard = activation_guard
        self.runtimes: dict[str, tuple[VirginStandbyRuntime, Any]] = {}
        self.counter = 0
        self.deleted_claims: list[str] = []

    def create_and_wait_claim(
        self,
        *,
        claim_name: str,
        billing_space_id: str,
        warm_pool_name: str = "hussh-one-warm-pool",
        idle_shutdown_seconds: int = 600,
        timeout_s: float = 30.0,
    ) -> ClaimedSandboxEndpoint:
        self.counter += 1
        sandbox_name = f"sbx-live-{self.counter}"
        port = _free_port()
        holder: dict[str, Any] = {}

        def _launch_fake_pod(bind_host: str, target_port: int) -> None:
            reset_pod_keypair_cache_for_tests()
            pub_payload = pod_public_key_payload()
            assert pod_key_is_durable() is True
            assert not (self.tmp_dir / ".pod_key_once").exists()

            pod_app = FastAPI()

            @pod_app.get("/health")
            def health() -> dict[str, Any]:
                return {
                    "status": "ok",
                    "sandbox": sandbox_name,
                    "hushh_id": os.environ.get("HUSSH_ID"),
                    "deploy_env": os.environ.get("HUSHH_DEPLOY_ENV"),
                    **pub_payload,
                }

            @pod_app.websocket("/api/one/puppy/relay")
            async def relay(websocket: WebSocket) -> None:
                await websocket.accept()
                try:
                    while True:
                        msg = await websocket.receive_text()
                        await websocket.send_text(
                            json.dumps(
                                {
                                    "echo": msg,
                                    "sandbox": sandbox_name,
                                    "podKeyId": pub_payload["podKeyId"],
                                }
                            )
                        )
                except WebSocketDisconnect:
                    return

            config = uvicorn.Config(
                pod_app,
                host=bind_host or "127.0.0.1",
                port=target_port,
                log_level="error",
            )
            server = uvicorn.Server(config)
            holder["server"] = server
            server.run()

        runtime = VirginStandbyRuntime(
            bind_host="127.0.0.1",
            port=port,
            activation_guard=self.activation_guard,
            tmp_dir=self.tmp_dir,
            asgi_launcher=_launch_fake_pod,
            uid=10001,
        )
        runtime.start_background()
        self.runtimes[claim_name] = (runtime, holder)
        return ClaimedSandboxEndpoint(
            claim_name=claim_name,
            namespace="hussh-agents",
            sandbox_name=sandbox_name,
            pod_ip="127.0.0.1",
            port=runtime.port,
            ready=True,
        )

    def delete_claim(self, claim_name: str) -> None:
        self.deleted_claims.append(claim_name)
        pair = self.runtimes.pop(claim_name, None)
        if pair is not None:
            runtime, holder = pair
            srv = holder.get("server")
            if srv is not None:
                srv.should_exit = True
            runtime.stop()


async def test_edge_gateway_http_ws_continuity_internal_block_and_reaper(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("APP_SIGNING_KEY", raising=False)
    monkeypatch.delenv("POD_DURABLE_IDENTITY_ENABLED", raising=False)
    guard = "edge-activation-check-value-01"
    admin_check = "edge-admin-check-value-01"
    master_seed = b"S" * 32
    now_clock = {"t": 100.0}

    claim_client = _LocalStandbyClaimClient(tmp_path, activation_guard=guard)
    manager = SandboxEdgeGatewayManager(
        claim_client=claim_client,
        master_seed=master_seed,
        idle_timeout_s=10.0,
        activation_header_value=guard,
        admin_header_value=admin_check,
        pod_url_base="https://edge.dev.example",
        claim_timeout_s=15.0,
        health_poll_timeout_s=10.0,
        clock_s=lambda: now_clock["t"],
    )
    gw_app = create_sandbox_edge_gateway_app(manager, enable_reaper=False)
    gw_port = _free_port()
    gw_server = uvicorn.Server(
        uvicorn.Config(gw_app, host="127.0.0.1", port=gw_port, log_level="error")
    )
    gw_thread = threading.Thread(target=gw_server.run, daemon=True)
    gw_thread.start()

    try:
        base_http = f"http://127.0.0.1:{gw_port}"
        async with httpx.AsyncClient(timeout=10.0) as client:
            for _ in range(30):
                try:
                    hz = await client.get(f"{base_http}/health")
                    if hz.status_code == 200:
                        assert hz.json()["status"] == "edge_gateway_ready"
                        break
                except httpx.HTTPError:
                    await asyncio.sleep(0.1)
            else:
                pytest.fail("Edge gateway /health did not respond with 200")

            # Public clients cannot invoke /internal/* inside the sandbox via edge route.
            blocked = await client.post(
                f"{base_http}/u/owner_alice/internal/v1/activate-lease",
                json={},
            )
            assert blocked.status_code == 403
            assert blocked.json()["detail"]["code"] == SANDBOX_INTERNAL_PATH_FORBIDDEN

            # Wake #1 + concurrent HTTP request coalesce onto 1 sandbox instance.
            r1, r2 = await asyncio.gather(
                client.get(f"{base_http}/u/owner_alice/health"),
                client.get(f"{base_http}/u/owner_alice/health"),
            )
            assert r1.status_code == 200 and r2.status_code == 200
            b1 = r1.json()
            b2 = r2.json()
            assert b1["sandbox"] == "sbx-live-1"
            assert b2["sandbox"] == "sbx-live-1"
            key_id_1 = b1["podKeyId"]
            assert b1["podKeyId"] == r1.headers["x-hussh-pod-key-id"]
            assert len(os.environ.get("APP_SIGNING_KEY") or "") == 64
            assert os.environ.get("POD_DURABLE_IDENTITY_ENABLED") == "0"

            # Puppy bidirectional WebSocket frame relay keeps sandbox exempt from idle reap.
            ws_uri = f"ws://127.0.0.1:{gw_port}/u/owner_alice/api/one/puppy/relay"
            async with websockets.connect(ws_uri, open_timeout=5.0) as ws:
                await ws.send("ping-from-puppy")
                echoed = json.loads(await ws.recv())
                assert echoed["echo"] == "ping-from-puppy"
                assert echoed["sandbox"] == "sbx-live-1"
                assert echoed["podKeyId"] == key_id_1

                # Advance clock past idle_timeout while WS is active -> must NOT reap.
                now_clock["t"] = 200.0
                assert await manager.reap_idle_leases() == []
                assert manager.active_count() == 1

            # Wait briefly for WS close cleanup, then advance clock -> reaper destroys sandbox #1.
            for _ in range(20):
                lease = manager.get_lease("owner_alice")
                if lease is not None and lease.active_ws_count == 0:
                    break
                await asyncio.sleep(0.05)

            now_clock["t"] += 20.0
            reaped = await manager.reap_idle_leases()
            assert reaped == ["owner_alice"]
            assert manager.active_count() == 0

            # Wake #2 allocates brand-new sandbox instance yet preserves exact same podKeyId.
            r3 = await client.get(f"{base_http}/u/owner_alice/health")
            assert r3.status_code == 200
            b3 = r3.json()
            assert b3["sandbox"] == "sbx-live-2"
            assert b3["podKeyId"] == key_id_1

            # Cross-check HKDF derivation determinism helper matches HTTP observation.
            _, _, derived_kid = derive_owner_pod_identity(master_seed, "owner_alice")
            assert derived_kid == key_id_1

            # Admin teardown cleans up sandbox #2 cleanly.
            del_resp = await client.delete(
                f"{base_http}/internal/leases/owner_alice",
                headers={"X-Edge-Admin-Token": admin_check},
            )
            assert del_resp.status_code == 200
            assert del_resp.json()["released"] is True
            assert len(claim_client.deleted_claims) == 2
    finally:
        gw_server.should_exit = True
        gw_thread.join(timeout=3.0)
        for cname in list(claim_client.runtimes):
            claim_client.delete_claim(cname)


async def test_edge_gateway_propagates_deploy_env_to_virgin_standby(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("APP_SIGNING_KEY", raising=False)
    monkeypatch.delenv("POD_DURABLE_IDENTITY_ENABLED", raising=False)
    monkeypatch.delenv("HUSHH_DEPLOY_ENV", raising=False)

    guard = "uat-activation-check-value-01"
    claim_client = _LocalStandbyClaimClient(tmp_path, activation_guard=guard)
    manager = SandboxEdgeGatewayManager(
        claim_client=claim_client,
        master_seed=b"U" * 32,
        activation_header_value=guard,
        admin_header_value="uat-admin-token",
        deploy_env="uat",
        claim_timeout_s=15.0,
        health_poll_timeout_s=10.0,
    )
    gw_app = create_sandbox_edge_gateway_app(manager, enable_reaper=False)
    gw_port = _free_port()
    gw_server = uvicorn.Server(
        uvicorn.Config(gw_app, host="127.0.0.1", port=gw_port, log_level="error")
    )
    gw_thread = threading.Thread(target=gw_server.run, daemon=True)
    gw_thread.start()

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f"http://127.0.0.1:{gw_port}/u/owner_uat/health")
            assert resp.status_code == 200
            assert resp.json()["deploy_env"] == "uat"
            assert os.environ.get("HUSHH_DEPLOY_ENV") == "uat"
    finally:
        gw_server.should_exit = True
        gw_thread.join(timeout=3.0)
        for cname in list(claim_client.runtimes):
            claim_client.delete_claim(cname)


async def test_edge_gateway_cors_sse_sentinel_storage_activation_and_waking(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from hushh_mcp.services.agent_sandbox import SentinelControlClient, SentinelProxyRuntime

    monkeypatch.delenv("APP_SIGNING_KEY", raising=False)
    monkeypatch.delenv("POD_DURABLE_IDENTITY_ENABLED", raising=False)

    ctrl_token = "edge-sentinel-ctrl-value-012345"
    sentinel_runtime = SentinelProxyRuntime(
        hmac_key=b"E" * 32,
        control_token=ctrl_token,
        proxy_port=0,
        control_port=0,
        model_gateway_port=0,
    )
    sentinel_runtime.start_background()
    ctrl = SentinelControlClient(
        base_url=f"http://127.0.0.1:{sentinel_runtime.control_port}",
        control_token=ctrl_token,
    )

    class _StreamingClaimClient(_LocalStandbyClaimClient):
        def create_and_wait_claim(
            self,
            *,
            claim_name: str,
            billing_space_id: str,
            warm_pool_name: str = "hussh-one-warm-pool",
            idle_shutdown_seconds: int = 600,
            timeout_s: float = 30.0,
        ) -> ClaimedSandboxEndpoint:
            self.counter += 1
            sandbox_name = f"sbx-stream-{self.counter}"
            port = _free_port()
            holder: dict[str, Any] = {}

            def _launch_fake_pod(bind_host: str, target_port: int) -> None:
                from starlette.responses import StreamingResponse

                reset_pod_keypair_cache_for_tests()
                pod_app = FastAPI()

                @pod_app.get("/health")
                def health() -> dict[str, Any]:
                    return {
                        "status": "ok",
                        "sandbox": sandbox_name,
                        "durable": os.environ.get("POD_DURABLE_IDENTITY_ENABLED"),
                        "storage_backend": os.environ.get("POD_STORAGE_BACKEND"),
                        "prefix_url": os.environ.get("POD_STORAGE_PREFIX_TOKEN_URL"),
                        "gw_url": os.environ.get("HUSSH_MODEL_GATEWAY_URL"),
                        "has_surrogate": bool(os.environ.get("HUSSH_MODEL_GATEWAY_TOKEN")),
                        "turn_enabled": os.environ.get("HUSSH_POD_TURN_ENABLED"),
                    }

                @pod_app.post("/api/one/turn/stream")
                async def stream_turn() -> StreamingResponse:
                    async def _gen():
                        yield b'event: token\ndata: {"t":"hi"}\n\n'
                        yield b"event: done\ndata: {}\n\n"

                    return StreamingResponse(_gen(), media_type="text/event-stream")

                cfg = uvicorn.Config(
                    pod_app, host=bind_host or "127.0.0.1", port=target_port, log_level="error"
                )
                srv = uvicorn.Server(cfg)
                holder["server"] = srv
                srv.run()

            runtime = VirginStandbyRuntime(
                bind_host="127.0.0.1",
                port=port,
                activation_guard=self.activation_guard,
                tmp_dir=self.tmp_dir,
                asgi_launcher=_launch_fake_pod,
                uid=10001,
            )
            runtime.start_background()
            self.runtimes[claim_name] = (runtime, holder)
            return ClaimedSandboxEndpoint(
                claim_name=claim_name,
                namespace="hussh-agents",
                sandbox_name=sandbox_name,
                pod_ip="127.0.0.1",
                port=runtime.port,
                ready=True,
            )

    claim_client = _StreamingClaimClient(tmp_path, activation_guard="edge-act-stream-01")
    manager = SandboxEdgeGatewayManager(
        claim_client=claim_client,
        master_seed=b"E" * 32,
        sentinel_control=ctrl,
        activation_header_value="edge-act-stream-01",
        admin_header_value="edge-admin-stream-01",
        pod_url_base="https://edge.dev.example",
        hub_url="https://dev.api.hussh.ai",
        deploy_env="dev",
        consent_ed25519_public_keys='{"kid1":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}',
        allowed_app_origins=["https://dev.one.hussh.ai"],
        sentinel_model_gateway_url=f"http://127.0.0.1:{sentinel_runtime.model_gateway_port}",
        sentinel_vertex_project="hushh-pda-dev",
        sentinel_vertex_location="global",
        enable_prefix_storage=True,
        claim_timeout_s=15.0,
        health_poll_timeout_s=10.0,
    )
    gw_app = create_sandbox_edge_gateway_app(manager, enable_reaper=False)
    gw_port = _free_port()
    gw_server = uvicorn.Server(
        uvicorn.Config(gw_app, host="127.0.0.1", port=gw_port, log_level="error")
    )
    gw_thread = threading.Thread(target=gw_server.run, daemon=True)
    gw_thread.start()

    try:
        base_http = f"http://127.0.0.1:{gw_port}"
        async with httpx.AsyncClient(timeout=10.0) as client:
            for _ in range(30):
                try:
                    if (await client.get(f"{base_http}/health")).status_code == 200:
                        break
                except httpx.HTTPError:
                    await asyncio.sleep(0.05)

            # 1. Preflight OPTIONS succeeds 204 without claiming a sandbox
            opt = await client.options(
                f"{base_http}/u/owner_cors/api/one/turn/stream",
                headers={
                    "Origin": "https://dev.one.hussh.ai",
                    "Access-Control-Request-Headers": "Authorization, Content-Type",
                },
            )
            assert opt.status_code == 204
            assert opt.headers["access-control-allow-origin"] == "https://dev.one.hussh.ai"
            assert manager.active_count() == 0

            # 2. First GET claims sandbox, pushes Sentinel policy+surrogate, and wires durable GCS gateway
            h1 = await client.get(
                f"{base_http}/u/owner_cors/health",
                headers={"Origin": "https://dev.one.hussh.ai"},
            )
            assert h1.status_code == 200
            assert h1.headers["access-control-allow-origin"] == "https://dev.one.hussh.ai"
            body = h1.json()
            assert body["durable"] == "1"
            assert body["storage_backend"] == "commit_log"
            assert (
                body["prefix_url"]
                == "https://dev.api.hussh.ai/api/one/pod/storage-gateway/pods/owner_cors"
            )
            assert body["has_surrogate"] is True
            assert body["turn_enabled"] == "true"
            assert sentinel_runtime.lease_for_ip("127.0.0.1")[1] == "owner_cors"

            # 3. SSE streams cleanly
            sse = await client.post(
                f"{base_http}/u/owner_cors/api/one/turn/stream",
                headers={"Origin": "https://dev.one.hussh.ai"},
            )
            assert sse.status_code == 200
            assert "event: token" in sse.text and "event: done" in sse.text

            # 4. Simulate sandbox pod crash -> Edge evicts stale lease and transparently re-wakes
            lease = manager.get_lease("owner_cors")
            assert lease is not None
            claim_client.delete_claim(lease.claim_name)
            h2 = await client.get(
                f"{base_http}/u/owner_cors/health",
                headers={"Origin": "https://dev.one.hussh.ai"},
            )
            assert h2.status_code == 200
            assert h2.json()["sandbox"] == "sbx-stream-2"

            # 5. Claim failure returns 503 SANDBOX_WAKING + X-Hussh-Pod-State: waking + CORS headers
            await manager.release_owner_lease("owner_cors")

            def _boom(**_kw):
                raise TimeoutError("pool scaling")

            monkeypatch.setattr(claim_client, "create_and_wait_claim", _boom)
            waking = await client.get(
                f"{base_http}/u/owner_cors/health",
                headers={"Origin": "https://dev.one.hussh.ai"},
            )
            assert waking.status_code == 503
            assert waking.headers["x-hussh-pod-state"] == "waking"
            assert waking.headers["access-control-allow-origin"] == "https://dev.one.hussh.ai"
            assert waking.json()["code"] == "SANDBOX_WAKING"
    finally:
        gw_server.should_exit = True
        gw_thread.join(timeout=3.0)
        for cname in list(claim_client.runtimes):
            claim_client.delete_claim(cname)
        sentinel_runtime.stop()
