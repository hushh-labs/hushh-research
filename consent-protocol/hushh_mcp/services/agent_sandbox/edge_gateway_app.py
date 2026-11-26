# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Stateless per-owner TLS Edge Gateway for disposable GKE sandboxes (#9744)."""

from __future__ import annotations

import asyncio
import base64
import contextlib
import hashlib
import hmac
import inspect
import os
import re
import secrets
import time
import urllib.parse
from collections.abc import AsyncIterator, Callable, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

import httpx
import websockets
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from fastapi import FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, StreamingResponse
from websockets.exceptions import ConnectionClosed, InvalidStatus

from hushh_mcp.services.agent_sandbox.k8s_claim_allocator import (
    ClaimedSandboxEndpoint,
    LiveK8sSandboxClaimClient,
    SandboxClaimPort,
    SentinelControlClient,
)

SANDBOX_INTERNAL_PATH_FORBIDDEN = "SANDBOX_INTERNAL_PATH_FORBIDDEN"
SANDBOX_OWNER_ID_INVALID = "SANDBOX_OWNER_ID_INVALID"
SANDBOX_WAKING_CODE = "SANDBOX_WAKING"
SANDBOX_HYDRATION_FAILED_CODE = "SANDBOX_HYDRATION_FAILED"
SANDBOX_EDGE_PLACEMENT_TS_HEADER = "x-hussh-sandbox-edge-ts"
SANDBOX_EDGE_PLACEMENT_SIG_HEADER = "x-hussh-sandbox-edge-sig"
_OWNER_ID_RE = re.compile(r"^[a-zA-Z0-9_-]{1,128}$")
_POD_IDENTITY_SALT = b"hussh-sandbox-pod-identity-v1"
_EDGE_PLACEMENT_SIG_CONTEXT = b"hussh-sandbox-edge-placement-v1"
_EDGE_PLACEMENT_WINDOW_SECONDS = 60
_TERMINAL_HEALTH_STATUSES = frozenset(
    {"hydration_failed", "storage_unavailable", "error", "failed", "unhealthy"}
)


class SandboxActivationError(RuntimeError):
    """Non-transient activation or memory-hydration failure that must fail fast."""

    def __init__(
        self,
        message: str,
        *,
        code: str = SANDBOX_HYDRATION_FAILED_CODE,
        phase: str = "unlocking",
    ) -> None:
        super().__init__(message)
        self.code = code
        self.phase = phase


class SandboxStandbyUnreachableError(RuntimeError):
    """Claimed standby pod vanished or refused TCP before accepting lease activation."""


def sign_sandbox_edge_placement_headers(
    master_seed: bytes,
    hushh_id: str,
    *,
    now_s: int | None = None,
) -> dict[str, str]:
    """Mint short-lived Edge-to-Hub HMAC headers to resolve an owner's placement_epoch."""
    clean_id = str(hushh_id or "").strip()
    if not _OWNER_ID_RE.fullmatch(clean_id):
        raise ValueError(f"{SANDBOX_OWNER_ID_INVALID}: invalid owner identifier")
    if len(master_seed) < 32:
        raise ValueError("Edge gateway master seed must be at least 32 bytes")
    ts_val = int(time.time()) if now_s is None else int(now_s)
    msg = _EDGE_PLACEMENT_SIG_CONTEXT + f"|{clean_id}|{ts_val}".encode("utf-8")
    sig = hmac.new(master_seed, msg, hashlib.sha256).hexdigest()
    return {
        SANDBOX_EDGE_PLACEMENT_TS_HEADER: str(ts_val),
        SANDBOX_EDGE_PLACEMENT_SIG_HEADER: sig,
    }


def verify_sandbox_edge_placement_headers(
    master_seed: bytes,
    hushh_id: str,
    headers: Any,
    *,
    now_s: int | None = None,
    window_s: int = _EDGE_PLACEMENT_WINDOW_SECONDS,
) -> bool:
    """Verify Edge-to-Hub HMAC headers using constant-time comparison and replay window."""
    clean_id = str(hushh_id or "").strip()
    if not _OWNER_ID_RE.fullmatch(clean_id) or len(master_seed) < 32 or headers is None:
        return False
    lowered = {str(k).lower(): str(v).strip() for k, v in headers.items()}
    raw_ts = lowered.get(SANDBOX_EDGE_PLACEMENT_TS_HEADER, "")
    supplied_sig = lowered.get(SANDBOX_EDGE_PLACEMENT_SIG_HEADER, "")
    if not raw_ts.isdigit() or len(supplied_sig) != 64:
        return False
    ts_val = int(raw_ts)
    now_val = int(time.time()) if now_s is None else int(now_s)
    if abs(now_val - ts_val) > max(1, int(window_s)):
        return False
    msg = _EDGE_PLACEMENT_SIG_CONTEXT + f"|{clean_id}|{ts_val}".encode("utf-8")
    expected_sig = hmac.new(master_seed, msg, hashlib.sha256).hexdigest()
    return hmac.compare_digest(supplied_sig, expected_sig)


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
    surrogate_expires_at_s: float = 0.0
    claim_expires_at_s: float = 0.0
    active_ws_count: int = 0
    active_http_count: int = 0


