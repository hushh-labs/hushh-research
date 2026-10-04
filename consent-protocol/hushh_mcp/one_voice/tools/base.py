"""Tool contract for One Live Voice.

Rules encoded here, not in prose:

* A tool is bound to exactly one generated gateway ``action_id``; the
  registry test fails when the id does not exist in the gateway.
* ``ToolPolicy`` decides whether a call executes now, needs a spoken
  confirmation after the card was shown, or needs a tap receipt.
* Person and circle arguments are canonical ids (``PersonRef``/``CircleRef``)
  and must already be present in the conversation's :class:`EntityContext`;
  a spoken name can never be an argument to a mutation.
* Every result carries ``status`` from a small, tool-specific vocabulary plus
  ``spoken_facts`` -- the sentences the model may state verbatim. Pending
  states (``confirmation_required``, ``position_publish_pending``,
  ``location_updates_pending``, ``navigation_dispatched``) are never success.
* The host validates ids, schemas, and authority and returns typed refusals.
  It never re-picks a tool, classifies transcripts, or auto-selects a person
  (AGENTS.md "no second decision-maker").
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Final, Literal

from pydantic import BaseModel, ConfigDict, Field

ENTITY_CONTEXT_TTL_SECONDS = 2 * 60 * 60
# How long a resolve_* candidate list stays selectable. Minutes, not the
# entity TTL: "the second one" must refer to a list the person can still see.
OFFER_TTL_SECONDS = 10 * 60
# Interim status of a device-executed Location updates step. Never success:
# the settled result arrives later as its own tool.result once the device
# reports back.
LOCATION_UPDATES_PENDING: Final = "location_updates_pending"


class ToolPolicy(str, Enum):
    read = "read"
    direct = "direct"
    confirm_voice = "confirm_voice"
    confirm_tap = "confirm_tap"

    @property
    def needs_confirmation(self) -> bool:
        return self in {ToolPolicy.confirm_voice, ToolPolicy.confirm_tap}

    @property
    def tier(self) -> str | None:
        if self is ToolPolicy.confirm_voice:
            return "voice"
        if self is ToolPolicy.confirm_tap:
            return "tap"
        return None


class ToolInput(BaseModel):
    """Base for every tool's arguments. Unknown fields are refused so the model
    cannot smuggle a free-text name past a typed id slot."""

    model_config = ConfigDict(extra="forbid")


class PersonRef(BaseModel):
    """A canonical person reference. Only ids, never names."""

    model_config = ConfigDict(extra="forbid")
    user_id: str = Field(
        min_length=1,
        max_length=128,
        description="Canonical user id from resolve_person/confirm_person.",
    )


class CircleRef(BaseModel):
    model_config = ConfigDict(extra="forbid")
    circle_id: str = Field(
        min_length=36,
        max_length=36,
        description="Canonical circle id from list_circles/confirm_circle.",
    )


Needs = Literal[
    "confirmation",
    "disambiguation",
    "repeat_name",
    "client_step",
    "unsupported",
    "setup",
    "consent",
    "invite",
]


class ToolResult(BaseModel):
    """Every tool output inherits this. ``status`` is the outcome vocabulary."""

    model_config = ConfigDict(extra="allow")
    status: str
    spoken_facts: list[str] = Field(default_factory=list)
    needs: Needs | None = None
    reason_code: str | None = None
    ui_refresh: list[str] = Field(default_factory=list)

    def public(self) -> dict[str, Any]:
        return self.model_dump(mode="json")

    def narratable_digest(self) -> str:
        """The short text this result may have spoken aloud, if any.

        A seam rather than a field the relay reads by name. ``session.py`` must not
        reach into a result for ``answer``: that would make the relay decide what
        is speakable, and every new result type would inherit the decision
        silently. A tool that has something safe to say declares it here, and
        everything else says nothing.

        Whatever a tool returns here is spoken by a separate narration context and
        must never be handed to the operational model -- see :meth:`model_public`.
        """
        return ""

    def model_public(self) -> dict[str, Any]:
        """What the Live model may see, which is not always what the screen sees.

        Identical to :meth:`public` for every ordinary tool. A tool whose result
        carries content the owner did not write -- mail, documents, anything a
        third party authored -- overrides this to return a receipt instead.

        The distinction is not cosmetic. The Live session runs with provider
        side context compression and a resumption handle persisted for hours,
        so whatever lands in the model's context outlives the turn and cannot
        be evicted from here. A sender's text placed there is an instruction
        the operational model keeps reading.
        """
        return self.public()


class Rejected(ToolResult):
    status: Literal["rejected"] = "rejected"


class Unsupported(ToolResult):
    status: Literal["unsupported"] = "unsupported"
    needs: Needs | None = "unsupported"


class ConfirmationRequired(ToolResult):
    status: Literal["confirmation_required"] = "confirmation_required"
    needs: Needs | None = "confirmation"
    pending_action_id: str
    tier: Literal["voice", "tap"]
    summary: str


class ConfirmationWaiting(ToolResult):
    """The same voice-tier proposal is already open. Never success, never a new
    row: the host refuses to mint a duplicate and hands back the existing id."""

    status: Literal["confirmation_waiting"] = "confirmation_waiting"
    needs: Needs | None = "confirmation"
    pending_action_id: str
    tier: Literal["voice"] = "voice"
    summary: str
    card_shown: bool


class ConfirmedPerson(BaseModel):
    model_config = ConfigDict(extra="forbid")
    user_id: str
    public_person_ref: str | None = None
    display_name: str
    photo_url: str | None = None
    relationship: Literal["connected", "pending_outgoing", "pending_incoming", "none", "self"] = (
        "none"
    )
    has_location_key: bool = False
    phone_verified: bool = False
    confirmed_at: str

    def spoken(self) -> str:
        label = {
            "connected": "connected",
            "pending_outgoing": "your request is pending",
            "pending_incoming": "they asked to connect",
            "none": "not connected",
            "self": "you",
        }[self.relationship]
        return f"{self.display_name}, {label}"


class ConfirmedCircle(BaseModel):
    model_config = ConfigDict(extra="forbid")
    circle_id: str
    name: str
    kind: str = "other"
    member_count: int | None = None
    confirmed_at: str


class OfferedRequest(BaseModel):
    """A connection request the server listed in this conversation. Only these
    ids may be accepted, declined or cancelled, and the card names the real
    counterpart even when the model omits ``person``."""

    model_config = ConfigDict(extra="forbid")
    request_id: str
    user_id: str
    display_name: str
    direction: Literal["incoming", "outgoing"]


def restore_context(model: type[Any], stored: Any) -> Any:
    """Rebuild a persisted context, keeping what this version understands.

    ``EntityContext`` and ``ScreenContext`` forbid unknown keys, which is the
    right contract for the model and the wrong behaviour for a stored row: a
    field written by a newer server fails validation for the whole row, and every
    caller's fallback is an empty context. A rollback would therefore drop every
    confirmed person and circle in every live conversation because of one key it
    did not recognise.

    Unknown keys are dropped and the rest is kept. A genuinely corrupt value
    still falls back to empty and is never trusted.
    """
    raw = stored if isinstance(stored, dict) else {}
    known = {key: value for key, value in raw.items() if key in model.model_fields}
    try:
        return model.model_validate(known)
    except Exception:  # noqa: BLE001 - a corrupt context is dropped, never trusted
        return model()


class OfferedMail(BaseModel):
    """The messages One last put in front of the person, in that order.

    Ordinal 1 is ``message_ids[0]``: the order the renderer drew and the order
    One counted. "Read the second one" is resolved here, by the server, because
    the Live model is given counts and never learns which message was second --
    it could not name it if it tried, and a model that guessed would produce a
    confident wrong answer with nothing to show it had.

    Ids and the account they were resolved in, and nothing else. No subject,
    sender or body: this row is persisted, and it is a pointer into the mailbox
    rather than a copy of it.
    """

    model_config = ConfigDict(extra="forbid")
    message_ids: list[str] = Field(default_factory=list, max_length=25)
    # The ``google_sub`` these ids belong to. Ids resolved in one mailbox must
    # never be applied to another, so reconnecting to a different Google account
    # invalidates the offer instead of reading the wrong inbox.
    account: str = ""
    mailbox: str = "inbox"
    offered_at: str | None = None
    revision: int = 0


class EntityContext(BaseModel):
    """Per-conversation confirmed entities, keyed by canonical id.

    Only ``confirm_person``/``confirm_circle`` (after a resolve) or a read tool
    that returned an unambiguous canonical record may add entries. Persisted as
    JSONB on the conversation row; entries older than the TTL are dropped.
    """

    model_config = ConfigDict(extra="forbid")
    people: dict[str, ConfirmedPerson] = Field(default_factory=dict)
    circles: dict[str, ConfirmedCircle] = Field(default_factory=dict)
    last_person_user_id: str | None = None
    last_circle_id: str | None = None
    # Candidate ids offered by the most recent resolve_* call. confirm_* only
    # accepts one of these, so the model cannot invent an id.
    offered_person_ids: list[str] = Field(default_factory=list)
    offered_circle_ids: list[str] = Field(default_factory=list)
    # When ``offered_person_ids`` came from a circle roster read, the circle
    # the server read them from. ``confirm_person`` revalidates a roster
    # candidate against that circle's membership, so a member who is not one
    # of the person's direct connections can still be confirmed -- and only
    # as a member of that circle, never as an id the model supplied.
    offered_person_circle_id: str | None = None
    # Which offer the candidates belong to, and when it was made. A selection
    # against an older revision, or after the TTL, is stale: the list the
    # person saw is not the list on record.
    offer_revision: int = 0
    offered_at: str | None = None
    # Connection requests the server listed, by request id. Replaced on every
    # list_people; a request id the model did not receive here is refused.
    offered_requests: dict[str, OfferedRequest] = Field(default_factory=dict)
    # The messages the last mail read showed, so a spoken position resolves to
    # the message it named rather than to whatever a fresh search returns now.
    offered_mail: OfferedMail | None = None

    @staticmethod
    def _now() -> datetime:
        return datetime.now(timezone.utc)

    def offer_is_fresh(self) -> bool:
        if not self.offered_person_ids:
            return False
        if not self.offered_at:
            return True  # a pre-revision record: nothing to compare against
        age = self._now().timestamp() - datetime.fromisoformat(self.offered_at).timestamp()
        return age <= OFFER_TTL_SECONDS

    def prune(self) -> None:
        cutoff = self._now().timestamp() - ENTITY_CONTEXT_TTL_SECONDS
        for key in list(self.people):
            if datetime.fromisoformat(self.people[key].confirmed_at).timestamp() < cutoff:
                del self.people[key]
        for key in list(self.circles):
            if datetime.fromisoformat(self.circles[key].confirmed_at).timestamp() < cutoff:
                del self.circles[key]
        if self.last_person_user_id not in self.people:
            self.last_person_user_id = None
        if self.last_circle_id not in self.circles:
            self.last_circle_id = None
        if self.offered_person_ids and not self.offer_is_fresh():
            self.offered_person_ids = []
            self.offered_person_circle_id = None
        if self.offered_mail is not None and not self.offered_mail_is_fresh():
            self.offered_mail = None

    def remember_person(self, person: ConfirmedPerson) -> None:
        self.people[person.user_id] = person
        self.last_person_user_id = person.user_id

    def offer_mail(self, message_ids: list[str], *, account: str, mailbox: str) -> int:
        """Replace the offered messages, and say when they were offered.

        Replaced on every read, like ``offer_requests``: the person is looking at
        the newest list, so that is the only one a position can mean.
        """
        self.offer_revision += 1
        self.offered_mail = OfferedMail(
            message_ids=list(message_ids)[:25],
            account=account,
            mailbox=mailbox,
            offered_at=self._now().isoformat(),
            revision=self.offer_revision,
        )
        return self.offer_revision

    def offered_mail_is_fresh(self) -> bool:
        """An offer with no timestamp is not trusted.

        Unlike ``offer_is_fresh``, there is no pre-revision record to be lenient
        about: every mail offer was written by code that stamps it.
        """
        offer = self.offered_mail
        if offer is None or not offer.message_ids or not offer.offered_at:
            return False
        age = self._now().timestamp() - datetime.fromisoformat(offer.offered_at).timestamp()
        return age <= OFFER_TTL_SECONDS

    def offered_mail_message_id(self, ordinal: int) -> str | None:
        """The message at a spoken position, or None when it cannot be trusted.

        None is a refusal to guess, not an invitation to search again.
        """
        if not self.offered_mail_is_fresh() or self.offered_mail is None:
            return None
        ids = self.offered_mail.message_ids
        return ids[ordinal - 1] if 1 <= ordinal <= len(ids) else None

    def offer_requests(self, requests: list[OfferedRequest]) -> None:
        self.offered_requests = {item.request_id: item for item in requests}

    def offered_request(self, request_id: str) -> OfferedRequest | None:
        return self.offered_requests.get(request_id)

    def offer_people(self, user_ids: list[str], *, circle_id: str | None = None) -> int:
        """Replace the offered person candidates and record where and when they
        came from. Returns the new offer revision."""
        self.offered_person_ids = list(user_ids)
        self.offered_person_circle_id = circle_id
        self.offer_revision += 1
        self.offered_at = self._now().isoformat()
        return self.offer_revision

    def remember_circle(self, circle: ConfirmedCircle) -> None:
        self.circles[circle.circle_id] = circle
        self.last_circle_id = circle.circle_id

    def person(self, user_id: str) -> ConfirmedPerson | None:
        self.prune()
        return self.people.get(user_id)

    def circle(self, circle_id: str) -> ConfirmedCircle | None:
        self.prune()
        return self.circles.get(circle_id)


class ScreenContext(BaseModel):
    """Sanitized ``app_context`` from the client. Never trusted for authority."""

    model_config = ConfigDict(extra="ignore")
    screen_id: str | None = None
    route: str | None = None
    available_action_ids: list[str] = Field(default_factory=list)
    screen_state: dict[str, Any] = Field(default_factory=dict)
    os_location_permission: Literal["unknown", "prompt", "granted", "denied"] = "unknown"
    # The circle whose detail screen is open, if any. A hint for "this
    # circle", never authority: every read of it goes through the authorized
    # circle service, and every mutation still needs the id confirmed.
    active_circle_id: str | None = None


@dataclass
class ToolContext:
    """What a tool handler receives. Authority lives in the token reference,
    resolved and re-validated by the relay before every mutation."""

    user_id: str
    conversation_id: str
    entities: EntityContext
    screen: ScreenContext
    vault_owner_token: str
    firebase_id_token: str | None = None
    # The owner's IANA zone as the client reported it, already bounded by the
    # auth frame. Handlers that resolve relative dates must pass it on; UTC is
    # the honest fallback, not a correct answer.
    timezone: str = "UTC"
    # Services may be injected for tests; handlers fall back to real ones.
    services: dict[str, Any] = field(default_factory=dict)
    # The prepared-effect snapshot a ``ToolSpec.prepare`` hook computed when
    # the card was shown; set by the executor only while that card's handler
    # runs, so the handler can refuse to act on a materially changed effect.
    prepared: dict[str, Any] | None = None
    # The Save My Soul alert this session armed: the exact grant set the
    # delivery report is bound to. Server state stays the authority; this is
    # the correlation, never a "sent" flag.
    sos_incident: dict[str, Any] | None = None

    def service(self, name: str, factory: Callable[[], Any]) -> Any:
        if name not in self.services:
            self.services[name] = factory()
        return self.services[name]


ToolHandler = Callable[[ToolContext, Any], Awaitable[ToolResult]]


@dataclass(frozen=True)
class Prepared:
    """What a confirm_* tool will do, computed from authorized state when the
    card is shown. ``summary`` is the card sentence; ``snapshot`` is stored
    with the pending row and handed back to the handler as ``ctx.prepared``
    so execution can detect drift instead of silently doing something else."""

    summary: str
    snapshot: dict[str, Any] = field(default_factory=dict)


PrepareHook = Callable[[ToolContext, Any], Awaitable["Prepared | ToolResult"]]


def arg_refs(value: Any) -> tuple[Any, ...]:
    """Every entity ref a tool argument carries, whether it names one or several.

    A batch argument holds a bounded list of refs instead of a single one, and the
    guard that checks each id was confirmed -- plus the confirmation card that
    shows the person who is affected -- both have to see all of them. Reading the
    arity here keeps those two readers identical for one person and for twenty.
    """
    if value is None:
        return ()
    if isinstance(value, (list, tuple)):
        return tuple(value)
    return (value,)


@dataclass(frozen=True)
class ToolSpec:
    name: str
    gateway_action_id: str
    policy: ToolPolicy
    input_model: type[ToolInput]
    output_model: type[ToolResult]
    description: str
    handler: ToolHandler
    # Argument field names that must name a confirmed entity in the context.
    person_args: tuple[str, ...] = ()
    circle_args: tuple[str, ...] = ()
    # First-party fields sealed before a confirmation row is persisted.
    private_args: tuple[str, ...] = ()
    # Client surfaces to refresh after a successful mutation.
    ui_refresh: tuple[str, ...] = ()
    # Requires a fresh Firebase proof at confirmation (people/profile plane).
    firebase_plane: bool = False
    # For confirm_* tools: how the pending card summarizes the action.
    summarize: Callable[[ToolContext, Any], str] | None = None
    # For confirm_* tools whose effect depends on live state: computes the
    # exact prepared effect before the card is shown. Returning a ToolResult
    # instead of a Prepared answers the call without a card (nothing to do,
    # state unreadable, already active).
    prepare: PrepareHook | None = None
    # The result hands the client a device step that only a live session can
    # run and settle; confirming it over plain HTTP would arm an effect with
    # no publisher, so that route refuses it.
    device_step: bool = False

    def declaration(self) -> dict[str, Any]:
        """Gemini function declaration (JSON-schema parameters, refs inlined)."""
        parameters = inline_schema_refs(self.input_model.model_json_schema())
        parameters.pop("title", None)
        return {
            "name": self.name,
            "description": self.description,
            "parameters_json_schema": parameters,
        }


def inline_schema_refs(schema: dict[str, Any]) -> dict[str, Any]:
    """Resolve local ``$ref``/``$defs`` so the declaration is self-contained.

    Provider function-calling schemas do not reliably honor ``$defs``; nested
    pydantic models (``PersonRef``, ``CircleRef``) are inlined instead.
    """
    defs = dict(schema.get("$defs") or {})

    def _resolve(node: Any) -> Any:
        if isinstance(node, dict):
            ref = node.get("$ref")
            if isinstance(ref, str) and ref.startswith("#/$defs/"):
                target = defs.get(ref.split("/")[-1], {})
                merged = {**_resolve(target), **{k: v for k, v in node.items() if k != "$ref"}}
                merged.pop("title", None)
                return merged
            return {k: _resolve(v) for k, v in node.items() if k != "$defs"}
        if isinstance(node, list):
            return [_resolve(item) for item in node]
        return node

    result = _resolve(schema)
    return result if isinstance(result, dict) else {}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


__all__ = [
    "CircleRef",
    "ConfirmationRequired",
    "ConfirmationWaiting",
    "ConfirmedCircle",
    "ConfirmedPerson",
    "ENTITY_CONTEXT_TTL_SECONDS",
    "LOCATION_UPDATES_PENDING",
    "OFFER_TTL_SECONDS",
    "EntityContext",
    "Needs",
    "OfferedRequest",
    "PersonRef",
    "Rejected",
    "ScreenContext",
    "ToolContext",
    "ToolHandler",
    "ToolInput",
    "ToolPolicy",
    "ToolResult",
    "ToolSpec",
    "Unsupported",
    "inline_schema_refs",
    "now_iso",
]
