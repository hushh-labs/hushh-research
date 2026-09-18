"""Wire protocol ``one-voice-v1`` between the app and the Live relay.

JSON text frames, discriminated on ``type``. Audio is base64 PCM16: 16 kHz in,
24 kHz out. Every frame the server sends about an action carries the same
typed payload the model narrates from, so the UI and the speech can never
disagree. Nothing in this module touches the provider.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError

from hushh_mcp.one_voice.tools.base import LOCATION_UPDATES_PENDING as _LOCATION_UPDATES_PENDING

PROTOCOL_VERSION = "one-voice-v1"
INPUT_MIME = "audio/pcm;rate=16000"
OUTPUT_MIME = "audio/pcm;rate=24000"
MAX_AUDIO_FRAME_B64_CHARS = 1_000_000
MAX_AUDIO_FRAME_BYTES = 512 * 1024
MAX_TEXT_CHARS = 4_000
MAX_CONTEXT_JSON_CHARS = 48_000

# Interim status of a device-executed Location updates step (resume/pause
# tools); defined with the tool contract, re-exported here for the wire.
LOCATION_UPDATES_PENDING = _LOCATION_UPDATES_PENDING
# Statuses whose ``tool.result`` frame carries ``ok: false``.
NOT_OK_STATUSES = frozenset(
    {
        "rejected",
        "unsupported",
        "confirmation_required",
        "firebase_proof_required",
        "scope_review_required",
        LOCATION_UPDATES_PENDING,
    }
)


class _Frame(BaseModel):
    model_config = ConfigDict(extra="forbid")


# --- client -> server ------------------------------------------------------


class AuthFrame(_Frame):
    type: Literal["auth"]
    vault_owner_token: str = Field(min_length=8, max_length=8_000)
    firebase_id_token: str | None = Field(default=None, max_length=8_000)
    conversation_id: str = Field(min_length=36, max_length=36)
    client: dict[str, Any] = Field(default_factory=dict)
    resume: bool = False


class AudioFrame(_Frame):
    type: Literal["audio"]
    data: str = Field(min_length=1, max_length=MAX_AUDIO_FRAME_B64_CHARS)
    mime_type: str = INPUT_MIME
    seq: int | None = None


class TextFrame(_Frame):
    type: Literal["text"]
    text: str = Field(min_length=1, max_length=MAX_TEXT_CHARS)


class AppContextFrame(_Frame):
    type: Literal["app_context"]
    screen_id: str | None = Field(default=None, max_length=120)
    route: str | None = Field(default=None, max_length=400)
    available_action_ids: list[str] = Field(default_factory=list, max_length=200)
    screen_state: dict[str, Any] = Field(default_factory=dict)
    os_location_permission: Literal["unknown", "prompt", "granted", "denied"] = "unknown"
    # Canonical id of the circle whose detail screen is open. Typed and
    # separate from ``screen_state`` (which is rendered into the prompt and
    # carries no identifiers); the host reads it through the circle service.
    active_circle_id: str | None = Field(default=None, min_length=36, max_length=36)


class PendingShownFrame(_Frame):
    type: Literal["pending_action.shown"]
    pending_action_id: str = Field(min_length=36, max_length=36)


class ConfirmActionFrame(_Frame):
    type: Literal["confirm_action"]
    pending_action_id: str = Field(min_length=36, max_length=36)
    receipt_token: str | None = Field(default=None, max_length=200)
    source: Literal["tap"] = "tap"
    firebase_id_token: str | None = Field(default=None, max_length=8_000)
    consent_version: str | None = Field(default=None, max_length=80)


class CancelActionFrame(_Frame):
    type: Literal["cancel_action"]
    pending_action_id: str | None = Field(default=None, max_length=36)
    scope: Literal["pending_action", "turn", "session"] = "pending_action"


class CandidateChooseFrame(_Frame):
    type: Literal["candidate.choose"]
    kind: Literal["person", "circle"] = "person"
    id: str | None = Field(default=None, max_length=128)
    none: bool = False


class ClientStepResultFrame(_Frame):
    type: Literal["client_step.result"]
    step_id: str = Field(min_length=1, max_length=64)
    status: Literal["ok", "failed"]
    payload: dict[str, Any] = Field(default_factory=dict)


class UiSettledFrame(_Frame):
    type: Literal["ui.settled"]
    directive_id: str = Field(min_length=1, max_length=64)
    status: Literal["opened", "failed", "ignored"] = "opened"


class InterruptFrame(_Frame):
    type: Literal["interrupt"]


class PingFrame(_Frame):
    type: Literal["ping"]


class EndFrame(_Frame):
    type: Literal["end"]


ClientFrame = Annotated[
    AuthFrame
    | AudioFrame
    | TextFrame
    | AppContextFrame
    | PendingShownFrame
    | ConfirmActionFrame
    | CancelActionFrame
    | CandidateChooseFrame
    | ClientStepResultFrame
    | UiSettledFrame
    | InterruptFrame
    | PingFrame
    | EndFrame,
    Field(discriminator="type"),
]
_client_adapter: TypeAdapter[Any] = TypeAdapter(ClientFrame)


class FrameError(ValueError):
    pass


def parse_client_frame(raw: str | bytes) -> Any:
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", errors="strict")
    if len(raw) > MAX_AUDIO_FRAME_B64_CHARS + 2_000:
        raise FrameError("frame_too_large")
    try:
        return _client_adapter.validate_json(raw)
    except ValidationError as exc:
        raise FrameError(f"frame_invalid:{exc.errors()[0].get('type', 'unknown')}") from None
    except ValueError:
        raise FrameError("frame_invalid:json") from None


# --- server -> client ------------------------------------------------------


def session_ready(
    *,
    session_id: str,
    conversation_id: str,
    model: str,
    resumed: bool,
    idle_timeout_ms: int,
    session_max_ms: int,
    pending_actions: list[dict[str, Any]],
    setup_progress: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "type": "session.ready",
        "protocol_version": PROTOCOL_VERSION,
        "session_id": session_id,
        "conversation_id": conversation_id,
        "model": model,
        "resumed": resumed,
        "idle_timeout_ms": idle_timeout_ms,
        "session_max_ms": session_max_ms,
        "pending_actions": pending_actions,
        "setup_progress": setup_progress,
        "output_mime_type": OUTPUT_MIME,
    }


def audio_out(data_b64: str, *, turn_id: str) -> dict[str, Any]:
    return {"type": "audio", "data": data_b64, "mime_type": OUTPUT_MIME, "turn_id": turn_id}


def transcript(
    kind: Literal["input", "output"], text: str, *, final: bool, turn_id: str
) -> dict[str, Any]:
    return {"type": f"transcript.{kind}", "text": text, "final": final, "turn_id": turn_id}


def turn(
    state: Literal["model_start", "model_end", "interrupted"], *, turn_id: str
) -> dict[str, Any]:
    return {"type": "turn", "state": state, "turn_id": turn_id}


def voice_state(
    state: Literal[
        "listening", "understanding", "asking", "confirming", "executing", "complete", "error"
    ],
    *,
    turn_id: str | None = None,
) -> dict[str, Any]:
    return {"type": "state", "state": state, "turn_id": turn_id}


def tool_started(*, call_id: str, tool: str, args_public: dict[str, Any]) -> dict[str, Any]:
    return {"type": "tool.started", "call_id": call_id, "tool": tool, "args_public": args_public}


def tool_result(
    *,
    call_id: str | None,
    tool: str,
    result_public: dict[str, Any],
    ok: bool | None = None,
) -> dict[str, Any]:
    return {
        "type": "tool.result",
        "call_id": call_id,
        "tool": tool,
        "status": result_public.get("status"),
        "ok": ok if ok is not None else result_public.get("status") not in NOT_OK_STATUSES,
        "result_public": result_public,
    }


def pending_action(
    *,
    row: dict[str, Any],
    receipt_token: str | None,
    entities: list[dict[str, Any]],
    risk_level: str,
) -> dict[str, Any]:
    payload = {
        "type": "pending_action",
        "risk_level": risk_level,
        "requires_tap": row.get("tier") == "tap",
        "entities": entities,
        **row,
    }
    if receipt_token:
        payload["receipt_token"] = receipt_token
    return payload


def pending_resolved(
    *, pending_action_id: str, status: str, result_public: dict[str, Any] | None
) -> dict[str, Any]:
    return {
        "type": "pending_action.resolved",
        "pending_action_id": pending_action_id,
        "status": status,
        "result_public": result_public,
    }


def entity_card(*, kind: Literal["person", "circle"], payload: dict[str, Any]) -> dict[str, Any]:
    return {"type": "entity_card", "kind": kind, **payload}


def candidate_picker(
    *, kind: Literal["person", "circle"], question: str, candidates: list[dict[str, Any]]
) -> dict[str, Any]:
    return {
        "type": "candidate_picker",
        "kind": kind,
        "question": question,
        "candidates": candidates,
    }


def ui_directive(*, directive_id: str, kind: str, payload: dict[str, Any]) -> dict[str, Any]:
    return {"type": "ui_directive", "directive_id": directive_id, "kind": kind, "payload": payload}


def client_step_request(
    *, step_id: str, kind: str, payload: dict[str, Any], timeout_s: int
) -> dict[str, Any]:
    return {
        "type": "client_step.request",
        "step_id": step_id,
        "kind": kind,
        "payload": payload,
        "timeout_s": timeout_s,
    }


def reconnect_required(reason: Literal["go_away", "max_duration"]) -> dict[str, Any]:
    return {"type": "session.reconnect_required", "reason": reason}


def pong() -> dict[str, Any]:
    return {"type": "pong"}


def error(code: str, message: str) -> dict[str, Any]:
    return {"type": "error", "code": code, "message": message}


# Application close codes (4000-4999 are ours).
CLOSE_DISABLED = 4001
CLOSE_AUTH = 4003
CLOSE_TICKET = 4004
CLOSE_PROTOCOL = 4008
CLOSE_IDLE = 4009
CLOSE_MAX_DURATION = 4010
CLOSE_PROVIDER_UNAVAILABLE = 4013
CLOSE_CAPACITY = 4029
CLOSE_REPLACED = 4030
CLOSE_ENDED = 1000
