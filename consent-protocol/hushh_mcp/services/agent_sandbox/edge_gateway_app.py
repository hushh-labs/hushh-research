# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Stateless per-owner TLS Edge Gateway for disposable GKE sandboxes (#9744)."""

from __future__ import annotations

import asyncio
import base64
import contextlib
import hashlib
import hmac
import os
import re
import secrets
import time
from collections.abc import Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

import httpx
import websockets
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from fastapi import FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from websockets.exceptions import ConnectionClosed, InvalidStatus

from hushh_mcp.services.agent_sandbox.k8s_claim_allocator import (
    ClaimedSandboxEndpoint,
    LiveK8sSandboxClaimClient,
    SandboxClaimPort,
    SentinelControlClient,
)

SANDBOX_INTERNAL_PATH_FORBIDDEN = "SANDBOX_INTERNAL_PATH_FORBIDDEN"
SANDBOX_OWNER_ID_INVALID = "SANDBOX_OWNER_ID_INVALID"
_OWNER_ID_RE = re.compile(r"^[a-zA-Z0-9_-]{1,128}$")
_POD_IDENTITY_SALT = b"hussh-sandbox-pod-identity-v1"
_HOP_BY_HOP_HEADERS = frozenset(
    {
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailers",
        "transfer-encoding",
        "upgrade",
        "content-length",
        "host",
    }
)


def derive_owner_pod_identity(master_seed: bytes, hushh_id: str) -> tuple[str, str, str]:
    """Derive a permanent X25519 identity pair for one owner across disposable sandboxes."""
    clean_id = str(hushh_id or "").strip()
    if not _OWNER_ID_RE.fullmatch(clean_id):
        raise ValueError(f"{SANDBOX_OWNER_ID_INVALID}: invalid owner identifier")
    if len(master_seed) < 32:
        raise ValueError("Edge gateway master seed must be at least 32 bytes")
    derived = bytearray(
        HKDF(
            algorithm=hashes.SHA256(),
            length=32,
            salt=_POD_IDENTITY_SALT,
            info=clean_id.encode("utf-8"),
        ).derive(master_seed)
    )
    try:
        raw_bytes = bytes(derived)
        priv_b64 = base64.b64encode(raw_bytes).decode("ascii")
        priv = X25519PrivateKey.from_private_bytes(raw_bytes)
        pub_b64 = base64.b64encode(
            priv.public_key().public_bytes(
                encoding=serialization.Encoding.Raw,
                format=serialization.PublicFormat.Raw,
            )
        ).decode("ascii")
        pod_key_id = f"podk_{hashlib.sha256(pub_b64.encode('utf-8')).hexdigest()[:32]}"
        return priv_b64, pub_b64, pod_key_id
    finally:
        for i in range(len(derived)):
            derived[i] = 0


@dataclass
class ActiveOwnerLease:
    hushh_id: str
    lease_id: str
    claim_name: str
    sandbox_name: str
    pod_ip: str
    port: int
    pod_key_id: str
    pod_public_key: str
    last_activity_s: float
    active_ws_count: int = 0


def _endpoint_scheme(endpoint: ClaimedSandboxEndpoint) -> str:
    return "http"


