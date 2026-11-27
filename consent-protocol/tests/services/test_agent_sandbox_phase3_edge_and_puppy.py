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
        "HUSSH_POD_MIGRATION_ENABLED",
        "HUSSH_POD_TICK_AUDIENCE",
        "POD_AGENT_MEMORY_ENABLED",
        "POD_DIRECTIVE_TRANSPORT_ENABLED",
        "HUSSH_POD_BROWSER_ENABLED",
        "POD_DATA_DOOR_ENABLED",
        "GOOGLE_GENAI_USE_VERTEXAI",
        "ACE_SANDBOX_ID",
        "ENVIRONMENT",
        "HUSSH_POD_METADATA_IDENTITY_DISABLED",
        "POD_HOST_KIND",
        "POD_FILES_ENABLED",
        "HUSSH_POD_FILES_ENABLED",
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
            port=0,
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
        health_poll_timeout_s=15.0,
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
                        "ios_client": os.environ.get("GOOGLE_IOS_CONNECTOR_CLIENT_ID"),
                        "durable": os.environ.get("POD_DURABLE_IDENTITY_ENABLED"),
                        "storage_backend": os.environ.get("POD_STORAGE_BACKEND"),
                        "prefix_url": os.environ.get("POD_STORAGE_PREFIX_TOKEN_URL"),
                        "gw_url": os.environ.get("HUSSH_MODEL_GATEWAY_URL"),
                        "has_surrogate": bool(os.environ.get("HUSSH_MODEL_GATEWAY_TOKEN")),
                        "turn_enabled": os.environ.get("HUSSH_POD_TURN_ENABLED"),
                        "migration_enabled": os.environ.get("HUSSH_POD_MIGRATION_ENABLED"),
                        "tick_audience": os.environ.get("HUSSH_POD_TICK_AUDIENCE"),
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
                port=0,
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
        ios_connector_client_id="123456789-testclient.apps.googleusercontent.com",
        allowed_app_origins=["https://dev.one.hussh.ai"],
        sentinel_model_gateway_url=f"http://127.0.0.1:{sentinel_runtime.model_gateway_port}",
        sentinel_vertex_project="hushh-pda-dev",
        sentinel_vertex_location="global",
        enable_prefix_storage=True,
        claim_timeout_s=15.0,
        health_poll_timeout_s=15.0,
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
            assert body["ios_client"] == "123456789-testclient.apps.googleusercontent.com"
            assert body["durable"] == "1"
            assert body["storage_backend"] == "commit_log"
            assert (
                body["prefix_url"]
                == "https://dev.api.hussh.ai/api/one/pod/storage-gateway/pods/owner_cors"
            )
            assert body["has_surrogate"] is True
            assert body["turn_enabled"] == "true"
            assert body["migration_enabled"] == "true"
            assert body["tick_audience"] == "https://edge.dev.example/u/owner_cors"
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


