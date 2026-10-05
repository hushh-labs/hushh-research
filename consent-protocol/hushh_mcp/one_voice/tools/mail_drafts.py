"""Drafts tools: show the owner's Gmail drafts, open one, send one as it stands.

These are the owner's own unsent words, so the boundary is narrower than mail's
and in one place deliberately wider:

* **No draft text reaches the model.** ``list_drafts`` reads headers and
  snippets only, for the screen, and its model receipt is a count. A draft's To
  and Subject can be a third party's words (a reply's "Re: <their subject>", a
  display name the other side chose), so no address, subject or recipient name
  goes into a receipt, a card sentence or a refusal. ``open_draft`` is a
  dispatch, like ``open_mail``: the surface fetches the body through
  ``POST /api/one/voice/draft/open`` and nothing about it passes through this
  module.
* **Positions, never ids.** Every tool takes the position the person named in
  the list One last showed. The server resolves it against the offer it minted,
  fenced to the Google account the ids were listed in, and refuses an inbox
  offer -- the drafts list and the mail list share one offer slot.
* **A send is approved by voice and re-read twice.** ``send_draft`` reads the
  draft when the card is prepared and again after the yes. The card names the
  draft by its position in the list on screen; if the draft was edited, sent or
  deleted in Gmail in between, nothing is sent. A draft with no To recipient is
  refused. Only Gmail's own ``drafts.send`` delivers, under the owner's Send
  switch and the compose grant that method requires, and an earlier send that
  never confirmed is never repeated.

Discarding a draft is not offered: it needs a Gmail permission this product
only asks for explicitly.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
from typing import Any, Final, Literal

from pydantic import Field

from hushh_mcp.one_voice.config import OneVoiceMailAdmission
from hushh_mcp.one_voice.tools.base import (
    OfferedMail,
    Prepared,
    Rejected,
    ToolContext,
    ToolInput,
    ToolPolicy,
    ToolResult,
    ToolSpec,
)
from hushh_mcp.one_voice.tools.mail import DRAFTS_MAILBOX, MAIL_ADMISSION_SERVICE
from hushh_mcp.runtime_settings import get_core_security_settings
from hushh_mcp.services import gmail_drafts_service
from hushh_mcp.services.connector_feature_admission import connector_feature_enabled
from hushh_mcp.services.gmail_receipts_service import GmailApiError

logger = logging.getLogger(__name__)

# The provider boundary, injected by tests; the real drafts service otherwise.
MAIL_DRAFTS_SERVICE = "voice_mail_drafts"

DRAFT_OPEN_DISPATCHED: Final = "draft_open_dispatched"
DRAFT_SENT: Final = "draft_sent"
DRAFT_SEND_UNCONFIRMED: Final = "draft_send_unconfirmed"


class _DraftsGateway:
    """The drafts service with the context's Gmail connection bound in."""

    def __init__(self, gmail: Any) -> None:
        self._gmail = gmail

    async def list(self, *, user_id: str, max_results: int) -> dict[str, Any]:
        listed: dict[str, Any] = await gmail_drafts_service.list_gmail_drafts(
            user_id=user_id, max_results=max_results, gmail=self._gmail
        )
        return listed

    async def get(self, *, user_id: str, draft_id: str, expect_account: str) -> dict[str, Any]:
        draft: dict[str, Any] = await gmail_drafts_service.get_gmail_draft(
            user_id=user_id, draft_id=draft_id, expect_account=expect_account, gmail=self._gmail
        )
        return draft

    async def assert_send_ready(self, *, user_id: str) -> None:
        await gmail_drafts_service.assert_draft_send_ready(user_id=user_id, gmail=self._gmail)

    async def send(
        self, *, user_id: str, draft_id: str, expect_account: str, recipient_count: int
    ) -> dict[str, Any]:
        sent: dict[str, Any] = await gmail_drafts_service.send_gmail_draft(
            user_id=user_id,
            draft_id=draft_id,
            expect_account=expect_account,
            recipient_count=recipient_count,
            gmail=self._gmail,
        )
        return sent


def _drafts(ctx: ToolContext) -> Any:
    injected = ctx.services.get(MAIL_DRAFTS_SERVICE)
    return injected if injected is not None else _DraftsGateway(ctx.services.get("gmail"))


def _unavailable(reason_code: str) -> Rejected:
    return Rejected(
        reason_code=reason_code,
        spoken_facts=["I can't look at your drafts right now."],
    )


