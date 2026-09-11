"""The device door of an owner pod: ``WS /api/one/puppy/relay``.

Puppy One dials the pod directly with a device-role pod session as its bearer.
The hello must name the session's own subject; the role is the binding's, never
the hello's. After the hello every frame in both directions is sealed by
``puppy_envelope`` under a key derived from this pod's identity key and the
ephemeral key the device sent, with the owner, device, session, incarnation epoch,
direction and sequence bound as AAD. The session is re-verified on every inbound
frame, so a revocation that lands at the pod closes the socket at the next frame.

A device never requests inference. It answers. A sealed ``inference.request`` from
the device closes the socket 1008: the hub broker used to echo that frame back,
and a device that can inject requests into its own answer stream is a device that
can make the private agent say anything.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from hushh_mcp.consent.puppy_envelope import (
    DIR_DEVICE_TO_POD,
    DIR_POD_TO_DEVICE,
    PuppyEnvelope,
    PuppyEnvelopeError,
    derive_frame_key,
)
from hushh_mcp.services.pod_config import active_pod_config
from hushh_mcp.services.pod_session_authority import (
    ROLE_DEVICE,
    SCOPE_PUPPY_INFERENCE,
    PodSessionRefused,
    active_session_authority,
)
from hushh_mcp.services.puppy_broker import BROKER, MAX_FRAME_BYTES

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/one/puppy", tags=["private-agent"])

_MODEL_MAX = 128
_CAPABILITY_MAX = 64
_CAPABILITIES_MAX = 32
_MODEL_FORBIDDEN = re.compile(r"\s|://")


def _bearer(websocket: WebSocket) -> str:
    raw = str(websocket.headers.get("authorization") or "").strip()
    scheme, _, token = raw.partition(" ")
    return token.strip() if scheme.lower() == "bearer" else ""


async def _frame(websocket: WebSocket) -> dict[str, Any]:
    value = await websocket.receive_text()
    if len(value.encode("utf-8")) > MAX_FRAME_BYTES:
        raise ValueError("frame too large")
    decoded = json.loads(value)
    if not isinstance(decoded, dict):
        raise ValueError("frame must be an object")
    return decoded


def valid_model_name(value: Any) -> str:
    """The device's resident model: bounded, no scheme, no whitespace; else empty."""
    name = str(value or "").strip()
    if not name or len(name) > _MODEL_MAX or _MODEL_FORBIDDEN.search(name):
        return ""
    return name


def valid_capabilities(value: Any) -> tuple[str, ...]:
    if not isinstance(value, list):
        return ()
    out: list[str] = []
    for item in value[:_CAPABILITIES_MAX]:
        name = str(item or "").strip()
        if name and len(name) <= _CAPABILITY_MAX and re.fullmatch(r"[a-z0-9_.-]+", name):
            out.append(name)
    return tuple(out)


@router.websocket("/relay")
async def pod_puppy_relay(websocket: WebSocket) -> None:
    authority = active_session_authority()
    if authority is None or not active_pod_config().puppy_broker:
        await websocket.close(code=1008, reason="Puppy relay unavailable")
        return
    token = _bearer(websocket)
    try:
        claims = authority.verify_session(token, expected_role=ROLE_DEVICE)
        await authority.require_held()
    except PodSessionRefused as exc:
        logger.info("pod_puppy_relay.refused code=%s", exc.code)
        await websocket.close(code=1008, reason="Puppy relay admission refused")
        return
    if SCOPE_PUPPY_INFERENCE not in set(claims.get("scopes") or []):
        await websocket.close(code=1008, reason="Puppy relay admission refused")
        return
    device_id = str(claims["subject_id"])
    key = (authority.hushh_id, device_id)

    await websocket.accept()
    link = None
    try:
        hello = await _frame(websocket)
        if (
            hello.get("type") != "relay.hello"
            or str(hello.get("role") or "").strip().lower() != ROLE_DEVICE
            or str(hello.get("deviceId") or "") != device_id
        ):
            await websocket.close(code=1008, reason="Puppy relay binding refused")
            return
        from hushh_mcp.services.pod_self_registration import pod_keypair  # noqa: PLC0415

        try:
            frame_key = derive_frame_key(
                pod_keypair().private_key, str(hello.get("deviceEphemeralPublicKey") or "")
            )
        except PuppyEnvelopeError:
            await websocket.close(code=1008, reason="Puppy relay key agreement refused")
            return
        envelope = PuppyEnvelope(
            frame_key,
            hushh_id=authority.hushh_id,
            device_id=device_id,
            session_id=str(claims["sid"]),
            epoch=authority.epoch,
        )
        outbound = {"seq": 0}
        inbound_expected = 1

        async def send(frame: dict[str, Any]) -> None:
            outbound["seq"] += 1
            await websocket.send_json(
                envelope.seal(frame, direction=DIR_POD_TO_DEVICE, seq=outbound["seq"])
            )

        async def close(code: int, reason: str) -> None:
            await websocket.close(code=code, reason=reason)

        link = await BROKER.register(
            key,
            send=send,
            close=close,
            epoch=authority.epoch,
            model=valid_model_name(hello.get("model")),
            capabilities=valid_capabilities(hello.get("capabilities")),
        )
        # The ready frame is the last plain frame: it tells the device which epoch
        # and key it is sealing against. It carries no secret.
        await websocket.send_json(
            {
                "type": "relay.ready",
                "role": ROLE_DEVICE,
                "epoch": authority.epoch,
                "podKeyId": authority.pod_key_id,
                "sessionExpiresAt": int(claims["exp"]) * 1000,
                "sealed": True,
            }
        )
        while True:
            raw = await _frame(websocket)
            inner = envelope.open(
                raw, expected_direction=DIR_DEVICE_TO_POD, expected_seq=inbound_expected
            )
            inbound_expected += 1
            try:
                authority.verify_session(token, expected_role=ROLE_DEVICE)
            except PodSessionRefused as exc:
                logger.info("pod_puppy_relay.session_lost code=%s", exc.code)
                await websocket.close(code=1008, reason="Puppy relay session ended")
                return
            if str(inner.get("type") or "") == "inference.request":
                logger.warning("pod_puppy_relay.device_requested_inference")
                await websocket.close(code=1008, reason="a device answers, it does not ask")
                return
            await BROKER.deliver(key, inner)
    except (WebSocketDisconnect, ValueError, PuppyEnvelopeError, json.JSONDecodeError):
        try:
            await websocket.close(code=1008, reason="Puppy relay frame refused")
        except Exception:  # noqa: BLE001 - already closed
            pass
        return
    except Exception:  # noqa: BLE001 - no frame content in logs
        logger.warning("pod_puppy_relay.connection_failed", exc_info=True)
        try:
            await websocket.close(code=1011, reason="Puppy relay unavailable")
        except Exception:  # noqa: BLE001
            pass
    finally:
        if link is not None:
            await BROKER.remove(key, link)


__all__ = ["router", "valid_capabilities", "valid_model_name"]
