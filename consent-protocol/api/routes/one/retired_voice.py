"""Compatibility responses for obsolete Live clients. No provider is constructed."""

from fastapi import APIRouter, WebSocket

router = APIRouter(tags=["Agent One"])


@router.websocket("/api/one/adk/location-command/live")
async def retired_location_command_socket(websocket: WebSocket):
    await websocket.accept()
    await websocket.send_json({"type": "error", "code": "ONE_LIVE_RETIRED"})
    await websocket.close(code=1008, reason="Live retired; use ordinary command transcription.")