def _gates(ctx: ToolContext) -> Rejected | None:
    """Re-checked at list, open, prepare and confirm: each is its own release."""
    admission = ctx.service(MAIL_ADMISSION_SERVICE, OneVoiceMailAdmission)
    if not admission.mail_drafts_enabled():
        return Rejected(
            reason_code="voice_mail_drafts_disabled",
            spoken_facts=["Drafts are switched off for me right now."],
        )
    if not admission.mail_reads_enabled():
        return _unavailable("voice_mail_reads_disabled")
    if not connector_feature_enabled("gmail_chat_reads", ctx.user_id):
        return _unavailable("mail_reads_unavailable")
    return None


# Connection refusals, by the receipts service's code. Connection state only.
_READ_REFUSALS: dict[str, tuple[str, str]] = {
    "GMAIL_NOT_CONNECTED": ("mail_connect_required", "Mail isn't connected, so I couldn't look."),
    "GMAIL_READ_PERMISSION_REQUIRED": (
        "mail_reconnect_required",
        "Mail needs reconnecting before I can look at your drafts.",
    ),
    "GMAIL_PERMISSION_DENIED": (
        "mail_reconnect_required",
        "Mail needs reconnecting before I can look at your drafts.",
    ),
    "GMAIL_ACCOUNT_CHANGED": (
        "mail_account_changed",
        "Your Mail connection changed since I showed that list. Ask me to show your drafts again.",
    ),
}
_SEND_NOT_READY: dict[str, tuple[str, str]] = {
    "GMAIL_NOT_CONNECTED": (
        "mail_connect_required",
        "Mail isn't connected, so I can't send a draft.",
    ),
    "GMAIL_SEND_PERMISSION_REQUIRED": (
        "send_permission_required",
        "Mail sending isn't allowed yet. Reconnect Mail to allow sending, then ask again.",
    ),
    "GMAIL_SEND_DISABLED": (
        "send_permission_required",
        "Mail sending is turned off. Turn it on in Mail settings, then ask again.",
    ),
    # Gmail sends a saved draft only under its drafts permission; the plain send
    # grant is not enough for that method.
    "GMAIL_COMPOSE_PERMISSION_REQUIRED": (
        "drafts_permission_required",
        "Sending a saved draft needs Gmail's drafts permission. Turn on Gmail drafts "
        "in Mail settings, then ask again.",
    ),
}


def _read_refused(exc: GmailApiError, stage: str) -> Rejected:
    code = str(exc.code or "")
    logger.info("one_voice.mail_drafts reason=%s stage=%s", code.lower()[:23], stage)
    reason, fact = _READ_REFUSALS.get(
        code, ("drafts_unavailable", "I couldn't look at your drafts just now.")
    )
    return Rejected(reason_code=reason, spoken_facts=[fact])


def _list_facts(count: int, has_more: bool) -> list[str]:
    """Counts only. A draft's To and Subject can be a third party's words -- a
    reply's "Re: <their subject>", a display name the other side chose -- so
    they stay on the screen and never reach the model."""
    if count == 0:
        return ["You don't have any drafts."]
    line = (
        "You have 1 draft. It's on your screen."
        if count == 1
        else f"You have {count} drafts. They're on your screen."
    )
    if has_more:
        line += " There are more in Gmail than I listed."
    return [line]


class ListDraftsInput(ToolInput):
    limit: int = Field(
        default=10,
        ge=1,
        le=gmail_drafts_service.DRAFTS_LIST_MAX,
        description="How many drafts to show. Leave it out for ten.",
    )


class DraftsListResult(ToolResult):
    """The drafts for the screen, and a receipt for the model.

    ``items`` carry the owner's draft headers and a snippet and never reach
    ``model_public``. The offer binding travels with the rows, as it does for a
    mail list, so a tap or "open the second one" resolves against this list.
    """

    items: list[dict[str, Any]] = Field(default_factory=list)
    coverage: dict[str, Any] = Field(default_factory=dict)
    offer_revision: int | None = None
    conversation_id: str = ""

    def model_public(self) -> dict[str, Any]:
        """A count, whether more exist, and the server's own sentence."""
        return {
            "status": self.status,
            "coverage": {
                key: self.coverage[key] for key in ("returned", "has_more") if key in self.coverage
            },
            "spoken_facts": list(self.spoken_facts),
        }


