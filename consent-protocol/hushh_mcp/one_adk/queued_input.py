"""Messages a person sends while One is still working on their turn.

The person can keep typing while a turn runs. A queued message joins the live
turn at its next model step (after a tool or agent step returns), so One takes
it into account without starting over. Anything the turn cannot take goes back
to the client, which sends it as the next turn.

Contract:

* **Owner-bound.** Every inbox is keyed by the authenticated owner and the
  conversation. Nothing is readable or writable across owners.
* **Exactly once.** Each message carries a client message id. A repeated enqueue
  returns the id's recorded outcome and never queues it twice, so a retried or
  reconnecting client cannot duplicate a message.
* **In order.** An inbox is FIFO; a drain delivers everything waiting, in order.
* **Safe boundary only.** Draining happens in the root agent's last
  ``before_model_callback``, which runs only when a real model call follows.
  That is between steps, never inside a tool or a streamed answer.
* **Where it is refused, it is next-turn.** A run that answers a consent
  continuation, opens a feed item, resumes a confirmation, or has read external
  content (the post-read authority barrier) never takes queued input: the
  message returns to the client and starts a fresh turn, which gets fresh
  admission. A queued message never inherits the original message's
  authorizations (selected-file export or share), which are decided once, at
  ingress, from that message alone.
* **Sealed or dropped.** Queued text lives in process memory only until it is
  delivered, at which point it is appended to the session through the session
  service, which seals it with the owner's chat key. A returned or withdrawn
  message is dropped. Text is never logged; only counts are.

The inbox is process memory. An enqueue that reaches an instance which is not
running this conversation's turn finds no inbox and is returned, so the client
falls back to next-turn delivery. Nothing is lost or duplicated; the message
simply does not join the live turn.
"""

from __future__ import annotations

import contextlib
import contextvars
import logging
import re
import threading
import time
from collections import OrderedDict
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any, Literal

from google.adk.events import Event
from google.adk.models.llm_response import LlmResponse
from google.genai import types

logger = logging.getLogger(__name__)

QUEUED_INPUT_EVENT = "hussh.queued_input"
QUEUED_INPUT_KIND = "queued_input_v1"
STOPPED_ANSWER = "Stopped."

MAX_PENDING_PER_RUN = 5
MAX_TEXT_CHARS = 4000
OUTCOME_TTL_SECONDS = 15 * 60
MAX_OUTCOMES_PER_CONVERSATION = 64
# Longer than any run can hold a chat key (``chat_key.MAX_BINDING_SECONDS``).
# An inbox this old belongs to a run that died before it could settle.
MAX_RUN_SECONDS = 600
MAX_SETTLED_RUNS = 256
_CLIENT_ID = re.compile(r"^[A-Za-z0-9_-]{8,64}$")

Status = Literal["queued", "delivered", "returned", "withdrawn", "unknown"]


class QueuedInputError(ValueError):
    """The request itself is malformed; nothing was recorded."""


@dataclass(frozen=True)
class Receipt:
    client_message_id: str
    status: Status


@dataclass(frozen=True)
class Settlement:
    """Where every message queued against one run ended up."""

    delivered: tuple[str, ...] = ()
    returned: tuple[str, ...] = ()


@dataclass
class _Item:
    client_message_id: str
    text: str


@dataclass
class _Inbox:
    run_id: str
    accepting: bool
    opened_at: float
    pending: list[_Item] = field(default_factory=list)
    inflight: list[_Item] = field(default_factory=list)
    delivered: list[str] = field(default_factory=list)
    returned: list[str] = field(default_factory=list)
    unannounced: list[str] = field(default_factory=list)
    stop_requested: bool = False


@dataclass
class _Outcome:
    status: Status
    at: float


_Key = tuple[str, str]


