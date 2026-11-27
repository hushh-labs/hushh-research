# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Hub Zero-Role Capability & Custody Broker HTTP door (`/api/one/pod/custody/*`).

Mounted on the central Hub ONLY (`_hub_router.py`), never on `pod_server.py`.
Authenticates active primary private pods strictly via signed Ed25519 request
identity (`verify_pod_request(..., owner_bound=True)` + `verified.signed is True`)
and brokers:

* `GET /api/one/pod/custody/broker-key` — Hub X25519 public key for sealed DEK upload
* `POST /api/one/pod/custody/storage-token` — 15-minute `pods/{hushh_id}/*` prefix token
* `POST /api/one/pod/custody/dek` — AAD-bound regional KMS DEK wrap/unwrap (zero plaintext DEK)
"""

from __future__ import annotations

import time
from typing import Any, Literal, Optional, cast
from urllib.parse import parse_qsl

from fastapi import APIRouter, Body, Header, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from api.routes.one.pod_identity_auth import verify_pod_request
from hushh_mcp.runtime_settings import (
    personal_agent_enabled,
    pod_hub_expected_audience,
    pod_hub_identity_auth_enabled,
)
from hushh_mcp.services.agent_sandbox.edge_gateway_app import (
    verify_sandbox_edge_placement_headers,
)
from hushh_mcp.services.pod_capability_broker import (
    MAX_STORAGE_TTL_SECONDS,
    MIN_STORAGE_TTL_SECONDS,
    PodCapabilityBrokerForbidden,
    PodCapabilityBrokerUnauthorized,
    PodCapabilityBrokerUnavailable,
    StorageProviderKind,
    broker_pod_dek_envelope,
    broker_pod_storage_token,
    describe_hub_custody_broker_key,
)
from hushh_mcp.services.pod_hub_client import POD_IDENTITY_HEADER
from hushh_mcp.services.pod_placement_fence import row_epoch
from hushh_mcp.services.pod_request_signing import (
    PodRequestSignatureMalformed,
    VerifiedPod,
    parse_signature_headers,
    timestamp_in_window,
    verify_request_signature,
)
from hushh_mcp.services.pod_request_verifier import NONCE_RETENTION_MS
from hushh_mcp.services.pooled_sandbox_cutover import (
    _identity_master_seed,
    derive_pooled_owner_public_keys,
    sandbox_pool_cutover_enabled,
)

router = APIRouter(prefix="/api/one/pod/custody", tags=["personal-agent"])

_PRECUTOVER_ALLOWED_STATUSES = frozenset(
    {"provisioned", "migrating", "needs_reinit", "provisioning_failed"}
)


class _PooledCutoverCustodyRegistryView:
    """Read-through registry projection for a pre-detach pooled ACE destination sandbox."""

    def __init__(
        self,
        base_registry: Any,
        *,
        hushh_id: str,
        owner_id: str,
        pooled_keys: dict[str, str],
    ) -> None:
        self._base = base_registry
        self._hushh_id = hushh_id
        self._owner_id = owner_id
        self._keys = pooled_keys

    def _overlay(self, row: Any) -> Optional[dict[str, Any]]:
        if not isinstance(row, dict):
            return None
        if (
            str(row.get("hushh_id") or "") != self._hushh_id
            or str(row.get("user_id") or "") != self._owner_id
        ):
            return dict(row)
        meta = row.get("backend_metadata")
        if isinstance(meta, dict) and "erasure" in meta:
            return dict(row)
        if str(row.get("status") or "") not in _PRECUTOVER_ALLOWED_STATUSES:
            return dict(row)
        return {
            **row,
            "status": "provisioned",
            "deployment_target": "ace",
            "pod_pubkey": self._keys["pod_pubkey"],
            "pod_key_id": self._keys["pod_key_id"],
            "pod_signing_pubkey": self._keys["pod_signing_pubkey"],
            "pod_signing_key_id": self._keys["pod_signing_key_id"],
        }

    async def get_by_hushh_id(self, hushh_id: str) -> Optional[dict[str, Any]]:
        return self._overlay(await self._base.get_by_hushh_id(hushh_id))

    async def get(self, user_id: str) -> Optional[dict[str, Any]]:
        return self._overlay(await self._base.get(user_id))

    async def tombstone_exists(self, key: str) -> bool:
        fn = getattr(self._base, "tombstone_exists", None)
        return bool(await fn(key)) if callable(fn) else False

    def clear_request_cache(self) -> None:
        clear_fn = getattr(self._base, "clear_request_cache", None)
        if callable(clear_fn):
            clear_fn()


class _RequestScopedRegistryReadCache:
    """Per-request read cache avoiding redundant registry reads across auth + pre-fence.

    Always cleared before post-I/O fencing via ``clear_request_cache()`` so mid-flight
    placement or erasure mutations during external STS/KMS calls are never masked.
    Cross-indexing ``user_id`` from ``get_by_hushh_id`` is enabled ONLY when backed by
    ``PersonalAgentRegistryRepo``, where PostgreSQL enforces ``UNIQUE(user_id)`` PK and
    ``UNIQUE(hushh_id)``.
    """

    def __init__(self, base_registry: Any, *, unique_owner_pk: bool = False) -> None:
        self._base = base_registry
        self._unique_owner_pk = unique_owner_pk
        self._by_hushh: dict[str, Optional[dict[str, Any]]] = {}
        self._by_user: dict[str, Optional[dict[str, Any]]] = {}

    def clear_request_cache(self) -> None:
        self._by_hushh.clear()
        self._by_user.clear()

    async def get_by_hushh_id(self, hushh_id: str) -> Optional[dict[str, Any]]:
        if hushh_id in self._by_hushh:
            cached = self._by_hushh[hushh_id]
            return dict(cached) if isinstance(cached, dict) else None
        row = await self._base.get_by_hushh_id(hushh_id)
        copied = dict(row) if isinstance(row, dict) else None
        self._by_hushh[hushh_id] = copied
        if self._unique_owner_pk and isinstance(copied, dict):
            uid = str(copied.get("user_id") or "").strip()
            if uid:
                self._by_user[uid] = copied
        return dict(copied) if isinstance(copied, dict) else None

    async def get(self, user_id: str) -> Optional[dict[str, Any]]:
        if user_id in self._by_user:
            cached = self._by_user[user_id]
            return dict(cached) if isinstance(cached, dict) else None
        row = await self._base.get(user_id)
        copied = dict(row) if isinstance(row, dict) else None
        self._by_user[user_id] = copied
        if self._unique_owner_pk and isinstance(copied, dict):
            hid = str(copied.get("hushh_id") or "").strip()
            if hid:
                self._by_hushh[hid] = copied
        return dict(copied) if isinstance(copied, dict) else None

    async def tombstone_exists(self, key: str) -> bool:
        fn = getattr(self._base, "tombstone_exists", None)
        return bool(await fn(key)) if callable(fn) else False

    def __getattr__(self, name: str) -> Any:
        return getattr(self._base, name)


async def _verify_precutover_pooled_sandbox(
    request: Request,
    *,
    registry: Any = None,
    store: Any = None,
) -> tuple[Optional[VerifiedPod], Any]:
    """Authenticate a Hub-derived pooled ACE sandbox booting pre-detach during lossless sync."""
    if not pod_hub_identity_auth_enabled() or not sandbox_pool_cutover_enabled():
        return None, registry
    try:
        signed = parse_signature_headers(request.headers)
    except PodRequestSignatureMalformed:
        return None, registry
    if signed is None:
        return None, registry

    hushh_id = str(request.headers.get(POD_IDENTITY_HEADER) or "").strip()
    aud = pod_hub_expected_audience()
    seed = _identity_master_seed()
    if not hushh_id or not aud or len(seed) < 32:
        return None, registry
    try:
        pooled_keys = derive_pooled_owner_public_keys(seed, hushh_id)
    except ValueError:
        return None, registry
    if signed.kid != pooled_keys["pod_signing_key_id"]:
        return None, registry

    now_ms = int(time.time() * 1000)
    if not timestamp_in_window(signed.ts_ms, now_ms):
        return None, registry

    if registry is None:
        from hushh_mcp.services.personal_agent_registry_repo import (  # noqa: PLC0415
            PersonalAgentRegistryRepo,
        )

        base_reg: Any = PersonalAgentRegistryRepo()
    else:
        base_reg = registry

    try:
        row = await base_reg.get_by_hushh_id(hushh_id)
    except Exception:  # noqa: BLE001
        return None, registry
    if not isinstance(row, dict) or str(row.get("hushh_id") or "") != hushh_id:
        return None, registry
    owner_id = str(row.get("user_id") or "").strip()
    meta = row.get("backend_metadata")
    if (
        not owner_id
        or str(row.get("status") or "") not in _PRECUTOVER_ALLOWED_STATUSES
        or (isinstance(meta, dict) and "erasure" in meta)
    ):
        return None, registry

    ep = row_epoch(row)
    if ep is None or (ep > 0 and (signed.epoch is None or signed.epoch < ep)):
        return None, registry

    try:
        body = await request.body()
    except Exception:  # noqa: BLE001
        return None, registry
    if not verify_request_signature(
        pooled_keys["pod_signing_pubkey"],
        signed,
        aud=aud,
        hushh_id=hushh_id,
        method=request.method,
        path=request.url.path,
        query_pairs=parse_qsl(request.url.query, keep_blank_values=True),
        body=body,
    ):
        return None, registry

    if store is None:
        from hushh_mcp.services.pod_request_identity_store import (  # noqa: PLC0415
            PodRequestIdentityStore,
        )

        nonce_store: Any = PodRequestIdentityStore()
    else:
        nonce_store = store
    try:
        consumed = bool(
            await nonce_store.consume_nonce(
                kid=signed.kid,
                nonce=signed.nonce,
                expires_at_ms=signed.ts_ms + NONCE_RETENTION_MS,
            )
        )
    except Exception:  # noqa: BLE001
        return None, registry
    if not consumed:
        return None, registry

    overlay = _PooledCutoverCustodyRegistryView(
        base_reg,
        hushh_id=hushh_id,
        owner_id=owner_id,
        pooled_keys=pooled_keys,
    )
    return VerifiedPod(hushh_id=hushh_id, key_id=signed.kid, standby=False), overlay


async def _resolve_custody_caller(
    request: Request,
    authorization: Optional[str],
    *,
    registry: Any = None,
    store: Any = None,
    refresh: Any = None,
    standbys: Any = None,
) -> tuple[VerifiedPod, Any]:
    from hushh_mcp.services.personal_agent_registry_repo import (  # noqa: PLC0415
        PersonalAgentRegistryRepo,
    )

    if registry is None:
        base_registry: Any = PersonalAgentRegistryRepo()
        unique_owner_pk = True
    else:
        base_registry = registry
        unique_owner_pk = isinstance(PersonalAgentRegistryRepo, type) and isinstance(
            base_registry, PersonalAgentRegistryRepo
        )

    cached_registry = _RequestScopedRegistryReadCache(
        base_registry,
        unique_owner_pk=unique_owner_pk,
    )
    verified = await verify_pod_request(
        request,
        authorization,
        owner_bound=True,
        registry=cached_registry,
        store=store,
        refresh=refresh,
        standbys=standbys,
    )
    if verified is not None and verified.signed:
        return verified, cached_registry
    precutover_pod, overlay_reg = await _verify_precutover_pooled_sandbox(
        request, registry=cached_registry, store=store
    )
    if precutover_pod is not None and precutover_pod.signed:
        return precutover_pod, overlay_reg
    raise HTTPException(status_code=401, detail="signed pod identity required")


async def handle_sandbox_placement(
    hushh_id: str,
    request: Request,
    *,
    registry: Any = None,
    master_seed: Optional[bytes] = None,
) -> dict[str, Any]:
    """Return owner placement_epoch strictly to HMAC-authenticated Sandbox Edge Gateway."""
    if not personal_agent_enabled():
        raise HTTPException(status_code=404, detail="personal agent is not available")
    seed = master_seed if master_seed is not None else _identity_master_seed()
    if len(seed) < 32:
        raise HTTPException(status_code=503, detail="sandbox identity master key unconfigured")
    if not verify_sandbox_edge_placement_headers(seed, hushh_id, request.headers):
        raise HTTPException(status_code=401, detail="sandbox edge signature required")

    reg = registry
    if reg is None:
        from hushh_mcp.services.personal_agent_registry_repo import (  # noqa: PLC0415
            PersonalAgentRegistryRepo,
        )

        reg = PersonalAgentRegistryRepo()
    try:
        row = await reg.get_by_hushh_id(hushh_id)
    except Exception:  # noqa: BLE001
        raise HTTPException(status_code=503, detail="pod registry authority unavailable") from None

    epoch = row_epoch(row) if isinstance(row, dict) else 0
    if epoch is None:
        raise HTTPException(status_code=503, detail="placement epoch malformed")
    return {"hushhId": hushh_id, "placementEpoch": max(0, int(epoch))}


class PodStorageTokenRequest(BaseModel):
    ttl_seconds: int = Field(
        default=MAX_STORAGE_TTL_SECONDS,
        alias="ttlSeconds",
        ge=MIN_STORAGE_TTL_SECONDS,
        le=MAX_STORAGE_TTL_SECONDS,
    )
    provider: Optional[StorageProviderKind] = Field(default=None)
    subprefix: Optional[str] = Field(default=None, max_length=96)

    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class PodDekBrokerRequest(BaseModel):
    operation: Literal["wrap", "unwrap"]
    sealed_dek: Optional[str] = Field(default=None, alias="sealedDek", max_length=4096)
    broker_key_id: Optional[str] = Field(default=None, alias="brokerKeyId", max_length=128)
    wrapped_dek: Optional[str] = Field(default=None, alias="wrappedDek", max_length=8192)

    model_config = ConfigDict(populate_by_name=True, extra="forbid")


def _raise_broker_http_error(exc: Exception) -> None:
    if isinstance(exc, PodCapabilityBrokerUnauthorized):
        raise HTTPException(status_code=401, detail="signed pod identity required") from None
    if isinstance(exc, PodCapabilityBrokerForbidden):
        raise HTTPException(status_code=403, detail="pod custody operation refused") from None
    if isinstance(exc, PodCapabilityBrokerUnavailable):
        raise HTTPException(status_code=503, detail="pod custody authority unavailable") from None
    raise exc


async def handle_broker_key(
    request: Request,
    authorization: Optional[str],
    *,
    registry: Any = None,
    store: Any = None,
    refresh: Any = None,
    standbys: Any = None,
    owner_tombstoned_fn: Any = None,
    secret: Optional[bytes] = None,
) -> dict[str, str]:
    if not personal_agent_enabled():
        raise HTTPException(status_code=404, detail="personal agent is not available")
    verified, eff_registry = await _resolve_custody_caller(
        request,
        authorization,
        registry=registry,
        store=store,
        refresh=refresh,
        standbys=standbys,
    )
    try:
        return cast(
            dict[str, str],
            await describe_hub_custody_broker_key(
                verified=verified,
                registry=eff_registry,
                owner_tombstoned_fn=owner_tombstoned_fn,
                secret=secret,
            ),
        )
    except (
        PodCapabilityBrokerUnauthorized,
        PodCapabilityBrokerForbidden,
        PodCapabilityBrokerUnavailable,
    ) as exc:
        _raise_broker_http_error(exc)
        raise AssertionError("unreachable") from exc


async def handle_storage_token(
    request: Request,
    authorization: Optional[str],
    payload: PodStorageTokenRequest,
    *,
    registry: Any = None,
    store: Any = None,
    refresh: Any = None,
    standbys: Any = None,
    owner_tombstoned_fn: Any = None,
    http_session: Any = None,
    gcp_source_token: Optional[str] = None,
    aws_sts_client: Any = None,
    azure_delegation_key: Any = None,
    secret: Optional[bytes] = None,
) -> dict[str, Any]:
    if not personal_agent_enabled():
        raise HTTPException(status_code=404, detail="personal agent is not available")
    verified, eff_registry = await _resolve_custody_caller(
        request,
        authorization,
        registry=registry,
        store=store,
        refresh=refresh,
        standbys=standbys,
    )
    try:
        return cast(
            dict[str, Any],
            await broker_pod_storage_token(
                verified=verified,
                ttl_seconds=payload.ttl_seconds,
                provider=payload.provider,
                subprefix=payload.subprefix,
                registry=eff_registry,
                owner_tombstoned_fn=owner_tombstoned_fn,
                http_session=http_session,
                gcp_source_token=gcp_source_token,
                aws_sts_client=aws_sts_client,
                azure_delegation_key=azure_delegation_key,
                secret=secret,
            ),
        )
    except (
        PodCapabilityBrokerUnauthorized,
        PodCapabilityBrokerForbidden,
        PodCapabilityBrokerUnavailable,
    ) as exc:
        _raise_broker_http_error(exc)
        raise AssertionError("unreachable") from exc


async def handle_dek_envelope(
    request: Request,
    authorization: Optional[str],
    payload: PodDekBrokerRequest,
    *,
    registry: Any = None,
    store: Any = None,
    refresh: Any = None,
    standbys: Any = None,
    owner_tombstoned_fn: Any = None,
    kms_backend: Any = None,
    http_session: Any = None,
    gcp_token: Optional[str] = None,
    aws_kms_client: Any = None,
    secret: Optional[bytes] = None,
) -> dict[str, str]:
    if not personal_agent_enabled():
        raise HTTPException(status_code=404, detail="personal agent is not available")
    verified, eff_registry = await _resolve_custody_caller(
        request,
        authorization,
        registry=registry,
        store=store,
        refresh=refresh,
        standbys=standbys,
    )
    try:
        return cast(
            dict[str, str],
            await broker_pod_dek_envelope(
                verified=verified,
                operation=payload.operation,
                sealed_dek_b64=payload.sealed_dek,
                broker_key_id=payload.broker_key_id,
                wrapped_dek_b64=payload.wrapped_dek,
                registry=eff_registry,
                owner_tombstoned_fn=owner_tombstoned_fn,
                kms_backend=kms_backend,
                http_session=http_session,
                gcp_token=gcp_token,
                aws_kms_client=aws_kms_client,
                secret=secret,
            ),
        )
    except (
        PodCapabilityBrokerUnauthorized,
        PodCapabilityBrokerForbidden,
        PodCapabilityBrokerUnavailable,
    ) as exc:
        _raise_broker_http_error(exc)
        raise AssertionError("unreachable") from exc


@router.get("/broker-key")
async def get_custody_broker_key_endpoint(
    request: Request,
    authorization: Optional[str] = Header(default=None),
) -> dict[str, str]:
    return await handle_broker_key(request, authorization)


@router.get("/sandbox-placement/{hushh_id}")
async def get_sandbox_placement_epoch_endpoint(
    hushh_id: str,
    request: Request,
) -> dict[str, Any]:
    return await handle_sandbox_placement(hushh_id, request)


@router.post("/storage-token")
async def mint_pod_storage_token_endpoint(
    request: Request,
    payload: PodStorageTokenRequest = Body(default_factory=PodStorageTokenRequest),
    authorization: Optional[str] = Header(default=None),
) -> dict[str, Any]:
    return await handle_storage_token(request, authorization, payload)


@router.post("/dek")
async def broker_pod_dek_endpoint(
    request: Request,
    payload: PodDekBrokerRequest = Body(...),
    authorization: Optional[str] = Header(default=None),
) -> dict[str, str]:
    return await handle_dek_envelope(request, authorization, payload)