class SandboxEdgeGatewayManager:
    """Coalesces concurrent owner requests onto 1 active sandbox and reaps idle leases."""

    def __init__(
        self,
        *,
        claim_client: SandboxClaimPort,
        master_seed: bytes,
        sentinel_control: SentinelControlClient | None = None,
        warm_pool_name: str = "hussh-one-warm-pool",
        idle_timeout_s: float = 600.0,
        activation_header_value: str | None = None,
        admin_header_value: str | None = None,
        pod_url_base: str | None = None,
        hub_url: str | None = None,
        scheduler_caller_emails: str | None = None,
        deploy_env: str | None = None,
        claim_timeout_s: float = 180.0,
        health_poll_timeout_s: float = 90.0,
        clock_s: Callable[[], float] | None = None,
    ) -> None:
        if len(master_seed) < 32:
            raise ValueError("Edge gateway master_seed must be at least 32 bytes")
        self.claim_client = claim_client
        self._master_seed = bytearray(master_seed)
        self.sentinel_control = sentinel_control
        self.warm_pool_name = warm_pool_name
        self.idle_timeout_s = max(1.0, float(idle_timeout_s))
        self._activation_guard = (activation_header_value or "").strip()
        self.admin_header_value = (admin_header_value or "").strip()
        self.pod_url_base = (pod_url_base or "").strip().rstrip("/")
        self.hub_url = (hub_url or "").strip().rstrip("/")
        self.scheduler_caller_emails = (scheduler_caller_emails or "").strip()
        self.deploy_env = (deploy_env or "").strip().lower()
        self.claim_timeout_s = float(claim_timeout_s)
        self.health_poll_timeout_s = float(health_poll_timeout_s)
        self._clock_s = clock_s or time.monotonic
        self._leases: dict[str, ActiveOwnerLease] = {}
        self._owner_locks: dict[str, asyncio.Lock] = {}

    def _lock_for(self, hushh_id: str) -> asyncio.Lock:
        lock = self._owner_locks.get(hushh_id)
        if lock is None:
            lock = asyncio.Lock()
            self._owner_locks[hushh_id] = lock
        return lock

    def active_count(self) -> int:
        return len(self._leases)

    def get_lease(self, hushh_id: str) -> ActiveOwnerLease | None:
        return self._leases.get(hushh_id)

    async def _activate_claimed_sandbox(
        self,
        *,
        hushh_id: str,
        lease_id: str,
        endpoint: ClaimedSandboxEndpoint,
    ) -> tuple[str, str]:
        priv_b64, pub_b64, pod_key_id = derive_owner_pod_identity(
            bytes(self._master_seed), hushh_id
        )
        base_url = f"{_endpoint_scheme(endpoint)}://{endpoint.pod_ip}:{endpoint.port}"
        payload: dict[str, str] = {
            "hushh_id": hushh_id,
            "owner_id": hushh_id,
            "lease_id": lease_id,
            "pod_private_key_b64": priv_b64,
        }
        if self.pod_url_base:
            payload["pod_url"] = f"{self.pod_url_base}/u/{hushh_id}"
        if self.hub_url:
            payload["hub_url"] = self.hub_url
        if self.scheduler_caller_emails:
            payload["scheduler_caller_emails"] = self.scheduler_caller_emails
        if self.deploy_env in {"dev", "development", "uat"}:
            payload["deploy_env"] = self.deploy_env

        headers: dict[str, str] = {}
        if self._activation_guard:
            headers["X-Sandbox-Activation-Token"] = self._activation_guard

        async with httpx.AsyncClient(timeout=15.0, trust_env=False) as client:
            last_exc: Exception | None = None
            for _ in range(20):
                try:
                    resp = await client.post(
                        f"{base_url}/internal/v1/activate-lease",
                        json=payload,
                        headers=headers,
                    )
                    if resp.status_code == 200:
                        last_exc = None
                        break
                    last_exc = RuntimeError(
                        f"Lease activation HTTP {resp.status_code}: {resp.text[:200]}"
                    )
                except httpx.HTTPError as exc:
                    last_exc = exc
                await asyncio.sleep(0.25)
            if last_exc is not None:
                raise last_exc

            deadline = time.monotonic() + max(2.0, self.health_poll_timeout_s)
            while time.monotonic() < deadline:
                try:
                    h_resp = await client.get(f"{base_url}/health", timeout=2.0)
                    if h_resp.status_code == 200:
                        return pub_b64, pod_key_id
                except httpx.HTTPError:
                    pass
                await asyncio.sleep(0.25)
        raise TimeoutError(f"Sandbox {endpoint.sandbox_name} /health did not turn Ready after bind")

    async def ensure_owner_lease(self, hushh_id: str) -> ActiveOwnerLease:
        clean_id = str(hushh_id or "").strip()
        if not _OWNER_ID_RE.fullmatch(clean_id):
            raise HTTPException(
                status_code=400,
                detail={"code": SANDBOX_OWNER_ID_INVALID, "message": "Invalid owner identifier"},
            )
        async with self._lock_for(clean_id):
            existing = self._leases.get(clean_id)
            if existing is not None:
                existing.last_activity_s = self._clock_s()
                return existing

            claim_name = f"claim-{secrets.token_hex(6)}"
            lease_id = f"lease_{secrets.token_hex(12)}"
            endpoint = await asyncio.to_thread(
                self.claim_client.create_and_wait_claim,
                claim_name=claim_name,
                billing_space_id=clean_id,
                warm_pool_name=self.warm_pool_name,
                idle_shutdown_seconds=max(60, min(3600, int(self.idle_timeout_s))),
                timeout_s=self.claim_timeout_s,
            )
            try:
                pub_b64, pod_key_id = await self._activate_claimed_sandbox(
                    hushh_id=clean_id,
                    lease_id=lease_id,
                    endpoint=endpoint,
                )
            except Exception:
                await asyncio.to_thread(self.claim_client.delete_claim, claim_name)
                raise

            lease = ActiveOwnerLease(
                hushh_id=clean_id,
                lease_id=lease_id,
                claim_name=claim_name,
                sandbox_name=endpoint.sandbox_name,
                pod_ip=endpoint.pod_ip,
                port=endpoint.port,
                pod_key_id=pod_key_id,
                pod_public_key=pub_b64,
                last_activity_s=self._clock_s(),
            )
            self._leases[clean_id] = lease
            return lease

    async def release_owner_lease(self, hushh_id: str) -> dict[str, Any] | None:
        clean_id = str(hushh_id or "").strip()
        async with self._lock_for(clean_id):
            lease = self._leases.pop(clean_id, None)
            if lease is None:
                return None
            if self.sentinel_control is not None:
                await asyncio.to_thread(self.sentinel_control.revoke_lease, lease.lease_id)
            await asyncio.to_thread(self.claim_client.delete_claim, lease.claim_name)
            return {
                "hushh_id": lease.hushh_id,
                "lease_id": lease.lease_id,
                "claim_name": lease.claim_name,
                "sandbox_name": lease.sandbox_name,
                "released": True,
            }

    async def reap_idle_leases(self) -> list[str]:
        now = self._clock_s()
        expired = [
            hid
            for hid, lease in list(self._leases.items())
            if lease.active_ws_count <= 0 and (now - lease.last_activity_s) >= self.idle_timeout_s
        ]
        reaped: list[str] = []
        for hid in expired:
            res = await self.release_owner_lease(hid)
            if res is not None:
                reaped.append(hid)
        return reaped


