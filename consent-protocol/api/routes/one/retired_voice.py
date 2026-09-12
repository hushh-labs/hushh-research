"""Compatibility responses for obsolete Live clients. No provider is constructed."""

from fastapi import APIRouter, WebSocket
from fastapi.responses import JSONResponse

router = APIRouter(tags=["Agent One"])


@router.post("/api/one/adk/relay-session")
async def retired_relay_session():
    return JSONResponse(
        status_code=410,
        content={
            "code": "ONE_LIVE_RETIRED",
            "detail": "Update HUSSH to use Talk to One commands. Live conversations are retired.",
        },
    )


@router.websocket("/api/one/adk/live")
async def retired_live_socket(websocket: WebSocket):
    await websocket.accept()
    await websocket.send_json({"type": "error", "code": "ONE_LIVE_RETIRED"})
    await websocket.close(code=1008, reason="Live retired; update to Location commands.")


@router.websocket("/api/one/adk/location-command/live")
async def retired_location_command_socket(websocket: WebSocket):
    await websocket.accept()
    await websocket.send_json({"type": "error", "code": "ONE_LIVE_RETIRED"})
    await websocket.close(code=1008, reason="Live retired; use ordinary command transcription.")
