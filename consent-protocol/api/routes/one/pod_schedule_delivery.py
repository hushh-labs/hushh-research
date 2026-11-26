"""Hub-only queue publication for signed Dev Sandbox requests."""

from __future__ import annotations

from fastapi import APIRouter, Header, HTTPException, Request, Response
from starlette.concurrency import run_in_threadpool

from api.routes.one.pod_identity_auth import verify_pod_request
from api.routes.one.pod_scheduled_tasks import PrivateScheduleRoute
from hushh_mcp.services.hosted_ace_placement import retained_hosted_ace_placement
from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo
from hushh_mcp.services.pod_sandbox_scheduled_delivery import (
    OFFER_PATH,
    SandboxScheduleOffer,
    enqueue_sandbox_schedule,
    sandbox_worker_email,
)
from hushh_mcp.services.pod_scheduled_contracts import ScheduleRefused

router = APIRouter(tags=["personal-agent"], route_class=PrivateScheduleRoute)


@router.post(OFFER_PATH, status_code=204)
async def offer_sandbox_schedule(
    request: Request, body: SandboxScheduleOffer, authorization: str | None = Header(default=None)
) -> Response:
    try:
        sandbox_worker_email()
    except ScheduleRefused as exc:
        raise HTTPException(503, detail={"code": exc.code}) from None
    registry = PersonalAgentRegistryRepo()
    verified = await verify_pod_request(request, authorization, owner_bound=True, registry=registry)
    if verified is None or not verified.signed or verified.standby:
        raise HTTPException(403, detail={"code": "SCHEDULE_PUBLISHER_REFUSED"})
    row = await registry.get_by_hushh_id(verified.hushh_id)
    placement = retained_hosted_ace_placement(row)
    if (
        not row
        or row.get("status") != "provisioned"
        or row.get("pod_signing_key_id") != verified.key_id
        or placement is None
        or placement.hushh_id != verified.hushh_id
    ):
        raise HTTPException(403, detail={"code": "SCHEDULE_PLACEMENT_REFUSED"})
    try:
        await run_in_threadpool(enqueue_sandbox_schedule, body, placement=placement)
    except ScheduleRefused as exc:
        status = 409 if exc.code == "SCHEDULE_DELIVERY_REFUSED" else 503
        raise HTTPException(status, detail={"code": exc.code}) from None
    return Response(status_code=204, headers={"Cache-Control": "no-store"})
