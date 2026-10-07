"""One Live Voice session: the relay between the app socket and Gemini Live.

Three concurrent pumps under one ``TaskGroup``: client frames → provider,
provider events → client, and a watchdog for idle/max-duration. Tool calls
are dispatched through :class:`ToolExecutor`; the session never chooses a
tool, never rewrites arguments, and never narrates. Every action the model
can talk about produces one typed payload that goes to the client as a frame
and back to the model as a tool response or an ``[ONE_EVENT]`` turn, so UI
and speech derive from the same data.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import secrets
import time
import unicodedata
import uuid
from collections import deque
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta, timezone
from typing import Any, Literal, Protocol

from hushh_mcp.one_voice import protocol
from hushh_mcp.one_voice.config import OneVoiceLiveConfig
from hushh_mcp.one_voice.conversations import (
    Conversation,
    ConversationNotOwned,
    ConversationStorageError,
    ConversationStore,
)
from hushh_mcp.one_voice.live_client import LiveEvent, LiveSessionPort
from hushh_mcp.one_voice.pending_actions import (
    PendingAction,
    PendingActionConflict,
    PendingActionStorageError,
    PendingActionStore,
)
from hushh_mcp.one_voice.tickets import TicketClaims
from hushh_mcp.one_voice.tools import registry
from hushh_mcp.one_voice.tools.base import (
    EntityContext,
    Rejected,
    ScreenContext,
    ToolContext,
    ToolResult,
    ToolSpec,
    arg_refs,
    restore_context,
)
from hushh_mcp.one_voice.tools.executor import (
    CONFIRMATION_WAITING,
    LOOKUP_TOOLS,
    PENDING_ACTION_EXISTS,
    STORAGE_UNAVAILABLE,
    ToolCallOutcome,
    ToolExecutor,
)
from hushh_mcp.one_voice.tools.session import OPENABLE_SCREENS
from hushh_mcp.services.gmail_delivery_service import GmailDeliveryError, get_owner_send_action
from hushh_mcp.services.gmail_reply_source_service import open_reply_source_ref

logger = logging.getLogger(__name__)

# Voice storage failures the relay survives. Each one used to escape the pumps
# and close a healthy session with 4013 (provider unavailable), which the client
# reads as an outage. Mutation governance fails closed in the executor; what
# reaches the relay is bookkeeping it can do without.
_STORAGE_ERRORS = (PendingActionStorageError, ConversationStorageError)


def _failure_fingerprints(error: BaseException) -> list[dict[str, Any]]:
    """Bounded error locations without messages, locals, arguments or transcripts.

    TaskGroup wraps the useful exception. Logging only that wrapper prevented
    diagnosis of live sessions which failed immediately after a people read.
    """
    from hushh_mcp.runtime_providers.dependency_health import classify_provider_error

    pending = [error]
    seen: set[int] = set()
    details: list[dict[str, Any]] = []
    while pending and len(seen) < 32 and len(details) < 6:
        current = pending.pop()
        if id(current) in seen:
            continue
        seen.add(id(current))
        if isinstance(current, BaseExceptionGroup):
            pending.extend(current.exceptions[:6])
            continue
        frames = []
        trace = current.__traceback__
        while trace is not None:
            code = trace.tb_frame.f_code
            frames.append(f"{code.co_filename.rsplit('/', 1)[-1]}:{code.co_name}:{trace.tb_lineno}")
            trace = trace.tb_next
        details.append(
            {
                "type": type(current).__name__,
                "class": classify_provider_error(current),
                "frames": frames[-6:],
            }
        )
    return details


AUTH_TIMEOUT_SECONDS = 5.0
CLIENT_STEP_TIMEOUT_SECONDS = 25
# Slack past the advertised timeout before a device report is treated as stale.
CLIENT_STEP_GRACE_SECONDS = 5
# A question accepted behind a stalled provider turn must not wait until the
# session's general idle close and disappear without an answer.
QUEUED_TEXT_MAX_WAIT_SECONDS = 30.0
PCM16_16K_BYTES_PER_SECOND = 32_000
_NOT_SUCCESS = {
    "rejected",
    "unsupported",
    "confirmation_required",
    CONFIRMATION_WAITING,
    PENDING_ACTION_EXISTS,
    "tap_required",
    "card_not_shown",
    "firebase_proof_required",
    "draft_open_unconfirmed",
}
# Bound for the per-session directive metadata and card_not_shown waiters.
_DIRECTIVE_MEMORY = 128
_SHOWN_WAITERS_MAX = 32
_PERF_TURN_MEMORY = 128
# From this many held proposals since the person last spoke, the held answer
# also tells the model, off the spoken path, that the card waits for them.
_HOLD_NOTE_FROM = 3
# Session tools that answer the waiting card for the person. Live may approve or
# withdraw a card only when something was said or handed to it: a yes or cancel
# made in silence is held exactly like a proposal made in silence (a cancel
# there would otherwise clear the way for an unprompted re-proposal).
_CARD_ANSWER_TOOLS = frozenset({"confirm_pending_action", "cancel_pending_action"})
# How long a review card's Send may still be reported to this session, and how
# many such cards it remembers. A send after this is still delivered and still
# shown on the card; One just does not speak it.
MAIL_DELIVERY_TTL_SECONDS = 30 * 60
_MAIL_DELIVERY_MEMORY = 16
# Clock slack between the database that stamps a send action and this process,
# when deciding the action was made after the card it is reported for.
_MAIL_DELIVERY_SKEW = timedelta(seconds=60)
# Reports per card: a failed send may be reviewed and sent again, once or twice.
_MAIL_DELIVERY_REPORTS = 3
# Typed "Edit name": the cards it may replace, the tool's own name bound, and
# how many answered operations a session remembers for an idempotent resend.
_NAME_EDITABLE_TOOLS = frozenset({"create_circle"})
_NAME_EDIT_MAX_CHARS = 80
_NAME_EDIT_MEMORY = 32
# Unicode categories a typed name may not carry: control characters, line and
# paragraph separators, and lone surrogates. Format characters stay allowed,
# so the joiners in emoji sequences and in Persian or Indic text get through,
# as they do through the tool's own bounds.
_NAME_EDIT_REFUSED_CATEGORIES = frozenset({"Cc", "Zl", "Zp", "Cs"})
# What the editor shows under the input on a refusal, by reason code.
_NAME_EDIT_MESSAGES = {
    "not_pending": "This card is no longer waiting, so its name can't be changed.",
    "not_editable": "Only a new circle's name can be edited here.",
    "already_confirmed": "This card was already confirmed, so its name wasn't changed.",
    "storage_unavailable": "That didn't go through. Please try again.",
    "not_proposed": "I couldn't prepare a card with that name. Please try again.",
}
# A client-executed step is still outstanding: neither a receipt nor a
# rejection. It never counts as ok (so the turn cannot read "complete") and
# never bumps the rejected counter; the settled result does one or the other.
# ``scope_review_required`` is the same shape for a confirmed accept: the
# review screen is open and nothing has been accepted yet.
_AWAITING_DEVICE = frozenset(
    {
        "draft_open_requested",
        protocol.LOCATION_UPDATES_PENDING,
        "scope_review_required",
        protocol.SOS_GRANTS_CREATED,
        protocol.RESET_STEP_ISSUED,
        protocol.DELETE_STEP_ISSUED,
    }
)
_CONFIRMED_CONTINUATION_STEPS = frozenset(
    {
        "open_mail_draft",
        "publish_location_envelopes",
        "set_location_updates",
        "account_lifecycle",
    }
)


def _confirmed_continuation_id(outcome: ToolCallOutcome, public: dict[str, Any]) -> str | None:
    """Only a verified pending row can carry an old action's required step."""
    pending = outcome.pending
    step = public.get("client_step")
    if pending is None or pending.status != "executed" or not isinstance(step, dict):
        return None
    kind = step.get("kind")
    return pending.id if isinstance(kind, str) and kind in _CONFIRMED_CONTINUATION_STEPS else None


class Transport(Protocol):
    """The socket as the session sees it (FastAPI WebSocket or a test fake)."""

    async def receive(self) -> str: ...

    async def send(self, frame: dict[str, Any]) -> None: ...

    async def close(self, code: int, reason: str) -> None: ...


class SessionClosed(Exception):
    def __init__(self, code: int, reason: str) -> None:
        super().__init__(reason)
        self.code = code
        self.reason = reason


@dataclass
class AuthResult:
    user_id: str
    vault_owner_token: str
    firebase_id_token: str | None
    display_name: str | None = None


AuthVerifier = Callable[[protocol.AuthFrame, TicketClaims], Awaitable[AuthResult]]
LiveFactory = Callable[[str, dict[str, Any]], AbstractAsyncContextManager[LiveSessionPort]]
# What a model-only continuation follows: a tool response or an injected app
# event Live owes a reply to, or nothing. Short values: logged as-is.
OpenedAfter = Literal["none", "tool", "event"]


@dataclass
class TurnState:
    turn_id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    tool_calls: int = 0
    ok_results: int = 0
    not_ok_results: int = 0
    output_text: list[str] = field(default_factory=list)
    audio_chunks: int = 0
    input_seen: bool = False
    input_transcript_completed: bool = False
    # Opened by a provider boundary with no input of its own: whatever Live says
    # next is either a continuation it owes or the answer to the next input.
    model_only: bool = False
    # Structural only, for forensics: what this continuation is answering.
    opened_after: OpenedAfter = "none"
    # Live said something in this turn: forwarded, held for a narration, or fenced.
    live_spoke: bool = False
    # Live output dropped because this turn was fenced; logged at its boundary.
    muted_chunks: int = 0
    # Output transcript chunks after this turn already forwarded an output
    # final, a resent final line included (that one is not sent again). A
    # count only, logged at the turn's boundary.
    output_final_sent: bool = False
    output_after_final: int = 0

    def reset(self) -> None:
        self.turn_id = uuid.uuid4().hex[:12]
        self.tool_calls = 0
        self.ok_results = 0
        self.not_ok_results = 0
        self.output_text = []
        self.audio_chunks = 0
        self.input_seen = False
        self.input_transcript_completed = False
        self.model_only = False
        self.opened_after = "none"
        self.live_spoke = False
        self.muted_chunks = 0
        self.output_final_sent = False
        self.output_after_final = 0


@dataclass
class TurnPerf:
    """Bounded timings and structural counts for one user input, never content."""

    input_turn_id: str
    transcript_final_at: float | None = None
    provider_activity_end_at: float | None = None
    first_tool_at: float | None = None
    first_audio_at: float | None = None
    tool_response_at: float | None = None
    provider_turns: int = 0
    tool_calls: int = 0
    pending_created: int = 0
    pending_reused: int = 0
    pending_cancelled: int = 0


def _spaced(text: str) -> str:
    """Whitespace-insensitive form of a transcript chunk or line.

    Only compares the chunks of one line with each other; it never reads what
    was said and never matches across lines, roles or turns.
    """
    return " ".join(text.split())


@dataclass
class TranscriptSegment:
    """One displayed transcript line the relay owns: identity, order, text so far.

    ``raw`` is the merged chunks exactly as Live sent them, leading space and
    all, so comparisons see the provider's shape; ``text`` is the line shown.
    The counts describe that shape, never its words, and are logged once when
    the line ends.
    """

    turn_id: str
    segment_id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    seq: int = 0
    text: str = ""
    raw: str = ""
    last_chunk: str | None = None
    partial: int = 0
    final: int = 0
    repeat: int = 0
    extended: int = 0
    restated: int = 0

    def accept(self, chunk: str, *, finished: bool) -> None:
        """Merge one provider chunk as the client merge did, plus final authority.

        A chunk not led by a space replaces the line when it extends it
        (whitespace aside, strictly longer) or, finished, equals it. A
        space-led chunk continues the line by its shape ("H" + " Hussh
        garage"), unless it is finished and resends the line byte for byte, or
        restates it whitespace aside without only repeating the previous chunk
        ("Shall I" + " create it?" + " Shall I create it?"). A repeated delta
        cannot be told from repeated speech, so it appends ("S" + " S"), as
        does anything else.
        """
        incoming, current = _spaced(chunk), _spaced(self.raw)
        grows = bool(current) and len(incoming) > len(current) and incoming.startswith(current)
        same = bool(current) and incoming == current
        repeat = self.last_chunk is not None and incoming == self.last_chunk
        self.repeat += repeat
        if finished:
            self.final += 1
            self.restated += same or grows
        else:
            self.partial += 1
            self.extended += grows
        space_led = chunk[:1].isspace()
        if (not space_led and (grows or (finished and same))) or (
            finished and (chunk == self.raw or (same and not repeat))
        ):
            self.raw = chunk
        else:
            self.raw += chunk
        self.last_chunk = incoming
        # A line never starts or ends with the space that separates deltas.
        self.text = self.raw.strip()


