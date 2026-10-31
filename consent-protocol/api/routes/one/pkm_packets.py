"""Owner management of PKM packets (named, priced bundles of PKM details).

  GET    /api/one/packets            -> the owner's packets + the standard catalogue
  POST   /api/one/packets            -> create a standard or custom packet
  PATCH  /api/one/packets/{id}       -> edit title, contents, price, credits, for-sale
  DELETE /api/one/packets/{id}       -> delete a packet

Packets hold PKM scope references, never values; selling one still needs the
owner's approval of each buyer request (marketplace_requests).
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Path

from api.middleware import require_vault_owner_token
from hushh_mcp.services.pkm_packet_service import (
    STANDARD_PACKETS,
    PacketValidationError,
    PkmPacketService,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/one/packets", tags=["One PKM Packets"])

_PacketId = Path(..., min_length=1, max_length=64)


def _service() -> PkmPacketService:
    return PkmPacketService()


def _bad_request(exc: PacketValidationError) -> HTTPException:
    return HTTPException(status_code=400, detail={"code": "INVALID_PACKET", "message": str(exc)})


@router.get("")
async def list_packets(token_data: dict = Depends(require_vault_owner_token)) -> dict[str, Any]:
    packets = await _service().list_packets(owner_user_id=token_data["user_id"])
    return {"packets": packets, "catalog": list(STANDARD_PACKETS)}


@router.post("")
async def create_packet(
    body: dict[str, Any] = Body(...),
    token_data: dict = Depends(require_vault_owner_token),
) -> dict[str, Any]:
    try:
        packet = await _service().create_packet(owner_user_id=token_data["user_id"], body=body)
    except PacketValidationError as exc:
        raise _bad_request(exc) from None
    return {"packet": packet}


@router.patch("/{packet_id}")
async def update_packet(
    packet_id: str = _PacketId,
    body: dict[str, Any] = Body(...),
    token_data: dict = Depends(require_vault_owner_token),
) -> dict[str, Any]:
    try:
        packet = await _service().update_packet(
            owner_user_id=token_data["user_id"], packet_id=packet_id, body=body
        )
    except PacketValidationError as exc:
        raise _bad_request(exc) from None
    if packet is None:
        raise HTTPException(status_code=404, detail="Packet not found")
    return {"packet": packet}


@router.delete("/{packet_id}")
async def delete_packet(
    packet_id: str = _PacketId,
    token_data: dict = Depends(require_vault_owner_token),
) -> dict[str, Any]:
    deleted = await _service().delete_packet(
        owner_user_id=token_data["user_id"], packet_id=packet_id
    )
    if not deleted:
        raise HTTPException(status_code=404, detail="Packet not found")
    return {"deleted": True}
