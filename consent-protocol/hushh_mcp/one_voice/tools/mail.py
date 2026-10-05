"""Mail tools: read the owner's inbox and open a reviewed compose or reply card.

No voice tool archives, labels, marks read, trashes, saves drafts, or sends.
``send_mail`` and ``reply_mail`` only propose a first-party draft after spoken
confirmation; the existing owner's card owns every provider write, and only the
owner's Send tap delivers anything.

The read itself is not implemented here. It belongs to
``email_delegated_read``, which runs a planner that sees the person's request
and no mailbox contents, then a tool-less interpreter that sees bounded
untrusted evidence and cannot call anything. This module is the adapter that
lets One Live Voice reach that path, and the place where its result stops.

Two boundaries are load-bearing:

* **The model never receives mail.** ``MailReadResult.model_public`` returns a
  receipt -- a status and a count -- while the client frame carries the whole
  answer. The Live session keeps provider-side compressed context and a
  resumption handle for hours, so a sender's text placed there would outlive
  the turn and steer later ones. See ``ToolResult.model_public``.

* **One says how many, not what they say.** The spoken line is built from
  counts the server computed itself. Reading a message aloud would mean handing
  its text to the model to speak, which is the boundary above. Until a narration
  path exists that speaks a validated answer without the operational model
  holding it, the answer is shown, not spoken.

The counts are the server's, not the interpreter's. ``sources`` is the list of
refs the interpreter chose to cite; ten messages can be projected and three
cited. Saying "I found three" then reports a fact about a model's citation habit
as a fact about the person's mailbox, so every number One says comes from
``coverage``, which the reader computes after it knows what survived.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import logging
from typing import Any, Literal

from pydantic import Field, field_validator

from hushh_mcp.one_voice.config import OneVoiceMailAdmission
from hushh_mcp.one_voice.tools.base import (
    OfferedMail,
    PersonRef,
    Prepared,
    Rejected,
    ToolContext,
    ToolInput,
    ToolPolicy,
    ToolResult,
    ToolSpec,
)
from hushh_mcp.runtime_settings import get_core_security_settings
from hushh_mcp.services import gmail_reply_source_service as reply_source
from hushh_mcp.services.connections_service import ConnectionsService
from hushh_mcp.services.connector_feature_admission import connector_feature_enabled
from hushh_mcp.services.email_delegated_read import run_delegated_mail_read
from hushh_mcp.services.gmail_delivery_service import GmailDeliveryError, normalize_draft
from hushh_mcp.services.gmail_metadata_reader import GmailMetadataReader
from hushh_mcp.services.gmail_receipts_service import GmailApiError, get_gmail_receipts_service

logger = logging.getLogger(__name__)

# The delegated read rejects anything longer than this itself; bounding it here
# keeps an oversized transcript out of the planner call entirely.
MAX_REQUEST_BYTES = 8000

# Injected by tests; built from the environment otherwise.
MAIL_ADMISSION_SERVICE = "voice_mail_admission"
# The provider boundary a reply re-reads its source through; injected by tests.
MAIL_REPLY_READER_SERVICE = "voice_mail_reply_reader"

# What One says when a read did not happen. Connection state and nothing else:
# no sender, subject or body, so the model boundary is untouched.
#
# The default matters more than the entries. Classification is an allowlist of
# success, not a denylist of failure, because `unavailable` covers a gene
# timeout, a malformed answer, and `invalid_mail_sources` -- the interpreter
# citing a source it was never given, which is how prompt injection shows up.
# Under a denylist that signal reported as an empty mailbox and counted as a
# successful turn.
_REJECT_SPOKEN = {
    "connect_required": "Mail isn't connected, so I couldn't look.",
    "reconnect_required": "Mail needs reconnecting before I can look.",
    "connection_changed": "Your Mail connection changed while I was looking. Nothing was read.",
    "permission_denied": "Mail didn't allow that read.",
    "source_changed": "The inbox changed while I was looking. Please ask again.",
    "response_too_large": "That search was too broad for me to read. Try narrowing it.",
    "invalid_argument": "I couldn't turn that into a search of your mail.",
}
_REJECT_DEFAULT = "I couldn't look at your mail just now."
_STAGE_FAILURES = {
    "planning": "I couldn't plan that Mail request just now. Please try again.",
    "retrieval": "Your Mail connection is available, but I couldn't fetch those messages just now.",
    "interpretation": "I fetched the messages, but I couldn't finish reading them just now.",
    "analysis": "I fetched the messages, but I couldn't complete the requested analysis.",
}
_ANALYSIS_FAILURE_NAMES = {
    "personal_info": "personal-information request",
    "action_items": "action-item",
    "meetings": "meeting",
}


def _analysis_failure_speech(value: Any) -> list[str]:
    """Name only validated category IDs; never speak delegated response text."""
    if not isinstance(value, list):
        return []
    categories = list(
        dict.fromkeys(
            category
            for category in value[:3]
            if isinstance(category, str) and category in _ANALYSIS_FAILURE_NAMES
        )
    )
    return [
        (
            "Your mailbox is connected, but I couldn't complete the "
            if index == 0
            else "I also couldn't complete the "
        )
        + _ANALYSIS_FAILURE_NAMES[category]
        + " analysis."
        for index, category in enumerate(categories)
    ]


# A dispatch, not an answer. The client opens the row it names through the same
# resolver a tap uses, so this result has nothing of its own to show and must not
# take the mail list's place on screen.
MAIL_OPEN_DISPATCHED = "mail_open_dispatched"

# A capability answer, not a read. Distinct from the read statuses so a surface
# never renders it as an empty mail list.
MAIL_ACCESS_STATUS = "mail_access"


class ReadMailInput(ToolInput):
    """The person's own question, forwarded to the planner unchanged.

    Not a command phrase and not parsed here: the planner owns turning it into
    exactly one bounded operation.

    ``ordinal`` is the exception, and only because there is nothing to plan: a
    position refers to a list this server minted, so the message is already
    chosen and the planner is skipped rather than asked and overruled.
    """

    request: str = Field(min_length=1, max_length=MAX_REQUEST_BYTES)
    ordinal: int | None = Field(
        default=None,
        ge=1,
        le=25,
        description=(
            "The position the person named in the list of mail you last showed them "
            "('read the second one' is 2). Set this whenever they refer to mail by "
            "position instead of describing it. The server resolves the position to "
            "the message it showed; you do not know which message that is, so never "
            "guess one or turn a position into a search."
        ),
    )


# Every key the model may see. An allowlist, so a field added to coverage
# later cannot reach the model's context by being added to a dict.
_MODEL_COVERAGE_KEYS = (
    "operation",
    "scope",
    "unit",
    "assessed",
    "returned",
    "cited",
    "matches_beyond_page",
    "items_omitted",
    "content_shortened",
    "content_depth",
    "analysis_requested",
    "analysis_failed",
    "findings_personal_info",
    "findings_action_items",
    "findings_meetings",
    "analysis_unassessable",
)

# Product words for what a row counts. A needs-reply row is a conversation.
_UNIT_NOUN = {
    "threads": ("conversation", "conversations"),
    "messages": ("message", "messages"),
}


class MailReadResult(ToolResult):
    """A mail answer for the screen, and a receipt for the model.

    ``items`` are the rows the person can be shown and can select; they carry
    what a sender wrote and so never reach ``model_public``. ``sources`` are the
    refs the interpreter cited, which mark rows the answer leaned on. ``coverage``
    is the server's own account of the work, and the only place a number spoken
    aloud may come from.
    """

    answer: str = ""
    sources: list[dict[str, Any]] = Field(default_factory=list)
    items: list[dict[str, Any]] = Field(default_factory=list)
    coverage: dict[str, Any] = Field(default_factory=dict)
    # Which offer these rows belong to, and which conversation it was made under.
    # The client sends both back when it opens a row.
    #
    # The revision refuses a row from a list that has since been replaced. The
    # conversation id matters for a subtler reason: the client's live
    # conversation id comes from server frames and can move on a reconnect while
    # the offer stays where it was written. Reading it from ambient state at tap
    # time would resolve the ordinal against a different conversation's offer and
    # open a confidently wrong message, so the id travels with the rows instead.
    #
    # Neither is shown to the model. Both are bindings between this server and
    # this screen, and the model cannot open anything with them.
    offer_revision: int | None = None
    conversation_id: str = ""
    truncated: bool = False
    metadata_only: bool = True

    def narratable_digest(self) -> str:
        """The interpreted answer, which is the useful sentence to hear.

        It is mail-derived, so it goes to the narration context and never to the
        operational model -- ``model_public`` below keeps it out of that one.
        """
        return self.answer

    def model_public(self) -> dict[str, Any]:
        """A receipt. No sender, subject, snippet, body or derived summary.

        ``spoken_facts`` is recomputed from ``coverage`` rather than copied from
        the field, so the model's sentence cannot carry mail content even if
        something upstream later puts content in ``spoken_facts``.
        """
        return {
            "status": self.status,
            "coverage": {
                key: self.coverage[key] for key in _MODEL_COVERAGE_KEYS if key in self.coverage
            },
            "spoken_facts": _spoken(self.coverage),
        }


def _spoken(coverage: dict[str, Any]) -> list[str]:
    """A line One can say, built only from counts the server computed.

    An absent or non-integer ``returned`` stays unknown. Reporting it as zero
    would turn "I could not count" into "your mailbox is empty".
    """
    returned = coverage.get("returned")
    if not isinstance(returned, int):
        return ["I looked at your mail, but I can't tell you how much I found."]
    requested = coverage.get("analysis_requested")
    if isinstance(requested, list) and requested:
        names = {
            "personal_info": ("personal-information request", "personal-information requests"),
            "action_items": ("action item", "action items"),
            "meetings": ("meeting finding in Mail", "meeting findings in Mail"),
        }
        failed = coverage.get("analysis_failed") or []
        assessed = coverage.get("assessed")
        checked = assessed if isinstance(assessed, int) else returned
        line = f"I checked {checked} message{'' if checked == 1 else 's'}."
        for category in requested:
            if category not in names:
                continue
            if category in failed:
                line += f" {names[category][1].capitalize()} could not be analyzed."
            else:
                found = coverage.get(f"findings_{category}")
                if isinstance(found, int):
                    line += f" {found} {names[category][0 if found == 1 else 1]} found."
        if coverage.get("matches_beyond_page") or coverage.get("items_omitted"):
            line += " More mail may be outside this page."
        if coverage.get("content_shortened"):
            line += " Some message text was shortened."
        if coverage.get("analysis_unassessable"):
            line += " Some messages had no readable text."
        return [line]
    if returned == 0:
        return ["I did not find any matching mail."]
    singular, plural = _UNIT_NOUN.get(str(coverage.get("unit")), _UNIT_NOUN["messages"])
    noun = singular if returned == 1 else plural
    scope = str(coverage.get("scope") or "")
    if scope == "selected":
        line = f"I have that {singular}." if returned == 1 else f"I have those {returned} {noun}."
    elif scope == "needs_reply":
        # A filtered set, not the front of the mailbox: "your 3 newest" would
        # describe a different read than the one that happened.
        line = (
            f"I found 1 {singular} that may need a reply."
            if returned == 1
            else f"I found {returned} {noun} that may need a reply."
        )
    elif scope == "newest":
        # Nothing was narrowed, so this is the front of the mailbox. Saying "I
        # found 5" for an update would report a budget as a total.
        line = (
            f"I read your newest {noun}."
            if returned == 1
            else f"I read your {returned} newest {noun}."
        )
    elif coverage.get("content_depth") == "message":
        line = f"I have that {singular}." if returned == 1 else f"I have those {returned} {noun}."
    else:
        line = f"I found {returned} {noun}."
    if coverage.get("matches_beyond_page"):
        line += " There may be more I haven't checked."
    if coverage.get("items_omitted"):
        line += " Some results were left out to fit."
    if coverage.get("content_shortened"):
        line += " Some of the text was shortened."
    return [line]


def _unavailable(reason_code: str) -> Rejected:
    return Rejected(
        reason_code=reason_code,
        spoken_facts=["I can't look at your mail right now."],
    )


async def _read_mail(ctx: ToolContext, args: ReadMailInput) -> ToolResult:
    admission = ctx.service(MAIL_ADMISSION_SERVICE, OneVoiceMailAdmission)
    if not admission.mail_reads_enabled():
        return _unavailable("voice_mail_reads_disabled")
    if not connector_feature_enabled("gmail_chat_reads", ctx.user_id):
        return _unavailable("mail_reads_unavailable")

    # A position is resolved here, against the list this server actually showed.
    # The model is given counts and never learns which message was second, so it
    # could not name one; a planner asked to interpret "the second one" plans a
    # body read with no criteria and returns the newest message instead, which is
    # a wrong answer that looks exactly like a right one.
    message_ids: tuple[str, ...] = ()
    offer_mailbox = "inbox"
    expect_account = ""
    if args.ordinal is not None:
        offer = ctx.entities.offered_mail
        if offer is None or not ctx.entities.offered_mail_is_fresh():
            return Rejected(
                reason_code="mail_offer_expired",
                spoken_facts=["That list is a while old. Ask me again and I'll take a fresh look."],
            )
        message_id = ctx.entities.offered_mail_message_id(args.ordinal)
        if message_id is None:
            shown = len(offer.message_ids)
            noun = "message" if shown == 1 else "messages"
            return Rejected(
                reason_code="mail_ordinal_not_offered",
                spoken_facts=[f"I only showed you {shown} {noun}. Which one did you mean?"],
            )
        message_ids = (message_id,)
        offer_mailbox = offer.mailbox
        expect_account = offer.account

    gmail = ctx.services.get("gmail") or get_gmail_receipts_service()

    async def require_access() -> None:
        """Re-checked around every provider hop by the delegated read.

        Cheap and idempotent on purpose: it runs several times per read, and a
        mid-flight withdrawal must stop the read rather than release what was
        already fetched. The delegated read calls this at its entry, after the
        planner, either side of the Gmail fetch, and once more after
        interpretation, so one closure covers every hop.
        """
        if not admission.mail_reads_enabled():
            raise PermissionError("Voice mail reads are disabled")
        if not connector_feature_enabled("gmail_chat_reads", ctx.user_id):
            raise PermissionError("Mail read authority is unavailable")

    try:
        outcome = await run_delegated_mail_read(
            gmail=gmail,
            user_id=ctx.user_id,
            consent_token=ctx.vault_owner_token,
            conversation_id=ctx.conversation_id,
            message=args.request,
            require_access=require_access,
            # "Today" and "this week" are the owner's, not the server's.
            timezone=ctx.timezone,
            message_ids=message_ids,
            offer_mailbox=offer_mailbox,
            expect_account=expect_account,
        )
    except PermissionError:
        # Admission was withdrawn mid-read. Nothing fetched is released.
        return _unavailable(
            "mail_reads_unavailable"
            if admission.mail_reads_enabled()
            else "voice_mail_reads_disabled"
        )

    # The handler's return is the release point: a read needs no confirmation,
    # so nothing downstream checks authority again. Today the delegated read's
    # last check sits close enough to its return that this is redundant, but
    # that is an accident of its control flow rather than a promise.
    if not admission.mail_reads_enabled():
        return _unavailable("voice_mail_reads_disabled")

    structured = outcome.get("structured") or {}
    status = str(structured.get("status") or "")
    sources = list(structured.get("sources") or [])

    if status == "input_required":
        # The planner asked a question, or the request was unusable. Its text is
        # authored from the request alone and has seen no mailbox, so passing it
        # through is safe -- and dropping it would discard the only thing One
        # has to say.
        return Rejected(
            reason_code="mail_read_needs_input",
            spoken_facts=[
                str(outcome.get("response") or "What would you like to find in your inbox?")
            ],
        )
    if status != "ok":
        # Anything that is not a successful read did not happen. Never an empty
        # inbox: "I found nothing" and "I could not look" are different answers
        # and the person acts differently on each.
        # The stage is the one fact the spoken line hides and an incident needs;
        # both values are short server enums, never provider or mail text.
        logger.info(
            "one_voice.mail_read reason=%s stage=%s",
            (status or "failed")[:23],
            str(outcome.get("failure_stage") or "none")[:23],
        )
        access_failure = _REJECT_SPOKEN.get(status)
        analysis_speech = (
            _analysis_failure_speech(outcome.get("analysis_failed"))
            if outcome.get("failure_stage") == "analysis" and not access_failure
            else []
        )
        return Rejected(
            reason_code=status or "mail_read_failed",
            spoken_facts=analysis_speech
            or [
                access_failure
                or _STAGE_FAILURES.get(str(outcome.get("failure_stage") or ""))
                or _REJECT_DEFAULT
            ],
        )

    coverage = dict(outcome.get("coverage") or {})
    items = list(outcome.get("items") or [])
    # Replace the offer with what this read actually put in front of the person.
    # Replaced, never merged: they are looking at the newest list, so that is the
    # only list a position can mean. A read that cannot name its rows clears the
    # offer rather than leaving positions pointing at a list that is gone.
    handback = outcome.get("offer") or {}
    offered_ids = [
        value for value in (handback.get("message_ids") or []) if isinstance(value, str) and value
    ]
    offer_revision: int | None = None
    if offered_ids:
        offer_revision = ctx.entities.offer_mail(
            offered_ids,
            account=str(handback.get("account") or ""),
            mailbox=str(handback.get("mailbox") or "inbox"),
            # A message read by its position keeps answering to that position.
            selected_ordinal=args.ordinal,
        )
    else:
        ctx.entities.offered_mail = None
        ctx.entities.offered_mail_selected_ordinal = None
    returned = coverage.get("returned")
    # A successful read with nothing in it is "empty". Anything else is "ok",
    # including a read whose count the server could not establish, because a
    # read did happen and calling it empty would be a claim about the mailbox.
    return MailReadResult(
        status="empty" if returned == 0 else "ok",
        answer=str(outcome.get("response") or ""),
        sources=sources,
        items=items,
        coverage=coverage,
        truncated=bool(structured.get("truncated")),
        metadata_only=bool(structured.get("metadata_only", True)),
        offer_revision=offer_revision,
        conversation_id=ctx.conversation_id,
        spoken_facts=_spoken(coverage),
        ui_refresh=["mail"],
    )


class OpenMailInput(ToolInput):
    """The position the person named, and nothing else.

    No message id: the model has never been told one, and a position is the only
    mail reference it can hold honestly.
    """

    ordinal: int = Field(
        ge=1,
        le=25,
        description=(
            "The position the person named in the list of mail you last showed them "
            "('open the second one' is 2). Use this to show them the original "
            "message. It does not read the mailbox again and it does not summarise; "
            "the surface opens the exact message it already offered at that "
            "position. Never guess a position that was not in that list."
        ),
    )


class MailOpenDispatched(ToolResult):
    """Ask the surface to open a row it is already showing.

    Carries no mail: the opening is done by the same authenticated resolver a tap
    uses, so nothing about the message passes through here and nothing about it
    reaches the model. The ordinal, the offer revision and the conversation travel
    so the surface resolves the position against the offer it drew, not against
    whatever list is current.
    """

    status: str = MAIL_OPEN_DISPATCHED
    ordinal: int = 0
    offer_revision: int = 0
    conversation_id: str = ""

    def model_public(self) -> dict[str, Any]:
        """A receipt. The model does not need the binding and cannot use it."""
        return {"status": self.status, "spoken_facts": list(self.spoken_facts)}


async def _open_mail(ctx: ToolContext, args: OpenMailInput) -> ToolResult:
    admission = ctx.service(MAIL_ADMISSION_SERVICE, OneVoiceMailAdmission)
    if not admission.mail_reads_enabled():
        return _unavailable("voice_mail_reads_disabled")
    # The same gate the read and the resolver route check. Without it One says
    # "Opening it." and the surface then gets a 403, which is a promise followed
    # by a refusal rather than a refusal.
    if not connector_feature_enabled("gmail_chat_reads", ctx.user_id):
        return _unavailable("mail_reads_unavailable")

    offer = ctx.entities.offered_mail
    if offer is None or not ctx.entities.offered_mail_is_fresh():
        return Rejected(
            reason_code="mail_offer_expired",
            spoken_facts=["That list is a while old. Ask me again and I'll take a fresh look."],
        )
    # Presence only. The message itself is fetched by the surface through the
    # resolver, so this handler performs no provider read and cannot duplicate one.
    position = ctx.entities.offered_mail_position(args.ordinal)
    if position is None:
        shown = len(offer.message_ids)
        noun = "message" if shown == 1 else "messages"
        return Rejected(
            reason_code="mail_ordinal_not_offered",
            spoken_facts=[f"I only showed you {shown} {noun}. Which one did you mean?"],
        )
    return MailOpenDispatched(
        # The row the surface draws, which is what it opens by.
        ordinal=position,
        offer_revision=offer.revision,
        conversation_id=ctx.conversation_id,
        spoken_facts=["Opening it."],
    )


class MailAccessInput(ToolInput):
    """Nothing to ask. Whose mailbox is already decided by the owner token."""


class MailAccessResult(ToolResult):
    """Whether One can read this mailbox -- established without reading it.

    ``state`` is copied from the Gmail service's own ``connection_state`` rather
    than re-derived here. The owning service already decides what a connection
    row plus its revoked flag and token usability mean, and a second opinion in
    this module would drift from the Connections screen the person can see.

    Carries no address and no scope list. "Which mailbox" is not what a capability
    question asks, the profile email is a different fact from mailbox access, and
    a raw address in the model's context outlives the turn.
    """

    status: str = MAIL_ACCESS_STATUS
    connected: bool = False
    state: str = "not_connected"
    can_read: bool = False

    def model_public(self) -> dict[str, Any]:
        """Capability facts, which is exactly what the question was about."""
        return {
            "status": self.status,
            "connected": self.connected,
            "state": self.state,
            "can_read": self.can_read,
            "spoken_facts": list(self.spoken_facts),
        }


async def _get_mail_access(ctx: ToolContext, args: MailAccessInput) -> ToolResult:
    """Answer "can you see my Gmail?" from the connection, not from the inbox.

    Without this, the question has no honest tool: ``get_profile`` returns the
    Hussh profile's masked email, which is an identity One holds whether or not a
    mailbox was ever connected, and ``read_mail`` would open the inbox to answer a
    question about access. Both were observed -- the profile address was reported
    as if it proved Gmail access.
    """
    gmail = ctx.services.get("gmail") or get_gmail_receipts_service()
    try:
        status = await gmail.get_status(user_id=ctx.user_id)
    except Exception:  # noqa: BLE001 - provider text is never reflected
        logger.warning("one_voice.mail_access reason=status_unavailable")
        return Rejected(
            reason_code="mail_status_unavailable",
            spoken_facts=["I can't check your mail connection right now."],
        )

    state = str(status.get("connection_state") or "not_connected")
    connected = bool(status.get("connected"))
    admission = ctx.service(MAIL_ADMISSION_SERVICE, OneVoiceMailAdmission)
    # Both gates are asked because they fail for different reasons and the person
    # can act on only one of them. A withdrawn read is not a broken connection.
    # Keyed on ``state``, not on ``connected``. The owning service derives one from
    # the other so they agree today, but readability is the claim that must never
    # be wrong in the optimistic direction: "I can read it" while the permission
    # has expired sends the person off to look for a failure that is right here.
    can_read = (
        state == "connected"
        and admission.mail_reads_enabled()
        and connector_feature_enabled("gmail_chat_reads", ctx.user_id)
    )

    if state == "needs_reauth":
        # The one case that legitimately asks for a reconnect.
        spoken = (
            "Your Gmail is connected but the permission expired, so I need you to reconnect it."
        )
    elif not connected:
        spoken = "Your Gmail isn't connected yet, so I can't read your mail."
    elif can_read:
        spoken = "Yes -- your Gmail is connected and I can read it."
    else:
        # Connected and healthy, withheld by a switch. Saying "reconnect" here
        # would send the person to fix something that is not broken.
        spoken = "Your Gmail is connected, but mail reading is switched off for me right now."

    return MailAccessResult(
        connected=connected,
        state=state,
        can_read=can_read,
        spoken_facts=[spoken],
    )


class SendMailInput(ToolInput):
    recipient: PersonRef = Field(
        description="Canonical person from resolve_person and confirm_person."
    )
    subject: str = Field(
        default="",
        max_length=256,
        description="Subject the owner dictated; leave empty if they gave none.",
    )
    message: str = Field(
        min_length=1,
        max_length=4000,
        description="The owner's dictated email message, preserved exactly; never invent it.",
    )

    @field_validator("subject")
    @classmethod
    def subject_is_one_line(cls, value: str) -> str:
        if "\r" in value or "\n" in value:
            raise ValueError("subject must be one line")
        return value

    @field_validator("message")
    @classmethod
    def message_has_words(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("message must not be blank")
        return value


class SendMailResult(ToolResult):
    status: Literal["draft_open_requested"] = "draft_open_requested"
    needs: Literal["client_step"] = "client_step"
    client_step: dict[str, Any]

    def model_public(self) -> dict[str, Any]:
        # The address and full draft go only to the owner's review card. The
        # operational Live model receives a bounded first-party speech receipt.
        return {
            "status": self.status,
            "needs": self.needs,
            "spoken_facts": list(self.spoken_facts),
        }


def _mail_connection(ctx: ToolContext, recipient_id: str) -> dict[str, Any] | None:
    connections = ctx.service("connections", ConnectionsService)
    rows = connections.list_connections(ctx.user_id)
    return next(
        (row for row in rows or [] if str(row.get("userId") or "") == recipient_id),
        None,
    )


def _email_binding(ctx: ToolContext, recipient_id: str, address: str) -> str:
    secret = get_core_security_settings().app_signing_key
    if not secret:
        raise ValueError("voice mail binding key is unavailable")
    material = (
        f"one-voice-send-mail-v1:{ctx.user_id}:{ctx.conversation_id}:{recipient_id}:{address}"
    )
    return hmac.new(secret.encode("utf-8"), material.encode("utf-8"), hashlib.sha256).hexdigest()


def _recipient_email(
    row: dict[str, Any] | None, subject: str, message: str
) -> tuple[str, str] | None:
    if row is None:
        return None
    raw = str(row.get("email") or "").strip()
    if not raw:
        return None
    try:
        normalized = normalize_draft({"to": raw, "subject": subject, "body": message})
    except GmailDeliveryError:
        return None
    if len(normalized.to) != 1:
        return None
    return normalized.to[0], normalized.subject


def _no_recipient_email(name: str) -> Rejected:
    return Rejected(
        reason_code="person_has_no_email",
        spoken_facts=[f"I don't have an email address for {name}, so I can't draft this."],
    )


def _recipient_changed(fact: str) -> Rejected:
    return Rejected(reason_code="recipient_changed", spoken_facts=[fact])


async def _prepare_send_mail(ctx: ToolContext, args: SendMailInput) -> Prepared | ToolResult:
    person = ctx.entities.person(args.recipient.user_id)
    if person is None or person.relationship != "connected":
        return Rejected(
            reason_code="recipient_not_connected",
            spoken_facts=["I can draft only to a confirmed connection with an email address."],
        )
    row = await asyncio.to_thread(_mail_connection, ctx, args.recipient.user_id)
    if row is None:
        # Confirmed earlier in the conversation, but no longer an active
        # connection. That is a different fact from "no address on file", and
        # the person acts on it differently.
        return Rejected(
            reason_code="recipient_not_connected",
            spoken_facts=[
                f"You aren't connected with {person.display_name} any more, so I can't draft this."
            ],
        )
    address = _recipient_email(row, args.subject, args.message)
    if address is None:
        return _no_recipient_email(person.display_name)
    to_email, _subject = address
    return Prepared(
        summary=f"draft an email to {person.display_name}",
        # An HMAC pins the confirmed recipient without retaining their address
        # in the long-lived pending-action row.
        snapshot={
            "recipient_user_id": args.recipient.user_id,
            "email_binding": _email_binding(ctx, args.recipient.user_id, to_email),
        },
    )


async def _send_mail(ctx: ToolContext, args: SendMailInput) -> ToolResult:
    person = ctx.entities.person(args.recipient.user_id)
    prepared = ctx.prepared or {}
    if (
        person is None
        or person.relationship != "connected"
        or prepared.get("recipient_user_id") != args.recipient.user_id
    ):
        return _recipient_changed(
            "That connection changed. I didn't open a draft; please ask again."
        )
    row = await asyncio.to_thread(_mail_connection, ctx, args.recipient.user_id)
    if row is None:
        # Connected when the card was shown, not any more: the approval was for
        # a recipient this draft can no longer be addressed to.
        return _recipient_changed(
            "That connection changed. I didn't open a draft; please ask again."
        )
    address = _recipient_email(row, args.subject, args.message)
    if address is None:
        return _no_recipient_email(person.display_name)
    to_email, subject = address
    if not hmac.compare_digest(
        str(prepared.get("email_binding") or ""),
        _email_binding(ctx, args.recipient.user_id, to_email),
    ):
        return _recipient_changed(
            "That email address changed. I didn't open a draft; please ask again."
        )
    preview = " ".join(args.message.split())
    if len(preview) > 180:
        preview = preview[:180].rstrip() + "…"
    facts = [f"I prepared an email draft to {person.display_name}."]
    if subject:
        facts.append(f"Subject: {subject}.")
    facts.append(f"Body starts: {preview}.")
    facts.append("I'm opening it for your review. Tap Send only after checking it.")
    return SendMailResult(
        spoken_facts=facts,
        client_step={
            "kind": "open_mail_draft",
            "draft": {
                "to": to_email,
                "to_name": person.display_name,
                "subject": subject,
                "body": args.message,
            },
        },
    )


class ReplyMailInput(ToolInput):
    """Which offered email to answer, and what to say. Never who or which thread.

    No recipient, subject, address or message id: a reply is addressed by the
    email it answers, and the server derives all of that from the message.
    """

    ordinal: int | None = Field(
        default=None,
        ge=1,
        le=25,
        description=(
            "The position of the email in the list of mail you last showed them, "
            "when they name one (the third email is 3). Leave it out when they mean "
            "the email they have open on screen, or the single email you just showed "
            "them: the server knows which one that is. Never guess a position."
        ),
    )
    message: str = Field(
        min_length=1,
        max_length=4000,
        description=(
            "The finished reply text, as it should read in the email. When they "
            "dictate it, their words exactly. When they only describe it (decline, "
            "accept, thank them), write that short reply yourself as the email "
            "body -- never pass their description through as the text -- and add "
            "no dates, amounts, commitments or facts they did not give. Never empty: "
            "if they have not said what to reply, ask them first."
        ),
    )

    @field_validator("message")
    @classmethod
    def message_has_words(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("message must not be blank")
        return value


class ReplyMailResult(ToolResult):
    status: Literal["draft_open_requested"] = "draft_open_requested"
    needs: Literal["client_step"] = "client_step"
    client_step: dict[str, Any]

    def model_public(self) -> dict[str, Any]:
        """A receipt. The recipient, subject and thread came from someone else's
        email, so they go only to the owner's review card, never to the model."""
        return {
            "status": self.status,
            "needs": self.needs,
            "spoken_facts": list(self.spoken_facts),
        }


