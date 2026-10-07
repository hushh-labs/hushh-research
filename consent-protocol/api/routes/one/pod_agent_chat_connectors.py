"""Private connector settings on the owner's agent: tool refresh and connector login.

For an owner whose agent runs in their own cloud, Settings used to send the
connector's access token to the hub to list its tools, and the hub held the login
attempt (and so saw the authorization code and the issued tokens). Both now run in
the owner's agent:

* ``POST /connectors/{id}/mcp/catalog`` lists tools with the configuration the app
  sends, admitted by this pod's session authority (``pod_mcp_catalog``).
* ``POST /connectors/{id}/mcp/oauth/{begin,complete,cancel}`` run the same
  ``mcp_oauth_attempts`` flow the hub runs, in this process. The issued tokens are
  returned to the owner's app once, ``no-store``, and are never written here.

The routes are included into ``pod_agent_chat.router`` so they share its prefix,
its ``PrivateConnectorRoute`` body bound and its owner admission.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from mcp.shared.auth import OAuthClientInformationFull
from pydantic import AnyUrl

from api.routes.external_connectors import (
    McpConfigurationRequest,
    McpOAuthAttemptRequest,
    McpOAuthBeginRequest,
    McpOAuthCompleteRequest,
    PrivateConnectorRoute,
    _mcp_oauth_binding,
    _mcp_oauth_return_uri,
    _mcp_review_response,
)
from api.routes.one.pod_chat_owner import owner_context
from hushh_mcp.one_adk.mcp_oauth_connection import mcp_oauth_attempts
from hushh_mcp.one_adk.pod_agui_context import PodChatContext

router = APIRouter(prefix="/connectors", route_class=PrivateConnectorRoute)


def _binding(connector_id: str, owner: PodChatContext) -> str:
    return _mcp_oauth_binding(connector_id, {"user_id": owner.owner})


@router.post("/{connector_id}/mcp/catalog")
async def refresh_private_mcp_catalog(
    connector_id: str,
    body: McpConfigurationRequest,
    owner: PodChatContext = Depends(owner_context),
):
    from hushh_mcp.one_adk.pod_mcp_catalog import discover_private_catalog

    if body.connectorConfiguration is None:
        raise HTTPException(400, detail="Unlock and provide the current connector settings.")
    return await _mcp_review_response(
        discover_private_catalog,
        owner=owner,
        connector_id=connector_id,
        configuration=body.connectorConfiguration,
    )


@router.post("/{connector_id}/mcp/oauth/begin")
async def begin_private_mcp_oauth(
    connector_id: str, body: McpOAuthBeginRequest, owner: PodChatContext = Depends(owner_context)
):
    binding = _binding(connector_id, owner)
    redirect_uri = _mcp_oauth_return_uri()
    client = body.registeredClient
    try:
        result = await mcp_oauth_attempts.begin(
            owner_id=binding,
            connector_id=connector_id,
            revision=str(body.revision),
            endpoint=body.endpoint,
            redirect_uri=redirect_uri,
            registered_client=(
                OAuthClientInformationFull(
                    client_id=client.clientId,
                    client_secret=client.clientSecret,
                    token_endpoint_auth_method=client.tokenEndpointAuthMethod,
                    redirect_uris=[AnyUrl(redirect_uri)],
                )
                if client
                else None
            ),
            registered_issuer=client.issuer if client else None,
        )
    except Exception:
        raise HTTPException(
            503, detail="Could not start connector login. Retry connecting."
        ) from None
    return {**result, "redirectUri": redirect_uri}


@router.post("/{connector_id}/mcp/oauth/complete")
async def complete_private_mcp_oauth(
    connector_id: str,
    body: McpOAuthCompleteRequest,
    owner: PodChatContext = Depends(owner_context),
):
    binding = _binding(connector_id, owner)
    try:
        result = await mcp_oauth_attempts.complete(
            handle=body.attemptId,
            owner_id=binding,
            connector_id=connector_id,
            revision=str(body.revision),
            code=body.code,
            state=body.state,
            issuer=body.issuer,
        )
    except Exception:
        raise HTTPException(
            409, detail="Connector login expired or failed. Connect again."
        ) from None
    return {
        "tokens": result.tokens.model_dump(mode="json", exclude_none=True),
        "clientInfo": result.client_info.model_dump(mode="json", exclude_none=True),
        "expiresAt": result.expires_at,
    }


@router.post("/{connector_id}/mcp/oauth/cancel", status_code=204)
async def cancel_private_mcp_oauth(
    connector_id: str, body: McpOAuthAttemptRequest, owner: PodChatContext = Depends(owner_context)
):
    binding = _binding(connector_id, owner)
    try:
        mcp_oauth_attempts.cancel(
            handle=body.attemptId,
            owner_id=binding,
            connector_id=connector_id,
            revision=str(body.revision),
        )
    except Exception:
        raise HTTPException(409, detail="Connector login is no longer available.") from None


__all__ = ["router"]
