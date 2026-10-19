"""Import-safe one-to-one call state and TURN credential policy.

This module carries no media, message plaintext, signing keys or provider access.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
from dataclasses import dataclass
from typing import Literal
from urllib.parse import urlsplit

CallState = Literal[
    "preparing", "ringing", "connecting", "active", "declined", "cancelled", "ended", "expired"
]
CallAction = Literal["accept", "connected", "decline", "cancel", "end"]
TERMINAL_STATES = frozenset({"declined", "cancelled", "ended", "expired"})
RING_SECONDS = 45
CALL_SECONDS = 3600
TURN_SECONDS = CALL_SECONDS


class CallError(RuntimeError):
    def __init__(self, code: str, message: str, status: int = 409):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


@dataclass(frozen=True)
class CallSnapshot:
    id: str
    conversation_id: str
    caller: str
    callee: str
    caller_device: str
    callee_device: str | None
    state: CallState
    revision: int
    expires_at: int
    caller_connected: bool = False
    callee_connected: bool = False


def transition(
    call: CallSnapshot, *, actor: str, device: str, action: CallAction, revision: int, now: int
) -> tuple[CallState, str | None, int]:
    """CAS and role checks happen before any state change or microphone admission."""
    if actor not in {call.caller, call.callee}:
        raise CallError("CALL_NOT_FOUND", "Call not found.", 404)
    if actor == call.caller and device != call.caller_device:
        raise CallError("CALL_DEVICE_MISMATCH", "Use the device that started this call.", 403)
    if actor == call.callee and call.callee_device and device != call.callee_device:
        raise CallError("CALL_ANSWERED_ELSEWHERE", "This call was answered on another device.", 403)
    if action == "end":
        return (
            (call.state if call.state in TERMINAL_STATES else "ended"),
            call.callee_device,
            min(now, call.expires_at),
        )
    if call.state in TERMINAL_STATES:
        raise CallError("CALL_FINISHED", "This call has finished.")
    if now >= call.expires_at:
        raise CallError("CALL_EXPIRED", "This call has expired.")
    if revision != call.revision:
        raise CallError("CALL_CHANGED", "This call changed. Refresh its status.")
    if action == "accept" and actor == call.callee and call.state == "ringing":
        return "connecting", device, call.expires_at - RING_SECONDS + CALL_SECONDS
    if action == "connected" and call.state in {"connecting", "active"}:
        peer_connected = call.callee_connected if actor == call.caller else call.caller_connected
        return "active" if peer_connected else "connecting", call.callee_device, call.expires_at
    if action == "decline" and actor == call.callee and call.state == "ringing":
        return "declined", device, now
    if action == "cancel" and actor == call.caller and call.state in {"preparing", "ringing"}:
        return "cancelled", call.callee_device, now
    if action == "end":
        return "ended", call.callee_device, now
    raise CallError("CALL_ACTION_INVALID", "That action is no longer available.")


@dataclass(frozen=True)
class RelayConfig:
    host: str
    secret: str

    def __post_init__(self):
        # Exactly one environment-qualified DNS name; never accept URLs, ports,
        # arbitrary ICE servers or a caller's origin as the credential audience.
        if (
            not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?", self.host)
            or "." not in self.host
            or ".." in self.host
            or len(self.secret) < 32
        ):
            raise CallError("CALL_RELAY_UNAVAILABLE", "Calling relay is unavailable.", 503)
        if urlsplit("//" + self.host).hostname != self.host:
            raise CallError("CALL_RELAY_UNAVAILABLE", "Calling relay is unavailable.", 503)

    def credentials(self, *, call_id: str, device_id: str, now: int, expires_at: int) -> dict:
        expiry = min(now + TURN_SECONDS, expires_at)
        if expiry <= now:
            raise CallError("CALL_EXPIRED", "This call has expired.")
        # Opaque allocation binding: no UID, device id, token, or phone number.
        binding = hmac.new(
            self.secret.encode(), f"{call_id}:{device_id}".encode(), hashlib.sha256
        ).hexdigest()[:32]
        username = f"{expiry}:{binding}"
        password = base64.b64encode(
            hmac.new(self.secret.encode(), username.encode(), hashlib.sha1).digest()
        ).decode()
        return {
            "iceTransportPolicy": "relay",
            "expiresAt": expiry,
            "iceServers": [
                {
                    "urls": [
                        f"turn:{self.host}:3478?transport=udp",
                        f"turns:{self.host}:443?transport=tcp",
                    ],
                    "username": username,
                    "credential": password,
                }
            ],
        }
