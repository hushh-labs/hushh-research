"""The signed owner feed: what an owner-cloud agent used to ask a scope-token door.

An agent in the person's own cloud no longer couriers a per-question consent token
to the hub to read its owner's location state, consent center, marketplace listing
or command candidates. It asks this route, which:

  1. authenticates the caller by its Ed25519 request signature only
     (``verify_pod_request`` with ``owner_bound``; the Google identity path and the
     standby key are refused), so the caller is one specific agent;
  2. resolves the owner from the registry row that agent's signing key is recorded
     on, never from anything the request carries, and requires that row to be a
     serving owner-cloud placement;
  3. builds the same fail-closed projection the old door returned
     (``pod_data_door``, ``pod_marketplace_read``, ``pod_command_reads``), then
     re-checks the serving binding before anything leaves;
  4. signs the answer under ``OWNER_FEED`` and seals it to the agent's X25519 key,
     so only that agent can read it and it knows the hub said it.

The consent question disappears here on purpose: this is the owner's own metadata
going to the owner's own agent, and the owner's session admits the read inside the
agent. Writes never come through here.
"""

from __future__ import annotations

import base64
import inspect
import logging
import time
from typing import Any, Literal, Optional

from fastapi import APIRouter, Body, Header, HTTPException, Path, Query, Request

from api.routes.one.pod_identity_auth import verify_pod_request
from hushh_mcp.runtime_settings import personal_agent_enabled
from hushh_mcp.services.pod_command_reads import MetadataCommandReadOptions
from hushh_mcp.services.pod_marketplace_read import MarketplaceReadOptions

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/one/pod/owner-feed", tags=["personal-agent"])

_SNAPSHOT_KINDS = frozenset({"location", "nav", "marketplace"})


async def _resolve_owner(verified: Any, registry: Any) -> tuple[str, bytes, str]:
    """The owner, and the agent key to seal to, from the row this signer holds."""
    from hushh_mcp.services.compute_backend import is_owner_cloud_target  # noqa: PLC0415
    from hushh_mcp.services.pod_access_audit import (  # noqa: PLC0415
        resolve_serving_owner_hushh_id,
    )
    from hushh_mcp.services.pod_connector_keypair_service import (  # noqa: PLC0415
        parse_pod_public_key,
    )

    try:
        row = await registry.get_by_hushh_id(verified.hushh_id)
        owner_id = str((row or {}).get("user_id") or "")
        serving = await resolve_serving_owner_hushh_id(owner_id, registry=registry)
    except Exception:  # noqa: BLE001 - never disclose database details
        raise HTTPException(503, detail="owner feed is unavailable") from None
    if (
        not row
        or not owner_id
        or serving != verified.hushh_id
        or row.get("pod_signing_key_id") != verified.key_id
        or not is_owner_cloud_target(row.get("deployment_target"))
    ):
        raise HTTPException(403, detail="owner feed is not available to this agent")
    try:
        key = parse_pod_public_key(str(row.get("pod_pubkey") or ""), str(row.get("pod_key_id")))
    except ValueError:
        raise HTTPException(403, detail="owner feed is not available to this agent") from None
    return owner_id, base64.b64decode(key.public_key_b64), key.key_id


async def _read_projection(
    kind: str,
    owner_id: str,
    *,
    marketplace: Optional[MarketplaceReadOptions],
    command: Optional[MetadataCommandReadOptions],
) -> Any:
    if kind == "command":
        from hushh_mcp.services.pod_command_reads import (  # noqa: PLC0415
            read_metadata_command_projection,
        )

        if command is None:
            raise ValueError("command feed needs its read options")
        return await read_metadata_command_projection(owner_id, command)
    if kind == "marketplace" and marketplace is not None:
        from hushh_mcp.services.pod_marketplace_read import (  # noqa: PLC0415
            read_marketplace_metadata,
        )

        return await read_marketplace_metadata(owner_id, marketplace)
    from hushh_mcp.services.pod_data_door import run_pod_data_door_read  # noqa: PLC0415

    return await run_pod_data_door_read(kind, owner_id=owner_id)


