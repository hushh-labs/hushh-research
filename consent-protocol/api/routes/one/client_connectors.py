"""Compatibility route for the shared owner client-connector registry."""

from __future__ import annotations

from typing import Any, cast

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from api.middleware import require_firebase_auth, require_vault_owner_token, verify_user_id_match
from hushh_mcp.services.client_connector_service import (
    ClientConnectorError,
    get_client_connector_service,
)

# Keep this path while browser clients migrate away from the historical KYC name.
# It now owns only the shared public-key registry, not a mailbox-KYC workflow.
router = APIRouter(prefix="/api/one/kyc", tags=["Owner client connectors"])


class ClientConnectorRequest(BaseModel):
    user_id: str = Field(min_length=1, max_length=128)
    connector_public_key: str = Field(min_length=32, max_length=5000)
    connector_key_id: str = Field(min_length=3, max_length=120)
    connector_wrapping_alg: str = Field(default="X25519-AES256-GCM")
    public_key_fingerprint: str | None = Field(default=None, max_length=128)


def _owner(token_data: dict[str, Any], user_id: str) -> str:
    owner = str(token_data.get("user_id") or "").strip()
    if not owner:
        raise HTTPException(status_code=401, detail={"code": "CLIENT_CONNECTOR_OWNER_REQUIRED"})
    verify_user_id_match(owner, user_id)
    return owner


def _error(exc: ClientConnectorError) -> HTTPException:
    return HTTPException(
        status_code=exc.status_code, detail={"code": exc.code, "message": str(exc)}
    )


@router.get("/client-connector")
async def get_client_connector(
    user_id: str = Query(min_length=1, max_length=128),
    token_data: dict[str, Any] = Depends(require_firebase_auth),
    _: dict[str, Any] = Depends(require_vault_owner_token),
) -> dict[str, Any]:
    result = await get_client_connector_service().get(user_id=_owner(token_data, user_id))
    return cast(dict[str, Any], result)


@router.post("/client-connector")
async def register_client_connector(
    request: ClientConnectorRequest,
    token_data: dict[str, Any] = Depends(require_firebase_auth),
    _: dict[str, Any] = Depends(require_vault_owner_token),
) -> dict[str, Any]:
    try:
        result = await get_client_connector_service().register(
            user_id=_owner(token_data, request.user_id),
            connector_public_key=request.connector_public_key,
            connector_key_id=request.connector_key_id,
            connector_wrapping_alg=request.connector_wrapping_alg,
            public_key_fingerprint=request.public_key_fingerprint,
        )
        return cast(dict[str, Any], result)
    except ClientConnectorError as exc:
        raise _error(exc) from exc
