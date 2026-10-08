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
from hushh_mcp.one_voice.tools.mail import MAIL_OPEN_DISPATCHED as _MAIL_OPEN_DISPATCHED
from hushh_mcp.one_voice.tools.mail_drafts import (
    DRAFT_OPEN_DISPATCHED as _DRAFT_OPEN_DISPATCHED,
)
from hushh_mcp.one_voice.tools.mail_drafts import (
    DRAFT_SEND_UNCONFIRMED as _DRAFT_SEND_UNCONFIRMED,
)

PROTOCOL_VERSION = "one-voice-v1"
# Additive client capabilities this relay accepts, advertised in session.ready.
# A client sends the matching keys or frames only when its relay lists them, so
# a newer app never has a whole frame refused by an older or rolled-back relay.
# "name_edit": the typed Edit name on an open create_circle card.
RELAY_FEATURES: tuple[str, ...] = ("active_mail", "mail_delivery", "name_edit", "mail_draft_review")
INPUT_MIME = "audio/pcm;rate=16000"
OUTPUT_MIME = "audio/pcm;rate=24000"
MAX_AUDIO_FRAME_B64_CHARS = 1_000_000
MAX_AUDIO_FRAME_BYTES = 512 * 1024
MAX_TEXT_CHARS = 4_000
MAX_CONTEXT_JSON_CHARS = 48_000
# Wire bound for a typed name; the relay applies the tool's own 1-80 rule.
MAX_NAME_EDIT_CHARS = 400