def _endpoint_scheme(endpoint: ClaimedSandboxEndpoint) -> str:
    return "http"


def _parse_allowed_origins(raw: Sequence[str] | str | None) -> tuple[str, ...]:
    if raw is None:
        return ()
    parts = raw.split(",") if isinstance(raw, str) else list(raw)
    cleaned: list[str] = []
    for item in parts:
        origin = str(item or "").strip().rstrip("/")
        if origin and origin != "*" and origin not in cleaned:
            cleaned.append(origin)
    return tuple(cleaned)


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
        schedule_worker_email: str | None = None,
        deploy_env: str | None = None,
        consent_ed25519_public_keys: str | None = None,
        owner_feed_ed25519_public_keys: str | None = None,
        ios_connector_client_id: str | None = None,
        allowed_app_origins: Sequence[str] | str | None = None,
        sentinel_model_gateway_url: str | None = None,
        sentinel_vertex_project: str | None = None,
        sentinel_vertex_location: str | None = None,
        enable_prefix_storage: bool = False,
        claim_timeout_s: float = 180.0,
        health_poll_timeout_s: float = 25.0,
        proxy_connect_timeout_s: float = 2.5,
        proxy_read_timeout_s: float = 240.0,
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
        self.schedule_worker_email = (schedule_worker_email or "").strip()
        self.deploy_env = (deploy_env or "").strip().lower()
        self.consent_ed25519_public_keys = (consent_ed25519_public_keys or "").strip()
        self.owner_feed_ed25519_public_keys = (owner_feed_ed25519_public_keys or "").strip()
        self.ios_connector_client_id = (ios_connector_client_id or "").strip()
        self.allowed_app_origins = _parse_allowed_origins(allowed_app_origins)
        self.sentinel_model_gateway_url = (sentinel_model_gateway_url or "").strip().rstrip("/")
        self.sentinel_vertex_project = (sentinel_vertex_project or "").strip()
        self.sentinel_vertex_location = (sentinel_vertex_location or "").strip()
        self.enable_prefix_storage = bool(enable_prefix_storage)
        self.claim_timeout_s = float(claim_timeout_s)
        self.health_poll_timeout_s = float(health_poll_timeout_s)
        self.proxy_connect_timeout_s = max(0.1, float(proxy_connect_timeout_s))
        self.proxy_read_timeout_s = max(1.0, float(proxy_read_timeout_s))
        self._clock_s = clock_s or time.monotonic
        self._leases: dict[str, ActiveOwnerLease] = {}
        self._owner_locks: dict[str, asyncio.Lock] = {}
        self._hub_http_client: httpx.AsyncClient | None = None
        self._hub_http_loop: asyncio.AbstractEventLoop | None = None
        self._proxy_http_client: httpx.AsyncClient | None = None
        self._proxy_http_loop: asyncio.AbstractEventLoop | None = None

    def _get_hub_http_client(self) -> httpx.AsyncClient:
        loop = asyncio.get_running_loop()
        if (
            self._hub_http_client is None
            or self._hub_http_client.is_closed
            or self._hub_http_loop is not loop
        ):
            self._hub_http_client = httpx.AsyncClient(timeout=5.0, trust_env=False)
            self._hub_http_loop = loop
        return self._hub_http_client

    def _get_proxy_http_client(self) -> httpx.AsyncClient:
        loop = asyncio.get_running_loop()
        if (
            self._proxy_http_client is None
            or self._proxy_http_client.is_closed
            or self._proxy_http_loop is not loop
        ):
            self._proxy_http_client = httpx.AsyncClient(
                follow_redirects=False,
                trust_env=False,
                timeout=httpx.Timeout(
                    connect=self.proxy_connect_timeout_s,
                    read=self.proxy_read_timeout_s,
                    write=30.0,
                    pool=5.0,
                ),
                limits=httpx.Limits(
                    max_connections=200,
                    max_keepalive_connections=64,
                    keepalive_expiry=30.0,
                ),
            )
            self._proxy_http_loop = loop
        return self._proxy_http_client

    def _claim_shutdown_seconds(self) -> int:
        # Give K8s lifecycle.shutdownTime a safety margin beyond the Edge's sliding
        # idle reaper so active users do not hit a fixed wall-clock pod deletion
        # while the Edge still caches the pod IP. Truly idle leases are still reaped
        # on schedule at `idle_timeout_s` by `reap_idle_leases()`.
        base_idle = int(self.idle_timeout_s)
        return max(60, min(3600, max(base_idle * 2, base_idle + 300)))

    async def aclose(self) -> None:
        if self._hub_http_client is not None and not self._hub_http_client.is_closed:
            await self._hub_http_client.aclose()
        self._hub_http_client = None
        self._hub_http_loop = None
        if self._proxy_http_client is not None and not self._proxy_http_client.is_closed:
            await self._proxy_http_client.aclose()
        self._proxy_http_client = None
        self._proxy_http_loop = None

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

    async def _resolve_owner_placement_epoch(self, hushh_id: str) -> int:
        if not (self.enable_prefix_storage and self.hub_url):
            return 0
        url = f"{self.hub_url}/api/one/pod/custody/sandbox-placement/{hushh_id}"
        sig_headers = sign_sandbox_edge_placement_headers(bytes(self._master_seed), hushh_id)
        try:
            resp = await self._get_hub_http_client().get(url, headers=sig_headers)
            if resp.status_code == 200:
                body = resp.json()
                raw_ep = body.get("placementEpoch", 0) if isinstance(body, dict) else 0
                if isinstance(raw_ep, int) and not isinstance(raw_ep, bool) and raw_ep > 0:
                    return raw_ep
        except Exception:  # noqa: BLE001 - best-effort lookup; epoch-0 sandboxes still wake cleanly
            pass
        return 0

    async def _activate_claimed_sandbox(
        self,
        *,
        hushh_id: str,
        lease_id: str,
        endpoint: ClaimedSandboxEndpoint,
        placement_epoch: int = 0,
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
            "sandbox_name": endpoint.sandbox_name,
        }
        if (
            isinstance(placement_epoch, int)
            and not isinstance(placement_epoch, bool)
            and placement_epoch > 0
        ):
            payload["placement_epoch"] = str(placement_epoch)
        if self.pod_url_base:
            payload["pod_url"] = f"{self.pod_url_base}/u/{hushh_id}"
        if self.hub_url:
            payload["hub_url"] = self.hub_url
        if self.scheduler_caller_emails:
            payload["scheduler_caller_emails"] = self.scheduler_caller_emails
        if self.deploy_env in {"dev", "development"} and self.schedule_worker_email:
            payload["schedule_worker_email"] = self.schedule_worker_email
        if self.deploy_env in {"dev", "development", "uat"}:
            payload["deploy_env"] = self.deploy_env
        if self.consent_ed25519_public_keys:
            payload["consent_ed25519_public_keys"] = self.consent_ed25519_public_keys
        if self.ios_connector_client_id:
            payload["ios_connector_client_id"] = self.ios_connector_client_id
        if self.owner_feed_ed25519_public_keys:
            payload["owner_feed_ed25519_public_keys"] = self.owner_feed_ed25519_public_keys
        if self.allowed_app_origins:
            payload["allowed_app_origins"] = ",".join(self.allowed_app_origins)
        if self.enable_prefix_storage and self.hub_url:
            payload["pod_storage_prefix_token_url"] = (
                f"{self.hub_url}/api/one/pod/storage-gateway/pods/{hushh_id}"
            )

        if self.sentinel_control is not None:
            sentinel_tasks: list[Any] = []
            has_policy = hasattr(self.sentinel_control, "set_lease_policy_with_ip")
            has_surrogate = hasattr(self.sentinel_control, "mint_model_surrogate")
            if has_policy:
                policy_kwargs: dict[str, Any] = {
                    "lease_id": lease_id,
                    "owner_id": hushh_id,
                    "pod_ip": endpoint.pod_ip,
                }
                if (
                    "domain_rules"
                    in inspect.signature(self.sentinel_control.set_lease_policy_with_ip).parameters
                ):
                    domain_rules: dict[str, str] = {
                        "oauth2.googleapis.com": "allow",
                        "openidconnect.googleapis.com": "allow",
                        "gmail.googleapis.com": "allow",
                        "www.googleapis.com": "allow",
                    }
                    extra_domains = str(
                        os.environ.get("HUSSH_SANDBOX_CONNECTOR_ALLOW_DOMAINS") or ""
                    ).strip()
                    for extra in extra_domains.split(","):
                        host_clean = extra.strip().lower()
                        if host_clean:
                            domain_rules[host_clean] = "allow"
                    if self.hub_url:
                        hub_host = (
                            (urllib.parse.urlsplit(self.hub_url).hostname or "").strip().lower()
                        )
                        if hub_host:
                            domain_rules[hub_host] = "allow"
                    policy_kwargs["domain_rules"] = domain_rules
                sentinel_tasks.append(
                    asyncio.to_thread(
                        self.sentinel_control.set_lease_policy_with_ip,
                        **policy_kwargs,
                    )
                )
            if has_surrogate:
                ttl = max(3600, min(7200, int(self.idle_timeout_s * 2)))
                sentinel_tasks.append(
                    asyncio.to_thread(
                        self.sentinel_control.mint_model_surrogate,
                        lease_id=lease_id,
                        owner_id=hushh_id,
                        ttl_seconds=ttl,
                    )
                )
            if sentinel_tasks:
                sentinel_results = await asyncio.gather(*sentinel_tasks)
                if has_surrogate:
                    surrogate = str(sentinel_results[-1])
                    payload["model_gateway_token"] = surrogate
                    if self.sentinel_model_gateway_url:
                        payload["model_gateway_url"] = self.sentinel_model_gateway_url
                    if self.sentinel_vertex_project:
                        payload["sentinel_vertex_project"] = self.sentinel_vertex_project
                    if self.sentinel_vertex_location:
                        payload["sentinel_vertex_location"] = self.sentinel_vertex_location

        headers: dict[str, str] = {}
        if self._activation_guard:
            headers["X-Sandbox-Activation-Token"] = self._activation_guard

        inspect_termination = getattr(self.claim_client, "inspect_pod_termination", None)
        async with httpx.AsyncClient(timeout=15.0, trust_env=False) as client:
            last_exc: Exception | None = None
            for act_attempt in range(30):
                try:
                    resp = await client.post(
                        f"{base_url}/internal/v1/activate-lease",
                        json=payload,
                        headers=headers,
                    )
                    if resp.status_code == 200:
                        last_exc = None
                        break
                    if 400 <= resp.status_code < 500:
                        raise SandboxActivationError(
                            f"Lease activation rejected (HTTP {resp.status_code})",
                            code=SANDBOX_HYDRATION_FAILED_CODE,
                            phase="unlocking",
                        )
                    last_exc = SandboxActivationError(
                        f"Lease activation HTTP {resp.status_code}: {resp.text[:200]}",
                        code=SANDBOX_HYDRATION_FAILED_CODE,
                        phase="unlocking",
                    )
                except SandboxActivationError:
                    raise
                except httpx.HTTPError as exc:
                    last_exc = exc
                    if callable(inspect_termination) and act_attempt >= 1:
                        pre_term = await asyncio.to_thread(
                            inspect_termination, endpoint.sandbox_name
                        )
                        if pre_term:
                            raise SandboxStandbyUnreachableError(pre_term) from exc
                await asyncio.sleep(0.15)
            if last_exc is not None:
                if isinstance(last_exc, (httpx.ConnectError, httpx.ConnectTimeout)):
                    raise SandboxStandbyUnreachableError(str(last_exc)) from last_exc
                raise last_exc

            last_pod_check_s = 0.0
            health_timeout = httpx.Timeout(2.5, connect=0.20)
            deadline = time.monotonic() + max(2.0, self.health_poll_timeout_s)
            while time.monotonic() < deadline:
                health_connect_failed = False
                try:
                    h_resp = await client.get(f"{base_url}/health", timeout=health_timeout)
                    try:
                        health_body = h_resp.json()
                    except Exception:  # noqa: BLE001 - non-JSON health is still not virgin_ready
                        health_body = None
                    if isinstance(health_body, dict):
                        health_status = str(health_body.get("status") or "").strip().lower()
                        if health_status in _TERMINAL_HEALTH_STATUSES:
                            err_detail = str(
                                health_body.get("error")
                                or health_body.get("message")
                                or f"Sandbox failed during {health_status}"
                            )
                            raise SandboxActivationError(
                                err_detail[:200],
                                code=SANDBOX_HYDRATION_FAILED_CODE,
                                phase="unlocking",
                            )
                        if h_resp.status_code in {500, 502, 503} and (
                            health_body.get("code") or health_body.get("detail")
                        ):
                            raise SandboxActivationError(
                                f"Sandbox health failed (HTTP {h_resp.status_code})",
                                code=SANDBOX_HYDRATION_FAILED_CODE,
                                phase="unlocking",
                            )
                    if h_resp.status_code == 200:
                        if (
                            not isinstance(health_body, dict)
                            or health_body.get("status") != "virgin_ready"
                        ):
                            return pub_b64, pod_key_id
                except SandboxActivationError:
                    raise
                except httpx.HTTPError:
                    health_connect_failed = True

                now_mono = time.monotonic()
                if callable(inspect_termination) and (
                    (health_connect_failed and (now_mono - last_pod_check_s) >= 0.30)
                    or (now_mono - last_pod_check_s) >= 0.75
                ):
                    last_pod_check_s = now_mono
                    term_reason = await asyncio.to_thread(
                        inspect_termination, endpoint.sandbox_name
                    )
                    if term_reason:
                        raise SandboxActivationError(
                            f"Sandbox exited during startup ({term_reason})",
                            code=SANDBOX_HYDRATION_FAILED_CODE,
                            phase="unlocking",
                        )
                await asyncio.sleep(0.03)
        raise TimeoutError(f"Sandbox {endpoint.sandbox_name} /health did not turn Ready after bind")

    async def invalidate_lease(self, hushh_id: str, expected_lease_id: str | None = None) -> None:
        clean_id = str(hushh_id or "").strip()
        async with self._lock_for(clean_id):
            current = self._leases.get(clean_id)
            if current is None:
                return
            if expected_lease_id is not None and current.lease_id != expected_lease_id:
                return
            self._leases.pop(clean_id, None)
            if self.sentinel_control is not None:
                if hasattr(self.sentinel_control, "delete_lease"):
                    await asyncio.to_thread(self.sentinel_control.delete_lease, current.lease_id)
                else:
                    await asyncio.to_thread(self.sentinel_control.revoke_lease, current.lease_id)
            await asyncio.to_thread(self.claim_client.delete_claim, current.claim_name)

    async def ensure_owner_lease(self, hushh_id: str) -> ActiveOwnerLease:
        clean_id = str(hushh_id or "").strip()
        if not _OWNER_ID_RE.fullmatch(clean_id):
            raise HTTPException(
                status_code=400,
                detail={"code": SANDBOX_OWNER_ID_INVALID, "message": "Invalid owner identifier"},
            )
        async with self._lock_for(clean_id):
            now_s = self._clock_s()
            existing = self._leases.get(clean_id)
            if existing is not None:
                claim_shutdown_s = self._claim_shutdown_seconds()
                claim_margin_s = min(180.0, max(15.0, float(claim_shutdown_s) * 0.25))
                claim_expiring_soon = (
                    existing.claim_expires_at_s > 0
                    and (existing.claim_expires_at_s - now_s) <= claim_margin_s
                )
                claim_extended = False
                if claim_expiring_soon and hasattr(self.claim_client, "extend_claim_shutdown"):
                    with contextlib.suppress(Exception):
                        if await asyncio.to_thread(
                            self.claim_client.extend_claim_shutdown,
                            existing.claim_name,
                            idle_shutdown_seconds=claim_shutdown_s,
                        ):
                            existing.claim_expires_at_s = self._clock_s() + float(claim_shutdown_s)
                            claim_extended = True
                claim_hard_expired = (
                    existing.claim_expires_at_s > 0
                    and not claim_extended
                    and now_s >= (existing.claim_expires_at_s - 15.0)
                )

                expiring_soon = (
                    existing.surrogate_expires_at_s > 0
                    and (existing.surrogate_expires_at_s - now_s) <= 300.0
                )
                renewed_in_place = False
                if (
                    expiring_soon
                    and not claim_hard_expired
                    and self.sentinel_control is not None
                    and hasattr(self.sentinel_control, "mint_model_surrogate")
                ):
                    renew_ttl = max(3600, min(7200, int(self.idle_timeout_s * 2)))
                    with contextlib.suppress(Exception):
                        await asyncio.to_thread(
                            self.sentinel_control.mint_model_surrogate,
                            lease_id=existing.lease_id,
                            owner_id=clean_id,
                            ttl_seconds=renew_ttl,
                        )
                        existing.surrogate_expires_at_s = self._clock_s() + float(renew_ttl)
                        renewed_in_place = True
                hard_expired = (
                    existing.surrogate_expires_at_s > 0 and now_s >= existing.surrogate_expires_at_s
                )
                should_rotate_claim = claim_hard_expired or (
                    claim_expiring_soon
                    and not claim_extended
                    and existing.active_http_count <= 0
                    and existing.active_ws_count <= 0
                )
                should_rotate_surrogate = not renewed_in_place and (
                    hard_expired
                    or (
                        expiring_soon
                        and existing.active_http_count <= 0
                        and existing.active_ws_count <= 0
                    )
                )
                if should_rotate_claim or should_rotate_surrogate:
                    self._leases.pop(clean_id, None)
                    if self.sentinel_control is not None:
                        if hasattr(self.sentinel_control, "delete_lease"):
                            with contextlib.suppress(Exception):
                                await asyncio.to_thread(
                                    self.sentinel_control.delete_lease, existing.lease_id
                                )
                        else:
                            with contextlib.suppress(Exception):
                                await asyncio.to_thread(
                                    self.sentinel_control.revoke_lease, existing.lease_id
                                )
                    with contextlib.suppress(Exception):
                        await asyncio.to_thread(self.claim_client.delete_claim, existing.claim_name)
                else:
                    existing.last_activity_s = now_s
                    return existing

            claim_shutdown_s = self._claim_shutdown_seconds()
            surrogate_ttl = (
                max(3600, min(7200, int(self.idle_timeout_s * 2)))
                if self.sentinel_control is not None
                and hasattr(self.sentinel_control, "mint_model_surrogate")
                else 0
            )
            claim_name = ""
            lease_id = ""
            claim_created_at_s = 0.0
            endpoint: ClaimedSandboxEndpoint | None = None
            pub_b64 = ""
            pod_key_id = ""
            for claim_attempt in range(2):
                claim_name = f"claim-{secrets.token_hex(6)}"
                lease_id = f"lease_{secrets.token_hex(12)}"
                claim_created_at_s = self._clock_s()
                endpoint, placement_epoch = await asyncio.gather(
                    asyncio.to_thread(
                        self.claim_client.create_and_wait_claim,
                        claim_name=claim_name,
                        billing_space_id=clean_id,
                        warm_pool_name=self.warm_pool_name,
                        idle_shutdown_seconds=claim_shutdown_s,
                        timeout_s=self.claim_timeout_s,
                    ),
                    self._resolve_owner_placement_epoch(clean_id),
                )
                try:
                    pub_b64, pod_key_id = await self._activate_claimed_sandbox(
                        hushh_id=clean_id,
                        lease_id=lease_id,
                        endpoint=endpoint,
                        placement_epoch=placement_epoch,
                    )
                    break
                except Exception as exc:
                    if self.sentinel_control is not None and hasattr(
                        self.sentinel_control, "delete_lease"
                    ):
                        with contextlib.suppress(Exception):
                            await asyncio.to_thread(self.sentinel_control.delete_lease, lease_id)
                    await asyncio.to_thread(self.claim_client.delete_claim, claim_name)
                    if claim_attempt == 0 and isinstance(exc, SandboxStandbyUnreachableError):
                        continue
                    raise

            if endpoint is None:
                raise RuntimeError("Sandbox claim failed to resolve endpoint")

            activated_at_s = self._clock_s()
            lease = ActiveOwnerLease(
                hushh_id=clean_id,
                lease_id=lease_id,
                claim_name=claim_name,
                sandbox_name=endpoint.sandbox_name,
                pod_ip=endpoint.pod_ip,
                port=endpoint.port,
                pod_key_id=pod_key_id,
                pod_public_key=pub_b64,
                last_activity_s=activated_at_s,
                surrogate_expires_at_s=(
                    activated_at_s + float(surrogate_ttl) if surrogate_ttl > 0 else 0.0
                ),
                claim_expires_at_s=claim_created_at_s + float(claim_shutdown_s),
            )
            self._leases[clean_id] = lease
            return lease

    async def release_owner_lease(
        self, hushh_id: str, *, drain_timeout_s: float = 15.0
    ) -> dict[str, Any] | None:
        clean_id = str(hushh_id or "").strip()
        async with self._lock_for(clean_id):
            lease = self._leases.get(clean_id)
            if lease is None:
                return None
            if drain_timeout_s > 0 and lease.active_http_count > 0:
                deadline = time.monotonic() + float(drain_timeout_s)
                while lease.active_http_count > 0 and time.monotonic() < deadline:
                    await asyncio.sleep(0.05)
            self._leases.pop(clean_id, None)
            if self.sentinel_control is not None:
                if hasattr(self.sentinel_control, "delete_lease"):
                    await asyncio.to_thread(self.sentinel_control.delete_lease, lease.lease_id)
                else:
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
            if lease.active_ws_count <= 0
            and lease.active_http_count <= 0
            and (now - lease.last_activity_s) >= self.idle_timeout_s
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


