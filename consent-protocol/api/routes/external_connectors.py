"""REST surface for the external MCP connector interface.

List what's registered (`external_mcp_connectors`, operator-curated via
`scripts/ops/configure_external_mcp_connector.py`), see the caller's own
connection status, and connect/disconnect. This is the backend for
`/one/profile/connectors` and, later, the chat directive card's confirm
action -- both go through the same connect path so "connect from chat" and
"connect from the manage page" behave identically.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from api.middleware import require_vault_owner_token
from hushh_mcp.services.external_connector_credentials_service import (
    ExternalConnectorCredentialError,
    get_external_connector_credentials_service,
)
from hushh_mcp.services.external_connector_oauth_service import (
    ExternalConnectorOAuthError,
    get_external_connector_oauth_service,
)
from hushh_mcp.services.external_connector_registry_service import (
    get_external_connector_registry_service,
)

router = APIRouter(prefix="/api/connectors", tags=["external-connectors"])


def _user_id(token_data: dict) -> str:
    return str(token_data.get("user_id") or "")


class ConnectorSummary(BaseModel):
    connectorId: str
    displayName: str
    description: str
    authStyle: str
    status: str
    accountLabel: Optional[str] = None
    connectedAt: Optional[str] = None


class ConnectorsResponse(BaseModel):
    connectors: list[ConnectorSummary]


class ConnectApiKeyRequest(BaseModel):
    apiKey: str = Field(min_length=1, max_length=4096)
    accountLabel: Optional[str] = Field(default=None, max_length=200)


class ConnectResultResponse(BaseModel):
    status: str
    connectorId: str


class StartOAuthRequest(BaseModel):
    redirectUri: str = Field(min_length=1, max_length=2048)


class StartOAuthResponse(BaseModel):
    authorizeUrl: str
    expiresAt: str


class CompleteOAuthRequest(BaseModel):
    state: str = Field(min_length=1, max_length=4096)
    code: str = Field(min_length=1, max_length=4096)


@router.get("", response_model=ConnectorsResponse)
async def list_connectors(token_data: dict = Depends(require_vault_owner_token)):
    user_id = _user_id(token_data)
    registry = get_external_connector_registry_service()
    credentials = get_external_connector_credentials_service()
    connectors = await registry.list_active_connectors()
    statuses = {row["connectorId"]: row for row in await credentials.list_statuses(user_id=user_id)}
    return ConnectorsResponse(
        connectors=[
            ConnectorSummary(
                connectorId=connector.connector_id,
                displayName=connector.display_name,
                description=connector.description,
                authStyle=connector.auth_style,
                status=statuses.get(connector.connector_id, {}).get("status", "not_connected"),
                accountLabel=statuses.get(connector.connector_id, {}).get("accountLabel"),
                connectedAt=statuses.get(connector.connector_id, {}).get("connectedAt"),
            )
            for connector in connectors
        ]
    )


@router.post("/{connector_id}/connect/api-key", response_model=ConnectResultResponse)
async def connect_with_api_key(
    connector_id: str,
    body: ConnectApiKeyRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    user_id = _user_id(token_data)
    registry = get_external_connector_registry_service()
    connector = await registry.get_connector(connector_id)
    if connector is None:
        raise HTTPException(status_code=404, detail="Connector not found")
    if connector.auth_style != "api_key":
        raise HTTPException(status_code=400, detail="This connector does not use an API key")
    credentials = get_external_connector_credentials_service()
    try:
        result = await credentials.store_credential(
            user_id=user_id,
            connector_id=connector_id,
            secret={"apiKey": body.apiKey},
            account_label=body.accountLabel,
        )
    except ExternalConnectorCredentialError as error:
        raise HTTPException(status_code=error.status_code, detail=str(error)) from error
    return ConnectResultResponse(status=result["status"], connectorId=connector_id)


@router.post("/{connector_id}/connect/oauth/start", response_model=StartOAuthResponse)
async def start_oauth_connect(
    connector_id: str,
    body: StartOAuthRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    user_id = _user_id(token_data)
    oauth = get_external_connector_oauth_service()
    try:
        result = await oauth.start(
            user_id=user_id, connector_id=connector_id, redirect_uri=body.redirectUri
        )
    except ExternalConnectorOAuthError as error:
        raise HTTPException(status_code=error.status_code, detail=str(error)) from error
    return StartOAuthResponse(**result)


@router.post("/oauth/complete", response_model=ConnectResultResponse)
async def complete_oauth_connect(
    body: CompleteOAuthRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    # Mirrors calendar.py's /connect/complete: the webapp's own callback page
    # calls this while still signed in, not the OAuth provider directly, so
    # the caller's identity must match the attempt's stored user_id -- the
    # signed `state` alone proves the attempt wasn't forged, not who is
    # completing it.
    oauth = get_external_connector_oauth_service()
    try:
        result = await oauth.complete(
            state=body.state, code=body.code, expected_user_id=_user_id(token_data)
        )
    except ExternalConnectorOAuthError as error:
        raise HTTPException(status_code=error.status_code, detail=str(error)) from error
    return ConnectResultResponse(**result)


@router.post("/{connector_id}/disconnect", response_model=ConnectResultResponse)
async def disconnect_connector(
    connector_id: str,
    token_data: dict = Depends(require_vault_owner_token),
):
    user_id = _user_id(token_data)
    credentials = get_external_connector_credentials_service()
    result = await credentials.disconnect(user_id=user_id, connector_id=connector_id)
    return ConnectResultResponse(status=result["status"], connectorId=connector_id)