def _filter_headers(headers: Any) -> dict[str, str]:
    out: dict[str, str] = {}
    for k, v in headers.items():
        if str(k).lower() in _HOP_BY_HOP_HEADERS:
            continue
        out[str(k)] = str(v)
    return out


def _authorize_admin(request: Request, manager: SandboxEdgeGatewayManager) -> None:
    expected = manager.admin_header_value
    if not expected:
        raise HTTPException(status_code=503, detail={"code": "EDGE_ADMIN_UNCONFIGURED"})
    supplied = str(request.headers.get("x-edge-admin-token") or "").strip()
    if not hmac.compare_digest(supplied, expected):
        raise HTTPException(status_code=401, detail={"code": "EDGE_ADMIN_UNAUTHORIZED"})


def create_sandbox_edge_gateway_app(
    manager: SandboxEdgeGatewayManager,
    *,
    enable_reaper: bool = True,
) -> FastAPI:
    """Create stateless Cloud Run TLS Edge Gateway routing directly to GKE sandbox IPs."""

    @asynccontextmanager
    async def _lifespan(_app: FastAPI):
        task: asyncio.Task[None] | None = None
        if enable_reaper:
            interval = min(30.0, max(0.05, manager.idle_timeout_s / 3.0))

            async def _reap_loop() -> None:
                while True:
                    await asyncio.sleep(interval)
                    await manager.reap_idle_leases()

            task = asyncio.create_task(_reap_loop())
        try:
            yield
        finally:
            if task is not None:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task

    gateway = FastAPI(title="Hussh Sandbox Edge Gateway", lifespan=_lifespan)
    gateway.state.manager = manager

    @gateway.get("/healthz")
    @gateway.get("/health")
    async def healthz() -> dict[str, Any]:
        return {
            "status": "edge_gateway_ready",
            "active_leases": manager.active_count(),
            "idle_timeout_s": manager.idle_timeout_s,
        }

    @gateway.get("/internal/leases/{hushh_id}")
    async def inspect_lease(hushh_id: str, request: Request) -> dict[str, Any]:
        _authorize_admin(request, manager)
        lease = manager.get_lease(hushh_id)
        if lease is None:
            raise HTTPException(status_code=404, detail={"code": "LEASE_NOT_FOUND"})
        return {
            "hushh_id": lease.hushh_id,
            "lease_id": lease.lease_id,
            "claim_name": lease.claim_name,
            "sandbox_name": lease.sandbox_name,
            "pod_ip": lease.pod_ip,
            "pod_key_id": lease.pod_key_id,
            "pod_public_key": lease.pod_public_key,
            "active_ws_count": lease.active_ws_count,
        }

    @gateway.delete("/internal/leases/{hushh_id}")
    async def teardown_lease(hushh_id: str, request: Request) -> dict[str, Any]:
        _authorize_admin(request, manager)
        released = await manager.release_owner_lease(hushh_id)
        if released is None:
            raise HTTPException(status_code=404, detail={"code": "LEASE_NOT_FOUND"})
        return released

    @gateway.websocket("/u/{hushh_id}/api/one/puppy/relay")
    async def puppy_relay_bridge(websocket: WebSocket, hushh_id: str) -> None:
        if not _OWNER_ID_RE.fullmatch(hushh_id):
            await websocket.close(code=1008, reason="Invalid owner identifier")
            return
        lease = await manager.ensure_owner_lease(hushh_id)
        lease.active_ws_count += 1
        upstream_url = f"ws://{lease.pod_ip}:{lease.port}/api/one/puppy/relay"
        forward_headers: dict[str, str] = {}
        auth_header = str(websocket.headers.get("authorization") or "").strip()
        if auth_header:
            forward_headers["Authorization"] = auth_header

        try:
            async with websockets.connect(
                upstream_url,
                additional_headers=forward_headers,
                open_timeout=15.0,
            ) as upstream_ws:
                await websocket.accept()

                async def _client_to_upstream() -> None:
                    while True:
                        msg = await websocket.receive()
                        msg_type = msg.get("type")
                        if msg_type == "websocket.disconnect":
                            await upstream_ws.close()
                            return
                        lease.last_activity_s = manager._clock_s()
                        if msg.get("text") is not None:
                            await upstream_ws.send(str(msg["text"]))
                        elif msg.get("bytes") is not None:
                            await upstream_ws.send(bytes(msg["bytes"]))

                async def _upstream_to_client() -> None:
                    try:
                        async for payload in upstream_ws:
                            lease.last_activity_s = manager._clock_s()
                            if isinstance(payload, bytes):
                                await websocket.send_bytes(payload)
                            else:
                                await websocket.send_text(str(payload))
                    except ConnectionClosed as closed:
                        rc = getattr(closed, "rcvd", None)
                        code = rc.code if rc and 1000 <= rc.code <= 4999 else 1000
                        reason = rc.reason if rc and rc.reason else ""
                        with contextlib.suppress(Exception):
                            await websocket.close(code=code, reason=reason)

                tasks = [
                    asyncio.create_task(_client_to_upstream()),
                    asyncio.create_task(_upstream_to_client()),
                ]
                done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                for p in pending:
                    p.cancel()
                for d in done:
                    with contextlib.suppress(WebSocketDisconnect, asyncio.CancelledError):
                        await d
        except ConnectionClosed as closed:
            await websocket.accept()
            rc = getattr(closed, "rcvd", None)
            code = rc.code if rc and 1000 <= rc.code <= 4999 else 1008
            reason = rc.reason if rc and rc.reason else "Upstream relay closed"
            with contextlib.suppress(Exception):
                await websocket.close(code=code, reason=reason)
        except InvalidStatus as rejected:
            status = int(getattr(getattr(rejected, "response", None), "status_code", 0) or 0)
            code = 1008 if status in {401, 403} else 1011
            with contextlib.suppress(Exception):
                await websocket.close(code=code, reason="Upstream WebSocket rejected")
        except Exception:  # noqa: BLE001 - refuse unestablished upstream cleanly
            with contextlib.suppress(Exception):
                await websocket.close(code=1011, reason="Sandbox relay unavailable")
        finally:
            lease.active_ws_count = max(0, lease.active_ws_count - 1)
            lease.last_activity_s = manager._clock_s()

    async def _proxy_owner_http(request: Request, hushh_id: str, subpath: str) -> Response:
        clean_sub = str(subpath or "").lstrip("/")
        if clean_sub == "internal" or clean_sub.startswith("internal/"):
            raise HTTPException(
                status_code=403,
                detail={
                    "code": SANDBOX_INTERNAL_PATH_FORBIDDEN,
                    "message": "Internal sandbox endpoints cannot be reached via public edge",
                },
            )
        lease = await manager.ensure_owner_lease(hushh_id)
        lease.last_activity_s = manager._clock_s()
        qs = request.url.query
        target = f"http://{lease.pod_ip}:{lease.port}/{clean_sub}" + (f"?{qs}" if qs else "")
        body = await request.body()
        req_headers = _filter_headers(request.headers)
        req_headers["X-Forwarded-Prefix"] = f"/u/{hushh_id}"
        async with httpx.AsyncClient(
            follow_redirects=False, timeout=160.0, trust_env=False
        ) as client:
            upstream = await client.request(
                method=request.method,
                url=target,
                content=body if body else None,
                headers=req_headers,
            )
        lease.last_activity_s = manager._clock_s()
        resp_headers = _filter_headers(upstream.headers)
        resp_headers["X-Hussh-Pod-Key-Id"] = lease.pod_key_id
        return Response(
            content=upstream.content,
            status_code=upstream.status_code,
            headers=resp_headers,
        )

    @gateway.api_route(
        "/u/{hushh_id}",
        methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
    )
    async def proxy_owner_root(request: Request, hushh_id: str) -> Response:
        return await _proxy_owner_http(request, hushh_id, "")

    @gateway.api_route(
        "/u/{hushh_id}/{subpath:path}",
        methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
    )
    async def proxy_owner_subpath(request: Request, hushh_id: str, subpath: str) -> Response:
        return await _proxy_owner_http(request, hushh_id, subpath)

    return gateway