# Every refusal a reply can meet, by the source service's code: what One says,
# and the reason the model reads. Authored text only; nothing from the message.
_REPLY_REFUSALS: dict[str, tuple[str, str]] = {
    reply_source.NOT_CONNECTED: (
        "mail_connect_required",
        "Mail isn't connected, so I can't prepare a reply.",
    ),
    reply_source.RECONNECT_REQUIRED: (
        "mail_reconnect_required",
        "Mail needs reconnecting before I can prepare a reply.",
    ),
    reply_source.ACCOUNT_CHANGED: (
        "mail_account_changed",
        "That email belongs to a different Mail connection now, so I didn't prepare a reply.",
    ),
    reply_source.SOURCE_UNAVAILABLE: (
        "reply_source_unavailable",
        "I can't find that original email now, so I didn't prepare a reply.",
    ),
    reply_source.SOURCE_CHANGED: (
        "reply_source_changed",
        "That email changed, so I didn't open a reply. Ask me to show it again.",
    ),
    reply_source.REF_INVALID: (
        "reply_source_changed",
        "I couldn't verify that email again, so I didn't open a reply. Nothing was sent.",
    ),
    reply_source.REF_EXPIRED: (
        "reply_source_changed",
        "That reply waited too long, so I didn't open it. Ask me to prepare it again.",
    ),
    reply_source.TARGET_IS_OWNER: (
        "reply_target_is_owner",
        # True whether the owner sent it or only its Reply-To names them.
        "A reply to that email would come back to you, so I didn't prepare one.",
    ),
    reply_source.TARGET_AMBIGUOUS: (
        "reply_target_ambiguous",
        "That email names more than one reply address, so I can't tell who to reply to.",
    ),
    reply_source.RECIPIENT_INVALID: (
        "reply_recipient_invalid",
        "That email has no reply address I can use, so I didn't prepare a reply.",
    ),
    reply_source.HEADERS_INVALID: (
        "reply_headers_invalid",
        "That email's reply details aren't usable, so I didn't prepare a reply.",
    ),
    reply_source.UNAVAILABLE: (
        "voice_mail_reply_disabled",
        "Replying to mail is switched off for me right now.",
    ),
}
_REPLY_RETRYABLE = (
    "reply_source_retryable",
    "I couldn't check that email just now. Nothing was sent.",
)
_SEND_NOT_READY: dict[str, tuple[str, str]] = {
    "GMAIL_NOT_CONNECTED": (
        "mail_connect_required",
        "Mail isn't connected, so I can't prepare a reply.",
    ),
    "GMAIL_SEND_PERMISSION_REQUIRED": (
        "send_permission_required",
        "Mail sending isn't allowed yet. Reconnect Mail to allow sending, then ask again.",
    ),
    "GMAIL_SEND_DISABLED": (
        "send_permission_required",
        "Mail sending is turned off. Turn it on in Mail settings, then ask again.",
    ),
}


