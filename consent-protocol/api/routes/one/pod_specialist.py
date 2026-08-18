"""The hub reads a DB-backed specialist FOR a pod, so the pod never holds a key.

A per-person pod holds no database credential -- that is the zero-role pod
identity, and it is why a DB-backed specialist (location, first) cannot read the
owner's state in-pod and returns ``runtime_unavailable``. This route is the read
half of the fix: the pod asks the hub to run one specific, allow-listed read on
the owner's own project and return a fail-closed projection.

It is the sibling of ``pod_consent``. Same authentication spine (pod identity
only -- there is no legitimate non-pod caller), same failure posture (one shape
for every rejection, a 503 rather than a lie when the authority is unreachable).
What it adds is a THREE-way binding that has to hold before a single field is
read:

  1. the caller is a pod (``verify_pod_identity``);
  2. it carries a live, unrevoked per-turn scope for THIS read
     (``validate_token_with_db`` against the DB revoked set); and
  3. the scope's owner is the very person this pod IS -- the owner's HusshID
     resolved from the token must equal the pod's asserted HusshID. Without this
     a valid location scope belonging to person A, presented to person B's pod,
     would read A's holdings on B's pod. The pod cannot forge the binding: it
     asserts its HusshID with a Google-signed identity token, and the owner side
     comes from the hub-issued scope.

The read itself is read-only by construction (``pod_data_door``): the registry
maps a NAME to a read method and has no write path. Writes never come through
here; they take the directive transport, where the browser executes on the
owner's own session.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, Body, Header, HTTPException, Path, Request
from pydantic import BaseModel, ConfigDict, Field

from api.routes.one.pod_identity_auth import verify_pod_identity
from hushh_mcp.runtime_settings import personal_agent_enabled, pod_data_door_enabled

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/one/pod/specialist", tags=["personal-agent"])

#: Each door's required per-turn scope. Keyed on the specialist name, and the
#: scope is the SAME one the owner's own reads use -- the door does not invent a
#: weaker scope, it reuses the real one and the relay mints it per turn with a
#: short TTL. A name absent here has no door and is refused before any read.
_REQUIRED_SCOPE: dict[str, str] = {
    "location": "cap.location.live.view",
}


class PodSpecialistReadRequest(BaseModel):
    """The per-turn scope the relay minted, couriered by the pod. Nothing here
    identifies the owner -- that is resolved from the token server-side, never
    taken from the pod -- so the body cannot be used to read someone else."""

    scope_token: str = Field(..., alias="scopeToken", min_length=1, max_length=4096)

    model_config = ConfigDict(populate_by_name=True)


async def broker_specialist_read(
    request: Request,
    name: str,
    authorization: Optional[str],
    payload: PodSpecialistReadRequest,
    *,
    validator: Any = None,
    registry: Any = None,
    reader: Any = None,
) -> dict:
    """Testable core: authenticate the pod, bind the scope to it, then read.

    ``validator`` / ``registry`` / ``reader`` are injection seams so the binding
    and the projection can be tested without a database, exactly as
    ``pod_consent`` does.
    """
    if not personal_agent_enabled() or not pod_data_door_enabled():
        # Flag off -> the door does not exist. 404, not 403: an off feature is
        # absent, not forbidden, and absent leaks nothing about what it guards.
        raise HTTPException(status_code=404, detail="specialist read is not available")

    required_scope = _REQUIRED_SCOPE.get(name)
    if required_scope is None:
        # A name with no door. Refuse before reading anything adjacent.
        raise HTTPException(status_code=404, detail="no such specialist read")

    asserted = await verify_pod_identity(request, authorization)
    if not asserted:
        raise HTTPException(status_code=401, detail="pod identity required")

    check = validator
    if check is None:
        from hushh_mcp.consent.token import validate_token_with_db  # noqa: PLC0415

        check = validate_token_with_db

    try:
        valid, reason, parsed = await _run(check, payload.scope_token, required_scope)
    except Exception as exc:  # noqa: BLE001
        # The DB is the authority on revocation. Unreachable -> "I do not know",
        # surfaced as 503, never a read on an unverifiable scope.
        logger.warning("pod_specialist.authority_unavailable %s", type(exc).__name__)
        raise HTTPException(status_code=503, detail="consent authority is unavailable") from exc

    if not valid or parsed is None:
        logger.info(
            "pod_specialist.denied pod=%s name=%s reason=%s",
            asserted,
            name,
            str(reason or "")[:120],
        )
        raise HTTPException(status_code=403, detail="scope is not valid for this read")

    owner_id = str(getattr(parsed, "user_id", "") or "").strip()
    if not owner_id:
        raise HTTPException(status_code=403, detail="scope carries no owner")

    # The binding that makes this safe: the scope's owner must be the person this
    # pod IS. The pod asserted its HusshID with a Google-signed token; the owner's
    # HusshID comes from the hub-issued scope. A mismatch is A's scope on B's pod.
    owner_hushh_id = await _hushh_id_for(owner_id, registry=registry)
    if not owner_hushh_id or owner_hushh_id != asserted:
        logger.warning("pod_specialist.owner_binding_refused pod=%s name=%s", asserted, name)
        # Same 403 shape as an invalid scope: do not reveal whether the mismatch
        # was the binding or the token.
        raise HTTPException(status_code=403, detail="scope is not valid for this read")

    run_read = reader
    if run_read is None:
        from hushh_mcp.services.pod_data_door import run_pod_data_door_read  # noqa: PLC0415

        run_read = run_pod_data_door_read

    try:
        projection = run_read(name, owner_id=owner_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="no such specialist read") from exc
    except Exception as exc:  # noqa: BLE001
        logger.warning("pod_specialist.read_failed name=%s %s", name, type(exc).__name__)
        raise HTTPException(status_code=502, detail="specialist read failed") from exc

    logger.info("pod_specialist.read pod=%s name=%s", asserted, name)
    return {"name": name, "state": projection}


async def _hushh_id_for(user_id: str, *, registry: Any = None) -> str:
    """The HusshID registered to this user, or empty when it cannot be resolved.

    Empty resolves to a refused binding above -- fail closed, never fall through
    to a read on an unbound owner. Same resolver ``pod_consent`` uses."""
    if not user_id:
        return ""
    repo = registry
    if repo is None:
        from hushh_mcp.services.personal_agent_registry_repo import (  # noqa: PLC0415
            PersonalAgentRegistryRepo,
        )

        repo = PersonalAgentRegistryRepo()
    try:
        row = await repo.get(user_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("pod_specialist.hushh_id_lookup_failed %s", type(exc).__name__)
        return ""
    return str((row or {}).get("hushh_id") or "")


async def _run(check: Any, token: str, scope: str):
    """Call the validator whether it is sync or async, without guessing a wrapper."""
    import inspect  # noqa: PLC0415

    result = check(token, expected_scope=scope)
    if inspect.isawaitable(result):
        return await result
    return result


@router.post("/{name}/read")
async def specialist_read_route(
    request: Request,
    name: str = Path(..., min_length=1, max_length=64),
    authorization: Optional[str] = Header(default=None),
    payload: PodSpecialistReadRequest = Body(...),
) -> dict:
    return await broker_specialist_read(request, name, authorization, payload)


__all__ = ["broker_specialist_read", "router", "PodSpecialistReadRequest"]
