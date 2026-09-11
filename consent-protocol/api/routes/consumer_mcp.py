"""Consumer MCP connection handoff; owner approval is never an MCP tool."""

import asyncio
from dataclasses import asdict
from typing import Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Path, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field

from api.developer_auth import (
    authenticate_developer_principal,
    developer_api_disabled_error,
    developer_api_enabled,
)
from api.middleware import require_firebase_auth
from hushh_mcp.services.consumer_mcp_connections import (
    ConsumerConnection,
    ConsumerConnectionDenied,
    ConsumerMcpConnections,
)

router = APIRouter(prefix="/oauth/consumer-connections", tags=["Consumer MCP"])
CONNECTION_REF = r"^cmc_[a-f0-9]{32}$"


class MemoryApproval(BaseModel):
    model_config = ConfigDict(extra="forbid")
    generation: int = Field(ge=1)
    authorization_id: int = Field(ge=1)
    policy_version: Literal[1]
    personal_memory_until_disconnected: Literal[True]


async def _call(method, **kwargs):
    if not developer_api_enabled():
        raise developer_api_disabled_error()
    try:
        return await asyncio.to_thread(method, **kwargs)
    except ConsumerConnectionDenied as error:
        raise HTTPException(
            status_code=403, detail=str(error), headers={"Cache-Control": "no-store"}
        ) from None
    except Exception:
        # Database exception strings may include bound identities or parameters.
        raise HTTPException(
            status_code=503,
            detail="Assistant connection temporarily unavailable",
            headers={"Cache-Control": "no-store"},
        ) from None


@router.post("/prepare", response_model=ConsumerConnection)
async def prepare_connection(
    request: Request, response: Response, authorization: str | None = Header(default=None)
):
    principal = await asyncio.to_thread(
        authenticate_developer_principal, request=request, authorization=authorization
    )
    review = await _call(ConsumerMcpConnections().prepare, principal=principal)
    response.headers["Cache-Control"] = "no-store"
    return asdict(review)


@router.get("/{connection_id}", response_model=ConsumerConnection)
async def review_connection(
    response: Response,
    connection_id: str = Path(pattern=CONNECTION_REF),
    authorization_id: int = Query(ge=1),
    owner: str = Depends(require_firebase_auth),
):
    review = await _call(
        ConsumerMcpConnections().review,
        owner=owner,
        connection_id=connection_id,
        authorization_id=authorization_id,
    )
    response.headers["Cache-Control"] = "no-store"
    return asdict(review)


@router.post("/{connection_id}/approve")
async def approve_connection(
    payload: MemoryApproval,
    response: Response,
    connection_id: str = Path(pattern=CONNECTION_REF),
    owner: str = Depends(require_firebase_auth),
):
    receipt = await _call(
        ConsumerMcpConnections().approve,
        owner=owner,
        connection_id=connection_id,
        generation=payload.generation,
        authorization_id=payload.authorization_id,
    )
    response.headers["Cache-Control"] = "no-store"
    return {"grant_receipt": receipt, "memory_access": True}


@router.delete("/{connection_id}", status_code=204)
async def disconnect_connection(
    connection_id: str = Path(pattern=CONNECTION_REF),
    generation: int = Query(ge=1),
    owner: str = Depends(require_firebase_auth),
):
    await _call(
        ConsumerMcpConnections().disconnect,
        owner=owner,
        connection_id=connection_id,
        generation=generation,
    )
    return Response(status_code=204, headers={"Cache-Control": "no-store"})