async def _list_drafts(ctx: ToolContext, args: ListDraftsInput) -> ToolResult:
    refused = _gates(ctx)
    if refused is not None:
        return refused
    try:
        listed = await _drafts(ctx).list(user_id=ctx.user_id, max_results=args.limit)
    except GmailApiError as exc:
        return _read_refused(exc, "list")
    # The handler's return is the release point; nothing downstream re-checks.
    refused = _gates(ctx)
    if refused is not None:
        return refused
    drafts = [row for row in listed.get("drafts") or [] if isinstance(row, dict)]
    items = [
        {
            "source_ref": f"draft:{position}",
            "to": str(row.get("to_label") or ""),
            "subject": str(row.get("subject") or ""),
            "snippet": str(row.get("snippet") or ""),
            "updated_at": row.get("updated_at_iso"),
        }
        for position, row in enumerate(drafts, start=1)
    ]
    draft_ids = [str(row.get("draft_id") or "") for row in drafts]
    offer_revision: int | None = None
    if items and all(draft_ids):
        # Replaced, never merged, exactly like a mail list: the newest list on
        # screen is the only one a position can mean.
        offer_revision = ctx.entities.offer_mail(
            draft_ids, account=str(listed.get("account") or ""), mailbox=DRAFTS_MAILBOX
        )
    else:
        ctx.entities.offered_mail = None
        ctx.entities.offered_mail_selected_ordinal = None
    has_more = bool(listed.get("has_more"))
    return DraftsListResult(
        status="ok" if items else "empty",
        items=items,
        coverage={"returned": len(items), "has_more": has_more},
        offer_revision=offer_revision,
        conversation_id=ctx.conversation_id,
        spoken_facts=_list_facts(len(items), has_more),
    )


class OpenDraftInput(ToolInput):
    ordinal: int = Field(
        ge=1,
        le=25,
        description=(
            "The position the person named in the list of drafts you last showed them "
            "('open the second one' is 2). The surface opens the exact draft it already "
            "showed at that position. Never guess a position that was not in that list."
        ),
    )


class DraftOpenDispatched(ToolResult):
    """Ask the surface to open a draft row it is already showing. Carries no draft."""

    status: str = DRAFT_OPEN_DISPATCHED
    ordinal: int = 0
    offer_revision: int = 0
    conversation_id: str = ""

    def model_public(self) -> dict[str, Any]:
        return {"status": self.status, "spoken_facts": list(self.spoken_facts)}


def _resolve_offer(ctx: ToolContext, ordinal: int) -> tuple[OfferedMail, int, str] | Rejected:
    """The offered draft at a spoken position, or the honest reason there is none."""
    offer = ctx.entities.offered_mail
    if offer is None or not ctx.entities.offered_mail_is_fresh():
        return Rejected(
            reason_code="draft_offer_expired",
            spoken_facts=["That drafts list is a while old. Ask me to show your drafts again."],
        )
    if offer.mailbox != DRAFTS_MAILBOX:
        return Rejected(
            reason_code="draft_offer_is_mail",
            spoken_facts=[
                "That list is your mail, not your drafts. Ask me to show your drafts first."
            ],
        )
    position = ctx.entities.offered_mail_position(ordinal)
    draft_id = ctx.entities.offered_mail_message_id(ordinal)
    if position is None or draft_id is None:
        shown = len(offer.message_ids)
        noun = "draft" if shown == 1 else "drafts"
        return Rejected(
            reason_code="draft_ordinal_not_offered",
            spoken_facts=[f"I only showed you {shown} {noun}. Which one did you mean?"],
        )
    return offer, position, draft_id


async def _open_draft(ctx: ToolContext, args: OpenDraftInput) -> ToolResult:
    refused = _gates(ctx)
    if refused is not None:
        return refused
    resolved = _resolve_offer(ctx, args.ordinal)
    if isinstance(resolved, Rejected):
        return resolved
    offer, position, _draft_id = resolved
    # No provider read here: the surface fetches the draft through the route,
    # so the body never passes through this handler or the model.
    return DraftOpenDispatched(
        ordinal=position,
        offer_revision=offer.revision,
        conversation_id=ctx.conversation_id,
        spoken_facts=["Opening it."],
    )


class SendDraftInput(ToolInput):
    ordinal: int = Field(
        ge=1,
        le=25,
        description=(
            "The position the person named in the list of drafts you last showed them "
            "('send the second one' is 2). The server resolves it to the draft it "
            "showed there. Never guess a position that was not in that list."
        ),
    )


class DraftSendResult(ToolResult):
    status: Literal["draft_sent", "draft_send_unconfirmed"] = DRAFT_SENT

    def model_public(self) -> dict[str, Any]:
        return {"status": self.status, "spoken_facts": list(self.spoken_facts)}


