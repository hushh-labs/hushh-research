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

from typing import Any, Literal, Optional

from fastapi import APIRouter, Body, Header, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from api.routes.one.pod_identity_auth import verify_pod_request
from hushh_mcp.runtime_settings import personal_agent_enabled
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

router = APIRouter(prefix="/api/one/pod/custody", tags=["personal-agent"])


class PodStorageTokenRequest(BaseModel):
    ttl_seconds: int = Field(
        default=MAX_STORAGE_TTL_SECONDS,
        alias="ttlSeconds",
        ge=MIN_STORAGE_TTL_SECONDS,
        le=MAX_STORAGE_TTL_SECONDS,
    )
    provider: Optional[StorageProviderKind] = Field(default=None)

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
    verified = await verify_pod_request(
        request,
        authorization,
        owner_bound=True,
        registry=registry,
        store=store,
        refresh=refresh,
        standbys=standbys,
    )
    if verified is None or not verified.signed:
        raise HTTPException(status_code=401, detail="signed pod identity required")
    try:
        return await describe_hub_custody_broker_key(
            verified=verified,
            registry=registry,
            owner_tombstoned_fn=owner_tombstoned_fn,
            secret=secret,
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
    verified = await verify_pod_request(
        request,
        authorization,
        owner_bound=True,
        registry=registry,
        store=store,
        refresh=refresh,
        standbys=standbys,
    )
    if verified is None or not verified.signed:
        raise HTTPException(status_code=401, detail="signed pod identity required")
    try:
        return await broker_pod_storage_token(
            verified=verified,
            ttl_seconds=payload.ttl_seconds,
            provider=payload.provider,
            registry=registry,
            owner_tombstoned_fn=owner_tombstoned_fn,
            http_session=http_session,
            gcp_source_token=gcp_source_token,
            aws_sts_client=aws_sts_client,
            azure_delegation_key=azure_delegation_key,
            secret=secret,
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
    verified = await verify_pod_request(
        request,
        authorization,
        owner_bound=True,
        registry=registry,
        store=store,
        refresh=refresh,
        standbys=standbys,
    )
    if verified is None or not verified.signed:
        raise HTTPException(status_code=401, detail="signed pod identity required")
    try:
        return await broker_pod_dek_envelope(
            verified=verified,
            operation=payload.operation,
            sealed_dek_b64=payload.sealed_dek,
            broker_key_id=payload.broker_key_id,
            wrapped_dek_b64=payload.wrapped_dek,
            registry=registry,
            owner_tombstoned_fn=owner_tombstoned_fn,
            kms_backend=kms_backend,
            http_session=http_session,
            gcp_token=gcp_token,
            aws_kms_client=aws_kms_client,
            secret=secret,
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
