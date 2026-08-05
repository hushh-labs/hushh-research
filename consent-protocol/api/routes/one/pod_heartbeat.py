"""The pod's "I am alive" door.

Push, not poll, and the direction is the whole point. The hub cannot cheaply ask
every pod in the fleet whether it is up: the pods are ``internal``-ingress services
with no public binding, so each check is an authenticated round trip -- and on the
scale-to-zero tier the question itself WAKES the pod being asked, which means a
polling health check would bill the founder for the privilege of finding out that
idle pods are idle. A pod reporting in costs one small request from a process that
is already running, and its silence is then real evidence rather than an artifact of
the hub's own timeout.

Authentication is pod-identity ONLY. Unlike the prompt route, there is no
consent-token fallback here, because there is no legitimate non-pod caller: a
person's browser has no reason to claim their agent is alive. Anything that is not
a verified pod gets 401 and writes nothing.

What a heartbeat is allowed to assert
-------------------------------------
Only that the pod bearing this HusshID is running. The body is ignored entirely --
there is deliberately no self-reported "status": "healthy" field to trust, because a
pod sick enough to lie about its health is exactly the pod whose self-report is
worthless. The fact recorded is the arrival of the beat itself, which the pod cannot
fake by being broken.

The HusshID comes from the verified header, never from the body, so a pod cannot
report a heartbeat on behalf of another user's agent by asking to.
"""

from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Header, HTTPException, Request

from api.routes.one.pod_identity_auth import verify_pod_identity
from hushh_mcp.runtime_settings import personal_agent_enabled
from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/one/pod", tags=["personal-agent"])


async def record_pod_heartbeat(
    request: Request,
    authorization: Optional[str],
    *,
    registry: Optional[PersonalAgentRegistryRepo] = None,
) -> dict:
    """Testable core: verify the pod, stamp the beat. Injectable registry."""
    if not personal_agent_enabled():
        raise HTTPException(status_code=404, detail="personal agent is not available")

    hushh_id = await verify_pod_identity(request, authorization)
    if not hushh_id:
        # One shape for every rejection -- flag off, bad token, wrong service
        # account, missing header -- so this is not an oracle for which of those
        # applies.
        raise HTTPException(status_code=401, detail="pod identity required")

    repo = registry or PersonalAgentRegistryRepo()
    matched = await repo.record_heartbeat(hushh_id=hushh_id)
    if not matched:
        # A pod is running and reporting for a HusshID the registry does not have.
        # That is an ORPHAN: billable compute nobody's row points at, which is
        # precisely the condition a fleet-cost audit needs to see. Answer 404 (the
        # beat was not recorded) and log it loudly rather than returning 200 and
        # letting a running-but-unknown pod look like a healthy one.
        logger.warning("pod_heartbeat.orphan hushh_id=%s", hushh_id)
        raise HTTPException(status_code=404, detail="no registry row for this pod")

    return {"recorded": True}


@router.post("/heartbeat")
async def pod_heartbeat_route(
    request: Request,
    authorization: Optional[str] = Header(default=None),
) -> dict:
    """A pod reports that it is alive."""
    return await record_pod_heartbeat(request, authorization)