class VoiceSession:
    def __init__(
        self,
        *,
        transport: Transport,
        config: OneVoiceLiveConfig,
        claims: TicketClaims,
        verify_auth: AuthVerifier,
        live_factory: LiveFactory,
        executor: ToolExecutor | None = None,
        conversations: ConversationStore | None = None,
        pending: PendingActionStore | None = None,
        clock: Callable[[], float] = time.monotonic,
        mail_delivery_status: Callable[..., Awaitable[dict[str, Any] | None]] | None = None,
    ) -> None:
        self.transport = transport
        self.config = config
        self.claims = claims
        self.verify_auth = verify_auth
        self.live_factory = live_factory
        self.pending = pending or PendingActionStore()
        self.executor = executor or ToolExecutor(pending_store=self.pending)
        self.conversations = conversations or ConversationStore()
        self.clock = clock
        self.session_id = claims.session_id
        self._conversation: Conversation | None = None
        self._ctx: ToolContext | None = None
        self._live: LiveSessionPort | None = None
        self.turn = TurnState()
        # Typed inputs accepted while a provider turn or tool is in flight wait
        # for that turn's completion. Text is never replayed or deduplicated.
        self._queued_texts: deque[tuple[str, str, float]] = deque()
        self._superseded_turn_ids: set[str] = set()
        self._input_segment_id: str | None = None
        # The open transcript line per direction (input, output), so every
        # transcript frame carries a relay-owned segment id and seq.
        self._transcript_segments: dict[str, TranscriptSegment] = {}
        # The line each direction just finished, as (turn id, its text with
        # whitespace collapsed), until the next chunk in that direction or
        # the provider turn's end: Live resending it is not shown twice.
        self._finished_transcripts: dict[str, tuple[str, str]] = {}
        self._pending_voice_turn_id: str | None = None
        self._pending_turn_ids: dict[str, str] = {}
        self._latest_input_turn_id: str | None = None
        self._conflicted_confirmation_input: str | None = None
        # Live can end a provider turn after a tool call, then continue the
        # same person's request in a fresh provider turn. Wire frames keep
        # that fresh turn ID so the client can display them after model_end;
        # this map retains the input that owns its effects and stale checks.
        self._turn_input_origins: dict[str, str] = {}
        self._directive_turn_ids: dict[str, str | None] = {}
        # What each directive asked the client to do, so its ui.settled can be
        # reported to the model with the screen it was about.
        self._directive_meta: dict[str, dict[str, str]] = {}
        # Cards whose spoken confirm was refused as card_not_shown. When the
        # client reports one shown, the model is told (it still decides).
        self._shown_waiters: dict[str, str | None] = {}
        # Cards the model was told about that way, with the input whose yes was
        # refused. While that input is still the person's latest, Live's next
        # confirm of the card answers that yes, so the hold lets it run once.
        # Spent on that use; the person's next input drops the rest.
        self._shown_recoveries: dict[str, str] = {}
        # A tool call can end its provider turn before Live speaks its reply.
        # Keep narration ownership through that continuation until new input
        # actually reaches Live.
        self._narration_owns_response = False
        self._narration_origin_turn_id: str | None = None
        # A tool's answer went to Live and Live has said nothing since. Live may
        # close that provider turn and speak the reply in a fresh one, so a new
        # input waits behind it instead of taking the turn the reply will use.
        self._reply_owed = False
        # What the owed reply answers; meaningful only while _reply_owed.
        self._reply_owed_to: OpenedAfter = "none"
        # Proposals held by ``_held_card``: how many since the input they
        # followed (new input restarts the count), and whether the reply Live
        # owes is to a held answer, with nothing real handed to it since.
        self._hold_streak: tuple[str | None, int] = (None, 0)
        self._hold_chain = False
        # Set from the auth frame before any tool runs; UTC until then.
        self._client_timezone = "UTC"
        self.started_at = clock()
        self.last_activity = clock()
        self.audio_in_bytes = 0
        self.audio_out_chunks = 0
        self.dropped_audio_frames = 0
        self.client_steps: dict[str, dict[str, Any]] = {}
        # Review cards this session opened, by the delivery_ref their Send
        # reports with. The report only names a send action; the outcome is
        # always re-read from the ledger through ``_mail_delivery_status``.
        self.mail_deliveries: dict[str, dict[str, Any]] = {}
        self._mail_delivery_status = mail_delivery_status or get_owner_send_action
        self.pending_receipts: dict[str, str] = {}
        # Answered typed name edits by operation id: a resend gets the same
        # name_edit.result back and never proposes a second card.
        self._name_edits: dict[str, dict[str, Any]] = {}
        self._last_turn_ok = False
        self.close_code: int | None = None
        self.close_reason: str = ""
        self._closed = False
        self._counters: dict[str, int] = {}
        self._send_lock = asyncio.Lock()
        # Only server-issued turn ids may re-enter operational logs through an
        # optional client perf frame. Shape validation alone cannot prove that
        # a hex string was not client-chosen content.
        self._issued_turn_ids: deque[str] = deque(maxlen=256)
        # Latency marks (monotonic, from ``clock``). Only durations are logged,
        # never names, screens or words.
        self._input_final_at: float | None = None
        self._awaiting_first_tool = False
        self._awaiting_first_audio = False
        self._tool_response_at: float | None = None
        self._turn_perfs: dict[str, TurnPerf] = {}
        self._provider_activity_end_at: float | None = None
        self._provider_activity_source: str | None = None
        self._provider_activity_started = False

    # -- state guards (raise instead of assert; the relay must never run
    #    a frame before auth or a provider before the socket is ready) --------

    @property
    def conversation(self) -> Conversation:
        if self._conversation is None:
            raise SessionClosed(protocol.CLOSE_PROTOCOL, "conversation_not_open")
        return self._conversation

    @conversation.setter
    def conversation(self, value: Conversation | None) -> None:
        self._conversation = value

    @property
    def ctx(self) -> ToolContext:
        if self._ctx is None:
            raise SessionClosed(protocol.CLOSE_AUTH, "not_authenticated")
        return self._ctx

    @ctx.setter
    def ctx(self, value: ToolContext | None) -> None:
        self._ctx = value

    @property
    def live(self) -> LiveSessionPort:
        if self._live is None:
            raise SessionClosed(protocol.CLOSE_PROTOCOL, "provider_not_ready")
        return self._live

    @live.setter
    def live(self, value: LiveSessionPort | None) -> None:
        self._live = value

    # -- helpers -------------------------------------------------------------

    async def _send(self, frame: dict[str, Any]) -> None:
        async with self._send_lock:
            if frame.get("type") in {"audio", "transcript.input", "transcript.output", "turn"}:
                turn_id = frame.get("turn_id")
                if isinstance(turn_id, str):
                    self._issued_turn_ids.append(turn_id)
            await self.transport.send(frame)

    async def _send_transcript(
        self,
        role: Literal["input", "output"],
        chunk: str,
        *,
        finished: bool,
        turn_id: str,
        request_id: str | None = None,
        typed: bool = False,
    ) -> None:
        """The one place a transcript frame leaves the relay.

        Live sends both directions as deltas (captured 2026-10-06 with
        synthetic audio: output chunks lead with a space and its ``finished``
        carries no text; input arrives as whole finished segments). The relay
        owns the line so the client never guesses from text shape: a stable
        segment id, a seq from 1, the whole text so far (``cumulative``) and
        ``final`` when Live finishes it. The chunks merge once, here, by
        ``TranscriptSegment.accept``. The client freezes a line at its final,
        so a finished chunk that only resends the line just finished in the
        same turn (whitespace aside) sends nothing; anything else starts a
        new line. A typed echo is its own one-frame segment. Never logs text.
        """
        segment = None if typed else self._transcript_segments.get(role)
        if segment is not None and segment.turn_id != turn_id:
            self._end_transcript_segment(role)
            segment = None
        if not typed:
            just_finished = self._finished_transcripts.pop(role, None)
            if segment is None and finished and just_finished == (turn_id, _spaced(chunk)):
                # Already shown final. For output, the turn's after_final
                # count still records the resend.
                self._finished_transcripts[role] = just_finished
                return
        if segment is None:
            segment = TranscriptSegment(turn_id=turn_id)
            if not typed:
                self._transcript_segments[role] = segment
        if typed:
            segment.text = chunk
        else:
            segment.accept(chunk, finished=finished)
            if finished:
                self._end_transcript_segment(role)
                self._finished_transcripts[role] = (turn_id, _spaced(segment.raw))
        if not segment.text:
            return
        segment.seq += 1
        await self._send(
            protocol.transcript(
                role,
                segment.text,
                final=finished,
                turn_id=turn_id,
                request_id=request_id,
                segment_id=segment.segment_id,
                seq=segment.seq,
                segment_kind="final" if finished else "cumulative",
            )
        )

    def _touch(self) -> None:
        self.last_activity = self.clock()

    def _bump(self, **counters: int) -> None:
        for name, value in counters.items():
            self._counters[name] = self._counters.get(name, 0) + value

    def _storage_failed(self, op: str, exc: BaseException) -> None:
        """Record a survived storage failure. ``op`` is a short fixed word."""
        self._bump(storage_failures=1)
        logger.warning(
            "one_voice.storage.failed session=%s op=%s error=%s",
            self.session_id,
            op,
            type(exc).__name__,
        )

    def _perf_for_input(self, input_turn_id: str) -> TurnPerf:
        perf = self._turn_perfs.get(input_turn_id)
        if perf is None:
            if len(self._turn_perfs) >= _PERF_TURN_MEMORY:
                self._turn_perfs.pop(next(iter(self._turn_perfs)))
            perf = TurnPerf(input_turn_id=input_turn_id)
            self._turn_perfs[input_turn_id] = perf
        return perf

    def _perf_for_turn(self, turn_id: str | None) -> TurnPerf | None:
        if turn_id is None:
            return None
        input_turn_id = self._turn_input_origins.get(turn_id, turn_id)
        return self._turn_perfs.get(input_turn_id)

    def _count_turn_perf(self, turn_id: str | None, field_name: str) -> None:
        perf = self._perf_for_turn(turn_id)
        if perf is not None:
            setattr(perf, field_name, getattr(perf, field_name) + 1)

    def _mark_input_final(self, input_turn_id: str, *, audio: bool = False) -> None:
        """A complete user input reached the model: start the latency clock."""
        now = self.clock()
        self._input_final_at = now
        self._awaiting_first_tool = True
        self._awaiting_first_audio = True
        self._tool_response_at = None
        perf = self._perf_for_input(input_turn_id)
        if perf.transcript_final_at is None:
            perf.transcript_final_at = now
            self._bump(user_input_turns=1)
        if audio and self._provider_activity_end_at is not None:
            elapsed_ms = int((now - self._provider_activity_end_at) * 1000)
            if 0 <= elapsed_ms <= 120_000:
                perf.provider_activity_end_at = self._provider_activity_end_at
                logger.info(
                    "one_voice.latency session=%s turn=%s phase=provider_activity_end_to_transcript source=%s ms=%d",
                    self.session_id,
                    input_turn_id,
                    self._provider_activity_source,
                    elapsed_ms,
                )
        self._provider_activity_end_at = None
        self._provider_activity_source = None
        self._provider_activity_started = False

    def _log_turn_perf(self, provider_turn_id: str) -> None:
        perf = self._perf_for_turn(provider_turn_id)
        if perf is None:
            return
        logger.info(
            "one_voice.turn_perf session=%s input_turn=%s provider_turn=%s "
            "provider_turns=%d tool_calls=%d pending_created=%d pending_reused=%d pending_cancelled=%d",
            self.session_id,
            perf.input_turn_id,
            provider_turn_id,
            perf.provider_turns,
            perf.tool_calls,
            perf.pending_created,
            perf.pending_reused,
            perf.pending_cancelled,
        )

    def _log_session_perf(self) -> None:
        inputs = self._counters.get("user_input_turns", 0)
        provider_turns = self._counters.get("provider_turns", 0)
        tool_calls = self._counters.get("tool_calls", 0)
        created = self._counters.get("pending_created", 0)
        reused = self._counters.get("pending_reused", 0)
        cancelled = self._counters.get("pending_cancelled", 0)
        ratios = (
            " provider_turns_per_user_input=%.2f tool_calls_per_user_input=%.2f "
            "pending_proposals_per_user_input=%.2f reused_or_cancelled_proposals_per_user_input=%.2f"
            % (
                provider_turns / inputs,
                tool_calls / inputs,
                created / inputs,
                (reused + cancelled) / inputs,
            )
            if inputs
            else ""
        )
        logger.info(
            "one_voice.session_perf session=%s user_input_turns=%d provider_turns=%d "
            "tool_calls=%d confirmation_proposals=%d confirmation_reused=%d "
            "confirmation_cancelled=%d confirmations_completed=%d clarifications=%d "
            "unprompted=%d chained=%d held=%d%s",
            self.session_id,
            inputs,
            provider_turns,
            tool_calls,
            created,
            reused,
            cancelled,
            self._counters.get("confirmations_completed", 0),
            self._counters.get("clarifications", 0),
            self._counters.get("unprompted", 0),
            self._counters.get("chained", 0),
            self._counters.get("held", 0),
            ratios,
        )

    def _log_latency(self, phase: str, started: float | None, turn_id: str | None = None) -> None:
        if started is None:
            return
        logger.info(
            "one_voice.latency session=%s turn=%s phase=%s ms=%d",
            self.session_id,
            turn_id or self.turn.turn_id,
            phase,
            int((self.clock() - started) * 1000),
        )

    async def _close(self, code: int, reason: str) -> None:
        if self._closed:
            return
        self._closed = True
        self.close_code = code
        self.close_reason = reason
        try:
            await self.transport.close(code, reason)
        except Exception:  # noqa: BLE001 - already closing
            pass

    async def _fail(self, code: int, error_code: str, message: str) -> None:
        try:
            await self._send(protocol.error(error_code, message))
        except Exception:  # noqa: BLE001
            pass
        await self._close(code, error_code)
        raise SessionClosed(code, error_code)

    # -- lifecycle -----------------------------------------------------------

    async def run(self) -> None:
        try:
            auth = await self._authenticate()
            await self._open_conversation(auth)
            await self._run_live()
        except SessionClosed:
            pass
        except ConversationNotOwned:
            await self._close(protocol.CLOSE_AUTH, "conversation_not_owned")
        except Exception as exc:  # noqa: BLE001 - classified, never reflected
            from hushh_mcp.runtime_providers.dependency_health import classify_provider_error

            reason = classify_provider_error(exc)
            logger.warning(
                "one_voice.session.failed class=%s error=%s session=%s failures=%s",
                reason,
                type(exc).__name__,
                self.session_id,
                json.dumps(_failure_fingerprints(exc), separators=(",", ":")),
            )
            try:
                await self._send(
                    protocol.error("voice_unavailable", "Voice is unavailable right now.")
                )
            except Exception:  # noqa: BLE001
                pass
            await self._close(protocol.CLOSE_PROVIDER_UNAVAILABLE, reason)
        finally:
            await self._record_close()

    async def _authenticate(self) -> AuthResult:
        try:
            raw = await asyncio.wait_for(self.transport.receive(), timeout=AUTH_TIMEOUT_SECONDS)
            frame = protocol.parse_client_frame(raw)
        except (asyncio.TimeoutError, protocol.FrameError):
            await self._fail(protocol.CLOSE_AUTH, "auth_required", "Send the auth frame first.")
        if not isinstance(frame, protocol.AuthFrame):
            await self._fail(protocol.CLOSE_AUTH, "auth_required", "Send the auth frame first.")
        if frame.conversation_id != self.claims.conversation_id:
            await self._fail(protocol.CLOSE_AUTH, "auth_mismatch", "Ticket and auth do not match.")
        try:
            auth = await self.verify_auth(frame, self.claims)
        except PermissionError as exc:
            await self._fail(protocol.CLOSE_AUTH, "auth_invalid", str(exc) or "Not authorized.")
        if auth.user_id != self.claims.user_id:
            await self._fail(protocol.CLOSE_AUTH, "auth_mismatch", "Ticket and auth do not match.")
        # A hint for resolving relative dates, not authority. AuthResult is the
        # route's authority object and stays untouched.
        self._client_timezone = frame.timezone or "UTC"
        return auth

    async def _open_conversation(self, auth: AuthResult) -> None:
        self.conversation = await self.conversations.open(
            user_id=auth.user_id,
            conversation_id=self.claims.conversation_id,
            model_id=self.config.model_id,
            model_location=self.config.location,
        )
        entities = restore_context(EntityContext, self.conversation.entity_context)
        entities.prune()
        screen = restore_context(ScreenContext, self.conversation.screen_context)
        self.ctx = ToolContext(
            user_id=auth.user_id,
            conversation_id=self.claims.conversation_id,
            entities=entities,
            screen=screen,
            vault_owner_token=auth.vault_owner_token,
            firebase_id_token=auth.firebase_id_token,
            timezone=self._client_timezone,
        )
        self._display_name = auth.display_name
        # Not guarded on purpose: a session that cannot say which cards are open
        # must not start, or a card shown in an earlier session could be
        # confirmed by voice while this client displays nothing.
        open_rows = await self.pending.list_open(
            user_id=auth.user_id, conversation_id=self.claims.conversation_id
        )
        self._pending_turn_ids.update(
            (row.id, row.origin_turn_id) for row in open_rows if row.origin_turn_id is not None
        )
        await self._send(
            protocol.session_ready(
                session_id=self.session_id,
                conversation_id=self.claims.conversation_id,
                model=self.config.model_id,
                resumed=self.conversation.session_count > 1,
                idle_timeout_ms=self.config.idle_close_seconds * 1000,
                session_max_ms=self.config.session_max_seconds * 1000,
                pending_actions=[row.public() for row in open_rows],
            )
        )

    async def _run_live(self) -> None:
        from hushh_mcp.one_voice.instruction import build_instruction

        declarations = registry.declarations()
        # Nothing else observes this list. It is assembled here and handed to the
        # provider; no endpoint returns it and no client frame carries it, so
        # without this line a running deployment cannot be asked which
        # capabilities a session was actually given -- only which ones its image
        # ought to contain, which is an inference and reads identical when the
        # catalog is wrong. Names only, and mail is named explicitly because a
        # release that claims mail is live is exactly the claim worth checking.
        mail_tools = sorted(
            name
            for name in (str(item.get("name") or "") for item in declarations)
            if "mail" in name
        )
        logger.info(
            "one_voice.session.tools count=%d mail=%s",
            len(declarations),
            ",".join(mail_tools) or "none",
        )
        instruction = build_instruction(
            tool_declarations=declarations,
            screen_ids=list(OPENABLE_SCREENS),
            screen_id=self.ctx.screen.screen_id,
            display_name=self._display_name,
            resumed=self.conversation.session_count > 1,
            # The owner's zone, so "tomorrow at 9" means their 9. The session
            # clock is monotonic, so the instruction reads the wall clock itself.
            timezone=self._client_timezone,
        )
        live_config = {
            "system_instruction": instruction,
            "tool_declarations": declarations,
            "resumption_handle": self.conversation.live_resumption_handle,
        }
        async with self.live_factory(self.config.model_id, live_config) as live:
            self.live = live
            await self._send(protocol.voice_state("listening"))
            try:
                async with asyncio.TaskGroup() as group:
                    group.create_task(self._pump_client())
                    group.create_task(self._pump_live())
                    group.create_task(self._watchdog())
            except* SessionClosed:
                pass

    async def _record_close(self) -> None:
        if self._conversation is None or self._ctx is None:
            return
        self._log_session_perf()
        # A lost socket cannot prove whether the review card appeared. Settle
        # every outstanding mail step as unconfirmed before the session leaves.
        for step_id, step in list(self.client_steps.items()):
            if step.get("kind") != "open_mail_draft":
                continue
            self.client_steps.pop(step_id, None)
            pending = step.get("pending")
            if not isinstance(pending, PendingAction):
                continue
            try:
                await self.pending.settle_mail_draft_step(
                    user_id=self.ctx.user_id,
                    pending_action_id=pending.id,
                    opened=False,
                    uncertain=True,
                )
            except Exception:  # noqa: BLE001 - close ledger still needs a chance to run
                logger.warning("one_voice.mail_draft.close_settle_failed")
        try:
            await self.conversations.bump(
                user_id=self.ctx.user_id,
                conversation_id=self.ctx.conversation_id,
                audio_in_seconds=self.audio_in_bytes // PCM16_16K_BYTES_PER_SECOND,
                **self._counters,
            )
            await self.conversations.save_entity_context(
                user_id=self.ctx.user_id,
                conversation_id=self.ctx.conversation_id,
                context=self.ctx.entities.model_dump(mode="json"),
            )
            await self.conversations.close(
                user_id=self.ctx.user_id,
                conversation_id=self.ctx.conversation_id,
                close_code=self.close_code,
                reason_class=self.close_reason,
                ended=self.close_code == protocol.CLOSE_ENDED,
            )
        except Exception:  # noqa: BLE001 - ledger writes are best effort at close
            logger.warning("one_voice.session.close_record_failed")

    # -- watchdog ------------------------------------------------------------

    async def _watchdog(self) -> None:
        warned = False
        while not self._closed:
            await asyncio.sleep(1.0)
            now = self.clock()
            for step_id, step in list(self.client_steps.items()):
                if step.get("kind") != "open_mail_draft" or now <= float(
                    step.get("expires_at") or 0
                ):
                    continue
                self.client_steps.pop(step_id, None)
                try:
                    await self._settle_mail_draft_step(
                        step,
                        protocol.ClientStepResultFrame(
                            type="client_step.result",
                            step_id=step_id,
                            status="failed",
                            payload={"reason": "timeout"},
                        ),
                    )
                except _STORAGE_ERRORS as exc:
                    # The row stays "requested" and storage's own recovery marks
                    # it unconfirmed; nothing here may report it as opened.
                    self._storage_failed("settle", exc)
            elapsed = now - self.started_at
            if (
                self._queued_texts
                and now - self._queued_texts[0][2] >= QUEUED_TEXT_MAX_WAIT_SECONDS
            ):
                await self._send(
                    protocol.error(
                        "turn_timeout", "One couldn't finish the previous answer. Please try again."
                    )
                )
                await self._close(protocol.CLOSE_PROVIDER_UNAVAILABLE, "queued_turn_timeout")
                raise SessionClosed(protocol.CLOSE_PROVIDER_UNAVAILABLE, "queued_turn_timeout")
            if (
                not warned
                and elapsed >= self.config.session_max_seconds - 60
                and self.live is not None
            ):
                warned = True
                await self._inject_event({"kind": "session_ending_soon", "seconds_left": 60})
            if elapsed >= self.config.session_max_seconds:
                await self._send(protocol.reconnect_required("max_duration"))
                await self._close(protocol.CLOSE_MAX_DURATION, "max_duration")
                raise SessionClosed(protocol.CLOSE_MAX_DURATION, "max_duration")
            if now - self.last_activity >= self.config.idle_close_seconds:
                await self._close(protocol.CLOSE_IDLE, "idle")
                raise SessionClosed(protocol.CLOSE_IDLE, "idle")

    # -- client → provider ---------------------------------------------------

    async def _pump_client(self) -> None:
        while not self._closed:
            try:
                raw = await self.transport.receive()
            except SessionClosed:
                raise
            except Exception:  # noqa: BLE001 - socket gone
                await self._close(protocol.CLOSE_ENDED, "client_disconnected")
                raise SessionClosed(protocol.CLOSE_ENDED, "client_disconnected")
            try:
                frame = protocol.parse_client_frame(raw)
            except protocol.FrameError as exc:
                await self._send(protocol.error("protocol", str(exc)))
                continue
            try:
                await self._handle_client_frame(frame)
            except _STORAGE_ERRORS as exc:
                # Whatever this frame asked for did not happen; the card or
                # setting stays as it was, and the person can simply try again.
                # A device's own step report is not something they did, so it
                # gets no "try again" (storage recovers that row on its own).
                self._storage_failed("frame", exc)
                if not isinstance(frame, protocol.ClientStepResultFrame):
                    await self._send(
                        protocol.error(
                            "storage_unavailable", "That didn't go through. Please try again."
                        )
                    )

    async def _handle_client_frame(self, frame: Any) -> None:
        if isinstance(frame, protocol.AudioFrame):
            size = len(frame.data) * 3 // 4
            if size > protocol.MAX_AUDIO_FRAME_BYTES:
                self.dropped_audio_frames += 1
                return
            self._touch()
            self.audio_in_bytes += size
            await self.live.send_audio(frame.data)
            return
        if isinstance(frame, protocol.PingFrame):
            await self._send(protocol.pong())
            return
        if isinstance(frame, protocol.PerfFrame):
            # Telemetry is optional and must not extend the idle deadline.
            logger.info(
                "one_voice.client_perf session=%s turn=%s metric=%s ms=%d",
                self.session_id,
                frame.turn_id if frame.turn_id in self._issued_turn_ids else "none",
                frame.metric,
                frame.duration_ms,
            )
            return
        self._touch()
        if isinstance(frame, protocol.TextFrame):
            if self.turn.input_seen:
                if len(self._queued_texts) >= 8:
                    await self._send(protocol.error("turn_busy", "Too many questions are waiting."))
                    return
                input_id = uuid.uuid4().hex[:12]
                self._queued_texts.append((input_id, frame.text, self.clock()))
                self._superseded_turn_ids.add(self.turn.turn_id)
                await self._send(protocol.turn("interrupted", turn_id=self.turn.turn_id))
            else:
                input_id = self.turn.turn_id
                self.turn.input_seen = True
                # The typed question owns this turn now; Live owes it an answer.
                self.turn.model_only = False
            self._latest_input_turn_id = input_id
            self._drop_stale_recoveries()
            self._bind_turn_to_input(input_id, input_id)
            await self._send_transcript(
                "input",
                frame.text,
                finished=True,
                turn_id=input_id,
                request_id=frame.request_id,
                typed=True,
            )
            if input_id == self.turn.turn_id:
                self._narration_owns_response = False
                self._narration_origin_turn_id = None
                self._mark_input_final(input_id)
                await self.live.send_text(frame.text)
        elif isinstance(frame, protocol.AppContextFrame):
            await self._update_screen(frame)
        elif isinstance(frame, protocol.PendingShownFrame):
            try:
                shown = await self.pending.mark_shown(
                    user_id=self.ctx.user_id, pending_action_id=frame.pending_action_id
                )
            except PendingActionStorageError as exc:
                # Not recorded as shown, so a spoken yes still gets card_not_shown
                # and a tap (which needs no shown mark) still works.
                self._storage_failed("shown", exc)
                shown = None
            if shown is not None and shown.id in self._shown_waiters:
                refused_turn_id = self._shown_waiters.pop(shown.id)
                if self._origin_is_stale(refused_turn_id):
                    # The person moved on after the refused yes; that yes no
                    # longer answers this card. Never revive it in a new turn.
                    self._bump(pending_shown_stale=1)
                else:
                    # A spoken yes was refused because the card was not on
                    # screen. Tell the model it is now; it decides. Recorded
                    # first, so the hold knows whose yes a confirm of this
                    # card answers before Live can act on the event.
                    self._bump(pending_shown_late=1)
                    self._record_recovery(shown.id, refused_turn_id)
                    await self._inject_event(
                        {"kind": "pending_shown", "pending_action_id": shown.id}
                    )
        elif isinstance(frame, protocol.ConfirmActionFrame):
            await self._confirm_by_tap(frame)
        elif isinstance(frame, protocol.CancelActionFrame):
            await self._cancel(frame)
        elif isinstance(frame, protocol.CandidateChooseFrame):
            await self._inject_event(
                {
                    "kind": "candidate_chosen",
                    "entity": frame.kind,
                    "id": frame.id,
                    "none": frame.none,
                }
            )
        elif isinstance(frame, protocol.ClientStepResultFrame):
            await self._client_step_result(frame)
        elif isinstance(frame, protocol.MailDeliveryResultFrame):
            await self._settle_mail_delivery(frame)
        elif isinstance(frame, protocol.UiSettledFrame):
            origin_turn_id = self._directive_turn_ids.pop(frame.directive_id, None)
            meta = self._directive_meta.pop(frame.directive_id, {})
            if origin_turn_id is not None and not self._origin_is_stale(origin_turn_id):
                # Screen ids go to the model only, never to a log line.
                await self._inject_event(
                    {
                        "kind": "ui_settled",
                        "directive_id": frame.directive_id,
                        "status": frame.status,
                        **meta,
                    }
                )
        elif isinstance(frame, protocol.InterruptFrame):
            await self._send(protocol.turn("interrupted", turn_id=self.turn.turn_id))
        elif isinstance(frame, protocol.EndFrame):
            await self._close(protocol.CLOSE_ENDED, "ended")
            raise SessionClosed(protocol.CLOSE_ENDED, "ended")
        elif isinstance(frame, protocol.NameEditSubmitFrame):
            await self._submit_name_edit(frame)
        elif isinstance(frame, protocol.AuthFrame):
            await self._send(protocol.error("protocol", "already_authenticated"))

    async def _update_screen(self, frame: protocol.AppContextFrame) -> None:
        from api.routes.one.agent_context import sanitize_agent_context

        payload = frame.model_dump(mode="json", exclude={"type"})
        if len(json.dumps(payload)) > protocol.MAX_CONTEXT_JSON_CHARS:
            await self._send(protocol.error("protocol", "context_too_large"))
            return
        sanitized = sanitize_agent_context({"screen_state": payload.get("screen_state") or {}})
        self.ctx.screen = ScreenContext(
            screen_id=frame.screen_id,
            route=frame.route,
            available_action_ids=list(frame.available_action_ids)[:200],
            screen_state=dict(sanitized.get("screen_state") or {}),
            os_location_permission=frame.os_location_permission,
            active_circle_id=frame.active_circle_id,
            active_mail_ordinal=frame.active_mail_ordinal,
            active_mail_offer_revision=frame.active_mail_offer_revision,
        )
        try:
            await self.conversations.save_screen_context(
                user_id=self.ctx.user_id,
                conversation_id=self.ctx.conversation_id,
                context=self.ctx.screen.model_dump(mode="json"),
            )
        except ConversationStorageError as exc:
            # The live screen above is what this session uses; only a resumed
            # session would start from an older one.
            self._storage_failed("screen", exc)

    async def _inject_event(self, event: dict[str, Any]) -> None:
        if self._live is None:
            return
        await self.live.send_event(
            "[ONE_EVENT] " + json.dumps(event, separators=(",", ":"), sort_keys=True)
        )
        # The event closes a turn of its own, so Live owes it a reply.
        self._reply_owed = True
        self._reply_owed_to = "event"
        # Live now has something real to answer, not only a held proposal.
        self._hold_chain = False
        # Live's reply lands in whatever turn is open; a continuation that
        # followed nothing is now answering this event.
        if self.turn.model_only and self.turn.opened_after == "none":
            self.turn.opened_after = "event"

    def _origin_is_stale(self, origin_turn_id: str | None) -> bool:
        input_turn_id = self._turn_input_origins.get(origin_turn_id or "", origin_turn_id)
        return bool(
            origin_turn_id
            and (
                origin_turn_id in self._superseded_turn_ids
                or input_turn_id in self._superseded_turn_ids
                or (
                    self._latest_input_turn_id is not None
                    and input_turn_id != self._latest_input_turn_id
                )
            )
        )

    def _record_recovery(self, card_id: str, refused_turn_id: str | None) -> None:
        """Remember the input whose yes to ``card_id`` was refused as not shown.

        Kept as the input id, resolved now: the refused confirm may have come
        from a provider continuation bound to that input.
        """
        if not refused_turn_id:
            return
        self._shown_recoveries.pop(card_id, None)
        if len(self._shown_recoveries) >= _SHOWN_WAITERS_MAX:
            self._shown_recoveries.pop(next(iter(self._shown_recoveries)))
        self._shown_recoveries[card_id] = self._turn_input_origins.get(
            refused_turn_id, refused_turn_id
        )

    def _drop_stale_recoveries(self) -> None:
        """The person said something new: an earlier refused yes answers nothing."""
        latest = self._latest_input_turn_id
        self._shown_recoveries = {
            card_id: input_turn_id
            for card_id, input_turn_id in self._shown_recoveries.items()
            if input_turn_id == latest
        }

    def _bind_turn_to_input(self, turn_id: str, input_turn_id: str) -> None:
        if turn_id not in self._turn_input_origins and len(self._turn_input_origins) >= 512:
            protected = {
                *self._pending_turn_ids.values(),
                *self._shown_waiters.values(),
                *(str(step.get("origin_turn_id") or "") for step in self.client_steps.values()),
                *(str(item.get("origin_turn_id") or "") for item in self.mail_deliveries.values()),
                *self._directive_turn_ids.values(),
                self.turn.turn_id,
                self._narration_origin_turn_id,
            }
            for old_turn_id in self._turn_input_origins:
                if old_turn_id not in protected:
                    del self._turn_input_origins[old_turn_id]
                    break
        self._turn_input_origins[turn_id] = input_turn_id

    def _remember_directive(
        self, origin_turn_id: str | None, *, kind: str, screen: str | None = None
    ) -> str:
        directive_id = uuid.uuid4().hex[:12]
        if len(self._directive_turn_ids) >= _DIRECTIVE_MEMORY:
            self._directive_turn_ids.pop(next(iter(self._directive_turn_ids)))
        if len(self._directive_meta) >= _DIRECTIVE_MEMORY:
            self._directive_meta.pop(next(iter(self._directive_meta)))
        self._directive_turn_ids[directive_id] = (
            origin_turn_id or self._latest_input_turn_id or self.turn.turn_id
        )
        meta = {"directive_kind": kind}
        if screen:
            meta["screen"] = screen
        self._directive_meta[directive_id] = meta
        return directive_id

    # -- confirmations -------------------------------------------------------

    async def _confirm_by_tap(self, frame: protocol.ConfirmActionFrame) -> None:
        spec = None
        row = await self.pending.get(
            user_id=self.ctx.user_id, pending_action_id=frame.pending_action_id
        )
        if row is not None:
            spec = registry.get_tool(row.tool_name)
        if spec is not None and spec.firebase_plane:
            # The tap's proof is verified here, not merely present: signature,
            # expiry, revocation, and that it names this session's user. The
            # row stays pending on refusal so the client can tap again with a
            # fresh proof.
            proof = await self.executor._actor_proof(frame.firebase_id_token, self.ctx.user_id)
            if proof != "ok":
                await self._send(
                    protocol.error(
                        "firebase_proof_required"
                        if proof == "missing"
                        else "firebase_proof_invalid",
                        "Sign-in proof is required for this action."
                        if proof == "missing"
                        else "Sign-in proof is invalid or names another account.",
                    )
                )
                return
        if frame.firebase_id_token:
            self.ctx.firebase_id_token = frame.firebase_id_token
        try:
            confirmed = await self.pending.confirm(
                user_id=self.ctx.user_id,
                pending_action_id=frame.pending_action_id,
                source="tap",
                receipt_token=frame.receipt_token,
            )
        except PendingActionConflict as exc:
            await self._send(
                protocol.pending_resolved(
                    pending_action_id=frame.pending_action_id,
                    status="not_pending",
                    result_public={"reason_code": str(exc)},
                )
            )
            return
        # This session's binding first: a card re-shown for a repeated proposal
        # belongs to the turn it was re-shown on, not the turn that created it.
        origin_turn_id = (
            self._pending_turn_ids.get(frame.pending_action_id) or confirmed.origin_turn_id
        )
        self._bump(confirmations_completed=1)
        if origin_turn_id is not None:
            await self._send(protocol.voice_state("executing", turn_id=origin_turn_id))
        outcome = await self.executor.execute_pending(self.ctx, confirmed)
        await self._after_execution(outcome, source="tap", origin_turn_id=origin_turn_id)

    async def _cancel(self, frame: protocol.CancelActionFrame) -> None:
        if frame.scope == "session":
            await self._close(protocol.CLOSE_ENDED, "ended")
            raise SessionClosed(protocol.CLOSE_ENDED, "ended")
        cancelled: list[str] = []
        if frame.pending_action_id:
            row = await self.pending.cancel(
                user_id=self.ctx.user_id, pending_action_id=frame.pending_action_id
            )
            if row is not None:
                cancelled.append(row.id)
        else:
            for row in await self.pending.list_open(
                user_id=self.ctx.user_id, conversation_id=self.ctx.conversation_id
            ):
                if await self.pending.cancel(user_id=self.ctx.user_id, pending_action_id=row.id):
                    cancelled.append(row.id)
        for pending_id in cancelled:
            origin_turn_id = self._pending_turn_ids.get(pending_id)
            self.pending_receipts.pop(pending_id, None)
            self._pending_turn_ids.pop(pending_id, None)
            await self._send(
                protocol.pending_resolved(
                    pending_action_id=pending_id, status="cancelled", result_public=None
                )
            )
            self._bump(pending_cancelled=1)
            self._count_turn_perf(origin_turn_id, "pending_cancelled")
        if frame.scope == "turn":
            await self._send(protocol.turn("interrupted", turn_id=self.turn.turn_id))
        await self._inject_event(
            {"kind": "cancelled", "pending_action_ids": cancelled, "scope": frame.scope}
        )
        await self._send(protocol.voice_state("listening"))

    # -- typed name edit -----------------------------------------------------

    async def _submit_name_edit(self, frame: protocol.NameEditSubmitFrame) -> None:
        """Answer one typed "Edit name", once per operation id."""
        answered = self._name_edits.get(frame.operation_id)
        if answered is None:
            answered = await self._name_edit(frame)
            if len(self._name_edits) >= _NAME_EDIT_MEMORY:
                self._name_edits.pop(next(iter(self._name_edits)))
            self._name_edits[frame.operation_id] = answered
            logger.info(
                "one_voice.name_edit session=%s status=%s reason=%s",
                self.session_id,
                answered["status"],
                answered["reason_code"] or "none",
            )
        await self._send(answered)

    def _name_edit_refused(
        self, frame: protocol.NameEditSubmitFrame, reason_code: str, message: str | None = None
    ) -> dict[str, Any]:
        return protocol.name_edit_result(
            operation_id=frame.operation_id,
            status="rejected",
            reason_code=reason_code,
            message=message or _NAME_EDIT_MESSAGES[reason_code],
        )

    async def _name_edit(self, frame: protocol.NameEditSubmitFrame) -> dict[str, Any]:
        """Replace an open create_circle card with the name the person typed.

        The typed text is the person's own: it is validated against the tool's
        bounds and proposed through the executor exactly as a model call
        would be, marked person-authored, and never sent to Live to be read
        again. Every refusal before the cancel leaves the card untouched.
        """
        try:
            row = await self.pending.get(
                user_id=self.ctx.user_id, pending_action_id=frame.pending_action_id
            )
        except PendingActionStorageError as exc:
            self._storage_failed("name_edit", exc)
            return self._name_edit_refused(frame, "storage_unavailable")
        if (
            row is None
            or row.user_id != self.ctx.user_id
            or row.conversation_id != self.ctx.conversation_id
            or row.status != "pending"
        ):
            return self._name_edit_refused(frame, "not_pending")
        if row.tool_name not in _NAME_EDITABLE_TOOLS:
            return self._name_edit_refused(frame, "not_editable")
        name = " ".join(frame.name.split())
        if not name:
            return self._name_edit_refused(frame, "invalid_name", "Type a name for the circle.")
        if len(name) > _NAME_EDIT_MAX_CHARS:
            return self._name_edit_refused(
                frame,
                "invalid_name",
                f"Keep the name to {_NAME_EDIT_MAX_CHARS} characters or fewer.",
            )
        if any(unicodedata.category(char) in _NAME_EDIT_REFUSED_CATEGORIES for char in name):
            return self._name_edit_refused(
                frame, "invalid_name", "That name has characters that can't be used."
            )
        try:
            cancelled = await self.pending.cancel(
                user_id=self.ctx.user_id, pending_action_id=row.id
            )
        except PendingActionStorageError as exc:
            self._storage_failed("name_edit", exc)
            return self._name_edit_refused(frame, "storage_unavailable")
        if cancelled is None:
            # A confirmation (or the clock) settled the card first; nothing is
            # proposed over an action the person already answered.
            try:
                current = await self.pending.get(user_id=self.ctx.user_id, pending_action_id=row.id)
            except PendingActionStorageError:
                current = None
            confirmed = current is not None and current.status in {
                "confirmed",
                "executed",
                "failed",
            }
            return self._name_edit_refused(
                frame, "already_confirmed" if confirmed else "not_pending"
            )
        replaced_turn_id = self._pending_turn_ids.pop(row.id, None) or row.origin_turn_id
        self.pending_receipts.pop(row.id, None)
        await self._send(
            protocol.pending_resolved(
                pending_action_id=row.id, status="cancelled", result_public=None
            )
        )
        self._bump(pending_cancelled=1)
        self._count_turn_perf(replaced_turn_id, "pending_cancelled")

        # The card rides the turn open now, the way a model proposal does. The
        # client fenced the input turn and its read-back at model_end and
        # drops a card sent on either; the open turn is bound to that input,
        # so a tap still reports there. While newer input waits for Live's
        # boundary, the open turn is superseded and the client follows that
        # input, so the card rides it instead.
        bind_turn_id = self.turn.turn_id
        if self._origin_is_stale(bind_turn_id) and self._latest_input_turn_id:
            bind_turn_id = self._latest_input_turn_id
        args: dict[str, Any] = {"name": name}
        kind = row.args.get("kind") if isinstance(row.args, dict) else None
        if isinstance(kind, str) and kind:
            args["kind"] = kind
        outcome = await self.executor.call(
            _typed_name_context(self.ctx), row.tool_name, args, origin_turn_id=bind_turn_id
        )
        for stale in outcome.superseded:
            self.pending_receipts.pop(stale.id, None)
            self._pending_turn_ids.pop(stale.id, None)
            await self._send(
                protocol.pending_resolved(
                    pending_action_id=stale.id, status="cancelled", result_public=None
                )
            )
            self._bump(pending_cancelled=1)
        await self._persist_entities()
        if outcome.pending is None or outcome.result.status != "confirmation_required":
            reason_code = str(outcome.result.public().get("reason_code") or "not_proposed")[:40]
            # The old card is gone and no new one exists: the model must not
            # ask about either.
            await self._inject_event(
                {
                    "kind": "name_edited",
                    "status": "rejected",
                    "reason_code": reason_code,
                    "replaced_pending_action_id": row.id,
                }
            )
            return protocol.name_edit_result(
                operation_id=frame.operation_id,
                status="rejected",
                reason_code=reason_code,
                message=_NAME_EDIT_MESSAGES["not_proposed"],
            )
        new_row = outcome.pending
        self._pending_turn_ids[new_row.id] = bind_turn_id
        if outcome.receipt_token:
            self.pending_receipts[new_row.id] = outcome.receipt_token
        await self._send(
            protocol.pending_action(
                row=new_row.public(),
                receipt_token=outcome.receipt_token,
                entities=self._entities_for(outcome),
                risk_level="high" if new_row.tier == "tap" else "medium",
                turn_id=bind_turn_id,
            )
        )
        self._bump(pending_created=1)
        self._count_turn_perf(bind_turn_id, "pending_created")
        await self._send(protocol.voice_state("confirming", turn_id=bind_turn_id))
        # The person typed this name; the model asks for the new card once. It
        # carries the card's own result, never the typed text as speech.
        await self._inject_event(
            {
                "kind": "name_edited",
                "status": "accepted",
                "tool": row.tool_name,
                "pending_action_id": new_row.id,
                "replaced_pending_action_id": row.id,
                "result": outcome.result.model_public(),
            }
        )
        return protocol.name_edit_result(
            operation_id=frame.operation_id, status="accepted", pending_action_id=new_row.id
        )

    async def _after_execution(
        self,
        outcome: ToolCallOutcome,
        *,
        source: str,
        ok: bool | None = None,
        call_id: str | None = None,
        origin_turn_id: str | None = None,
    ) -> None:
        """Mirror a confirmed action's real outcome to the client and the model.

        Also the settle path for a device-executed step: ``ok`` is then decided
        by the settlement allowlist and ``call_id`` names the originating call
        so the client can replace its pending entry.
        """
        public = outcome.result.public()
        pending_id = outcome.pending.id if outcome.pending else None
        if origin_turn_id is None and outcome.pending is not None:
            origin_turn_id = outcome.pending.origin_turn_id or self._pending_turn_ids.get(
                outcome.pending.id
            )
        awaiting = outcome.result.status in _AWAITING_DEVICE
        executed = ok if ok is not None else outcome.result.status not in _NOT_SUCCESS
        # An outstanding client step: the confirmed action ran (the card is
        # settled), but the outcome is not in yet, so it is neither ok nor a
        # rejection until the step reports back.
        status = "executed" if (executed or awaiting) else "failed"
        if pending_id:
            self.pending_receipts.pop(pending_id, None)
            await self._send(
                protocol.pending_resolved(
                    pending_action_id=pending_id, status=status, result_public=public
                )
            )
        if pending_id and origin_turn_id is None:
            # Rows created before turn binding was stored still settle their
            # exact card. Their result has no safe answer, screen or model owner.
            self._pending_turn_ids.pop(pending_id, None)
            if not awaiting:
                self._bump(
                    tool_results_ok=1 if status == "executed" else 0,
                    tool_results_rejected=0 if status == "executed" else 1,
                )
            await self._persist_entities()
            logger.info("one_voice.pending_unbound session=%s", self.session_id)
            return
        if self._origin_is_stale(origin_turn_id):
            # The exact card above is still truthful, but an old answer must
            # never enter a newer screen or Live model, even after the client
            # has pruned that turn from its bounded local fence.
            if _confirmed_continuation_id(outcome, public):
                # Confirmation already authorized this exact action. Let its
                # required device step finish without importing A's answer or
                # unrelated screen effects into B's turn.
                await self._emit_side_effects(
                    outcome, origin_turn_id=origin_turn_id, client_steps_only=True
                )
            if pending_id and not awaiting:
                self._pending_turn_ids.pop(pending_id, None)
            if not awaiting:
                self._bump(
                    tool_results_ok=1 if status == "executed" else 0,
                    tool_results_rejected=0 if status == "executed" else 1,
                )
            await self._persist_entities()
            return
        await self._send(
            protocol.tool_result(
                call_id=call_id,
                pending_action_id=pending_id,
                tool=outcome.spec.name if outcome.spec else "",
                result_public=public,
                ok=False if awaiting else ok,
                turn_id=origin_turn_id,
            )
        )
        if pending_id and not awaiting:
            self._pending_turn_ids.pop(pending_id, None)
        if not awaiting:
            self._bump(
                tool_results_ok=1 if status == "executed" else 0,
                tool_results_rejected=0 if status == "executed" else 1,
            )
        await self._emit_side_effects(outcome, origin_turn_id=origin_turn_id)
        await self._persist_entities()
        await self._inject_event(
            {
                "kind": "tool_result",
                "tool": outcome.spec.name if outcome.spec else None,
                "pending_action_id": pending_id,
                "confirmation_source": source,
                # Injected into the model's own context, so it takes the model
                # projection for the same reason as the handback above.
                "result": outcome.result.model_public(),
            }
        )
        # An awaiting step settles the card but not the turn: "complete" only
        # once the device outcome is in and verified.
        await self._send(
            protocol.voice_state(
                "complete" if status == "executed" and not awaiting else "listening",
                turn_id=origin_turn_id,
            )
        )

    # -- client steps --------------------------------------------------------

    async def _client_step_result(self, frame: protocol.ClientStepResultFrame) -> None:
        step = self.client_steps.pop(frame.step_id, None)
        if step is None:
            await self._send(protocol.error("protocol", "unknown_client_step"))
            return
        if step.get("kind") == "set_location_updates":
            # Settled server-side from the typed report; the raw claim is never
            # handed to the model as a client_step event.
            await self._settle_location_updates_step(step, frame)
            return
        if step.get("kind") == "open_request_review":
            await self._settle_request_review_step(step, frame)
            return
        if step.get("purpose") == "sos" and step.get("kind") == "publish_location_envelopes":
            await self._settle_sos_publish_step(step, frame)
            return
        if step.get("kind") == "account_lifecycle":
            await self._settle_account_lifecycle_step(step, frame)
            return
        if step.get("kind") == "open_mail_draft":
            await self._settle_mail_draft_step(step, frame)
            return
        event: dict[str, Any] = {
            "kind": "client_step",
            "step": step.get("kind"),
            "step_id": frame.step_id,
            "status": frame.status,
            "payload": frame.payload,
        }
        if step.get("kind") == "publish_location_envelopes":
            verification = await self._verify_grants_published(list(step.get("grant_ids") or []))
            event["verification"] = verification
            pending = step.get("pending")
            if isinstance(pending, PendingAction) and pending.status == "executed":
                # The grant was created before this step. The device's claim
                # cannot prove delivery; publish status comes from the server
                # re-read and updates only the confirmed action's own card.
                publish_status = str(verification.get("status") or "unverified")
                label = "check-in" if step.get("purpose") == "check_in" else "share"
                if publish_status == "published":
                    fact = f"The {label} was created, and your position was published."
                elif publish_status == "partial":
                    fact = (
                        f"The {label} was created, but your position was published "
                        "for only some recipients."
                    )
                elif publish_status == "not_published":
                    fact = f"The {label} was created, but your position was not published."
                else:
                    fact = (
                        f"The {label} was created, but I couldn't verify that your "
                        "position was published."
                    )
                result_public = dict(pending.result or {})
                result_public.pop("client_step", None)
                result_public.update(
                    needs=None,
                    publish_verification=verification,
                    spoken_facts=[fact],
                )
                await self._send(
                    protocol.pending_resolved(
                        pending_action_id=pending.id,
                        status="executed",
                        result_public=result_public,
                    )
                )
        if not self._origin_is_stale(str(step.get("origin_turn_id") or "") or None):
            await self._inject_event(event)

    async def _settle_mail_draft_step(
        self, step: dict[str, Any], frame: protocol.ClientStepResultFrame
    ) -> None:
        """A review card is open only after the owning UI confirms its mount.

        The ledger write is what makes "open" true. When it cannot be made --
        storage is unreachable, or the row is no longer in the state that write
        expects (its earlier resolve never landed) -- the draft is reported as
        unverified: never opened, never sent, and never "nothing is pending".
        The card may well be on screen; nothing re-opens, re-drafts or sends it.
        """
        pending = step.get("pending")
        if not isinstance(pending, PendingAction):
            return
        self._log_latency(
            "draft_step",
            step.get("requested_at"),
            turn_id=str(step.get("origin_turn_id") or "") or None,
        )
        opened = (
            frame.status == "ok"
            and frame.payload.get("mounted") is True
            and self.clock() <= float(step.get("expires_at") or 0)
        )
        uncertain = not opened and (
            self.clock() > float(step.get("expires_at") or 0)
            or frame.payload.get("reason") in {"timeout", "no_handler", "surface_unmounted"}
        )
        unrecorded: str | None = None
        try:
            settled = await self.pending.settle_mail_draft_step(
                user_id=self.ctx.user_id,
                pending_action_id=pending.id,
                opened=opened,
                uncertain=uncertain,
            )
        except PendingActionStorageError as exc:
            self._storage_failed("settle", exc)
            settled, unrecorded = None, "storage_unavailable"
        if settled is None:
            if unrecorded is None:
                # The row is not in the state a settlement expects, typically
                # because the resolve after the handler never landed and it is
                # still "confirmed". Close it the way storage's own recovery
                # would (resolve is the one owner of that transition, and it
                # scrubs the sealed dictation); a no-op for any other state.
                try:
                    await self.pending.resolve(
                        user_id=self.ctx.user_id,
                        pending_action_id=pending.id,
                        status="failed",
                        result={"status": "draft_open_unconfirmed", "needs": None},
                    )
                except PendingActionStorageError as exc:
                    self._storage_failed("settle", exc)
            unrecorded = unrecorded or "draft_not_settled"
            await self._send(
                protocol.pending_resolved(
                    pending_action_id=pending.id,
                    status="failed",
                    result_public={
                        "status": "draft_open_unconfirmed",
                        "needs": None,
                        "reason_code": unrecorded,
                    },
                )
            )
        else:
            await self._send(
                protocol.pending_resolved(
                    pending_action_id=settled.id,
                    status=settled.status,
                    result_public=settled.result,
                )
            )
        raw_draft = step.get("draft")
        draft: dict[str, Any] = raw_draft if isinstance(raw_draft, dict) else {}
        noun = "reply" if draft.get("mode") == "reply" else "draft"
        if not opened:
            # No card, so no Send can follow; its delivery report is never valid.
            self.mail_deliveries.pop(str(step.get("delivery_ref") or ""), None)
        if not self._origin_is_stale(str(step.get("origin_turn_id") or "") or None):
            event: dict[str, Any] = {
                "kind": "client_step",
                "step": "open_mail_draft",
                "status": "ok" if opened and unrecorded is None else "failed",
                "spoken_facts": [
                    f"I couldn't verify the {noun} review state just now. Nothing was sent."
                    if unrecorded is not None
                    else (
                        "The reply is open for review in the original thread. It has not been sent."
                        if noun == "reply"
                        else "The draft is open for review. It has not been sent."
                    )
                    if opened
                    else f"I couldn't confirm the {noun} opened. Nothing was sent."
                    if uncertain
                    else f"The {noun} did not open. Nothing was sent."
                ],
            }
            if unrecorded is not None:
                event["reason_code"] = unrecorded
            await self._inject_event(event)

    def _issue_mail_delivery(self, payload: dict[str, Any], origin_turn_id: str | None) -> str:
        """Remember a review card so its Send can be reported back once it finishes.

        The ref correlates; it authorizes nothing. What the card's Send did is
        read from the send ledger when the report arrives, never taken from it.
        """
        raw_draft = payload.get("draft")
        draft: dict[str, Any] = raw_draft if isinstance(raw_draft, dict) else {}
        reply = draft.get("mode") == "reply"
        delivery_ref = secrets.token_urlsafe(18)
        while len(self.mail_deliveries) >= _MAIL_DELIVERY_MEMORY:
            self.mail_deliveries.pop(next(iter(self.mail_deliveries)))
        self.mail_deliveries[delivery_ref] = {
            "mode": "reply" if reply else "compose",
            # Server-minted and opaque to the client; read back only to learn
            # which thread a "sent" reply had to land in.
            "source_mail_ref": str(draft.get("source_mail_ref") or "") if reply else "",
            "origin_turn_id": origin_turn_id,
            "issued_at": datetime.now(timezone.utc),
            "expires_at": self.clock() + MAIL_DELIVERY_TTL_SECONDS,
            "reports": 0,
        }
        return delivery_ref

    def _mail_delivery_outcome(self, delivery: dict[str, Any], row: dict[str, Any] | None) -> str:
        """The ledger's answer for this card's Send, in five words.

        ``unverified`` covers everything the ledger cannot vouch for: no such
        action for this owner, an action older than the card (some earlier
        send), a reply that landed outside its thread, or a send still in flight.
        """
        if row is None:
            return "unverified"
        created = row.get("created_at")
        if not isinstance(created, datetime):
            return "unverified"
        if created.tzinfo is None:
            created = created.replace(tzinfo=timezone.utc)
        if created < delivery["issued_at"] - _MAIL_DELIVERY_SKEW:
            return "unverified"
        state = str(row.get("state") or "")
        if state == "sent":
            if delivery["mode"] == "reply":
                try:
                    ref = open_reply_source_ref(
                        delivery["source_mail_ref"],
                        owner_user_id=self.ctx.user_id,
                        allow_expired=True,
                    )
                except GmailDeliveryError:
                    return "unverified"
                if str(row.get("gmail_thread_id") or "") != ref.thread_id:
                    return "unverified"
            return "sent"
        if state == "failed":
            return "failed"
        if state == "outcome_unknown":
            return (
                "thread_unconfirmed"
                if str(row.get("safe_error_code") or "") == "reply_thread_mismatch"
                else "outcome_unknown"
            )
        return "unverified"

    async def _settle_mail_delivery(self, frame: protocol.MailDeliveryResultFrame) -> None:
        """A review card's Send finished. Say what the ledger says, once.

        Only reaches the model while the person is still on the turn that opened
        the card; a late report never interrupts a newer question. The card shows
        its own outcome either way, and nothing here retries or re-sends.
        """
        delivery = self.mail_deliveries.get(frame.delivery_ref)
        if delivery is None or self.clock() > float(delivery["expires_at"]):
            # A card this session did not open (the socket reconnected), or one
            # that outlived the window. Its mail was still sent and its card
            # still shows the outcome; One just does not speak it. Not a
            # protocol error, which the panel would show the person as one.
            self.mail_deliveries.pop(frame.delivery_ref, None)
            logger.info("one_voice.mail_delivery outcome=untracked")
            return
        delivery["reports"] = int(delivery.get("reports") or 0) + 1
        try:
            row = await self._mail_delivery_status(
                user_id=self.ctx.user_id, action_id=frame.action_id
            )
        except Exception as exc:  # noqa: BLE001 - an unreadable ledger is "unverified"
            logger.warning("one_voice.mail_delivery.read_failed error=%s", type(exc).__name__)
            row = None
        outcome = self._mail_delivery_outcome(delivery, row)
        # A failed send can be reviewed and sent again from the same card, so
        # its ref stays for the next report; anything else is final.
        if outcome != "failed" or delivery["reports"] >= _MAIL_DELIVERY_REPORTS:
            self.mail_deliveries.pop(frame.delivery_ref, None)
        reply = delivery["mode"] == "reply"
        logger.info("one_voice.mail_delivery mode=%s outcome=%s", delivery["mode"], outcome[:23])
        noun = "reply" if reply else "email"
        fact = {
            "sent": (
                "Your reply was sent in the original thread." if reply else "Your email was sent."
            ),
            "failed": f"Gmail didn't send the {noun}. Nothing was sent.",
            "thread_unconfirmed": (
                "Gmail took the reply, but I couldn't confirm it stayed in the original "
                "thread. Check Sent Mail before trying again."
            ),
        }.get(
            outcome,
            f"I couldn't confirm whether the {noun} was sent. Check Sent Mail before trying again.",
        )
        if not self._origin_is_stale(str(delivery.get("origin_turn_id") or "") or None):
            await self._inject_event(
                {
                    "kind": "mail_delivery",
                    "mode": delivery["mode"],
                    "status": outcome,
                    "spoken_facts": [fact],
                }
            )

    async def _settle_sos_publish_step(
        self, step: dict[str, Any], frame: protocol.ClientStepResultFrame
    ) -> None:
        """Final outcome of a Save My Soul alert this session armed.

        The device only says whether its publish step ran; whether anyone was
        reached is decided by ``report_save_my_soul_delivery`` from the stored
        envelopes on the exact grant set the trigger armed (the step record
        carries it, so the model cannot narrow it). The raw client payload
        never reaches the model. A late or failed report still verifies: an
        envelope may have been stored even though the device's reply was lost.
        The trigger card resolves a second time with the verified report so
        the client can replace "armed" with the real outcome.
        """
        grant_ids = [str(gid) for gid in (step.get("grant_ids") or []) if gid]
        outcome = await self.executor.call(
            self.ctx, "report_save_my_soul_delivery", {"grant_ids": grant_ids}
        )
        report = outcome.result
        public = report.public()
        public["device_step"] = {
            "status": frame.status,
            "late": self.clock() > float(step.get("expires_at") or 0),
        }
        report = report.model_copy(update={"device_step": public["device_step"]})
        pending = step.get("pending")
        settled = ToolCallOutcome(
            result=report,
            spec=outcome.spec,
            pending=pending if isinstance(pending, PendingAction) else None,
        )
        ok = report.status in {"sos_sent", "sos_partial"}
        await self._after_execution(
            settled,
            source="device",
            ok=ok,
            call_id=str(step.get("call_id") or "") or None,
            origin_turn_id=str(step.get("origin_turn_id") or "") or None,
        )
        if ok and not self._origin_is_stale(str(step.get("origin_turn_id") or "") or None):
            self.turn.ok_results += 1
            self._last_turn_ok = True

    async def _settle_account_lifecycle_step(
        self, step: dict[str, Any], frame: protocol.ClientStepResultFrame
    ) -> None:
        """Final outcome of a reset or deletion this session armed.

        The device only says what its lifecycle flow reported; whether the
        account was reset or deleted is decided by ``report_account_lifecycle``
        from the server (the ``vault_keys`` stamp, or the tombstone). The raw
        client payload never reaches the model, and the step record -- not the
        frame -- names the operation and the owner, so a report cannot be
        redirected. The card resolves a second time with the verified outcome
        so the client can replace "resetting"/"deleting" with what happened.
        """
        payload = frame.payload if isinstance(frame.payload, dict) else {}
        client_status = str(payload.get("outcome") or "").strip().lower()
        if frame.status != "ok" and client_status in {"", "reset", "deleted"}:
            client_status = "unknown"
        if client_status not in {
            "reset",
            "not_reset",
            "deleted",
            "needs_unlock",
            "auth_failed",
            "blocked_external",
            "failed",
            "unknown",
        }:
            client_status = "unknown"
        outcome = await self.executor.call(
            self.ctx,
            "report_account_lifecycle",
            {
                "operation": str(step.get("operation") or ""),
                "client_status": client_status,
                "issued_at_ms": int(step.get("issued_at_ms") or 0),
            },
        )
        report = outcome.result
        public = report.public()
        public["device_step"] = {
            "status": frame.status,
            "late": self.clock() > float(step.get("expires_at") or 0),
        }
        report = report.model_copy(update={"device_step": public["device_step"]})
        pending = step.get("pending")
        settled = ToolCallOutcome(
            result=report,
            spec=outcome.spec,
            pending=pending if isinstance(pending, PendingAction) else None,
        )
        ok = report.status in {"account_reset", "account_deleted"}
        await self._after_execution(
            settled,
            source="device",
            ok=ok,
            call_id=str(step.get("call_id") or "") or None,
            origin_turn_id=str(step.get("origin_turn_id") or "") or None,
        )
        if ok and not self._origin_is_stale(str(step.get("origin_turn_id") or "") or None):
            self.turn.ok_results += 1
            self._last_turn_ok = True

    async def _settle_location_updates_step(
        self, step: dict[str, Any], frame: protocol.ClientStepResultFrame
    ) -> None:
        """Final result for this device's Location updates switch.

        The step record binds the outcome to this session (the record exists only
        here), the originating tool and call, the gateway action, the desired
        state, and a deadline; the pure settlement refuses anything that does not
        match. Success is an allowlist, so nothing interim or contradictory is
        ever narrated as "on" or "off".
        """
        from hushh_mcp.one_voice.tools.location_state import (
            LOCATION_UPDATES_SETTLED_OK,
            settle_location_updates_step,
        )

        result = settle_location_updates_step(
            step, status=frame.status, payload=frame.payload, now=self.clock()
        )
        ok = result.status in LOCATION_UPDATES_SETTLED_OK
        spec = step.get("spec")
        pending = step.get("pending")
        outcome = ToolCallOutcome(
            result=result,
            spec=spec if isinstance(spec, ToolSpec) else None,
            pending=pending if isinstance(pending, PendingAction) else None,
        )
        await self._after_execution(
            outcome,
            source="device",
            ok=ok,
            call_id=str(step.get("call_id") or "") or None,
            origin_turn_id=str(step.get("origin_turn_id") or "") or None,
        )
        if ok and not self._origin_is_stale(str(step.get("origin_turn_id") or "") or None):
            # The narration turn that follows must read as a receipt even if a
            # turn_complete landed between the tool call and the device report.
            self.turn.ok_results += 1
            self._last_turn_ok = True

    async def _settle_request_review_step(
        self, step: dict[str, Any], frame: protocol.ClientStepResultFrame
    ) -> None:
        """Final result for a connection request that needed an on-screen scope
        review. The client only says the screen closed (or that it never
        opened); the request and the relationship are re-read here and that
        re-read is what the model and the card get."""
        from hushh_mcp.one_voice.tools.people import settle_request_review

        request_id = str(step.get("request_id") or "")
        user_id = str(step.get("user_id") or "")
        known = self.ctx.entities.person(user_id) if user_id else None
        display_name = (
            str(step.get("display_name") or "")
            or (known.display_name if known else "")
            or "that person"
        )
        result = await settle_request_review(
            self.ctx, request_id=request_id, user_id=user_id, display_name=display_name
        )
        result = result.model_copy(
            update={
                "review_reported": frame.status,
                "review_payload": {
                    k: v for k, v in dict(frame.payload or {}).items() if k in {"outcome", "reason"}
                },
            }
        )
        spec = step.get("spec")
        if isinstance(spec, ToolSpec) and result.status == "accepted":
            result.ui_refresh = sorted(set(result.ui_refresh) | set(spec.ui_refresh))
        pending = step.get("pending")
        outcome = ToolCallOutcome(
            result=result,
            spec=spec if isinstance(spec, ToolSpec) else None,
            pending=pending if isinstance(pending, PendingAction) else None,
        )
        # A review that reached a real decision is a settled result even when
        # the decision was "no": only an open or unreadable request is not.
        ok = result.status in {"accepted", "declined", "withdrawn"}
        await self._after_execution(
            outcome,
            source="review",
            ok=ok,
            call_id=str(step.get("call_id") or "") or None,
            origin_turn_id=str(step.get("origin_turn_id") or "") or None,
        )
        if ok and not self._origin_is_stale(str(step.get("origin_turn_id") or "") or None):
            self.turn.ok_results += 1
            self._last_turn_ok = True

    async def _verify_grants_published(self, grant_ids: list[str]) -> dict[str, Any]:
        """Server-side check that each grant now has a first envelope."""
        try:
            from hushh_mcp.services.one_location_agent_service import OneLocationAgentService

            service = self.ctx.service("location", OneLocationAgentService)
            state = await asyncio.to_thread(service.list_state, self.ctx.user_id)
        except Exception:  # noqa: BLE001 - verification unavailable is not success
            return {"status": "unverified", "published": [], "unpublished": grant_ids}
        owner_grants = {str(g.get("id")): g for g in (state.get("ownerGrants") or [])}
        published = [gid for gid in grant_ids if owner_grants.get(gid, {}).get("latestEnvelopeId")]
        unpublished = [gid for gid in grant_ids if gid not in published]
        status = (
            "published"
            if published and not unpublished
            else ("partial" if published else "not_published")
        )
        return {"status": status, "published": published, "unpublished": unpublished}

    # -- provider → client ---------------------------------------------------

    async def _pump_live(self) -> None:
        events: AsyncIterator[LiveEvent] = self.live.events()
        async for event in events:
            if self._closed:
                break
            try:
                await self._handle_live_event(event)
            except _STORAGE_ERRORS as exc:
                self._storage_failed("event", exc)
        if not self._closed:
            await self._close(protocol.CLOSE_PROVIDER_UNAVAILABLE, "provider_closed")
            raise SessionClosed(protocol.CLOSE_PROVIDER_UNAVAILABLE, "provider_closed")

    async def _handle_live_event(self, event: LiveEvent) -> None:
        kind = event.kind
        if kind == "activity_start":
            self._provider_activity_end_at = None
            self._provider_activity_source = None
            self._provider_activity_started = True
        elif kind == "activity_end":
            # Accept an end only for an observed start or an active transcript
            # segment. A late end from the previous utterance must not be
            # assigned to the next person's input.
            if event.activity_source in {"voice_activity", "vad_signal"} and (
                self._provider_activity_started
                or self._input_segment_id is not None
                or event.same_message_input_transcript
            ):
                self._provider_activity_end_at = self.clock()
                self._provider_activity_source = event.activity_source
        elif kind == "audio" and event.audio_b64:
            self._touch()
            self.turn.live_spoke = True
            if self.turn.turn_id in self._superseded_turn_ids:
                self.turn.muted_chunks += 1
                return
            # Live has answered, even when a narration owns what the person hears.
            self._reply_owed = False
            if self._narration_owns_response:
                return
            self.turn.input_seen = True
            if self.turn.audio_chunks == 0:
                perf = self._perf_for_turn(self.turn.turn_id)
                if perf is not None and perf.first_audio_at is None:
                    perf.first_audio_at = self.clock()
                    self._log_latency("first_audio", perf.transcript_final_at, self.turn.turn_id)
                if self._tool_response_at is not None:
                    self._log_latency("reply_audio", self._tool_response_at)
                    self._tool_response_at = None
                    self._awaiting_first_audio = False
                elif self._awaiting_first_audio:
                    self._awaiting_first_audio = False
                await self._send(protocol.turn("model_start", turn_id=self.turn.turn_id))
                await self._send(
                    protocol.voice_state(self._speaking_state(), turn_id=self.turn.turn_id)
                )
            self.turn.audio_chunks += 1
            self.audio_out_chunks += 1
            await self._send(
                protocol.audio_out(
                    event.audio_b64,
                    turn_id=self.turn.turn_id,
                    origin_turn_id=self.turn.turn_id,
                )
            )
        elif kind == "input_transcript" and event.text:
            self._touch()
            input_turn_id = self._input_segment_id
            if input_turn_id is None:
                input_turn_id = (
                    self.turn.turn_id
                    if not self.turn.input_transcript_completed
                    else uuid.uuid4().hex[:12]
                )
                self._input_segment_id = input_turn_id
                if input_turn_id != self.turn.turn_id:
                    await self._place_new_input(input_turn_id)
            self._latest_input_turn_id = input_turn_id
            self._drop_stale_recoveries()
            self._bind_turn_to_input(input_turn_id, input_turn_id)
            if input_turn_id != self._narration_origin_turn_id:
                self._narration_owns_response = False
                self._narration_origin_turn_id = None
            self.turn.input_seen = True
            await self._send_transcript(
                "input", event.text, finished=bool(event.finished), turn_id=input_turn_id
            )
            if event.finished:
                self.turn.input_transcript_completed = True
                self._input_segment_id = None
                self._mark_input_final(input_turn_id, audio=True)
                await self._send(protocol.voice_state("understanding", turn_id=input_turn_id))
        elif kind == "output_transcript" and event.text:
            self.turn.live_spoke = True
            if self.turn.turn_id in self._superseded_turn_ids:
                return
            self._reply_owed = False
            if self._narration_owns_response:
                return
            self.turn.input_seen = True
            self.turn.output_text.append(event.text)
            await self._send_transcript(
                "output", event.text, finished=bool(event.finished), turn_id=self.turn.turn_id
            )
            if self.turn.output_final_sent:
                self.turn.output_after_final += 1
            elif event.finished:
                self.turn.output_final_sent = True
        elif kind == "interrupted":
            # Live dropped the generation it was speaking, including any reply a
            # tool result was waiting on.
            self._reply_owed = False
            await self._send(protocol.turn("interrupted", turn_id=self.turn.turn_id))
            self._log_muted(self.turn)
            self._log_transcript_shape(self.turn)
            await self._advance_turn()
            await self._send(protocol.voice_state("listening"))
        elif kind == "turn_complete":
            await self._send(protocol.turn("model_end", turn_id=self.turn.turn_id))
            self._log_muted(self.turn)
            self._log_transcript_shape(self.turn)
            self._narration_guard()
            self._bump(provider_turns=1)
            self._count_turn_perf(self.turn.turn_id, "provider_turns")
            self._log_turn_perf(self.turn.turn_id)
            self._last_turn_ok = (
                bool(self.turn.ok_results)
                if self.turn.turn_id not in self._superseded_turn_ids
                else False
            )
            await self._advance_turn()
            await self._send(protocol.voice_state("listening"))
        elif kind == "tool_call":
            self._touch()
            self.turn.input_seen = True
            refused = await self._conflicting_batch_calls(event.function_calls)
            for index, call in enumerate(event.function_calls):
                await self._dispatch_tool_call(call, rejection=refused.get(index))
        elif kind == "tool_cancel":
            pass
        elif kind == "resumption" and event.resumption_handle:
            try:
                await self.conversations.save_resumption_handle(
                    user_id=self.ctx.user_id,
                    conversation_id=self.ctx.conversation_id,
                    handle=event.resumption_handle,
                )
            except ConversationStorageError as exc:
                # This session is unaffected; only a later reconnect would start
                # from an older handle (or none).
                self._storage_failed("resume", exc)
        elif kind == "go_away":
            await self._send(protocol.reconnect_required("go_away"))
            await self._close(protocol.CLOSE_ENDED, "go_away")
            raise SessionClosed(protocol.CLOSE_ENDED, "go_away")

    def _speaking_state(self) -> Literal["asking", "confirming", "complete"]:
        if self.pending_receipts:
            return "confirming"
        # The provider ends the tool-call turn before it speaks about the result,
        # so a spoken turn with no calls of its own inherits the previous turn's
        # outcome: speech right after a successful tool reads as "complete".
        if self.turn.ok_results or (not self.turn.tool_calls and self._last_turn_ok):
            return "complete"
        return "asking"

    async def _place_new_input(self, input_turn_id: str) -> None:
        """Start a spoken input that cannot reuse the current turn's id.

        Live events carry no turn id: the next thing Live says is attributed to
        ``self.turn``. When Live has finished, owes nothing and has said nothing
        since, that next thing answers this input, so the input becomes the turn
        now. Otherwise -- Live is still speaking (a barge-in), still owes a
        reply to a tool result or an app event, or other input is waiting -- the
        input waits for Live's next boundary, as it always has, and whatever
        still lands in the fenced turn is never shown as this input's answer.
        """
        fenced = self.turn
        if self._pending_voice_turn_id:
            mode = "park_pending"
        elif self._queued_texts:
            mode = "park_queued"
        elif not fenced.model_only or fenced.live_spoke or fenced.tool_calls:
            mode = "park_busy"
        elif self._reply_owed:
            mode = "park_owed"
        else:
            mode = "adopt"
        self._log_input_placement(input_turn_id, mode)
        if mode == "adopt":
            # Not added to the superseded set: no further Live output can land in
            # it, and _origin_is_stale already treats it as stale because it is
            # bound to an older input than this one.
            self.turn = TurnState(turn_id=input_turn_id, input_seen=True)
            return
        self._superseded_turn_ids.add(fenced.turn_id)
        self._pending_voice_turn_id = input_turn_id

    def _log_input_placement(self, input_turn_id: str, mode: str) -> None:
        logger.info(
            "one_voice.turn_input session=%s turn=%s mode=%s",
            self.session_id,
            input_turn_id,
            mode,
        )

    def _log_muted(self, turn: TurnState) -> None:
        """Count Live output a fence dropped, so a muted answer is visible."""
        if turn.muted_chunks:
            logger.info(
                "one_voice.turn_muted session=%s turn=%s chunks=%d",
                self.session_id,
                turn.turn_id,
                turn.muted_chunks,
            )

    def _log_transcript_shape(self, turn: TurnState) -> None:
        """Count output transcript chunks that followed the turn's own final."""
        if turn.output_after_final:
            logger.info(
                "one_voice.transcript_shape after_final=%d session=%s turn=%s",
                turn.output_after_final,
                self.session_id,
                turn.turn_id,
            )

    def _end_transcript_segment(self, role: Literal["input", "output"]) -> None:
        """Close the open line for ``role`` and log its chunk shape, once.

        Counts only: chunks before the finish, finished chunks, chunks equal to
        the previous one, chunks that extended the line before the finish, and
        finished chunks that restated or extended it.
        """
        segment = self._transcript_segments.pop(role, None)
        if segment is None:
            return
        logger.info(
            "one_voice.transcript_shape role=%s partial=%d final=%d repeat=%d extended=%d"
            " restated=%d session=%s turn=%s",
            role,
            segment.partial,
            segment.final,
            segment.repeat,
            segment.extended,
            segment.restated,
            self.session_id,
            segment.turn_id,
        )

    def _log_unprompted_tool(self, spec: ToolSpec | None, origin_turn_id: str) -> None:
        """Record a confirm-tier call from a provider turn with no input of its own.

        Structural only: a model-only continuation that the relay attributes to
        an earlier input. A continuation that follows a tool response or an
        injected event is Live answering what it was handed, so it is counted as
        chained; only one that followed nothing is unprompted. The call still
        runs exactly as the model asked.
        """
        if spec is None or not spec.policy.needs_confirmation or not self.turn.model_only:
            return
        if self._turn_input_origins.get(origin_turn_id) == origin_turn_id:
            return
        opened_after = self.turn.opened_after
        if opened_after == "none":
            self._bump(unprompted=1)
        else:
            self._bump(chained=1)
        logger.info(
            "one_voice.tool.no_input tool=%s after=%s session=%s turn=%s",
            spec.name[:80],
            opened_after,
            self.session_id,
            origin_turn_id,
        )

    async def _held_card(
        self, spec: ToolSpec | None, origin_turn_id: str, *, name: str = ""
    ) -> PendingAction | ToolCallOutcome | None:
        """The waiting card a proposal Live made on its own must leave alone.

        UAT 2026-10-06: 14.5 s after a card was read back, with no input
        transcript, Live proposed again with different arguments and replaced
        the card the person was about to answer. Structural, never lexical:
        a confirm-tier call in a continuation with no input of its own (bound
        to an earlier input, with none newer and none in progress) that Live
        opened owing nothing -- no tool result or app event waiting for its
        reply -- while a card already presented waits for the person. A call
        that follows a held answer, with nothing real handed to Live since, is
        held the same way. A tool result (even one Live said a word about
        first), an app event, or anything the person says lets the call run
        as the model asked. Arguments are never read. A confirm or cancel of
        the waiting card made the same way is held too: only the person
        answers a card. The one exception is the person's own yes: when their
        confirm was refused as card_not_shown and the client then reported
        that card shown, Live's next confirm of that card runs while their
        yes is still the latest input (see ``_shown_recoveries``).

        Returns the card to hold the call on, or None to let it run. When the
        open cards cannot be read, a card answer gets a fail-closed outcome
        instead, which the relay answers without running the call.
        """
        proposes = spec is not None and spec.policy.needs_confirmation
        if not (proposes or name in _CARD_ANSWER_TOOLS) or not self.turn.model_only:
            return None
        input_turn_id = self._turn_input_origins.get(origin_turn_id)
        if input_turn_id is None or input_turn_id == origin_turn_id:
            return None
        if self._origin_is_stale(origin_turn_id) or self._input_segment_id is not None:
            # The person has spoken since, or is speaking: the call runs as
            # asked, and the stale branch answers it if newer input owns it.
            return None
        follows_hold = self._hold_chain and self._hold_streak[0] == input_turn_id
        if not follows_hold and (self._reply_owed or self.turn.opened_after != "none"):
            return None
        try:
            open_rows = await self.pending.list_open(
                user_id=self.ctx.user_id, conversation_id=self.ctx.conversation_id
            )
        except PendingActionStorageError as exc:
            # Unreadable is not "nothing waiting". A proposal is left to the
            # executor, which reads the same rows and fails closed. A card
            # answer is not: the executor confirms or cancels by id without
            # that read, so storage back a moment later would let a yes or
            # cancel made in silence through. It is answered here instead,
            # with nothing changed and the card left as it is, and the relay
            # treats that answer as a held one (see _dispatch_tool_call_inner).
            self._storage_failed("hold", exc)
            if name not in _CARD_ANSWER_TOOLS:
                return None
            # No spoken facts, since the person asked for nothing; only a note
            # for Live, as on a held answer.
            return ToolCallOutcome(
                result=Rejected(reason_code=STORAGE_UNAVAILABLE, spoken_facts=[]).model_copy(
                    update={
                        "note": (
                            "Nothing was changed. The waiting card is the person's to answer. "
                            "Wait for them to answer it."
                        )
                    }
                )
            )
        other: PendingAction | None = None
        for row in open_rows:
            open_spec = registry.get_tool(row.tool_name)
            if open_spec is None:
                # Nothing could confirm it any more; it waits for nobody.
                continue
            if spec is not None and open_spec.correction_key == spec.correction_key:
                return row
            other = other or row
        if (
            other is not None
            and name == "confirm_pending_action"
            and self._spend_recovery(other.id, origin_turn_id)
        ):
            return None
        return other

    def _spend_recovery(self, card_id: str, origin_turn_id: str) -> bool:
        """Whether a confirm of the waiting card answers the person's refused yes.

        True once, while the input whose yes was refused is still the latest;
        that use spends the record. Logged without the card or any words.
        """
        refused_input = self._shown_recoveries.get(card_id)
        if refused_input is None or refused_input != self._latest_input_turn_id:
            return False
        del self._shown_recoveries[card_id]
        self._bump(hold_recovered=1)
        logger.info(
            "one_voice.tool.recovered tool=confirm_pending_action after=%s session=%s turn=%s",
            self.turn.opened_after,
            self.session_id,
            origin_turn_id,
        )
        return True

    async def _answer_held(
        self,
        card: PendingAction,
        *,
        name: str,
        call_id: Any,
        origin_turn_id: str,
    ) -> None:
        """Answer a held proposal without running it.

        The executor never sees the call: no row is written and the waiting
        card is not cancelled, replaced or sent again. The model gets that card
        back as confirmation_waiting with nothing to say; the client gets a
        not-ok result and stays on the card. Recorded as ``held``, so a skipped
        call is never mistaken for one the executor answered.
        """
        self._bump(held=1)
        logger.info(
            "one_voice.tool.held tool=%s after=%s session=%s turn=%s",
            name[:80],
            self.turn.opened_after,
            self.session_id,
            origin_turn_id,
        )
        if self._origin_is_stale(origin_turn_id):
            # A question arrived while the cards were read: answered exactly
            # as the stale branch answers any call, and the card left alone.
            await self.live.send_tool_response(
                call_id=call_id,
                name=name,
                response={
                    "status": "superseded",
                    "reason_code": "newer_question",
                    "spoken_facts": [],
                },
            )
            return
        count = self._count_hold(origin_turn_id)
        waiting: dict[str, Any] = {
            "pending_action_id": card.id,
            "tier": card.tier,
            "summary": card.summary,
            "card_shown": card.shown_at is not None,
        }
        if count >= _HOLD_NOTE_FROM:
            # Not a spoken fact: Live keeps proposing while the person is silent.
            waiting["note"] = (
                "This proposal is already waiting for the person's answer. "
                "Wait for them to answer it."
            )
        result = ToolResult(
            status=CONFIRMATION_WAITING,
            needs="confirmation",
            reason_code="awaiting_answer",
            spoken_facts=[],
        ).model_copy(update=waiting)
        self.turn.not_ok_results += 1
        await self._send(
            protocol.tool_result(
                call_id=str(call_id or "") or None,
                tool=name,
                result_public=result.public(),
                turn_id=origin_turn_id,
            )
        )
        await self._send(protocol.voice_state("confirming", turn_id=self.turn.turn_id))
        await self.live.send_tool_response(
            call_id=call_id, name=name, response=result.model_public()
        )
        # Live owes this answer a reply like any other, so input that arrives
        # first waits as usual; that reply answers a held call, nothing real.
        self._reply_owed = True
        self._reply_owed_to = "tool"
        self._hold_chain = True

    def _count_hold(self, origin_turn_id: str) -> int:
        """Count a held answer against the input its call followed.

        New input restarts the count. Returns the holds in a row so far.
        """
        input_turn_id = self._turn_input_origins.get(origin_turn_id)
        streak_input, count = self._hold_streak
        count = count + 1 if streak_input == input_turn_id else 1
        self._hold_streak = (input_turn_id, count)
        return count

    async def _advance_turn(self) -> None:
        # The client freezes a turn's answer line at model_end/interrupted, so
        # whatever Live says next is a new transcript line, even the same words.
        self._end_transcript_segment("output")
        self._finished_transcripts.clear()
        finished = self.turn
        finished_id = finished.turn_id
        input_origin = self._turn_input_origins.get(finished_id)
        self._superseded_turn_ids.discard(finished_id)
        # Read before the owed reply is cleared below: what the next
        # continuation, if there is one, is answering.
        opened_after: OpenedAfter = (
            "tool" if finished.tool_calls else (self._reply_owed_to if self._reply_owed else "none")
        )
        if finished.model_only and not finished.tool_calls:
            # Live closed a turn of its own without calling a tool, so a reply
            # still owed did not come in it. Holding the next input any longer
            # would mute that input's own answer.
            self._reply_owed = False
        # Voice was already streamed to Live. Finish or fence that turn before
        # forwarding any typed question, otherwise its answer is mislabeled as
        # the typed question's answer.
        if self._pending_voice_turn_id:
            self.turn = TurnState(turn_id=self._pending_voice_turn_id, input_seen=True)
            self._bind_turn_to_input(self.turn.turn_id, self.turn.turn_id)
            self._pending_voice_turn_id = None
            if self._queued_texts:
                self._superseded_turn_ids.add(self.turn.turn_id)
        elif self._queued_texts:
            turn_id, text, _queued_at = self._queued_texts.popleft()
            self.turn = TurnState(turn_id=turn_id, input_seen=True)
            self._bind_turn_to_input(turn_id, turn_id)
            if self._queued_texts:
                self._superseded_turn_ids.add(turn_id)
            self._narration_owns_response = False
            self._narration_origin_turn_id = None
            self._mark_input_final(turn_id)
            await self.live.send_text(text)
        else:
            # No user input arrived during the provider turn. A later spoken
            # transcript belongs to a new input segment, even though this
            # model-only continuation has a fresh display turn ID.
            self.turn = TurnState(
                input_transcript_completed=input_origin is not None,
                model_only=True,
                opened_after=opened_after,
            )
            if input_origin is not None:
                self._bind_turn_to_input(self.turn.turn_id, input_origin)

    def _narration_guard(self) -> None:
        """Structural, not lexical: a turn that attempted a mutation which was
        rejected or left pending, and produced no successful result, is
        recorded. Nothing is muted or rewritten (AGENTS.md:109)."""
        if (
            self.turn.tool_calls
            and self.turn.not_ok_results
            and not self.turn.ok_results
            and self.turn.output_text
        ):
            self._bump(narration_without_receipt=1)
            logger.info("one_voice.narration_without_receipt session=%s", self.session_id)

    async def _conflicting_batch_calls(self, calls: list[dict[str, Any]]) -> dict[int, Rejected]:
        """Refuse contradictory controls before any call can consume approval.

        This compares declared tools and pending identities, never utterances.
        Independent reads and a confirmation followed by a different action
        keep their existing behavior.
        """

        def pending_identity(value: Any) -> str:
            text = str(value or "").strip()
            try:
                return str(uuid.UUID(text))
            except ValueError:
                return text

        confirms = {
            index: pending_identity((call.get("args") or {}).get("pending_action_id"))
            for index, call in enumerate(calls)
            if call.get("name") == "confirm_pending_action"
        }
        if not confirms or len(calls) < 2:
            return {}
        try:
            rows = await self.pending.list_open(
                user_id=self.ctx.user_id, conversation_id=self.ctx.conversation_id
            )
        except PendingActionStorageError:
            self._conflicted_confirmation_input = self._turn_input_origins.get(
                self.turn.turn_id, self.turn.turn_id
            )
            # No action in an unchecked batch may use an approval. Reads may
            # still run through their own normal authority checks.
            return {
                index: Rejected(
                    reason_code=STORAGE_UNAVAILABLE,
                    spoken_facts=["I couldn't check that confirmation. Please try again."],
                )
                for index in confirms
            }
        by_id = {pending_identity(row.id): row for row in rows}
        conflicts: set[int] = set()
        for index, pending_id in confirms.items():
            row = by_id.get(pending_id)
            current = registry.get_tool(row.tool_name) if row else None
            if current is None:
                continue
            for other_index, call in enumerate(calls):
                if other_index == index:
                    continue
                name = str(call.get("name") or "")
                spec = registry.get_tool(name)
                lookup = LOOKUP_TOOLS.get(name)
                cancels = (
                    name == "cancel_pending_action"
                    and pending_identity((call.get("args") or {}).get("pending_action_id"))
                    == pending_id
                )
                corrects = (
                    spec is not None
                    and spec.policy.needs_confirmation
                    and (spec.correction_key == current.correction_key or spec.preempts_pending)
                )
                if cancels or corrects or (lookup and current.stale_on_lookup(lookup)):
                    conflicts.update((index, other_index))
        if conflicts:
            self._conflicted_confirmation_input = self._turn_input_origins.get(
                self.turn.turn_id, self.turn.turn_id
            )
            logger.info("one_voice.tool.batch_conflict count=%d", len(conflicts))
        return {
            index: Rejected(
                reason_code="conflicting_confirmation",
                spoken_facts=[
                    "That answer both approved and changed the waiting action. "
                    "Nothing in that action ran. Ask whether to change it or go ahead."
                ],
            )
            for index in conflicts
        }

    async def _dispatch_tool_call(
        self, call: dict[str, Any], *, rejection: Rejected | None = None
    ) -> None:
        name = str(call.get("name") or "")
        call_id = call.get("id")
        args = dict(call.get("args") or {})
        origin_turn_id = self.turn.turn_id
        dispatch_started = self.clock()
        logger.info(
            "one_voice.tool.selected session=%s turn=%s call=%s tool=%s",
            self.session_id,
            origin_turn_id,
            str(call_id or "")[:64],
            name[:80],
        )
        if self._awaiting_first_tool:
            perf = self._perf_for_turn(origin_turn_id)
            if perf is not None and perf.first_tool_at is None:
                perf.first_tool_at = dispatch_started
            self._log_latency(
                "first_tool",
                perf.transcript_final_at if perf is not None else self._input_final_at,
                origin_turn_id,
            )
            self._awaiting_first_tool = False
        try:
            await self._dispatch_tool_call_inner(
                name=name,
                call_id=call_id,
                args=args,
                origin_turn_id=origin_turn_id,
                rejection=rejection,
            )
        finally:
            self._tool_response_at = self.clock()
            perf = self._perf_for_turn(origin_turn_id)
            if perf is not None:
                perf.tool_response_at = self._tool_response_at
            logger.info(
                "one_voice.latency session=%s turn=%s phase=tool tool=%s ms=%d",
                self.session_id,
                origin_turn_id,
                name[:80],
                int((self._tool_response_at - dispatch_started) * 1000),
            )

    async def _dispatch_tool_call_inner(
        self,
        *,
        name: str,
        call_id: Any,
        args: dict[str, Any],
        origin_turn_id: str,
        rejection: Rejected | None = None,
    ) -> None:
        self.turn.tool_calls += 1
        self._bump(tool_calls=1)
        self._count_turn_perf(origin_turn_id, "tool_calls")
        spec = registry.get_tool(name)
        self._log_unprompted_tool(spec, origin_turn_id)
        if (
            rejection is None
            and name == "confirm_pending_action"
            and self._conflicted_confirmation_input
            == (self._turn_input_origins.get(origin_turn_id, origin_turn_id))
        ):
            # An unrelated read/tool response cannot turn an ambiguous answer
            # into consent. A new owner input is required, including for a
            # same-turn retry or a replacement review created in that turn.
            rejection = Rejected(
                reason_code="conflicting_confirmation",
                spoken_facts=["Ask for a fresh confirmation after clarifying the change."],
            )
        await self._send(
            protocol.tool_started(
                call_id=str(call_id or ""),
                tool=name,
                args_public=_public_args(
                    args,
                    hidden_fields=spec.private_args if spec is not None else (),
                ),
                turn_id=origin_turn_id,
            )
        )
        held = (
            ToolCallOutcome(result=rejection, spec=spec)
            if rejection is not None
            else await self._held_card(spec, origin_turn_id, name=name)
        )
        if isinstance(held, PendingAction):
            await self._answer_held(held, name=name, call_id=call_id, origin_turn_id=origin_turn_id)
            return
        # The hold's fail-closed answer to a card answer it could not check
        # never ran the call: like a held answer, it hands Live nothing real,
        # so Live's retry is checked again. Anything else this call returns
        # is something real for Live to answer.
        fail_closed = held is not None
        if not fail_closed:
            self._hold_chain = False
        await self._send(protocol.voice_state("executing", turn_id=self.turn.turn_id))
        outcome = (
            held
            if held is not None
            else await self.executor.call(self.ctx, name, args, origin_turn_id=origin_turn_id)
        )
        if outcome.timings:
            # Executor phases only (store reads, prepare, handler), as short
            # key=ms pairs; the result status is bounded vocabulary.
            logger.info(
                "one_voice.latency session=%s turn=%s phase=exec status=%s steps=%s",
                self.session_id,
                origin_turn_id,
                str(outcome.result.status)[:40],
                ",".join(f"{key}:{value}" for key, value in sorted(outcome.timings.items())),
            )
        public = outcome.result.public()
        if (
            name == "confirm_pending_action"
            and outcome.pending is not None
            and outcome.pending.confirmation_source == "voice"
            and outcome.pending.status in {"executed", "failed"}
        ):
            self._bump(confirmations_completed=1)
        if (
            name == "cancel_pending_action"
            and outcome.result.status == "cancelled"
            and outcome.pending is not None
        ):
            # The model withdrew a card: the same confirmation_cancelled count
            # a tap cancel or a superseding proposal records.
            self._bump(pending_cancelled=1)
            self._count_turn_perf(
                self._pending_turn_ids.get(outcome.pending.id) or outcome.pending.origin_turn_id,
                "pending_cancelled",
            )
        if outcome.result.status == "rejected" and outcome.result.reason_code == "unknown_tool":
            self._bump(unknown_tool_calls=1)
        if outcome.result.status == "card_not_shown":
            waiting_id = public.get("pending_action_id")
            if isinstance(waiting_id, str) and waiting_id:
                self._bump(confirm_not_shown=1)
                if len(self._shown_waiters) >= _SHOWN_WAITERS_MAX:
                    self._shown_waiters.pop(next(iter(self._shown_waiters)))
                self._shown_waiters[waiting_id] = origin_turn_id
        for stale in outcome.superseded:
            # A card the client is still showing no longer means anything: a
            # newer proposal replaced it, or a fresh lookup made its target
            # stale. Say so to both sides rather than letting it expire quietly.
            stale_turn_id = self._pending_turn_ids.get(stale.id) or stale.origin_turn_id
            self.pending_receipts.pop(stale.id, None)
            self._pending_turn_ids.pop(stale.id, None)
            await self._send(
                protocol.pending_resolved(
                    pending_action_id=stale.id, status="cancelled", result_public=None
                )
            )
            self._bump(pending_cancelled=1)
            self._count_turn_perf(stale_turn_id, "pending_cancelled")
        if outcome.superseded:
            public = dict(public, superseded_pending_action_ids=[s.id for s in outcome.superseded])
        if self._origin_is_stale(origin_turn_id):
            # A newer question arrived while this call was running. Never leave
            # an unseen confirmation in storage for session.ready to resurrect.
            if outcome.pending is not None and outcome.result.status == "confirmation_required":
                try:
                    cancelled = await self.pending.cancel(
                        user_id=self.ctx.user_id,
                        pending_action_id=outcome.pending.id,
                    )
                except PendingActionStorageError as exc:
                    # Never shown and never confirmable by voice (no shown
                    # mark); it expires on its own. The model still gets its
                    # answer below.
                    self._storage_failed("cancel", exc)
                    cancelled = None
                if cancelled is not None:
                    self._bump(pending_cancelled=1)
                    self._count_turn_perf(origin_turn_id, "pending_cancelled")
            elif outcome.pending is not None and outcome.pending.status in {
                "executed",
                "failed",
                "cancelled",
                "expired",
            }:
                # A confirmation may already have committed while the newer
                # question arrived. Settle the real card without replaying its
                # answer, effects, or model event into that newer turn.
                self.pending_receipts.pop(outcome.pending.id, None)
                self._pending_turn_ids.pop(outcome.pending.id, None)
                await self._send(
                    protocol.pending_resolved(
                        pending_action_id=outcome.pending.id,
                        status=outcome.pending.status,
                        result_public=public,
                    )
                )
                if _confirmed_continuation_id(outcome, public):
                    await self._emit_side_effects(
                        outcome,
                        call_id=str(call_id or "") or None,
                        origin_turn_id=origin_turn_id,
                        client_steps_only=True,
                    )
                await self._persist_entities()
            superseded_result = {"status": "superseded", "reason_code": "newer_question"}
            await self.live.send_tool_response(
                call_id=call_id,
                name=name,
                response={**superseded_result, "spoken_facts": []},
            )
            return
        if outcome.pending is not None and outcome.result.status == "confirmation_required":
            self._pending_turn_ids[outcome.pending.id] = origin_turn_id
            if outcome.receipt_token:
                self.pending_receipts[outcome.pending.id] = outcome.receipt_token
            await self._send(
                protocol.pending_action(
                    row=outcome.pending.public(),
                    receipt_token=outcome.receipt_token,
                    entities=self._entities_for(outcome),
                    risk_level="high" if outcome.pending.tier == "tap" else "medium",
                    turn_id=origin_turn_id,
                )
            )
            await self._send(protocol.voice_state("confirming", turn_id=self.turn.turn_id))
            self._bump(pending_created=1)
            self._count_turn_perf(origin_turn_id, "pending_created")
        elif outcome.pending is not None and outcome.result.status == CONFIRMATION_WAITING:
            # The same proposal is already open: no new row, no side effects.
            # The card now answers this turn, so a tap on it reports here.
            self._pending_turn_ids[outcome.pending.id] = origin_turn_id
            self._bump(pending_reused=1)
            self._count_turn_perf(origin_turn_id, "pending_reused")
            if outcome.pending.shown_at is None:
                # Repair, not a new card: the same row and id, carried on the
                # current turn so the client does not drop it as stale. Voice
                # tier has no receipt to hand out again.
                await self._send(
                    protocol.pending_action(
                        row=outcome.pending.public(),
                        receipt_token=None,
                        entities=self._entities_for(outcome),
                        risk_level="medium",
                        turn_id=origin_turn_id,
                    )
                )
            await self._send(protocol.voice_state("confirming", turn_id=self.turn.turn_id))
        elif outcome.pending is not None and outcome.result.status == PENDING_ACTION_EXISTS:
            # A different card is still waiting and the model is about to ask
            # about it, so a tap on it now answers this turn. Nothing is
            # re-sent: the client already holds that card (and any receipt).
            self._pending_turn_ids[outcome.pending.id] = origin_turn_id
            self._bump(pending_blocked=1)
            await self._send(protocol.voice_state("confirming", turn_id=self.turn.turn_id))
        else:
            if outcome.pending is not None and outcome.pending.status in {
                "executed",
                "failed",
                "cancelled",
                "expired",
            }:
                # A model-confirmed voice action returns the resolved row too.
                # Retire its original card instead of presenting a second one.
                self.pending_receipts.pop(outcome.pending.id, None)
                self._pending_turn_ids.pop(outcome.pending.id, None)
                await self._send(
                    protocol.pending_resolved(
                        pending_action_id=outcome.pending.id,
                        status=outcome.pending.status,
                        result_public=public,
                    )
                )
            await self._emit_side_effects(
                outcome,
                call_id=str(call_id or "") or None,
                origin_turn_id=origin_turn_id,
            )
        ok = outcome.result.status not in _NOT_SUCCESS
        if outcome.pending is None or outcome.pending.status in {
            "executed",
            "failed",
            "cancelled",
            "expired",
        }:
            if outcome.result.status in _AWAITING_DEVICE:
                # Outstanding device step: no receipt yet, not a rejection.
                self.turn.not_ok_results += 1
            elif ok:
                self.turn.ok_results += 1
                self._bump(tool_results_ok=1)
            else:
                self.turn.not_ok_results += 1
                self._bump(tool_results_rejected=1)
        else:
            self.turn.not_ok_results += 1
        # A read_mail result makes its Open button actionable immediately. Save
        # the offered message IDs before publishing that result so a fast tap's
        # HTTP resolver observes the same list the person just saw.
        await self._persist_entities()
        await self._send(
            protocol.tool_result(
                call_id=str(call_id or "") or None,
                tool=name,
                result_public=public,
                turn_id=origin_turn_id,
            )
        )
        # The client frame above carries the full result. The model gets its own
        # projection, which for an external-content read is a receipt rather
        # than the mail itself.
        # Spoken before the model is told anything, so the model cannot start
        # talking over it. A narration IS the answer, so its cost is the model's
        # acknowledgement arriving a few seconds later -- and that acknowledgement
        # is counts-only, so there is little to delay.
        narrated = (
            await self._narrate(outcome.result, origin_turn_id=origin_turn_id)
            if not self._origin_is_stale(origin_turn_id)
            else False
        )
        response = outcome.result.model_public()
        if narrated:
            # The digest has been said. Leaving the count sentence in would have
            # One announce the same turn twice, in two different voices of its own.
            response = {**response, "spoken_facts": []}
        await self.live.send_tool_response(call_id=call_id, name=name, response=response)
        # Live still speaks about this result, possibly in a fresh provider turn;
        # after a narration that is the short acknowledgement the narration holds.
        self._reply_owed = True
        self._reply_owed_to = "tool"
        if fail_closed:
            self._count_hold(origin_turn_id)
            self._hold_chain = True

    async def _narrate(self, result: ToolResult, *, origin_turn_id: str) -> bool:
        """Speak a result's own short digest, if it has one and narration is on.

        The digest never reaches the operational model: it is rendered by a
        separate provider context with no tools and no history, and arrives at the
        client as ordinary audio frames marked `narration`, which close the
        microphone while they play. See ``services.voice_narration``.

        Returns whether anything was spoken. A failure is silent by design -- the
        visible result is already on screen, and the screen and the speaker are
        separate outcomes.
        """
        from hushh_mcp.one_voice.config import voice_mail_narration_enabled

        if not voice_mail_narration_enabled():
            return False
        digest = ""
        try:
            digest = result.narratable_digest()
        except Exception:  # noqa: BLE001 - a tool that cannot say it says nothing
            return False
        if not digest.strip():
            return False
        if self.turn.audio_chunks or self._narration_owns_response:
            # The model is already speaking this turn. A narration would be a
            # second voice over the first, and its unseen turn id would outrank
            # the model's in the player's fence.
            return False

        from hushh_mcp.one_voice.instruction import voice_name
        from hushh_mcp.services.voice_narration import (
            NarrationUnavailable,
            narrate_digest_stream,
        )

        # Its own turn id: the player schedules per turn, and a narration is not
        # part of the model's turn.
        turn_id = uuid.uuid4().hex[:12]
        spoken = False
        try:
            async for chunk in narrate_digest_stream(digest, voice_name=voice_name()):
                if self._origin_is_stale(origin_turn_id):
                    break
                await self._send(
                    protocol.audio_out(
                        base64.b64encode(chunk.audio).decode("ascii"),
                        turn_id=turn_id,
                        narration=True,
                        origin_turn_id=origin_turn_id,
                    )
                )
                spoken = True
                self._narration_owns_response = True
                self._narration_origin_turn_id = origin_turn_id
                self._touch()
        except NarrationUnavailable as exc:
            # Named, not detailed: a provider message can echo the digest.
            logger.info("Narration unavailable: %s", exc.reason)
            return spoken
        return spoken

    async def _emit_side_effects(
        self,
        outcome: ToolCallOutcome,
        *,
        call_id: str | None = None,
        origin_turn_id: str | None = None,
        client_steps_only: bool = False,
    ) -> None:
        """Turn typed result fields into client directives/steps and entity cards."""
        public = outcome.result.public()
        if (
            not client_steps_only
            and public.get("status") == "navigation_dispatched"
            and public.get("gateway_action_id")
        ):
            await self._send(
                protocol.ui_directive(
                    directive_id=self._remember_directive(
                        origin_turn_id,
                        kind="navigate",
                        screen=str(public.get("screen") or "") or None,
                    ),
                    kind="navigate",
                    turn_id=origin_turn_id,
                    payload={
                        "call_id": call_id,
                        "gateway_action_id": public["gateway_action_id"],
                        "screen": public.get("screen"),
                        "circle_id": public.get("circle_id"),
                        "user_id": public.get("user_id"),
                        "public_person_ref": public.get("public_person_ref"),
                    },
                )
            )
        if not client_steps_only and public.get("status") == protocol.MAIL_OPEN_DISPATCHED:
            # The surface opens the row through its own authenticated resolver.
            # Nothing about the message passes through the relay or the model; this
            # carries only which row, from which offer, in which conversation.
            await self._send(
                protocol.ui_directive(
                    directive_id=self._remember_directive(origin_turn_id, kind="open_mail"),
                    kind="open_mail",
                    turn_id=origin_turn_id,
                    payload={
                        "ordinal": public.get("ordinal"),
                        "offer_revision": public.get("offer_revision"),
                        "conversation_id": public.get("conversation_id"),
                    },
                )
            )
        if not client_steps_only and public.get("status") == protocol.DRAFT_OPEN_DISPATCHED:
            # The same binding for a draft row: which row, from which offer, in
            # which conversation. The surface fetches the draft through its own
            # authenticated route; nothing about it passes through here.
            await self._send(
                protocol.ui_directive(
                    directive_id=self._remember_directive(origin_turn_id, kind="open_draft"),
                    kind="open_draft",
                    turn_id=origin_turn_id,
                    payload={
                        "ordinal": public.get("ordinal"),
                        "offer_revision": public.get("offer_revision"),
                        "conversation_id": public.get("conversation_id"),
                    },
                )
            )
        step = public.get("client_step")
        if isinstance(step, dict) and step.get("kind"):
            step_id = uuid.uuid4().hex[:12]
            payload = {k: v for k, v in step.items() if k != "kind"}
            if step["kind"] == "open_mail_draft":
                payload["delivery_ref"] = self._issue_mail_delivery(payload, origin_turn_id)
            timeout_s = int(step.get("timeout_s") or CLIENT_STEP_TIMEOUT_SECONDS)
            requested_at = self.clock()
            self.client_steps[step_id] = {
                "kind": step["kind"],
                "purpose": step.get("purpose"),
                "grant_ids": step.get("grant_ids") or [],
                **payload,
                # Binding for a settled step: the originating tool and call, and
                # a deadline (monotonic) after which a report is stale.
                "tool": outcome.spec.name if outcome.spec else None,
                "spec": outcome.spec,
                "call_id": call_id,
                "origin_turn_id": origin_turn_id,
                # The card this step belongs to, so its settlement can resolve
                # the same card again with the verified outcome.
                "pending": outcome.pending,
                "requested_at": requested_at,
                "expires_at": requested_at + timeout_s + CLIENT_STEP_GRACE_SECONDS,
            }
            await self._send(
                protocol.client_step_request(
                    step_id=step_id,
                    kind=str(step["kind"]),
                    payload=payload,
                    timeout_s=timeout_s,
                    turn_id=origin_turn_id,
                    confirmed_pending_action_id=_confirmed_continuation_id(outcome, public),
                )
            )
        candidates = public.get("candidates")
        if (
            not client_steps_only
            and isinstance(candidates, list)
            and public.get("status")
            in {
                "multiple",
                "single_likely",
                "low_confidence",
                "truncated",
            }
        ):
            # A shown candidate picker is an explicit clarification; do not
            # classify free-form speech or model wording to derive this count.
            self._bump(clarifications=1)
            kind: Literal["person", "circle"] = (
                "circle" if outcome.spec and "circle" in outcome.spec.name else "person"
            )
            await self._send(
                protocol.candidate_picker(
                    kind=kind,
                    turn_id=origin_turn_id,
                    question="Which one do you mean?"
                    if public.get("status") in {"multiple", "truncated"}
                    else "Is this who you mean?",
                    candidates=[c for c in candidates if isinstance(c, dict)][:5],
                )
            )
        if not client_steps_only and public.get("status") == "confirmed" and outcome.spec:
            for card in self._entities_for(outcome):
                card_kind: Literal["person", "circle"] = (
                    "circle" if card.get("kind") == "circle" else "person"
                )
                await self._send(
                    protocol.entity_card(kind=card_kind, payload=card, turn_id=origin_turn_id)
                )

    def _entities_for(self, outcome: ToolCallOutcome) -> list[dict[str, Any]]:
        cards: list[dict[str, Any]] = []
        parsed = outcome.parsed
        spec = outcome.spec
        if parsed is None or spec is None:
            if outcome.result.status == "confirmed":
                last = self.ctx.entities.last_person_user_id
                person = self.ctx.entities.person(last) if last else None
                if person:
                    cards.append({"kind": "person", **person.model_dump(mode="json")})
            return cards
        for arg in spec.person_args:
            # One chip per person named, so a card proposing a group shows the
            # whole group. A card that named only the first of several would ask
            # for consent to something wider than it displayed.
            for ref in arg_refs(getattr(parsed, arg, None)):
                person = self.ctx.entities.person(str(getattr(ref, "user_id", "")))
                if person:
                    cards.append({"kind": "person", **person.model_dump(mode="json")})
        for arg in spec.circle_args:
            ref = getattr(parsed, arg, None)
            circle = self.ctx.entities.circle(str(getattr(ref, "circle_id", ""))) if ref else None
            if circle:
                cards.append({"kind": "circle", **circle.model_dump(mode="json")})
        if outcome.result.status == "confirmed" and not cards:
            if "circle" in spec.name and self.ctx.entities.last_circle_id:
                circle = self.ctx.entities.circle(self.ctx.entities.last_circle_id)
                if circle:
                    cards.append({"kind": "circle", **circle.model_dump(mode="json")})
            elif self.ctx.entities.last_person_user_id:
                person = self.ctx.entities.person(self.ctx.entities.last_person_user_id)
                if person:
                    cards.append({"kind": "person", **person.model_dump(mode="json")})
        return cards

    async def _persist_entities(self) -> None:
        try:
            await self.conversations.save_entity_context(
                user_id=self.ctx.user_id,
                conversation_id=self.ctx.conversation_id,
                context=self.ctx.entities.model_dump(mode="json"),
            )
        except ConversationStorageError as exc:
            # This session keeps the confirmed entities in memory, and a tool
            # result already computed must still reach the model. Only a
            # resumed session (or an HTTP tap resolver) would see older ones.
            self._storage_failed("entities", exc)