def _reply_refused(code: str) -> Rejected:
    reason, fact = _REPLY_REFUSALS.get(code, _REPLY_RETRYABLE)
    return Rejected(reason_code=reason, spoken_facts=[fact])


def _reply_off() -> Rejected:
    return Rejected(
        reason_code="voice_mail_reply_disabled",
        spoken_facts=["Replying to mail is switched off for me right now."],
    )


# How a reply's target was found, which decides the sentence that names it: a
# position the person said, the row they opened, or the one email just shown.
ReplyTargetSource = Literal["position", "opened", "shown"]
_REPLY_TARGET_SUMMARY = {
    "opened": "prepare a reply to the email you opened",
    "shown": "prepare a reply to the email I just showed you",
}


def _resolve_reply_target(
    ctx: ToolContext, ordinal: int | None
) -> tuple[int, OfferedMail, str, ReplyTargetSource] | Rejected:
    """The offered message a reply answers, or the honest reason there is none.

    An explicit position wins. Without one, the row open on screen is used, and
    only while the list it was opened from is still the current offer: a
    revision that no longer matches is a different list, and its position would
    name a different email. Failing that, an offer of exactly one email is the
    email on screen -- reading "the second one" leaves just that message in
    front of the person, so "reply to it" can only mean it.
    """
    offer = ctx.entities.offered_mail
    source: ReplyTargetSource = "position"
    if ordinal is None:
        hint = ctx.screen.active_mail_ordinal
        if (
            hint is not None
            and offer is not None
            and ctx.screen.active_mail_offer_revision == offer.revision
        ):
            ordinal, source = hint, "opened"
        elif offer is not None and len(offer.message_ids) == 1:
            ordinal, source = 1, "shown"
        else:
            return Rejected(
                reason_code="reply_target_required",
                spoken_facts=[
                    "Which email should I reply to? Open it, or ask me to show your mail first."
                ],
            )
    if offer is None:
        return Rejected(
            reason_code="mail_not_shown",
            spoken_facts=["I haven't shown you any mail yet. Ask me to show your mail first."],
        )
    if not ctx.entities.offered_mail_is_fresh():
        return Rejected(
            reason_code="mail_offer_expired",
            spoken_facts=["That Mail list is a while old. Ask me to show your mail again."],
        )
    message_id = ctx.entities.offered_mail_message_id(ordinal)
    if message_id is None:
        shown = len(offer.message_ids)
        noun = "message" if shown == 1 else "messages"
        return Rejected(
            reason_code="mail_ordinal_not_offered",
            spoken_facts=[f"I only showed you {shown} {noun}. Which one did you mean?"],
        )
    return ordinal, offer, message_id, source