def create_edge_gateway_from_env() -> FastAPI:
    """Build production/Dev Cloud Run Sandbox Edge Gateway from environment configuration."""
    seed_raw = (os.environ.get("HUSSH_SANDBOX_IDENTITY_MASTER_KEY") or "").strip().encode("utf-8")
    if len(seed_raw) < 32:
        raise ValueError("HUSSH_SANDBOX_IDENTITY_MASTER_KEY must be at least 32 bytes")
    namespace = (os.environ.get("HUSSH_SANDBOX_NAMESPACE") or "hussh-agents").strip()
    warm_pool = (os.environ.get("HUSSH_SANDBOX_POOL") or "hussh-one-warm-pool").strip()
    api_server = (os.environ.get("HUSSH_K8S_API_SERVER") or "").strip()
    ca_pem_b64 = (os.environ.get("HUSSH_K8S_CA_CERT_B64") or "").strip()
    if api_server:
        ca_pem = (
            base64.b64decode(ca_pem_b64).decode("utf-8")
            if ca_pem_b64
            else (os.environ.get("HUSSH_K8S_CA_CERT_PEM") or "")
        )
        claim_client = LiveK8sSandboxClaimClient.from_gcp_credentials(
            api_server=api_server,
            ca_cert_pem=ca_pem or None,
            namespace=namespace,
            on_demand_scale_pool=True,
        )
    else:
        claim_client = LiveK8sSandboxClaimClient.from_incluster(
            namespace=namespace,
            on_demand_scale_pool=True,
        )
    sentinel_url = (os.environ.get("SENTINEL_CONTROL_URL") or "").strip()
    sentinel_auth = (os.environ.get("SENTINEL_CONTROL_TOKEN") or "").strip()
    sentinel = (
        SentinelControlClient(base_url=sentinel_url, control_token=sentinel_auth)
        if sentinel_url and sentinel_auth
        else None
    )
    manager = SandboxEdgeGatewayManager(
        claim_client=claim_client,
        master_seed=seed_raw,
        sentinel_control=sentinel,
        warm_pool_name=warm_pool,
        idle_timeout_s=float(os.environ.get("HUSSH_SANDBOX_IDLE_TIMEOUT_SECONDS") or "600"),
        health_poll_timeout_s=float(
            os.environ.get("HUSSH_SANDBOX_HEALTH_POLL_TIMEOUT_SECONDS") or "90"
        ),
        activation_header_value=os.environ.get("HUSSH_SANDBOX_ACTIVATION_TOKEN"),
        admin_header_value=os.environ.get("HUSSH_EDGE_ADMIN_TOKEN"),
        pod_url_base=os.environ.get("HUSSH_SANDBOX_EDGE_PUBLIC_URL"),
        hub_url=os.environ.get("HUSSH_HUB_URL"),
        scheduler_caller_emails=os.environ.get("HUSHH_SCHEDULER_CALLER_EMAILS"),
        deploy_env=os.environ.get("HUSHH_DEPLOY_ENV"),
    )
    return create_sandbox_edge_gateway_app(manager)