def _typed_name_context(ctx: ToolContext) -> ToolContext:
    """A copy of ``ctx`` that marks the proposed name as typed by the person.

    A copy, because the model's own tool calls run concurrently on ``ctx`` and
    must never inherit the mark. It shares ``entities``, so what the prepare
    hook records about the name lands in the conversation as usual.
    """
    return replace(ctx, typed_name=True)


def _public_args(args: dict[str, Any], *, hidden_fields: tuple[str, ...] = ()) -> dict[str, Any]:
    """Arguments are canonical ids and short strings; still bound the size."""
    out: dict[str, Any] = {}
    for key, value in list(args.items())[:12]:
        if key in hidden_fields:
            continue
        if isinstance(value, (str, int, float, bool)) or value is None:
            out[key] = value if not isinstance(value, str) else value[:120]
        elif isinstance(value, dict):
            out[key] = {
                k: (v[:120] if isinstance(v, str) else v) for k, v in list(value.items())[:8]
            }
        elif isinstance(value, list):
            # A batch argument is a bounded list of refs. Rendering it as the word
            # "list" would make the one frame that records what was asked for
            # useless on exactly the calls that affect several people.
            out[key] = [
                (
                    {k: (v[:120] if isinstance(v, str) else v) for k, v in list(item.items())[:8]}
                    if isinstance(item, dict)
                    else (item[:120] if isinstance(item, str) else item)
                )
                for item in value[:20]
            ]
        else:
            out[key] = str(type(value).__name__)
    return out


def b64_len_bytes(data_b64: str) -> int:
    return len(base64.b64decode(data_b64, validate=False)) if data_b64 else 0