def _reply_target_key(ctx: ToolContext, args: ReplyMailInput) -> str | None:
    resolved = _resolve_reply_target(ctx, args.ordinal)
    if isinstance(resolved, Rejected):
        return None
    _ordinal, offer, message_id, _source = resolved
    return str(
        reply_source.reply_target_key(
            owner_user_id=ctx.user_id, account=offer.account, message_id=message_id
        )
    )


def _reply_access(ctx: ToolContext, admission: OneVoiceMailAdmission) -> Any:
    async def require_access() -> None:
        """Re-checked by the source read around its provider hop."""
        if not admission.mail_reply_enabled() or not admission.mail_reads_enabled():
            raise PermissionError("Voice mail replies are disabled")
        if not connector_feature_enabled("gmail_chat_reads", ctx.user_id):
            raise PermissionError("Mail read authority is unavailable")

    return require_access


def _reply_gates(ctx: ToolContext, admission: OneVoiceMailAdmission) -> Rejected | None:
    if not admission.mail_reply_enabled():
        return _reply_off()
    if not admission.mail_reads_enabled():
        return _unavailable("voice_mail_reads_disabled")
    if not connector_feature_enabled("gmail_chat_reads", ctx.user_id):
        return _unavailable("mail_reads_unavailable")
    return None