# Interim status of a device-executed Location updates step (resume/pause
# tools); defined with the tool contract, re-exported here for the wire.
LOCATION_UPDATES_PENDING = _LOCATION_UPDATES_PENDING
# Re-exported for the wire, like the status above it, so the relay does not have
# to import a tool family to know a dispatch when it sees one.
MAIL_OPEN_DISPATCHED = _MAIL_OPEN_DISPATCHED
# The drafts list's twin of the dispatch above: open a draft row on screen.
DRAFT_OPEN_DISPATCHED = _DRAFT_OPEN_DISPATCHED
# Interim status of an armed Save My Soul alert: grants exist, the device has
# not published a position yet, and nobody has been reached.
SOS_GRANTS_CREATED = "sos_grants_created"
# Interim status of an account reset / deletion the person tapped: the device
# is running the lifecycle flow and the server has verified nothing yet.
RESET_STEP_ISSUED = "reset_step_issued"
DELETE_STEP_ISSUED = "delete_step_issued"
ACCOUNT_LIFECYCLE_STEP_KIND = "account_lifecycle"
ACCOUNT_LIFECYCLE_REPORT_TOOL = "report_account_lifecycle"
# Statuses whose ``tool.result`` frame carries ``ok: false``.
NOT_OK_STATUSES = frozenset(
    {
        "rejected",
        "unsupported",
        "confirmation_required",
        "confirmation_waiting",
        "pending_action_exists",
        "firebase_proof_required",
        "scope_review_required",
        "draft_open_requested",
        "review_requested",
        "review_pending",
        "needs_input",
        "outcome_unknown",
        "sending",
        "draft_open_unconfirmed",
        _DRAFT_SEND_UNCONFIRMED,
        # A scheduled-mail cancel that did not cancel anything, and a scheduled
        # send whose confirmation could not be recorded: none is a success.
        "already_sent",
        "already_sending",
        "not_sent",
        "send_unconfirmed",
        "schedule_unconfirmed",
        LOCATION_UPDATES_PENDING,
        SOS_GRANTS_CREATED,
        RESET_STEP_ISSUED,
        DELETE_STEP_ISSUED,
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
    # The owner's IANA zone, for resolving "today" and "this week" on their
    # clock rather than the server's. A hint, never authority: it is validated
    # downstream and falls back to UTC. Bounded because it reaches ZoneInfo.
    timezone: str | None = Field(default=None, max_length=64)
    resume: bool = False


class AudioFrame(_Frame):
    type: Literal["audio"]
    data: str = Field(min_length=1, max_length=MAX_AUDIO_FRAME_B64_CHARS)
    mime_type: str = INPUT_MIME
    seq: int | None = None


class TextFrame(_Frame):
    type: Literal["text"]
    text: str = Field(min_length=1, max_length=MAX_TEXT_CHARS)
    request_id: str | None = Field(default=None, min_length=1, max_length=64)


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
    # The mail row open on screen: its position in a server offer and that
    # offer's revision. No message id ever travels this way; the server resolves
    # the position against its own offer, and only while the revisions match.
    active_mail_ordinal: int | None = Field(default=None, ge=1, le=25)
    active_mail_offer_revision: int | None = Field(default=None, ge=0, le=1_000_000_000)


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


class MailDraftFields(_Frame):
    to: str = Field(default="", max_length=16000)
    cc: str = Field(default="", max_length=16000)
    bcc: str = Field(default="", max_length=16000)
    subject: str = Field(default="", max_length=256)
    body: str = Field(default="", max_length=4000)


class MailDraftChangedFrame(_Frame):
    type: Literal["mail_draft.changed"]
    draft_ref: str = Field(min_length=16, max_length=64)
    revision: int = Field(ge=1, le=10000)
    operation_id: str = Field(min_length=8, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    # Validate private fields after the issued edit envelope has revoked old authority.
    draft: Any = None
    closed: bool = False


class MailDeliveryResultFrame(_Frame):
    """The device says a review card's Send finished. Never what happened.

    Names the send action and the session-issued correlation only. There is no
    status field on purpose: the relay re-reads the action server-side, so a
    client cannot report a send that did not happen.
    """

    type: Literal["mail_delivery.result"]
    delivery_ref: str = Field(min_length=16, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    action_id: str = Field(min_length=36, max_length=36)


class UiSettledFrame(_Frame):
    type: Literal["ui.settled"]
    directive_id: str = Field(min_length=1, max_length=64)
    status: Literal["opened", "failed", "ignored"] = "opened"


class InterruptFrame(_Frame):
    type: Literal["interrupt"]


class PingFrame(_Frame):
    type: Literal["ping"]


class PerfFrame(_Frame):
    """Content-free, optional client timing sample for operational logs."""

    type: Literal["perf"]
    metric: Literal[
        "endpointing_client",
        "audio_receive_to_audible",
        "capture_callback_to_socket_enqueue",
    ]
    duration_ms: int = Field(ge=0, le=120_000, strict=True)
    # Every relay-issued turn id is uuid4 hex[:12]. Restrict this field so an
    # untrusted client cannot smuggle a transcript or other content into logs.
    turn_id: str | None = Field(default=None, pattern=r"^[0-9a-f]{12}$")


class EndFrame(_Frame):
    type: Literal["end"]


class NameEditSubmitFrame(_Frame):
    """The person typed a new name on an open create_circle card.

    The name is bounded loosely here and validated by the relay, so a refusal
    reaches the editor as a ``name_edit.result`` the person can read rather
    than as a protocol error. ``operation_id`` makes a resend idempotent.
    """

    type: Literal["name_edit.submit"]
    pending_action_id: str = Field(min_length=36, max_length=36)
    name: str = Field(max_length=MAX_NAME_EDIT_CHARS)
    operation_id: str = Field(min_length=8, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")


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
    | MailDeliveryResultFrame
    | MailDraftChangedFrame
    | UiSettledFrame
    | InterruptFrame
    | PingFrame
    | PerfFrame
    | EndFrame
    | NameEditSubmitFrame,
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
        # Optional extension advertised before the client may send perf
        # frames. Older relays omit it during rolling deployment.
        "client_perf": True,
        "features": list(RELAY_FEATURES),
    }


def audio_out(
    data_b64: str, *, turn_id: str, narration: bool = False, origin_turn_id: str | None = None
) -> dict[str, Any]:
    """One chunk of speech for the player.

    ``narration`` marks audio this server synthesized rather than audio the Live
    model produced. The client needs the distinction for one reason: while
    narration plays, the microphone must be closed on every device, because the
    speaker is carrying mail-derived text and the Live session transcribes what
    the microphone hears straight into the context this feature exists to keep it
    out of. Ordinary model speech needs no such gate -- it is already in that
    context -- and closing the mic for it would cost barge-in.

    Additive and optional, so a client that predates it plays the audio and
    ignores the field.
    """
    frame: dict[str, Any] = {
        "type": "audio",
        "data": data_b64,
        "mime_type": OUTPUT_MIME,
        "turn_id": turn_id,
    }
    if narration:
        frame["narration"] = True
    if origin_turn_id:
        frame["origin_turn_id"] = origin_turn_id
    return frame


# How a client applies a contracted transcript frame to its segment's row.
TranscriptKind = Literal["partial", "cumulative", "final"]


def transcript(
    kind: Literal["input", "output"],
    text: str,
    *,
    final: bool,
    turn_id: str,
    request_id: str | None = None,
    segment_id: str | None = None,
    seq: int | None = None,
    segment_kind: TranscriptKind | None = None,
) -> dict[str, Any]:
    """One transcript frame.

    ``segment_id``/``seq``/``kind`` are additive and travel together: the relay
    names the segment, numbers its frames from 1, and says how to apply the
    text (``partial`` appends it, ``cumulative`` replaces the row, ``final``
    replaces and freezes it). A client that ignores them keeps its own merge.
    """
    frame: dict[str, Any] = {
        "type": f"transcript.{kind}",
        "text": text,
        "final": final,
        "turn_id": turn_id,
    }
    if request_id:
        frame["request_id"] = request_id
    if segment_id is not None and seq is not None and segment_kind is not None:
        frame["segment_id"] = segment_id
        frame["seq"] = seq
        frame["kind"] = segment_kind
    return frame


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


def tool_started(
    *, call_id: str, tool: str, args_public: dict[str, Any], turn_id: str | None = None
) -> dict[str, Any]:
    frame = {"type": "tool.started", "call_id": call_id, "tool": tool, "args_public": args_public}
    if turn_id:
        frame["turn_id"] = turn_id
    return frame


def tool_result(
    *,
    call_id: str | None,
    pending_action_id: str | None = None,
    tool: str,
    result_public: dict[str, Any],
    ok: bool | None = None,
    turn_id: str | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "type": "tool.result",
        "call_id": call_id,
        "tool": tool,
        "status": result_public.get("status"),
        "ok": ok if ok is not None else result_public.get("status") not in NOT_OK_STATUSES,
        "result_public": result_public,
    }
    if pending_action_id:
        payload["pending_action_id"] = pending_action_id
    if turn_id:
        payload["turn_id"] = turn_id
    return payload


def pending_action(
    *,
    row: dict[str, Any],
    receipt_token: str | None,
    entities: list[dict[str, Any]],
    risk_level: str,
    turn_id: str | None = None,
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
    if turn_id:
        payload["turn_id"] = turn_id
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


def entity_card(
    *, kind: Literal["person", "circle"], payload: dict[str, Any], turn_id: str | None = None
) -> dict[str, Any]:
    frame = {"type": "entity_card", "kind": kind, **payload}
    if turn_id:
        frame["turn_id"] = turn_id
    return frame


def candidate_picker(
    *,
    kind: Literal["person", "circle"],
    question: str,
    candidates: list[dict[str, Any]],
    turn_id: str | None = None,
) -> dict[str, Any]:
    frame = {
        "type": "candidate_picker",
        "kind": kind,
        "question": question,
        "candidates": candidates,
    }
    if turn_id:
        frame["turn_id"] = turn_id
    return frame


def ui_directive(
    *, directive_id: str, kind: str, payload: dict[str, Any], turn_id: str | None = None
) -> dict[str, Any]:
    frame = {"type": "ui_directive", "directive_id": directive_id, "kind": kind, "payload": payload}
    if turn_id:
        frame["turn_id"] = turn_id
    return frame


def client_step_request(
    *,
    step_id: str,
    kind: str,
    payload: dict[str, Any],
    timeout_s: int,
    turn_id: str | None = None,
    confirmed_pending_action_id: str | None = None,
) -> dict[str, Any]:
    frame = {
        "type": "client_step.request",
        "step_id": step_id,
        "kind": kind,
        "payload": payload,
        "timeout_s": timeout_s,
    }
    if turn_id:
        frame["turn_id"] = turn_id
    if confirmed_pending_action_id:
        frame["confirmed_pending_action_id"] = confirmed_pending_action_id
    return frame


def name_edit_result(
    *,
    operation_id: str,
    status: Literal["accepted", "rejected"],
    reason_code: str | None = None,
    message: str | None = None,
    pending_action_id: str | None = None,
) -> dict[str, Any]:
    """The answer to one ``name_edit.submit``; the same frame on a resend."""
    return {
        "type": "name_edit.result",
        "operation_id": operation_id,
        "status": status,
        "reason_code": reason_code,
        "message": message,
        "pending_action_id": pending_action_id,
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
