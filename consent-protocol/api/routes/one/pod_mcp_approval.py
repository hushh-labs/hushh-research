"""Hub-owned MCP issue/consume door. Browser confirmation is a separate authority."""

from fastapi import APIRouter, Header, HTTPException, Request

from api.routes.external_connectors import PrivateConnectorRoute
from api.routes.one.pod_identity_auth import verify_pod_request
from hushh_mcp.runtime_settings import personal_agent_enabled
from hushh_mcp.services.action_directive_ledger import ActionDirectiveAuthorityError
from hushh_mcp.services.pod_mcp_approval import PodMcpMutation, mutate_review

router = APIRouter(
    prefix="/api/one/pod/mcp-approval", tags=["personal-agent"], route_class=PrivateConnectorRoute
)


async def apply(request: Request, body: PodMcpMutation, authorization: str | None, operation: str):
    if not personal_agent_enabled():
        raise HTTPException(404, detail="Private connector authority unavailable.")
    asserted = await verify_pod_request(request, authorization, owner_bound=True)
    if asserted is None or not asserted.owner_bound or asserted.hushh_id != body.review.hushhId:
        raise HTTPException(401, detail="Owner pod identity required.")
    try:
        return await mutate_review(operation, body, principal=asserted)
    except ActionDirectiveAuthorityError:
        raise HTTPException(409, detail="Private connector review changed or expired.") from None
    except Exception:
        raise HTTPException(503, detail="Private connector authority unavailable.") from None


@router.post("/issue")
async def issue(request: Request, body: PodMcpMutation, authorization: str | None = Header(None)):
    return await apply(request, body, authorization, "issue")


@router.post("/consume")
async def consume(request: Request, body: PodMcpMutation, authorization: str | None = Header(None)):
    return await apply(request, body, authorization, "consume")