async def _prepare_reply_mail(ctx: ToolContext, args: ReplyMailInput) -> Prepared | ToolResult:
    admission = ctx.service(MAIL_ADMISSION_SERVICE, OneVoiceMailAdmission)
    refused = _reply_gates(ctx, admission)
    if refused is not None:
        return refused
    resolved = _resolve_reply_target(ctx, args.ordinal)
    if isinstance(resolved, Rejected):
        return resolved
    ordinal, offer, message_id, target_source = resolved
    gmail = ctx.services.get("gmail") or get_gmail_receipts_service()
    try:
        # Send readiness is checked before the card, not discovered at the tap:
        # a card that can never be sent is a promise followed by a refusal.
        await gmail.assert_send_ready(user_id=ctx.user_id)
    except GmailApiError as exc:
        reason, fact = _SEND_NOT_READY.get(
            str(exc.code or ""), _SEND_NOT_READY["GMAIL_SEND_PERMISSION_REQUIRED"]
        )
        return Rejected(reason_code=reason, spoken_facts=[fact])
    try:
        source = await reply_source.read_reply_source(
            gmail=gmail,
            user_id=ctx.user_id,
            message_id=message_id,
            expected_account=offer.account,
            require_access=_reply_access(ctx, admission),
            reader_factory=ctx.services.get(MAIL_REPLY_READER_SERVICE) or GmailMetadataReader,
        )
    except GmailDeliveryError as exc:
        logger.info("one_voice.mail_reply reason=%s stage=prepare", exc.code.lower()[:23])
        return _reply_refused(exc.code)
    return Prepared(
        # The card and the model read this sentence. A position is safe to say;
        # the sender and subject are someone else's words and are not.
        summary=_REPLY_TARGET_SUMMARY.get(
            target_source, f"prepare a reply to email {ordinal} in your list"
        ),
        snapshot={
            "source_mail_ref": reply_source.seal_reply_source_ref(
                source, owner_user_id=ctx.user_id
            ),
            # The list the card's sentence points into. A newer list makes "email
            # 2 in your list" name a different email, so the yes no longer
            # approves what it seems to.
            "offer_revision": offer.revision,
        },
    )