def _binding(ctx: ToolContext, purpose: str, value: str) -> str:
    secret = get_core_security_settings().app_signing_key
    if not secret:
        raise ValueError("voice drafts binding key is unavailable")
    material = f"one-voice-send-draft-v1:{purpose}:{ctx.user_id}:{value}"
    return hmac.new(secret.encode("utf-8"), material.encode("utf-8"), hashlib.sha256).hexdigest()


def _send_draft_target_key(ctx: ToolContext, args: SendDraftInput) -> str | None:
    """Which draft a send card is about, without its id in the pending row."""
    resolved = _resolve_offer(ctx, args.ordinal)
    if isinstance(resolved, Rejected):
        return None
    offer, _position, draft_id = resolved
    return _binding(ctx, "target", f"{offer.account}:{draft_id}")[:32]


def _draft_version(ctx: ToolContext, draft: dict[str, Any]) -> str:
    # Gmail gives a draft a new message id on every edit, so this names the exact
    # text the owner approved without keeping any of it.
    return _binding(ctx, "version", f"{draft.get('draft_id')}:{draft.get('message_id')}")


async def _send_ready(ctx: ToolContext) -> Rejected | None:
    try:
        await _drafts(ctx).assert_send_ready(user_id=ctx.user_id)
    except GmailApiError as exc:
        reason, fact = _SEND_NOT_READY.get(
            str(exc.code or ""), _SEND_NOT_READY["GMAIL_SEND_PERMISSION_REQUIRED"]
        )
        return Rejected(reason_code=reason, spoken_facts=[fact])
    return None


async def _read_draft(
    ctx: ToolContext, draft_id: str, offer: OfferedMail, *, gone: str, stage: str
) -> dict[str, Any] | Rejected:
    try:
        draft: dict[str, Any] = await _drafts(ctx).get(
            user_id=ctx.user_id, draft_id=draft_id, expect_account=offer.account
        )
    except GmailApiError as exc:
        if exc.code == "GMAIL_DRAFT_NOT_FOUND":
            return Rejected(reason_code="draft_gone", spoken_facts=[gone])
        return _read_refused(exc, stage)
    return draft


async def _prepare_send_draft(ctx: ToolContext, args: SendDraftInput) -> Prepared | ToolResult:
    refused = _gates(ctx)
    if refused is not None:
        return refused
    resolved = _resolve_offer(ctx, args.ordinal)
    if isinstance(resolved, Rejected):
        return resolved
    offer, position, draft_id = resolved
    # Readiness before the card, not at the yes: a card that can never be sent
    # is a promise followed by a refusal.
    not_ready = await _send_ready(ctx)
    if not_ready is not None:
        return not_ready
    draft = await _read_draft(
        ctx, draft_id, offer, gone="That draft is gone, so I didn't send it.", stage="prepare"
    )
    if isinstance(draft, Rejected):
        return draft
    if not draft.get("recipient_count"):
        return Rejected(
            reason_code="draft_has_no_recipient",
            spoken_facts=["That draft has no recipient yet, so I can't send it."],
        )
    if not draft.get("to_list"):
        # Only Cc or Bcc: a card could name no one the owner would recognise as
        # the person it goes to.
        return Rejected(
            reason_code="draft_no_to_recipient",
            spoken_facts=[
                "That draft has no To recipient, so I didn't send it. "
                "Open it in Gmail to check who it goes to."
            ],
        )
    return Prepared(
        # The card and the model read this sentence, and the pending row keeps
        # it. A position is safe to say; the draft's To and Subject can be a
        # third party's words, so they stay on the screen.
        summary=f"send draft {position} in your list now",
        snapshot={
            "offer_revision": offer.revision,
            "draft_version": _draft_version(ctx, draft),
        },
    )