class QueuedInputRegistry:
    """Per-conversation inboxes for the runs executing in this process."""

    def __init__(self, *, clock: Any = time.monotonic) -> None:
        self._lock = threading.Lock()
        self._clock = clock
        # Opened in run order. More than one run can be open for a conversation
        # while a stopped run finishes and the next one waits behind it.
        self._inboxes: dict[_Key, list[_Inbox]] = {}
        self._outcomes: dict[_Key, OrderedDict[str, _Outcome]] = {}
        # A run is closed twice: by the stream when it sees the terminal event
        # and by the background run when it ends. Either may be first, so the
        # first close keeps its settlement for the second, which takes it.
        self._settled: OrderedDict[tuple[_Key, str], Settlement] = OrderedDict()

    # ── run lifecycle ────────────────────────────────────────────────────────
    def open_run(
        self, owner_id: str, conversation_id: str, run_id: str, *, accepting: bool
    ) -> None:
        key = (owner_id, conversation_id)
        with self._lock:
            runs = self._inboxes.setdefault(key, [])
            if any(inbox.run_id == run_id for inbox in runs):
                return
            runs.append(_Inbox(run_id=run_id, accepting=accepting, opened_at=self._clock()))

    def close_run(self, owner_id: str, conversation_id: str, run_id: str) -> Settlement:
        """Settle a run, deferring final closure while a session append is in flight."""
        key = (owner_id, conversation_id)
        with self._lock:
            runs = self._inboxes.get(key, [])
            inbox = next((item for item in runs if item.run_id == run_id), None)
            if inbox is None:
                return self._settled.pop((key, run_id), Settlement())
            if inbox.inflight:
                # A disconnected stream can close before the background model
                # callback finishes saving a drained message. Leave that
                # outcome pending until the append resolves and the background
                # close records the final settlement.
                inbox.accepting = False
                for item in inbox.pending:
                    inbox.returned.append(item.client_message_id)
                    self._record(key, item.client_message_id, "returned")
                inbox.pending.clear()
                return Settlement(delivered=tuple(inbox.delivered), returned=tuple(inbox.returned))
            runs.remove(inbox)
            if not runs:
                self._inboxes.pop(key, None)
            for item in [*inbox.inflight, *inbox.pending]:
                inbox.returned.append(item.client_message_id)
                self._record(key, item.client_message_id, "returned")
            inbox.pending.clear()
            inbox.inflight.clear()
            settlement = Settlement(
                delivered=tuple(inbox.delivered), returned=tuple(inbox.returned)
            )
            self._settled[(key, run_id)] = settlement
            while len(self._settled) > MAX_SETTLED_RUNS:
                self._settled.popitem(last=False)
            return settlement

    # ── person-facing operations ─────────────────────────────────────────────
    def enqueue(
        self, owner_id: str, conversation_id: str, client_message_id: str, text: str
    ) -> Receipt:
        _require_client_id(client_message_id)
        clean = text.strip() if isinstance(text, str) else ""
        if not clean or len(clean) > MAX_TEXT_CHARS:
            raise QueuedInputError("Queued message must be 1 to 4000 characters.")
        key = (owner_id, conversation_id)
        with self._lock:
            known = self._outcome(key, client_message_id)
            if known is not None:
                return Receipt(client_message_id, known)
            self._close_abandoned(key)
            runs = self._inboxes.get(key) or []
            inbox = runs[-1] if runs else None
            if (
                inbox is None
                or not inbox.accepting
                or inbox.stop_requested
                or len(inbox.pending) >= MAX_PENDING_PER_RUN
            ):
                # Recorded, so a retry of the same id can never join a later run
                # after the client has already sent it as the next turn.
                self._record(key, client_message_id, "returned")
                return Receipt(client_message_id, "returned")
            inbox.pending.append(_Item(client_message_id, clean))
            self._record(key, client_message_id, "queued")
            return Receipt(client_message_id, "queued")

    def withdraw(self, owner_id: str, conversation_id: str, client_message_id: str) -> Receipt:
        _require_client_id(client_message_id)
        key = (owner_id, conversation_id)
        with self._lock:
            for inbox in self._inboxes.get(key, []):
                for item in inbox.pending:
                    if item.client_message_id == client_message_id:
                        inbox.pending.remove(item)
                        self._record(key, client_message_id, "withdrawn")
                        return Receipt(client_message_id, "withdrawn")
            known = self._outcome(key, client_message_id)
            if known is None:
                # Never seen: record it so a late enqueue of the same id is refused.
                self._record(key, client_message_id, "withdrawn")
                return Receipt(client_message_id, "withdrawn")
            return Receipt(client_message_id, known)

    def status(
        self, owner_id: str, conversation_id: str, client_message_ids: list[str]
    ) -> list[Receipt]:
        key = (owner_id, conversation_id)
        receipts: list[Receipt] = []
        with self._lock:
            for client_message_id in client_message_ids:
                _require_client_id(client_message_id)
                receipts.append(
                    Receipt(client_message_id, self._outcome(key, client_message_id) or "unknown")
                )
        return receipts

    def request_stop(self, owner_id: str, conversation_id: str) -> Settlement | None:
        """Ask every open run of the conversation to end at its next step.

        Returns what was still waiting (now returned to the client), or ``None``
        when no run of this conversation is executing in this process.
        """
        key = (owner_id, conversation_id)
        returned: list[str] = []
        with self._lock:
            runs = self._inboxes.get(key) or []
            if not runs:
                return None
            for inbox in runs:
                inbox.stop_requested = True
                for item in inbox.pending:
                    inbox.returned.append(item.client_message_id)
                    returned.append(item.client_message_id)
                    self._record(key, item.client_message_id, "returned")
                inbox.pending.clear()
        return Settlement(returned=tuple(returned))

    # ── run-side operations ──────────────────────────────────────────────────
    def drain(self, owner_id: str, conversation_id: str, run_id: str) -> list[_Item]:
        key = (owner_id, conversation_id)
        with self._lock:
            inbox = self._inbox(key, run_id)
            if inbox is None or not inbox.accepting or inbox.stop_requested or not inbox.pending:
                return []
            items = list(inbox.pending)
            inbox.pending.clear()
            # A drained message is not delivered until the sealed session
            # append succeeds. A failed append must return it to the client.
            inbox.inflight.extend(items)
            return items

    def persisted(self, owner_id: str, conversation_id: str, run_id: str, item: _Item) -> None:
        key = (owner_id, conversation_id)
        with self._lock:
            inbox = self._inbox(key, run_id)
            if inbox is None or item not in inbox.inflight:
                return
            inbox.inflight.remove(item)
            inbox.delivered.append(item.client_message_id)
            inbox.unannounced.append(item.client_message_id)
            self._record(key, item.client_message_id, "delivered")

    def append_failed(self, owner_id: str, conversation_id: str, run_id: str) -> None:
        key = (owner_id, conversation_id)
        with self._lock:
            inbox = self._inbox(key, run_id)
            if inbox is None:
                return
            for item in inbox.inflight:
                inbox.returned.append(item.client_message_id)
                self._record(key, item.client_message_id, "returned")
            inbox.inflight.clear()

    def stop_requested(self, owner_id: str, conversation_id: str, run_id: str) -> bool:
        with self._lock:
            inbox = self._inbox((owner_id, conversation_id), run_id)
            return bool(inbox and inbox.stop_requested)

    def take_announcements(self, owner_id: str, conversation_id: str, run_id: str) -> list[str]:
        """Ids delivered since the last call, for the live stream to report once."""
        with self._lock:
            inbox = self._inbox((owner_id, conversation_id), run_id)
            if inbox is None or not inbox.unannounced:
                return []
            ids = list(inbox.unannounced)
            inbox.unannounced.clear()
            return ids

    # ── internals (lock held) ────────────────────────────────────────────────
    def _close_abandoned(self, key: _Key) -> None:
        runs = self._inboxes.get(key)
        if not runs:
            return
        horizon = self._clock() - MAX_RUN_SECONDS
        for inbox in [item for item in runs if item.opened_at < horizon]:
            runs.remove(inbox)
            for item in [*inbox.pending, *inbox.inflight]:
                self._record(key, item.client_message_id, "returned")
        if not runs:
            self._inboxes.pop(key, None)

    def _inbox(self, key: _Key, run_id: str) -> _Inbox | None:
        return next((item for item in self._inboxes.get(key, []) if item.run_id == run_id), None)

    def _outcome(self, key: _Key, client_message_id: str) -> Status | None:
        outcomes = self._outcomes.get(key)
        if not outcomes:
            return None
        self._expire(key, outcomes)
        outcome = outcomes.get(client_message_id)
        return outcome.status if outcome else None

    def _record(self, key: _Key, client_message_id: str, status: Status) -> None:
        outcomes = self._outcomes.setdefault(key, OrderedDict())
        outcomes[client_message_id] = _Outcome(status=status, at=self._clock())
        outcomes.move_to_end(client_message_id)
        while len(outcomes) > MAX_OUTCOMES_PER_CONVERSATION:
            outcomes.popitem(last=False)

    def _expire(self, key: _Key, outcomes: OrderedDict[str, _Outcome]) -> None:
        horizon = self._clock() - OUTCOME_TTL_SECONDS
        while outcomes:
            oldest_id, oldest = next(iter(outcomes.items()))
            if oldest.at >= horizon:
                break
            outcomes.pop(oldest_id)
        if not outcomes:
            self._outcomes.pop(key, None)