async def _reply_mail(ctx: ToolContext, args: ReplyMailInput) -> ToolResult:
    admission = ctx.service(MAIL_ADMISSION_SERVICE, OneVoiceMailAdmission)
    refused = _reply_gates(ctx, admission)
    if refused is not None:
        return refused
    prepared = ctx.prepared or {}
    offer = ctx.entities.offered_mail
    if offer is None or offer.revision != prepared.get("offer_revision"):
        return Rejected(
            reason_code="reply_list_changed",
            spoken_facts=[
                "Your mail list changed since I asked, so I didn't open the reply. "
                "Nothing was sent. Tell me which email to answer."
            ],
        )
    gmail = ctx.services.get("gmail") or get_gmail_receipts_service()
    try:
        # The email is read again after the yes: the card opens on what the
        # message says now, and a message that changed since the question was
        # asked is refused rather than answered.
        ref = reply_source.open_reply_source_ref(
            str(prepared.get("source_mail_ref") or ""), owner_user_id=ctx.user_id
        )
        source = await reply_source.verified_reply_source(
            gmail=gmail,
            user_id=ctx.user_id,
            ref=ref,
            require_access=_reply_access(ctx, admission),
            reader_factory=ctx.services.get(MAIL_REPLY_READER_SERVICE) or GmailMetadataReader,
        )
    except GmailDeliveryError as exc:
        logger.info("one_voice.mail_reply reason=%s stage=open", exc.code.lower()[:23])
        return _reply_refused(exc.code)
    preview = " ".join(args.message.split())
    if len(preview) > 180:
        preview = preview[:180].rstrip() + "…"
    return ReplyMailResult(
        # The person's own words only. Who it goes to and the subject are on the
        # card, which is where the person checks them.
        spoken_facts=[
            "I prepared your reply in the original thread.",
            f"Reply starts: {preview}.",
            "I'm opening it for your review. Tap Send reply only after checking it.",
        ],
        client_step={
            "kind": "open_mail_draft",
            "draft": {
                "to": source.recipient_email,
                "to_name": source.recipient_display,
                "subject": source.subject,
                "body": args.message,
                "mode": "reply",
                # Minted now, after the re-read, so the card's own window starts
                # when it opens. The browser can carry it but not open or alter it.
                "source_mail_ref": reply_source.seal_reply_source_ref(
                    source, owner_user_id=ctx.user_id
                ),
            },
        },
    )