async def _send_draft(ctx: ToolContext, args: SendDraftInput) -> ToolResult:
    refused = _gates(ctx)
    if refused is not None:
        return refused
    prepared = ctx.prepared or {}
    offer = ctx.entities.offered_mail
    if (
        offer is None
        or offer.mailbox != DRAFTS_MAILBOX
        or offer.revision != prepared.get("offer_revision")
    ):
        return Rejected(
            reason_code="draft_list_changed",
            spoken_facts=[
                "Your drafts changed since I asked, so I didn't send it. "
                "Ask me to show your drafts again."
            ],
        )
    resolved = _resolve_offer(ctx, args.ordinal)
    if isinstance(resolved, Rejected):
        return resolved
    _offer, _position, draft_id = resolved
    not_ready = await _send_ready(ctx)
    if not_ready is not None:
        return not_ready
    # Read again after the yes: what goes out must be what the card named.
    draft = await _read_draft(
        ctx,
        draft_id,
        offer,
        gone=(
            "That draft isn't in Gmail anymore. It may have been sent or deleted there. "
            "I didn't send anything."
        ),
        stage="confirm",
    )
    if isinstance(draft, Rejected):
        return draft
    if not hmac.compare_digest(
        str(prepared.get("draft_version") or ""), _draft_version(ctx, draft)
    ):
        return Rejected(
            reason_code="draft_changed",
            spoken_facts=[
                "That draft changed since I asked, so I didn't send it. "
                "Ask me again to send it as it is now."
            ],
        )
    try:
        sent = await _drafts(ctx).send(
            user_id=ctx.user_id,
            draft_id=draft_id,
            expect_account=offer.account,
            recipient_count=int(draft.get("recipient_count") or 1),
        )
    except GmailApiError as exc:
        code = str(exc.code or "")
        logger.info("one_voice.mail_drafts reason=%s stage=send", code.lower()[:23])
        if code == "GMAIL_DRAFT_ALREADY_SENT":
            return Rejected(
                reason_code="draft_already_sent", spoken_facts=["That draft was already sent."]
            )
        if code == "GMAIL_DRAFT_NOT_FOUND":
            return Rejected(
                reason_code="draft_gone",
                spoken_facts=["That draft was already sent or deleted, so I didn't send it."],
            )
        if code in _SEND_NOT_READY:
            reason, fact = _SEND_NOT_READY[code]
            return Rejected(reason_code=reason, spoken_facts=[fact])
        return Rejected(
            reason_code="draft_send_failed",
            spoken_facts=["Gmail couldn't send that draft. Nothing was sent."],
        )
    if sent.get("state") == "sent":
        return DraftSendResult(status=DRAFT_SENT, spoken_facts=["Sent."])
    if sent.get("state") == "previous_unconfirmed":
        # Gmail was not asked this turn: an earlier ask may have delivered it.
        return Rejected(
            reason_code="draft_prior_unconfirmed",
            spoken_facts=[
                "An earlier send of this draft didn't confirm, so I didn't send it again. "
                "Check your Sent folder."
            ],
        )
    return DraftSendResult(
        status=DRAFT_SEND_UNCONFIRMED,
        spoken_facts=[
            "I asked Gmail to send it, but I couldn't confirm it went through. "
            "Check your Sent folder before sending it again."
        ],
    )


TOOLS: tuple[ToolSpec, ...] = (
    ToolSpec(
        name="list_drafts",
        gateway_action_id="email.chat.turn",
        policy=ToolPolicy.read,
        input_model=ListDraftsInput,
        output_model=DraftsListResult,
        description=(
            "Show the owner's Gmail drafts: who each is to, its subject, and how old "
            "it is. Use when they ask about their drafts. You learn only how many "
            "there are; the list appears on screen. Bodies are never read by the list."
        ),
        handler=_list_drafts,
    ),
    ToolSpec(
        name="open_draft",
        gateway_action_id="email.chat.turn",
        policy=ToolPolicy.read,
        input_model=OpenDraftInput,
        output_model=DraftOpenDispatched,
        description=(
            "Show the owner the full text of one draft from the list of drafts you "
            "last showed them, when they ask to open it. Pass that draft's position "
            "in the list (ordinal); never invent a draft id. It opens what is "
            "already on screen and does not read it to you."
        ),
        handler=_open_draft,
    ),
    ToolSpec(
        name="send_draft",
        gateway_action_id="email.chat.turn",
        policy=ToolPolicy.confirm_voice,
        input_model=SendDraftInput,
        output_model=DraftSendResult,
        description=(
            "Send — never delete — one of the owner's Gmail drafts, now, after spoken "
            "confirmation. Deleting or discarding a draft is not possible here: say so "
            "and prepare nothing. A draft cannot be scheduled here: when they name any "
            "later time (tomorrow, at nine, tonight), say so, ask whether to send it "
            "now, and prepare nothing. Use it for a draft they picked from the list of "
            "drafts you showed; it goes as-is. Use send_mail for a new email they "
            "dictate now."
        ),
        handler=_send_draft,
        prepare=_prepare_send_draft,
        ui_refresh=("mail",),
        # Names no person or circle: a lookup made for something else must not
        # cancel a send card the person is answering.
        lookup_targets=(),
        target_key=_send_draft_target_key,
    ),
)
