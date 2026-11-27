# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Hub-only endpoint for single-use Agent Sandbox warm-pool claims (#9744)."""

from __future__ import annotations

import os
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from api.middleware import require_firebase_auth
from api.middlewares.rate_limit import RateLimits, limiter
from hushh_mcp.runtime_settings import personal_agent_enabled
from hushh_mcp.services.agent_sandbox.hub_sandbox_router import HubSandboxSessionRouter
from hushh_mcp.services.agent_sandbox.lease_manager import SandboxAdmissionError

router = APIRouter(prefix="/api/one/sandbox/claims", tags=["personal-agent"])

_DEFAULT_ROUTER: HubSandboxSessionRouter | None = None


class SandboxClaimRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    workspace_id: str = Field(..., min_length=1, max_length=128)
    billing_space_id: str | None = Field(default=None, max_length=63)
    target: str = Field(default="ace", min_length=1, max_length=32)
    units: int = Field(default=1, ge=0, le=100)
    idle_shutdown_seconds: int = Field(default=600, ge=60, le=3600)


def _require_sandbox_pool_enabled() -> None:
    enabled = (os.environ.get("HUSSH_AGENT_SANDBOX_POOL_ENABLED") or "").strip().lower()
    if not personal_agent_enabled() or enabled not in {"1", "true", "yes"}:
        raise HTTPException(status_code=404, detail="sandbox pool routing is not enabled")


def set_hub_sandbox_router(router_instance: HubSandboxSessionRouter | None) -> None:
    """Attach or clear the singleton Hub sandbox router (used by runtime startup and tests)."""
    global _DEFAULT_ROUTER
    _DEFAULT_ROUTER = router_instance


def get_hub_sandbox_router() -> HubSandboxSessionRouter:
    global _DEFAULT_ROUTER
    if _DEFAULT_ROUTER is not None:
        return _DEFAULT_ROUTER
    if not (os.environ.get("KUBERNETES_SERVICE_HOST") or "").strip():
        raise HTTPException(
            status_code=503,
            detail={
                "code": "SANDBOX_ROUTER_UNCONFIGURED",
                "message": "Agent sandbox router is not connected to a Kubernetes cluster.",
            },
        )
    raw_hmac = (os.environ.get("SENTINEL_AUDIT_HMAC_KEY") or "").strip().encode("utf-8")
    if len(raw_hmac) < 32:
        raise HTTPException(
            status_code=503,
            detail={"code": "SANDBOX_ROUTER_UNCONFIGURED", "message": "Audit key unavailable."},
        )
    from hushh_mcp.services.ace_backend import AceComputeBackend

    _DEFAULT_ROUTER = AceComputeBackend().build_hub_sandbox_router(
        audit_hmac_key=raw_hmac,
        namespace=(os.environ.get("HUSSH_SANDBOX_NAMESPACE") or "hussh-agents").strip(),
        warm_pool_name=(os.environ.get("HUSSH_SANDBOX_POOL") or "hussh-one-warm-pool").strip(),
        sentinel_control_url=os.environ.get("SENTINEL_CONTROL_URL"),
        sentinel_control_token=os.environ.get("SENTINEL_CONTROL_TOKEN"),
        use_in_cluster_k8s=True,
    )
    return _DEFAULT_ROUTER


@router.post("")
@limiter.limit(RateLimits.AGENT_CHAT)
async def create_sandbox_claim(
    request: Request,
    payload: SandboxClaimRequest,
    user_id: str = Depends(require_firebase_auth),
) -> dict[str, Any]:
    """Claim one untouched virgin sandbox lease after quota/invite checks."""
    _require_sandbox_pool_enabled()
    hub_router = get_hub_sandbox_router()
    try:
        session = hub_router.allocate_turn_sandbox(
            owner_id=user_id,
            workspace_id=payload.workspace_id,
            billing_space_id=payload.billing_space_id or user_id,
            target=payload.target,
            units=payload.units,
            idle_shutdown_seconds=payload.idle_shutdown_seconds,
        )
    except SandboxAdmissionError as exc:
        raise HTTPException(
            status_code=exc.status,
            detail={"code": exc.code, "message": str(exc)},
        ) from None
    return dict(session.to_public_dict())


@router.get("/{lease_id}")
@limiter.limit(RateLimits.AGENT_CHAT)
async def read_sandbox_claim(
    request: Request,
    lease_id: str,
    user_id: str = Depends(require_firebase_auth),
) -> dict[str, Any]:
    """Read an active sandbox claim lease owned by the caller."""
    _require_sandbox_pool_enabled()
    hub_router = get_hub_sandbox_router()
    try:
        return dict(hub_router.get_session(lease_id, owner_id=user_id).to_public_dict())
    except SandboxAdmissionError as exc:
        raise HTTPException(
            status_code=exc.status,
            detail={"code": exc.code, "message": str(exc)},
        ) from None


@router.delete("/{lease_id}")
@limiter.limit(RateLimits.AGENT_CHAT)
async def destroy_sandbox_claim(
    request: Request,
    lease_id: str,
    user_id: str = Depends(require_firebase_auth),
) -> dict[str, Any]:
    """Zeroize ephemeral scratch keys, revoke surrogates, and destroy the single-use sandbox."""
    _require_sandbox_pool_enabled()
    hub_router = get_hub_sandbox_router()
    try:
        receipt = hub_router.teardown_turn_sandbox(lease_id, owner_id=user_id)
    except SandboxAdmissionError as exc:
        raise HTTPException(
            status_code=exc.status,
            detail={"code": exc.code, "message": str(exc)},
        ) from None
    return {
        "lease_id": receipt.lease_id,
        "sandbox_instance_id": receipt.sandbox_instance_id,
        "key_zeroized": receipt.key_zeroized,
        "sandbox_terminated": receipt.sandbox_terminated,
        "tombstoned_at_s": receipt.tombstoned_at_s,
    }