def _require_client_id(value: Any) -> None:
    if not isinstance(value, str) or not _CLIENT_ID.fullmatch(value):
        raise QueuedInputError("Queued message id is invalid.")


registry = QueuedInputRegistry()


# ── the run a callback belongs to ────────────────────────────────────────────
@dataclass(frozen=True)
class RunKey:
    owner_id: str
    conversation_id: str
    run_id: str


_CURRENT_RUN: contextvars.ContextVar[RunKey | None] = contextvars.ContextVar(
    "hussh_queued_input_run", default=None
)


def clubbing_admitted(state: dict[str, Any], *, resuming: bool) -> bool:
    """Whether a run may take queued input at its step boundaries.

    Refused turns deliver queued input as the next turn instead. Each refusal is
    a turn whose admission was decided for one exact purpose at ingress, and a
    message joining it would ride on that admission.
    """
    from hushh_mcp.one_adk.consent_continuation import STATE_CONSENT_CONTINUATION
    from hushh_mcp.one_adk.feed_attention import STATE_FEED_ATTENTION
    from hushh_mcp.one_adk.mcp_call_approval import STATE_MCP_APPROVAL

    if resuming:
        return False
    return not any(
        state.get(key)
        for key in (STATE_CONSENT_CONTINUATION, STATE_FEED_ATTENTION, STATE_MCP_APPROVAL)
    )


