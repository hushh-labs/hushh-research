"""Mail tools: read the owner's inbox and open a reviewed compose card.

No voice tool archives, labels, marks read, trashes, saves drafts, or sends.
``send_mail`` only proposes a first-party draft after spoken confirmation;
the existing owner's card owns every provider write.

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
from hushh_mcp.services.connections_service import ConnectionsService
from hushh_mcp.services.connector_feature_admission import connector_feature_enabled
from hushh_mcp.services.email_delegated_read import run_delegated_mail_read
from hushh_mcp.services.gmail_delivery_service import GmailDeliveryError, normalize_draft
from hushh_mcp.services.gmail_receipts_service import get_gmail_receipts_service

logger = logging.getLogger(__name__)

# The delegated read rejects anything longer than this itself; bounding it here
# keeps an oversized transcript out of the planner call entirely.
MAX_REQUEST_BYTES = 8000

# Injected by tests; built from the environment otherwise.
MAIL_ADMISSION_SERVICE = "voice_mail_admission"

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
        line = f"I checked {checked} messages."
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
        )
    else:
        ctx.entities.offered_mail = None
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
    if ctx.entities.offered_mail_message_id(args.ordinal) is None:
        shown = len(offer.message_ids)
        noun = "message" if shown == 1 else "messages"
        return Rejected(
            reason_code="mail_ordinal_not_offered",
            spoken_facts=[f"I only showed you {shown} {noun}. Which one did you mean?"],
        )
    return MailOpenDispatched(
        ordinal=args.ordinal,
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


async def _prepare_send_mail(ctx: ToolContext, args: SendMailInput) -> Prepared | ToolResult:
    person = ctx.entities.person(args.recipient.user_id)
    if person is None or person.relationship != "connected":
        return Rejected(
            reason_code="recipient_not_connected",
            spoken_facts=["I can draft only to a confirmed connection with an email address."],
        )
    row = await asyncio.to_thread(_mail_connection, ctx, args.recipient.user_id)
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
        return Rejected(
            reason_code="recipient_changed",
            spoken_facts=["That connection changed. I didn't open a draft; please ask again."],
        )
    row = await asyncio.to_thread(_mail_connection, ctx, args.recipient.user_id)
    address = _recipient_email(row, args.subject, args.message)
    if address is None:
        return _no_recipient_email(person.display_name)
    to_email, subject = address
    if not hmac.compare_digest(
        str(prepared.get("email_binding") or ""),
        _email_binding(ctx, args.recipient.user_id, to_email),
    ):
        return Rejected(
            reason_code="recipient_changed",
            spoken_facts=["That email address changed. I didn't open a draft; please ask again."],
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
)