TOOLS: tuple[ToolSpec, ...] = (
    ToolSpec(
        name="get_mail_access",
        gateway_action_id="email.chat.turn",
        policy=ToolPolicy.read,
        input_model=MailAccessInput,
        output_model=MailAccessResult,
        description=(
            "Answer whether you can see the person's mail at all: whether their "
            "Gmail is connected, needs reconnecting, or is switched off for you. "
            "Use this for a question about access or capability -- 'can you see my "
            "email', 'is my Gmail connected', 'do you have access to my inbox'. "
            "Does not open the mailbox and returns no messages. The person's Hushh "
            "profile email is a different fact and never answers this: get_profile "
            "reports the address on their account, not whether a mailbox is "
            "connected. Use read_mail only when they want what their mail says."
        ),
        handler=_get_mail_access,
    ),
    ToolSpec(
        name="read_mail",
        gateway_action_id="email.chat.turn",
        policy=ToolPolicy.read,
        input_model=ReadMailInput,
        output_model=MailReadResult,
        description=(
            "Answer a question about the person's own mailbox: recent or unread mail, "
            "mail from someone, what needs a reply, or what a specific message says. "
            "Shows the matching messages and says how many were found. "
            "When they refer to mail by its position in the list you last showed "
            "them, pass that position as `ordinal` instead of describing it. "
            "Reading never marks mail read and never archives, sends or deletes anything."
        ),
        handler=_read_mail,
        ui_refresh=("mail",),
    ),
    ToolSpec(
        name="open_mail",
        gateway_action_id="email.chat.turn",
        policy=ToolPolicy.read,
        input_model=OpenMailInput,
        output_model=MailOpenDispatched,
        description=(
            "Show the person the original message at a position in the list of mail "
            "you last showed them, when they ask to open it. Opens what is already "
            "on screen: it does not search, does not read the mailbox again, does "
            "not summarise, and does not mark anything read. Use read_mail instead "
            "when they want to know what a message says rather than to see it."
        ),
        handler=_open_mail,
    ),
    ToolSpec(
        name="send_mail",
        gateway_action_id="email.chat.turn",
        policy=ToolPolicy.confirm_voice,
        input_model=SendMailInput,
        output_model=SendMailResult,
        description=(
            "Prepare an email the owner dictates to a confirmed person. "
            "Use when they ask to send, write, or draft mail to a person by name. "
            "First resolve_person and confirm_person; pass only that canonical "
            "PersonRef as recipient. Preserve their dictated message in message "
            "and never invent an address, subject, or body. This tool opens an "
            "editable review card after spoken confirmation; it never sends. "
            "Only the owner's tap on Send in that card can deliver the email."
        ),
        handler=_send_mail,
        person_args=("recipient",),
        private_args=("subject", "message"),
        prepare=_prepare_send_mail,
        device_step=True,
    ),
    ToolSpec(
        name="reply_mail",
        gateway_action_id="email.chat.turn",
        policy=ToolPolicy.confirm_voice,
        input_model=ReplyMailInput,
        output_model=ReplyMailResult,
        description=(
            "Prepare a reply inside the same Gmail thread as an email you already "
            "showed the person. Use when they want to answer or respond to a "
            "particular email: by its position in the list you showed, the email "
            "they have open on screen, or the single email you just showed them. "
            "It needs what the reply should say: when they have not said, ask what "
            "they would like to say and do not call it yet. A reply goes only to "
            "whoever wrote that email, never to everyone on it: when they ask to "
            "reply to all, forward it, change its subject or attach something, do "
            "not call it; say that is not possible here and ask whether a reply to "
            "the sender alone would do. Never look the sender up as a person "
            "(resolve_person or list_people) for a reply: the server derives the "
            "recipient, subject and thread from the original email. Use send_mail "
            "instead for a new email to a named person, read_mail when they only "
            "want to know what mail says or what needs a reply, and open_mail when "
            "they only want to see it. If there is no email to answer yet, search "
            "their mail with read_mail first, then ask which one. After "
            "spoken confirmation it opens a review card with the reply; it never "
            "sends. Only the owner's tap on Send reply in that card delivers it."
        ),
        handler=_reply_mail,
        private_args=("message",),
        prepare=_prepare_reply_mail,
        device_step=True,
        # Names no person or circle: a lookup made for something else must not
        # cancel a reply card the person is answering.
        lookup_targets=(),
        target_key=_reply_target_key,
    ),
)