@contextlib.asynccontextmanager
async def run_scope(
    owner_id: str, conversation_id: str, run_id: str, *, accepting: bool
) -> AsyncIterator[RunKey | None]:
    """Open this run's inbox and bind it to the run's context.

    The ADK background task copies the context when the bridge starts it, so the
    model callback sees the same run. The inbox stays open after the reader
    leaves; the background run closes it when it settles.
    """
    if not owner_id or owner_id.startswith("anonymous:") or not conversation_id or not run_id:
        yield None
        return
    key = RunKey(owner_id, conversation_id, run_id)
    registry.open_run(owner_id, conversation_id, run_id, accepting=accepting)
    token = _CURRENT_RUN.set(key)
    try:
        yield key
    finally:
        with contextlib.suppress(ValueError):
            _CURRENT_RUN.reset(token)


def current_run() -> RunKey | None:
    return _CURRENT_RUN.get()


def settle(key: RunKey | None) -> Settlement:
    if key is None:
        return Settlement()
    return registry.close_run(key.owner_id, key.conversation_id, key.run_id)


def queued_input_event_value(
    *, joined: list[str] | tuple[str, ...], returned: list[str] | tuple[str, ...], settled: bool
) -> dict[str, Any]:
    """The content-free wire notice: ids and a phase, never text."""
    return {
        "phase": "settled" if settled else "joined",
        "joined": list(joined),
        "returned": list(returned),
    }


async def club_queued_input(callback_context: Any, llm_request: Any) -> LlmResponse | None:
    """At a model-step boundary, deliver waiting messages into the live turn.

    Registered LAST on the root agent, so it runs only when no earlier callback
    answered for the model and a real model call follows. Delivered messages are
    appended to the session as the person's own events (sealed by the session
    service) and to this request, so this call and every later step see them.
    """
    key = _CURRENT_RUN.get()
    if key is None:
        return None
    if registry.stop_requested(key.owner_id, key.conversation_id, key.run_id):
        # Between steps, so no call is left without its response.
        return LlmResponse(
            content=types.Content(role="model", parts=[types.Part(text=STOPPED_ANSWER)]),
            turn_complete=True,
        )
    from hushh_mcp.one_adk.external_read_boundary import external_read_active

    if external_read_active(callback_context):
        # The post-read barrier narrows this turn's authority. A new instruction
        # would inherit it, so it waits for a fresh turn instead.
        return None
    items = registry.drain(key.owner_id, key.conversation_id, key.run_id)
    if not items:
        return None
    invocation = callback_context._invocation_context
    try:
        for item in items:
            event = Event(
                invocation_id=invocation.invocation_id,
                author="user",
                branch=invocation.branch,
                content=types.Content(role="user", parts=[types.Part(text=item.text)]),
                custom_metadata={
                    "kind": QUEUED_INPUT_KIND,
                    "clientMessageId": item.client_message_id,
                },
            )
            await invocation.session_service.append_event(invocation.session, event)
            registry.persisted(key.owner_id, key.conversation_id, key.run_id, item)
            llm_request.contents.append(event.content)
    except Exception:
        registry.append_failed(key.owner_id, key.conversation_id, key.run_id)
        raise
    logger.info("one.queued_input_joined count=%d", len(items))
    return None