async def serve_owner_feed(
    request: Request,
    kind: str,
    authorization: Optional[str],
    *,
    marketplace: Optional[MarketplaceReadOptions] = None,
    command: Optional[MetadataCommandReadOptions] = None,
    registry: Any = None,
    verifier: Any = None,
    reader: Any = None,
    now_ms: Optional[int] = None,
) -> dict:
    """Testable core. ``registry`` / ``verifier`` / ``reader`` are injection seams."""
    if not personal_agent_enabled():
        raise HTTPException(404, detail="owner feed is not available")
    if kind not in _SNAPSHOT_KINDS and kind != "command":
        raise HTTPException(404, detail="no such owner feed")
    check = verifier or verify_pod_request
    verified = await check(request, authorization, owner_bound=True)
    if verified is None or not getattr(verified, "signed", False) or verified.standby:
        raise HTTPException(401, detail="signed agent identity required")
    if registry is None:
        from hushh_mcp.services.personal_agent_registry_repo import (  # noqa: PLC0415
            PersonalAgentRegistryRepo,
        )

        registry = PersonalAgentRegistryRepo()
    owner_id, pod_public, pod_key_id = await _resolve_owner(verified, registry)
    try:
        projection = (reader or _read_projection)(
            kind, owner_id, marketplace=marketplace, command=command
        )
        if inspect.isawaitable(projection):
            projection = await projection
    except Exception as exc:  # noqa: BLE001
        logger.warning("pod_owner_feed.read_failed kind=%s %s", kind, type(exc).__name__)
        raise HTTPException(502, detail="owner feed read failed") from None
    if not isinstance(projection, dict):
        raise HTTPException(502, detail="owner feed read failed")
    # The read can block on storage: the binding must still hold before it leaves.
    binding_after = await _resolve_owner(verified, registry)
    if binding_after != (owner_id, pod_public, pod_key_id):
        raise HTTPException(403, detail="owner feed is not available to this agent")

    from hushh_mcp.services.pod_owner_feed_envelope import seal_feed, sign_feed  # noqa: PLC0415

    try:
        signed = sign_feed(
            kind=kind,
            owner_id=owner_id,
            hushh_id=verified.hushh_id,
            projection=projection,
            issued_at_ms=int(time.time() * 1000) if now_ms is None else now_ms,
        )
        envelope = seal_feed(signed, pod_public_key_raw=pod_public, pod_key_id=pod_key_id)
    except Exception as exc:  # noqa: BLE001 - an unsignable feed is unavailable, never unsigned
        logger.warning("pod_owner_feed.sign_failed %s", type(exc).__name__)
        raise HTTPException(503, detail="owner feed is unavailable") from None
    logger.info("pod_owner_feed.served pod=%s kind=%s", verified.hushh_id, kind)
    return {"envelope": envelope}


@router.get("/{kind}")
async def owner_feed_route(
    request: Request,
    kind: str = Path(..., min_length=1, max_length=32),
    operation: Optional[Literal["published", "publishable", "earnings"]] = Query(None),
    topic: Optional[str] = Query(None, max_length=160),
    power: Optional[str] = Query(None, max_length=40),
    mood: Optional[str] = Query(None, max_length=40),
    authorization: Optional[str] = Header(default=None),
) -> dict:
    if kind not in _SNAPSHOT_KINDS:
        raise HTTPException(404, detail="no such owner feed")
    options = {
        key: value
        for key, value in (
            ("operation", operation),
            ("topic", topic),
            ("power", power),
            ("mood", mood),
        )
        if value is not None
    }
    if options and kind != "marketplace":
        raise HTTPException(422, detail="read options belong to the marketplace feed")
    marketplace = MarketplaceReadOptions(**options) if kind == "marketplace" else None
    return await serve_owner_feed(request, kind, authorization, marketplace=marketplace)


@router.post("/command")
async def owner_feed_command_route(
    request: Request,
    payload: MetadataCommandReadOptions = Body(...),
    authorization: Optional[str] = Header(default=None),
) -> dict:
    return await serve_owner_feed(request, "command", authorization, command=payload)


__all__ = ["router", "serve_owner_feed"]
