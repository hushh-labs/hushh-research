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

A beat also FINISHES PROVISIONING
---------------------------------
A pod's first beat is the only moment the hub reliably knows that pod is up and
warm. That is exactly the moment to collect its public key and move the row from
``connecting`` to ``provisioned``.

Before this, nothing drove that step. ``collect_pod_key_if_pending`` had one
caller -- a status read whose only client fires once on mount with no polling, on
a screen the AI-setup flow does not route to. The route's own comment claimed
"onboarding polls this endpoint"; that poller does not exist. So a created pod
sat at ``connecting`` indefinitely, and the person's agent was never finished.

The beat TRIGGERS the hub's own pull; it does not carry the key. That distinction
is the security property and it is not a detail. Every pod shares one service
account, so a pod's ID token proves "a hussh pod", never WHICH pod -- the HusshID
is the pod's own assertion. If a beat carried key material, a compromised pod
could claim another user's HusshID and register ITS key against that row, and
thereafter receive material wrapped to it. Because the beat only SELECTS a row,
and the key still comes from the URL the hub itself recorded at service creation,
a lying pod gains nothing: the hub fetches from the real pod and gets the real key.

It also fixes the cold-start problem in the pull. The 5s key fetch used to race a
container start; a pod that is beating has already booted, so the fetch lands on a
warm process.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, Header, HTTPException, Request

from api.routes.one.pod_identity_auth import verify_pod_identity
from hushh_mcp.runtime_settings import personal_agent_enabled
from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/one/pod", tags=["personal-agent"])

# The one status that is waiting on a key. Matches pod_key_collector's own
# _COLLECTABLE_STATUS: `provisioning` has no host yet and `provisioned` already has
# a key, so a fetch for either would be work with no possible effect.
_AWAITING_KEY = "connecting"


async def record_pod_heartbeat(
    request: Request,
    authorization: Optional[str],
    *,
    registry: Optional[PersonalAgentRegistryRepo] = None,
    collector: Any = None,
) -> dict:
    """Testable core: verify the pod, stamp the beat, finish provisioning if due."""
    if not personal_agent_enabled():
        raise HTTPException(status_code=404, detail="personal agent is not available")

    hushh_id = await verify_pod_identity(request, authorization)
    if not hushh_id:
        # One shape for every rejection -- flag off, bad token, wrong service
        # account, missing header -- so this is not an oracle for which of those
        # applies.
        raise HTTPException(status_code=401, detail="pod identity required")

    repo = registry or PersonalAgentRegistryRepo()
    row = await repo.record_heartbeat(hushh_id=hushh_id)
    if not row:
        # A pod is running and reporting for a HusshID the registry does not have.
        # That is an ORPHAN: billable compute nobody's row points at, which is
        # precisely the condition a fleet-cost audit needs to see. Answer 404 (the
        # beat was not recorded) and log it loudly rather than returning 200 and
        # letting a running-but-unknown pod look like a healthy one.
        logger.warning("pod_heartbeat.orphan hushh_id=%s", hushh_id)
        raise HTTPException(status_code=404, detail="no registry row for this pod")

    return {"recorded": True, "status": await _finish_provisioning(row, collector=collector)}


async def _finish_provisioning(row: dict, *, collector: Any = None) -> str:
    """Collect the pod's key if this row is still waiting on one.

    Runs INLINE rather than as a background task. A fire-and-forget here would be
    the same mistake that stranded these rows in the first place: the hub throttles
    CPU between requests, so a task scheduled after the response returns may never
    meaningfully run. Inline costs at most one bounded fetch, and only while the row
    is ``connecting`` -- a provisioned pod's every-60s beat does no extra work at all.

    Never raises. A pod's liveness report must not fail because provisioning could
    not be finished on this particular beat; the next beat is 60 seconds away and
    the row is already in the honest state for it.
    """
    status_now = str(row.get("status") or "").strip()
    if status_now != _AWAITING_KEY:
        return status_now

    collect = collector
    if collect is None:
        from hushh_mcp.services.pod_key_collector import (  # noqa: PLC0415
            collect_pod_key_if_pending,
        )

        collect = collect_pod_key_if_pending

    try:
        new_status = await collect(row)
    except Exception as exc:  # noqa: BLE001 - a beat must never fail on this
        logger.warning("pod_heartbeat.collect_failed %s", type(exc).__name__)
        return status_now

    if new_status:
        logger.info("pod_heartbeat.provisioning_finished status=%s", new_status)
        return str(new_status)
    return status_now


@router.post("/heartbeat")
async def pod_heartbeat_route(
    request: Request,
    authorization: Optional[str] = Header(default=None),
) -> dict:
    """A pod reports that it is alive."""
    return await record_pod_heartbeat(request, authorization)