def test_virgin_standby_prewarm_and_hub_broker_activation_envs(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Standby prewarm must succeed without APP_SIGNING_KEY and set zero-metadata + Files envs."""
    from hushh_mcp.services.agent_sandbox.virgin_standby import prewarm_runtime_imports

    monkeypatch.delenv("APP_SIGNING_KEY", raising=False)
    prewarm_runtime_imports()

    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey

    priv = X25519PrivateKey.generate()
    priv_b64 = base64.b64encode(
        priv.private_bytes(
            serialization.Encoding.Raw,
            serialization.PrivateFormat.Raw,
            serialization.NoEncryption(),
        )
    ).decode("ascii")

    launched: dict[str, Any] = {}

    def _capture_launcher(host: str, port: int) -> None:
        launched["host"] = host
        launched["port"] = port
        launched["metadata_disabled"] = os.environ.get("HUSSH_POD_METADATA_IDENTITY_DISABLED")
        launched["files_enabled"] = os.environ.get("POD_FILES_ENABLED")
        launched["host_kind"] = os.environ.get("POD_HOST_KIND")

    runtime = VirginStandbyRuntime(
        bind_host="127.0.0.1",
        port=0,
        tmp_dir=tmp_path,
        asgi_launcher=_capture_launcher,
        uid=10001,
    )
    runtime.start_background()
    try:
        with httpx.Client(timeout=5.0) as client:
            assert client.get(f"http://127.0.0.1:{runtime.port}/health").status_code == 200
            assert client.get(f"http://127.0.0.1:{runtime.port}/healthz").status_code == 200
            act = client.post(
                f"http://127.0.0.1:{runtime.port}/internal/v1/activate-lease",
                json={
                    "hushh_id": "ha1_prewarm_check",
                    "owner_id": "owner-prewarm",
                    "lease_id": "lease_prewarm",
                    "pod_private_key_b64": priv_b64,
                    "sandbox_name": "sbx-prewarm",
                    "pod_storage_prefix_token_url": (
                        "https://dev.api.hussh.ai/api/one/pod/storage-gateway/pods/ha1_prewarm_check"
                    ),
                },
            )
            assert act.status_code == 200
    finally:
        runtime.stop()

    assert launched.get("metadata_disabled") == "1"
    assert launched.get("files_enabled") == "true"
    assert launched.get("host_kind") == "gcp_ace"


@pytest.mark.asyncio
async def test_edge_gateway_fails_fast_on_blackholed_pod_ip_and_rotates_expiring_claims(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Dead/blackholed pod IPs fail over in <= proxy_connect_timeout_s (never 127s TCP SYN hang)
    and claims approaching K8s wall-clock shutdownTime extend or proactively rotate."""
    import time

    now = [1000.0]
    extended_claims: list[str] = []
    allow_extend = [True]

    class _LifecycleClaimClient(_LocalStandbyClaimClient):
        def extend_claim_shutdown(
            self, claim_name: str, *, idle_shutdown_seconds: int = 600
        ) -> bool:
            extended_claims.append(claim_name)
            return allow_extend[0]

    claim_client = _LifecycleClaimClient(tmp_path, activation_guard="edge-act-fast-01")
    manager = SandboxEdgeGatewayManager(
        claim_client=claim_client,
        master_seed=b"F" * 32,
        idle_timeout_s=600.0,
        activation_header_value="edge-act-fast-01",
        admin_header_value="edge-admin-fast-01",
        claim_timeout_s=15.0,
        health_poll_timeout_s=15.0,
        proxy_connect_timeout_s=0.35,
        clock_s=lambda: now[0],
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

            # 1. Initial request creates lease and uses pooled proxy client with fast connect timeout
            r1 = await client.get(f"{base_http}/u/owner_fast/health")
            assert r1.status_code == 200
            assert r1.json()["sandbox"] == "sbx-live-1"
            proxy_client = manager._proxy_http_client
            assert proxy_client is not None
            assert proxy_client.timeout.connect == pytest.approx(0.35)
            # Matches SandboxEdgeGatewayManager default (240.0s, exceeding the 230s+ AG-UI turn window).
            assert proxy_client.timeout.read == pytest.approx(240.0)

            # Second warm request reuses the exact same pooled client instance
            r2 = await client.get(f"{base_http}/u/owner_fast/health")
            assert r2.status_code == 200
            assert manager._proxy_http_client is proxy_client

            # 2. Simulate silent TCP SYN blackhole on cached lease IP -> must fail fast (< 2s) and recover
            lease1 = manager.get_lease("owner_fast")
            assert lease1 is not None
            stale_port = lease1.port
            real_send = proxy_client.send

            async def _blackhole_once(
                req: httpx.Request, *args: Any, **kwargs: Any
            ) -> httpx.Response:
                if req.url.port == stale_port:
                    await asyncio.sleep(0.1)
                    raise httpx.ConnectTimeout("simulated VPC blackhole timeout")
                return await real_send(req, *args, **kwargs)

            monkeypatch.setattr(proxy_client, "send", _blackhole_once)
            t0 = time.monotonic()
            r3 = await client.get(f"{base_http}/u/owner_fast/health")
            elapsed = time.monotonic() - t0
            assert r3.status_code == 200
            assert r3.json()["sandbox"] == "sbx-live-2"
            assert elapsed < 5.0
            monkeypatch.setattr(proxy_client, "send", real_send)

            # 3. Approaching claim_expires_at_s extends claim in place when supported
            lease2 = manager.get_lease("owner_fast")
            assert lease2 is not None
            initial_exp = lease2.claim_expires_at_s
            assert initial_exp > now[0]
            now[0] = initial_exp - 60.0
            r4 = await client.get(f"{base_http}/u/owner_fast/health")
            assert r4.status_code == 200
            assert r4.json()["sandbox"] == "sbx-live-2"
            assert lease2.claim_name in extended_claims
            assert lease2.claim_expires_at_s > initial_exp

            # 4. When extension is unsupported/fails near expiry, Edge proactively rotates BEFORE K8s kills pod
            allow_extend[0] = False
            now[0] = lease2.claim_expires_at_s - 10.0
            r5 = await client.get(f"{base_http}/u/owner_fast/health")
            assert r5.status_code == 200
            assert r5.json()["sandbox"] == "sbx-live-3"
    finally:
        gw_server.should_exit = True
        gw_thread.join(timeout=3.0)
        for cname in list(claim_client.runtimes):
            claim_client.delete_claim(cname)


@pytest.mark.asyncio
async def test_edge_gateway_aborts_crashed_pod_in_under_2s_and_replaces_dead_standby(
    tmp_path: Path,
) -> None:
    """Crashed post-activation sandboxes abort in <2s with SANDBOX_HYDRATION_FAILED instead of
    blind 25s /health polling, while dead pre-activation standby pods auto-replace cleanly."""
    import time

    class _MixedStandbyClaimClient(_LocalStandbyClaimClient):
        def __init__(self, root: Path, *, activation_guard: str) -> None:
            super().__init__(root, activation_guard=activation_guard)
            self.terminated: dict[str, str] = {}

        def inspect_pod_termination(self, sandbox_name: str) -> str | None:
            return self.terminated.get(sandbox_name)

        def create_and_wait_claim(
            self,
            *,
            claim_name: str,
            billing_space_id: str,
            warm_pool_name: str = "hussh-one-warm-pool",
            idle_shutdown_seconds: int = 600,
            timeout_s: float = 30.0,
        ) -> ClaimedSandboxEndpoint:
            if self.counter == 0:
                self.counter += 1
                sandbox_name = f"sbx-crash-{self.counter}"
                crashed_runtime = VirginStandbyRuntime(
                    bind_host="127.0.0.1",
                    port=0,
                    activation_guard=self.activation_guard,
                    tmp_dir=self.tmp_dir / f"crash-{self.counter}",
                    asgi_launcher=lambda _h, _p: self.terminated.__setitem__(
                        sandbox_name, "ContainerTerminated:Error:1"
                    ),
                    uid=10001,
                )
                crashed_runtime.start_background()
                self.runtimes[claim_name] = (crashed_runtime, {})
                return ClaimedSandboxEndpoint(
                    claim_name=claim_name,
                    namespace="hussh-agents",
                    sandbox_name=sandbox_name,
                    pod_ip="127.0.0.1",
                    port=crashed_runtime.port,
                    ready=True,
                )
            if self.counter == 1:
                self.counter += 1
                sandbox_name = f"sbx-dead-pre-{self.counter}"
                dead_port = _free_port()
                self.terminated[sandbox_name] = "PodDeleted"
                return ClaimedSandboxEndpoint(
                    claim_name=claim_name,
                    namespace="hussh-agents",
                    sandbox_name=sandbox_name,
                    pod_ip="127.0.0.1",
                    port=dead_port,
                    ready=True,
                )
            return super().create_and_wait_claim(
                claim_name=claim_name,
                billing_space_id=billing_space_id,
                warm_pool_name=warm_pool_name,
                idle_shutdown_seconds=idle_shutdown_seconds,
                timeout_s=timeout_s,
            )

    claim_client = _MixedStandbyClaimClient(tmp_path, activation_guard="edge-act-crash-01")
    manager = SandboxEdgeGatewayManager(
        claim_client=claim_client,
        master_seed=b"C" * 32,
        idle_timeout_s=600.0,
        activation_header_value="edge-act-crash-01",
        admin_header_value="edge-admin-crash-01",
        claim_timeout_s=15.0,
        health_poll_timeout_s=25.0,
        proxy_connect_timeout_s=0.35,
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

            t0 = time.monotonic()
            r_crash = await client.get(f"{base_http}/u/owner_crash/health")
            crash_elapsed = time.monotonic() - t0
            assert r_crash.status_code == 503
            assert r_crash.headers.get("x-hussh-pod-state") == "unavailable"
            assert r_crash.json()["detail"]["code"] == "SANDBOX_HYDRATION_FAILED"
            assert crash_elapsed < 2.5
            assert len(claim_client.deleted_claims) == 1

            t1 = time.monotonic()
            r_heal = await client.get(f"{base_http}/u/owner_heal/health")
            heal_elapsed = time.monotonic() - t1
            assert r_heal.status_code == 200
            assert r_heal.json()["sandbox"] == "sbx-live-3"
            assert heal_elapsed < 4.0
            assert len(claim_client.deleted_claims) == 2
    finally:
        gw_server.should_exit = True
        gw_thread.join(timeout=3.0)
        for cname in list(claim_client.runtimes):
            claim_client.delete_claim(cname)


def test_dev_hub_sandbox_custody_bootstrap_fences_lanes_and_hydrates_without_hardcoded_hashes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Dev Hub startup self-hydrates missing ACE custody bindings from Secret Manager while
    keeping UAT, Prod, commerce previews, pod_mode, and explicit kill-switches 100% untouched."""
    from hushh_mcp.services.dev_sandbox_custody_bootstrap import (
        bootstrap_dev_hub_sandbox_custody,
        derive_sibling_edge_gateway_url,
    )

    monkeypatch.delenv("HUSSH_POD_MODE", raising=False)
    assert (
        derive_sibling_edge_gateway_url("https://consent-protocol-xyz123-uc.a.run.app")
        == "https://sandbox-edge-gateway-xyz123-uc.a.run.app"
    )
    assert derive_sibling_edge_gateway_url("http://consent-protocol-xyz123.a.run.app") == ""

    secrets_map = {
        "hussh-custody-broker-seal-key": "seal_secret_material_value_for_test",  # pragma: allowlist secret
        "sandbox-edge-identity-master-key": "m" * 48,  # pragma: allowlist secret
    }

    dev_env = {
        "HUSHH_DEPLOY_ENV": "dev",
        "ENVIRONMENT": "dev",
        "K_SERVICE": "consent-protocol",
        "GOOGLE_CLOUD_PROJECT": "hushh-pda-dev",
        "CONSENT_API_PUBLIC_ORIGIN": "https://consent-protocol-xyz123-uc.a.run.app",
    }
    res = bootstrap_dev_hub_sandbox_custody(
        environ=dev_env,
        allow_in_tests=True,
        token_fetcher=lambda: "fake-adc-token",
        secret_fetcher=lambda _proj, name, _tok: secrets_map[name],
        edge_probe=lambda url: url == "https://sandbox-edge-gateway-xyz123-uc.a.run.app",
    )
    assert res["bootstrapped"] is True
    assert dev_env["HUSSH_AGENT_SANDBOX_CUTOVER_ENABLED"] == "1"
    assert (
        dev_env["HUSSH_SANDBOX_EDGE_PUBLIC_URL"]
        == "https://sandbox-edge-gateway-xyz123-uc.a.run.app"
    )
    assert (
        dev_env["HUSSH_HUB_STORAGE_PREFIX_BASE_URL"]
        == "https://consent-protocol-xyz123-uc.a.run.app/api/one/pod/storage-gateway"
    )
    assert dev_env["HUSSH_HUB_STORAGE_TOKEN_PROVIDER"] == "ace_prefix_bearer"
    assert dev_env["HUSSH_POD_STORAGE_GATEWAY_GCS_BUCKET"] == "hussh-hosted-pods-dev"
    assert dev_env["HUSSH_SOURCE_POD_RETIREMENT_SWEEP_ENABLED"] == "true"
    assert dev_env["HUSSH_CUSTODY_BROKER_SEAL_KEY"] == secrets_map["hussh-custody-broker-seal-key"]
    assert (
        dev_env["HUSSH_SANDBOX_IDENTITY_MASTER_KEY"]
        == secrets_map["sandbox-edge-identity-master-key"]
    )

    for neg_env in (
        {**dev_env, "HUSHH_DEPLOY_ENV": "uat", "ENVIRONMENT": "uat"},
        {**dev_env, "HUSHH_DEPLOY_ENV": "production", "ENVIRONMENT": "production"},
        {**dev_env, "K_SERVICE": "scope-commerce-sandbox-consent-protocol"},
        {**dev_env, "HUSSH_AGENT_SANDBOX_CUTOVER_ENABLED": "0"},
    ):
        clean_neg = {
            k: v
            for k, v in neg_env.items()
            if k
            in {
                "HUSHH_DEPLOY_ENV",
                "ENVIRONMENT",
                "K_SERVICE",
                "GOOGLE_CLOUD_PROJECT",
                "CONSENT_API_PUBLIC_ORIGIN",
                "HUSSH_AGENT_SANDBOX_CUTOVER_ENABLED",
            }
        }
        verdict = bootstrap_dev_hub_sandbox_custody(
            environ=clean_neg,
            allow_in_tests=True,
            token_fetcher=lambda: pytest.fail("must not fetch metadata token on fenced lanes"),
        )
        assert verdict["bootstrapped"] is False
        assert "HUSSH_CUSTODY_BROKER_SEAL_KEY" not in clean_neg


@pytest.mark.asyncio
async def test_sentinel_shared_oauth_and_plaid_gate_keeps_pod_single_container(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Sentinel :8082 mediates Google Web OAuth (.si) and Plaid Vault with IP-bound surrogates."""
    from hushh_mcp.services.agent_sandbox.sentinel_proxy_server import SentinelProxyRuntime

    web_cid = "9876543210-webclient9999.apps.googleusercontent.com"
    monkeypatch.setenv("GOOGLE_WEB_OAUTH_CLIENT_ID", web_cid)
    monkeypatch.setenv("GOOGLE_WEB_OAUTH_CLIENT_SECRET", "test_sentinel_oauth_secret_fixture")
    monkeypatch.setenv("PLAID_ENV", "sandbox")
    monkeypatch.setenv("PLAID_CLIENT_ID", "plaid_cid_test")
    monkeypatch.setenv("PLAID_SANDBOX_SECRET", "plaid_sandbox_secret_test")

    captured_upstreams: list[tuple[str, str, bytes]] = []

    def _fake_upstream(
        url: str, method: str, _headers: dict[str, str], body: bytes
    ) -> tuple[int, dict[str, str], bytes]:
        captured_upstreams.append((url, method, body))
        if url == "https://oauth2.googleapis.com/token":
            resp = {
                "access_token": "ya29.test_access",
                "refresh_token": "1//test_refresh",
                "scope": "openid email https://www.googleapis.com/auth/gmail.modify",
                "expires_in": 3599,
                "internal_debug": "must_strip",
            }
            return 200, {"Content-Type": "application/json"}, json.dumps(resp).encode("utf-8")
        if url == "https://sandbox.plaid.com/link/token/create":
            return (
                200,
                {"Content-Type": "application/json"},
                json.dumps(
                    {"link_token": "link-sandbox-ok", "expiration": "2026-12-01T00:00:00Z"}
                ).encode("utf-8"),
            )
        return 404, {"Content-Type": "application/json"}, b"{}"

    sentinel_runtime = SentinelProxyRuntime(
        hmac_key=b"S" * 32,
        control_token="ctrl-oauth-plaid-token-01",  # noqa: S106 - synthetic test control token
        audit_log_path=tmp_path / "sentinel_oauth_plaid.jsonl",
        proxy_port=0,
        control_port=0,
        model_gateway_port=0,
        upstream_transport=_fake_upstream,
    )
    sentinel_runtime.start_background()
    try:
        sentinel_runtime.set_lease_policy(
            "lease-oauth-1", {}, owner_id="ha1_owner_si", pod_ip="127.0.0.1"
        )
        surrogate, _ = sentinel_runtime.mint_model_surrogate(
            lease_id="lease-oauth-1", owner_id="ha1_owner_si"
        )
        gw_base = f"http://127.0.0.1:{sentinel_runtime.model_gateway_port}"
        auth_headers = {"Authorization": f"Bearer {surrogate}"}

        async with httpx.AsyncClient(timeout=5.0, trust_env=False) as client:
            # Negative control 1: unauthenticated call rejected 401
            unauth = await client.get(f"{gw_base}/v1/oauth/google/ready")
            assert unauth.status_code == 401

            # Positive 1: OAuth ready returns public clientId only
            ready = await client.get(f"{gw_base}/v1/oauth/google/ready", headers=auth_headers)
            assert ready.status_code == 200
            assert ready.json() == {"clientId": web_cid}
            assert ready.headers.get("cache-control") == "no-store"

            # Positive 2: OAuth exchange on canonical one.hussh.si attaches secret & strips extras
            exch = await client.post(
                f"{gw_base}/v1/oauth/google/exchange",
                headers=auth_headers,
                json={
                    "grant_type": "authorization_code",
                    "client_id": web_cid,
                    "code": "4/0AeanS0code",
                    "redirect_uri": "https://one.hussh.si",
                },
            )
            assert exch.status_code == 200
            exch_body = exch.json()
            assert exch_body["access_token"] == "ya29.test_access"
            assert "internal_debug" not in exch_body
            assert b"test_sentinel_oauth_secret_fixture" in captured_upstreams[-1][2]

            # Negative control 2: contacts scope or untrusted origin refused before upstream
            bad_origin = await client.post(
                f"{gw_base}/v1/oauth/google/exchange",
                headers=auth_headers,
                json={
                    "grant_type": "authorization_code",
                    "client_id": web_cid,
                    "code": "4/0AeanS0code",
                    "redirect_uri": "https://evil.hussh.si",
                },
            )
            assert bad_origin.status_code == 400

            bad_scope = await client.post(
                f"{gw_base}/v1/oauth/google/exchange",
                headers=auth_headers,
                json={
                    "grant_type": "refresh_token",
                    "client_id": web_cid,
                    "refresh_token": "1//refresh",
                    "scope": "https://www.googleapis.com/auth/contacts.readonly",
                },
            )
            assert bad_scope.status_code == 400

            # Positive 3: Plaid proxy injects HMAC client_user_id + sandbox secret
            plaid_ready = await client.get(f"{gw_base}/v1/plaid/ready", headers=auth_headers)
            assert plaid_ready.status_code == 200
            assert plaid_ready.json() == {"environment": "sandbox"}

            plaid_resp = await client.post(
                f"{gw_base}/v1/plaid/proxy",
                headers=auth_headers,
                json={
                    "path": "/link/token/create",
                    "payload": {"client_name": "hussh One", "user": {"client_user_id": "forged"}},
                },
            )
            assert plaid_resp.status_code == 200
            assert plaid_resp.json()["link_token"] == "link-sandbox-ok"
            sent_plaid = json.loads(captured_upstreams[-1][2].decode("utf-8"))
            assert sent_plaid["secret"] == "plaid_sandbox_secret_test"
            assert sent_plaid["user"]["client_user_id"].startswith("hv1_")
            assert sent_plaid["user"]["client_user_id"] != "forged"

            # Negative control 3: unapproved Plaid path rejected 403
            bad_plaid = await client.post(
                f"{gw_base}/v1/plaid/proxy",
                headers=auth_headers,
                json={"path": "/processor/token/create", "payload": {}},
            )
            assert bad_plaid.status_code == 403

        events = [
            e["event_type"] for e in sentinel_runtime.audit_sink.entries_for_lease("lease-oauth-1")
        ]
        assert "OAUTH_WEB_EXCHANGE" in events
        assert "PLAID_GATEWAY_INVOKE" in events
    finally:
        sentinel_runtime.stop()