def _overlay_response_headers(
    resp_headers: dict[str, str],
    *,
    pod_key_id: str,
    cors_hdrs: dict[str, str],
) -> None:
    """Replace upstream case-variant CORS and pod-key headers without duplicating ASGI headers."""
    drop_lower = {"x-hussh-pod-key-id"}
    if cors_hdrs:
        drop_lower.add("vary")
        drop_lower.update(k.lower() for k in cors_hdrs)
    for existing in [
        k
        for k in list(resp_headers)
        if k.lower() in drop_lower or (cors_hdrs and k.lower().startswith("access-control-"))
    ]:
        resp_headers.pop(existing, None)
    resp_headers["X-Hussh-Pod-Key-Id"] = pod_key_id
    resp_headers.update(cors_hdrs)


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
            await manager.aclose()

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
                open_timeout=max(2.0, min(15.0, manager.proxy_connect_timeout_s * 2.0)),
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

    def _cors_headers(request: Request) -> dict[str, str]:
        origin = str(request.headers.get("origin") or "").strip().rstrip("/")
        if not origin or origin not in manager.allowed_app_origins:
            return {}
        req_headers = str(request.headers.get("access-control-request-headers") or "").strip()
        allow_headers = (
            req_headers
            or "Authorization, Content-Type, Accept, X-Hussh-Client-Version, X-Request-Id, X-Browser-Pod-Incarnation, X-Pod-Session, X-Consent-Token"
        )
        return {
            "Access-Control-Allow-Origin": origin,
            "Vary": "Origin",
            "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD",
            "Access-Control-Allow-Headers": allow_headers,
            "Access-Control-Expose-Headers": (
                "X-Hussh-Pod-Key-Id, X-Hussh-Pod-State, "
                "X-Browser-Pod-Incarnation, X-Browser-Task-Id, X-Browser-Pod-Id, "
                "X-Browser-Control-Epoch, X-Browser-Sequence, X-Browser-Next-Sequence, "
                "X-Browser-Revision, X-Browser-Width, X-Browser-Height"
            ),
            "Access-Control-Max-Age": "600",
        }

    def _waking_response(request: Request) -> JSONResponse:
        headers = {
            "X-Hussh-Pod-State": "waking",
            "Cache-Control": "no-store",
            **_cors_headers(request),
        }
        return JSONResponse(
            status_code=503,
            content={"code": SANDBOX_WAKING_CODE, "message": "Personal sandbox is waking up"},
            headers=headers,
        )

    def _unavailable_response(
        request: Request,
        *,
        code: str = SANDBOX_HYDRATION_FAILED_CODE,
        phase: str = "unlocking",
        message: str = "Personal sandbox could not finish starting",
    ) -> JSONResponse:
        headers = {
            "X-Hussh-Pod-State": "unavailable",
            "Cache-Control": "no-store",
            **_cors_headers(request),
        }
        return JSONResponse(
            status_code=503,
            content={"detail": {"code": code, "phase": phase, "message": message}},
            headers=headers,
        )

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
        if request.method == "OPTIONS":
            if not _OWNER_ID_RE.fullmatch(str(hushh_id or "").strip()):
                raise HTTPException(
                    status_code=400,
                    detail={
                        "code": SANDBOX_OWNER_ID_INVALID,
                        "message": "Invalid owner identifier",
                    },
                )
            return Response(status_code=204, headers=_cors_headers(request))

        from hushh_mcp.services.pod_sandbox_scheduled_delivery import WORKER_PATH

        if clean_sub.rstrip("/") == WORKER_PATH.lstrip("/"):
            from hushh_mcp.services.scheduler_identity import (
                SchedulerIdentityError,
                verify_scheduler_request,
            )

            if (
                manager.deploy_env not in {"dev", "development"}
                or not manager.pod_url_base
                or not _OWNER_ID_RE.fullmatch(hushh_id)
                or request.method != "POST"
            ):
                raise HTTPException(403, detail={"code": "SCHEDULE_WORKER_REFUSED"})
            try:
                await asyncio.to_thread(
                    verify_scheduler_request,
                    authorization_header=request.headers.get("authorization"),
                    audience=f"{manager.pod_url_base}/u/{hushh_id}",
                    allowed_emails=(manager.schedule_worker_email,),
                )
            except SchedulerIdentityError:
                raise HTTPException(403, detail={"code": "SCHEDULE_WORKER_REFUSED"}) from None

        body = await request.body()
        req_headers = _filter_headers(request.headers)
        req_headers["X-Forwarded-Prefix"] = f"/u/{hushh_id}"
        qs = request.url.query
        cors_hdrs = _cors_headers(request)

        for attempt in range(2):
            try:
                lease = await manager.ensure_owner_lease(hushh_id)
            except HTTPException:
                raise
            except SandboxActivationError as exc:
                return _unavailable_response(
                    request,
                    code=exc.code,
                    phase=exc.phase,
                    message="Personal sandbox could not finish starting. Try again shortly.",
                )
            except (TimeoutError, httpx.HTTPError, RuntimeError):
                return _waking_response(request)

            lease.active_http_count += 1
            lease.last_activity_s = manager._clock_s()
            target = f"http://{lease.pod_ip}:{lease.port}/{clean_sub}" + (f"?{qs}" if qs else "")
            client = manager._get_proxy_http_client()
            try:
                built = client.build_request(
                    method=request.method,
                    url=target,
                    content=body if body else None,
                    headers=req_headers,
                )
                upstream = await client.send(built, stream=True)
            except (httpx.ConnectError, httpx.ConnectTimeout):
                lease.active_http_count = max(0, lease.active_http_count - 1)
                await manager.invalidate_lease(hushh_id, expected_lease_id=lease.lease_id)
                if attempt == 0:
                    continue
                return _waking_response(request)
            except httpx.RemoteProtocolError:
                lease.active_http_count = max(0, lease.active_http_count - 1)
                if attempt == 0 and request.method.upper() in {"GET", "HEAD", "OPTIONS"}:
                    await manager.invalidate_lease(hushh_id, expected_lease_id=lease.lease_id)
                    continue
                return _waking_response(request)
            except httpx.HTTPError:
                lease.active_http_count = max(0, lease.active_http_count - 1)
                return _waking_response(request)
            except BaseException:
                lease.active_http_count = max(0, lease.active_http_count - 1)
                raise

            lease.last_activity_s = manager._clock_s()
            resp_headers = _filter_headers(upstream.headers)
            _overlay_response_headers(
                resp_headers,
                pod_key_id=lease.pod_key_id,
                cors_hdrs=cors_hdrs,
            )

            content_type = str(upstream.headers.get("content-type") or "").lower()
            if content_type.startswith("text/event-stream"):
                resp_headers.setdefault("Cache-Control", "no-cache, no-store, no-transform")
                resp_headers.setdefault("X-Accel-Buffering", "no")

                async def _stream_sse(
                    upstream_resp: httpx.Response = upstream,
                    active_lease: ActiveOwnerLease = lease,
                ) -> AsyncIterator[bytes]:
                    try:
                        async for chunk in upstream_resp.aiter_raw():
                            active_lease.last_activity_s = manager._clock_s()
                            if chunk:
                                yield chunk
                    finally:
                        active_lease.active_http_count = max(0, active_lease.active_http_count - 1)
                        active_lease.last_activity_s = manager._clock_s()
                        with contextlib.suppress(Exception):
                            await upstream_resp.aclose()

                return StreamingResponse(
                    _stream_sse(),
                    status_code=upstream.status_code,
                    headers=resp_headers,
                )

            try:
                raw_content = await upstream.aread()
            finally:
                lease.active_http_count = max(0, lease.active_http_count - 1)
                lease.last_activity_s = manager._clock_s()
                with contextlib.suppress(Exception):
                    await upstream.aclose()

            if upstream.status_code in {502, 503, 504} and "x-hussh-pod-state" not in {
                k.lower() for k in resp_headers
            }:
                resp_headers["X-Hussh-Pod-State"] = "waking"
            return Response(
                content=raw_content,
                status_code=upstream.status_code,
                headers=resp_headers,
            )

        return _waking_response(request)

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
    hub_url = (os.environ.get("HUSSH_HUB_URL") or "").strip()
    prefix_flag = (os.environ.get("HUSSH_SANDBOX_PREFIX_STORAGE_ENABLED") or "").strip().lower()
    enable_prefix_storage = prefix_flag in {"1", "true", "yes"} if prefix_flag else bool(hub_url)
    manager = SandboxEdgeGatewayManager(
        claim_client=claim_client,
        master_seed=seed_raw,
        sentinel_control=sentinel,
        warm_pool_name=warm_pool,
        idle_timeout_s=float(os.environ.get("HUSSH_SANDBOX_IDLE_TIMEOUT_SECONDS") or "600"),
        health_poll_timeout_s=float(
            os.environ.get("HUSSH_SANDBOX_HEALTH_POLL_TIMEOUT_SECONDS") or "25"
        ),
        activation_header_value=os.environ.get("HUSSH_SANDBOX_ACTIVATION_TOKEN"),
        admin_header_value=os.environ.get("HUSSH_EDGE_ADMIN_TOKEN"),
        pod_url_base=os.environ.get("HUSSH_SANDBOX_EDGE_PUBLIC_URL"),
        hub_url=hub_url,
        scheduler_caller_emails=os.environ.get("HUSHH_SCHEDULER_CALLER_EMAILS"),
        schedule_worker_email=os.environ.get("HUSSH_SANDBOX_TASK_WORKER_EMAIL"),
        deploy_env=os.environ.get("HUSHH_DEPLOY_ENV"),
        consent_ed25519_public_keys=os.environ.get("CONSENT_ED25519_PUBLIC_KEYS"),
        ios_connector_client_id=os.environ.get("GOOGLE_IOS_CONNECTOR_CLIENT_ID"),
        owner_feed_ed25519_public_keys=os.environ.get("OWNER_FEED_ED25519_PUBLIC_KEYS"),
        allowed_app_origins=(
            os.environ.get("CORS_ALLOWED_ORIGINS") or os.environ.get("POD_ALLOWED_APP_ORIGINS")
        ),
        sentinel_model_gateway_url=os.environ.get("SENTINEL_MODEL_GATEWAY_URL"),
        sentinel_vertex_project=(
            os.environ.get("HUSSH_SENTINEL_VERTEX_PROJECT")
            or os.environ.get("GOOGLE_CLOUD_PROJECT")
        ),
        sentinel_vertex_location=os.environ.get("HUSSH_SENTINEL_VERTEX_LOCATION"),
        enable_prefix_storage=enable_prefix_storage,
        claim_timeout_s=float(os.environ.get("HUSSH_SANDBOX_CLAIM_TIMEOUT_SECONDS") or "180"),
        proxy_connect_timeout_s=float(
            os.environ.get("HUSSH_SANDBOX_PROXY_CONNECT_TIMEOUT_SECONDS") or "2.5"
        ),
        proxy_read_timeout_s=float(
            os.environ.get("HUSSH_SANDBOX_PROXY_READ_TIMEOUT_SECONDS") or "240.0"
        ),
    )
    return create_sandbox_edge_gateway_app(manager)
