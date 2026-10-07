"""Session-private compose revisions over the existing Gmail delivery ledger.

Only opaque references enter model results/pending storage. The editable envelope
lives in this owner's live session. A new voice session needs a fresh review;
the still-visible owner card can tap its existing action until ledger expiry.
"""

from __future__ import annotations

import asyncio
import secrets
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from pydantic import Field

from hushh_mcp.one_voice.tools.base import (
    Prepared,
    Rejected,
    ToolContext,
    ToolInput,
    ToolPolicy,
    ToolResult,
    ToolSpec,
)
from hushh_mcp.one_voice.tools.mail_recipients import RecipientSource, resolve_recipient_sources
from hushh_mcp.services.gmail_delivery_service import (
    GmailDeliveryError,
    GmailDeliveryService,
    get_owner_send_action,
    normalize_draft,
)
from hushh_mcp.services.gmail_receipts_service import GmailApiError


class ComposeResult(ToolResult):
    draft_ref: str = ""
    revision: int = 0
    client_step: dict[str, Any] | None = None

    def model_public(self) -> dict[str, Any]:
        return self.model_dump(mode="json", exclude={"client_step"})


@dataclass
class ComposeDraft:
    ref: str
    draft: dict[str, Any]
    revision: int = 1
    rendered: bool = False
    review_epoch: int = 0
    state: str = "composing"
    prepared: dict[str, Any] = field(default_factory=dict)
    recipients: Any = None
    operations: set[str] = field(default_factory=set)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


_RECOVERY = {
    "GMAIL_SEND_DISABLED": "Turn on Gmail sending to continue. Your draft is still here.",
    "GMAIL_SEND_PERMISSION_REQUIRED": "Reconnect Gmail and allow sending, then review this draft again.",
    "GMAIL_NOT_CONNECTED": "Connect Gmail to send this email. Your draft is still here.",
    "GMAIL_RECONNECT_REQUIRED": "Reconnect Gmail, then review this draft again.",
    "GMAIL_SENDER_CHANGED": "The sending account changed. Review this draft again.",
    "DRAFT_CHANGED": "This draft changed. Review it again before sending.",
}


def _refusal(reason: str, fact: str) -> Rejected:
    return Rejected(reason_code=reason, spoken_facts=[fact])


def _same_destinations(before: dict[str, Any], after: dict[str, Any]) -> bool:
    """A full typed snapshot does not itself change a connection's authority."""
    try:
        previous, current = (
            normalize_draft(
                {**{key: value.get(key) for key in ("to", "cc", "bcc")}, "body": "check"}
            )
            for value in (before, after)
        )
        return (previous.to, previous.cc, previous.bcc) == (current.to, current.cc, current.bcc)
    except GmailDeliveryError:
        return False


class MailComposeRuntime:
    def __init__(
        self,
        *,
        review_supported: bool = False,
        input_generation: Callable[[], int] | None = None,
        input_active: Callable[[], bool] | None = None,
        approval_input: Callable[[], tuple[int, bool] | None] | None = None,
    ) -> None:
        self.review_supported = review_supported
        self.input_generation = input_generation
        self.input_active = input_active
        self.approval_input = approval_input
        self.tasks: dict[str, ComposeDraft] = {}

    def current(self, ref: str, revision: int) -> ComposeDraft | Rejected:
        task = self.tasks.get(ref)
        if task is None:
            return _refusal(
                "draft_unavailable", "That draft is no longer available. Please prepare it again."
            )
        if task.revision != revision:
            return _refusal(
                "draft_stale", "The draft changed. Review its current version before sending."
            )
        return task

    @staticmethod
    def delivery(ctx: ToolContext) -> Any:
        return ctx.service("gmail_delivery", GmailDeliveryService)

    @staticmethod
    def result(task: ComposeDraft, **kwargs: Any) -> ComposeResult:
        return ComposeResult(draft_ref=task.ref, revision=task.revision, **kwargs)

    def needs_input(self, task: ComposeDraft, *, reason: str, fact: str) -> ComposeResult:
        task.state = "needs_input"
        return self.result(
            task,
            status="needs_input",
            needs="client_step",
            reason_code=reason,
            spoken_facts=[fact],
            client_step={
                "kind": "review_mail_draft",
                "draft_ref": task.ref,
                "revision": task.revision,
                "draft": dict(task.draft),
                "prepared": None,
                "reason_code": reason,
            },
        )

    async def _retire_action(self, ctx: ToolContext, action: str) -> dict[str, Any]:
        result = await self.delivery(ctx).cancel_prepared(user_id=ctx.user_id, action_id=action)
        if isinstance(result, dict):
            if result.get("action_id", action) != action:
                return {"cancelled": False, "state": "unverified"}
            return result
        return {
            "cancelled": result is True,
            "state": "cancelled" if result is True else "unverified",
        }

    async def create(
        self, ctx: ToolContext, draft: dict[str, Any], *, recipients: Any = None
    ) -> ToolResult:
        if not self.review_supported:
            return _refusal(
                "review_unavailable", "Open the private Mail review to compose this email."
            )
        active = next(
            (t for t in self.tasks.values() if t.state not in {"sent", "cancelled", "failed"}), None
        )
        if active is not None:
            return self.result(
                active,
                status="draft_already_open",
                spoken_facts=["An email draft is already open. Edit or cancel that draft first."],
            )
        if len(self.tasks) >= 16:
            self.tasks.pop(next(iter(self.tasks)))
        task = ComposeDraft(
            ref=secrets.token_urlsafe(18),
            draft={"to": "", "cc": "", "bcc": "", "subject": "", "body": "", **draft},
            recipients=recipients,
        )
        self.tasks[task.ref] = task
        async with task.lock:
            return await self._prepare(ctx, task)

    async def _prepare(self, ctx: ToolContext, task: ComposeDraft) -> ToolResult:
        task.rendered = False
        task.review_epoch += 1
        expected_epoch = task.review_epoch
        expected_revision = task.revision
        task.state = "composing"
        try:
            normalize_draft(task.draft)
            if not str(task.draft.get("body") or "").strip():
                raise GmailDeliveryError("INVALID_DRAFT", "Add the message you want to send.")
            prepared = await self.delivery(ctx).prepare(
                user_id=ctx.user_id,
                draft_payload={
                    **task.draft,
                    "draft_ref": task.ref,
                    "revision": task.revision,
                    "_connection_recipient_ids": [
                        source.person.user_id
                        for source in task.recipients.sources
                        if source.kind == "connection" and source.person
                    ]
                    if task.recipients
                    else [],
                },
                idempotency_key=f"voice:{ctx.conversation_id}:{task.ref}:{task.revision}",
            )
        except (GmailDeliveryError, GmailApiError) as exc:
            if task.revision != expected_revision or task.review_epoch != expected_epoch:
                return _refusal("draft_stale", "The draft changed while its review was preparing.")
            return self.needs_input(
                task,
                reason=exc.code,
                fact=_RECOVERY.get(
                    exc.code,
                    "Check the address and message in this draft, then review it again.",
                ),
            )
        except Exception:  # no private exception text in model results
            if task.revision != expected_revision or task.review_epoch != expected_epoch:
                return _refusal("draft_stale", "The draft changed while its review was preparing.")
            return self.needs_input(
                task,
                reason="mail_prepare_unavailable",
                fact="I couldn't prepare sending just now. Your draft is still here.",
            )
        if task.revision != expected_revision or task.review_epoch != expected_epoch:
            if prepared.get("action_id"):
                # Keep the issued action until its retirement is verified. Even
                # a review we never displayed can have a durable ledger row.
                task.prepared = prepared
                try:
                    retired = await self._retire_action(ctx, prepared["action_id"])
                except Exception:
                    task.state = "blocked"
                else:
                    if retired.get("cancelled") or retired.get("state") in {
                        "cancelled",
                        "expired",
                        "failed",
                    }:
                        task.prepared = {}
                        task.state = "composing"
                    else:
                        task.state = "outcome_unknown"
            return _refusal("draft_stale", "The draft changed while its review was preparing.")
        if (
            prepared.get("state") != "prepared"
            or not prepared.get("action_id")
            or not prepared.get("sender_token")
        ):
            return self.needs_input(
                task,
                reason="mail_prepare_unverified",
                fact="I couldn't verify this review. Nothing was sent.",
            )
        task.prepared = prepared
        task.state = "review_pending"
        return self.result(
            task,
            status="review_requested",
            needs="client_step",
            spoken_facts=["I'm opening the exact email for review. Nothing has been sent."],
            client_step={
                "kind": "review_mail_draft",
                "draft_ref": task.ref,
                "revision": task.revision,
                "draft": dict(task.draft),
                "prepared": dict(prepared),
            },
        )

    def mark_reviewed(self, ref: str, revision: int, action_id: str) -> bool:
        task = self.current(ref, revision)
        if (
            isinstance(task, Rejected)
            or task.state != "review_pending"
            or task.prepared.get("action_id") != action_id
        ):
            return False
        task.rendered, task.state = True, "review_ready"
        return True

    async def edit(
        self,
        ctx: ToolContext,
        ref: str,
        revision: int,
        patch: dict[str, Any],
        *,
        operation_id: str,
        recipients: Any = None,
    ) -> ToolResult:
        task = self.current(ref, revision)
        if isinstance(task, Rejected):
            return task
        task.rendered = False
        task.review_epoch += 1
        async with task.lock:
            if task.revision != revision:
                return _refusal("draft_stale", "The draft changed. Use its current review.")
            if operation_id in task.operations:
                return self.result(task, status=task.state, spoken_facts=[])
            if task.state in {"sending", "sent", "outcome_unknown", "cancelled"}:
                return _refusal(
                    "draft_not_editable",
                    "That send has already started or ended. Check its status before preparing another email.",
                )
            task.rendered = False
            old_action = str(task.prepared.get("action_id") or "")
            if old_action:
                try:
                    cancelled = await self._retire_action(ctx, old_action)
                except Exception:
                    task.state = "blocked"
                    return self.result(
                        task,
                        status="needs_input",
                        reason_code="review_retirement_unavailable",
                        spoken_facts=[
                            "I couldn't retire the previous review. Sending is blocked; check its status."
                        ],
                    )
                if not cancelled.get("cancelled") and cancelled.get("state") not in {
                    "cancelled",
                    "expired",
                    "failed",
                }:
                    task.state = "outcome_unknown"
                    return self.result(
                        task,
                        status="outcome_unknown",
                        spoken_facts=[
                            "The previous send may already be in progress. I won't send another copy."
                        ],
                    )
            # The old action is now provably unsendable. Only now can a new
            # revision replace it; a failed retirement must remain recoverable.
            task.prepared = {}
            task.revision += 1
            task.operations.add(operation_id)
            destinations_changed = any(
                k in patch for k in ("to", "cc", "bcc")
            ) and not _same_destinations(task.draft, {**task.draft, **patch})
            task.draft.update(
                {k: v for k, v in patch.items() if k in {"to", "cc", "bcc", "subject", "body"}}
            )
            if recipients is not None:
                task.recipients = recipients
            elif destinations_changed:
                task.recipients = None
            return await self._prepare(ctx, task)

    async def invalidate(self, ctx: ToolContext, ref: str, revision: int) -> ToolResult | None:
        task = self.current(ref, revision)
        if isinstance(task, Rejected):
            return task
        task.rendered = False
        task.review_epoch += 1
        async with task.lock:
            if task.revision != revision:
                return _refusal("draft_stale", "The draft changed. Use its current review.")
            if task.state in {"sending", "sent", "outcome_unknown", "cancelled"}:
                return self.result(task, status=task.state, spoken_facts=[])
            action = str(task.prepared.get("action_id") or "")
            if action:
                try:
                    settled = await self._retire_action(ctx, action)
                except Exception:
                    task.state = "blocked"
                    return _refusal(
                        "review_retirement_unavailable",
                        "Sending is blocked until the previous review can be retired.",
                    )
                if not settled.get("cancelled") and settled.get("state") not in {
                    "cancelled",
                    "expired",
                    "failed",
                }:
                    task.state = "outcome_unknown"
                    return self.result(
                        task,
                        status="outcome_unknown",
                        spoken_facts=[
                            "The send may already be in progress. I won't send another copy."
                        ],
                    )
            task.prepared = {}
            task.state = "composing"
        return None

    async def cancel(self, ctx: ToolContext, ref: str, revision: int) -> ToolResult:
        task = self.current(ref, revision)
        if isinstance(task, Rejected):
            return task
        task.rendered = False
        task.review_epoch += 1
        async with task.lock:
            if task.revision != revision:
                return _refusal("draft_stale", "The draft changed. Use its current review.")
            if task.state in {"sent", "sending", "outcome_unknown"}:
                return self.result(
                    task,
                    status=task.state,
                    spoken_facts=[
                        "Sending may already have started. Cancellation cannot recall an email."
                    ],
                )
            action = str(task.prepared.get("action_id") or "")
            if action:
                try:
                    result = await self._retire_action(ctx, action)
                except Exception:
                    task.state = "blocked"
                    return self.result(
                        task,
                        status="outcome_unknown",
                        spoken_facts=["I couldn't verify cancellation. I won't send another copy."],
                    )
                if not result.get("cancelled") and result.get("state") not in {
                    "cancelled",
                    "expired",
                    "failed",
                }:
                    task.state = "outcome_unknown"
                    return self.result(
                        task,
                        status="outcome_unknown",
                        spoken_facts=[
                            "Sending may already be in progress. Check the message status."
                        ],
                    )
            task.state = "cancelled"
            task.draft.clear()
            task.recipients = None
            task.prepared = {}
            return self.result(
                task, status="cancelled", spoken_facts=["The unsent email was cancelled."]
            )

    def prepare_send(self, ref: str, revision: int) -> Prepared | Rejected:
        task = self.current(ref, revision)
        if isinstance(task, Rejected):
            return task
        if not task.rendered or task.state != "review_ready":
            return _refusal(
                "draft_not_reviewed",
                "Review the current email on screen before approving its send.",
            )
        expires = task.prepared.get("expires_at")
        try:
            if isinstance(expires, str):
                expires = datetime.fromisoformat(expires.replace("Z", "+00:00"))
        except ValueError:
            expires = None
        if not isinstance(expires, datetime) or expires.replace(
            tzinfo=expires.tzinfo or timezone.utc
        ) <= datetime.now(timezone.utc):
            return _refusal(
                "draft_expired", "The review expired. Review the email again before sending."
            )
        return Prepared(
            summary="send this reviewed email now",
            snapshot={
                "draft_ref": ref,
                "revision": revision,
                "action_id": task.prepared["action_id"],
                **(
                    {"proposal_input_generation": self.input_generation()}
                    if self.input_generation
                    else {}
                ),
            },
        )

    async def send(self, ctx: ToolContext, ref: str, revision: int) -> ToolResult:
        # Admission belongs to the received confirmation, before any queue,
        # proof, ledger or task-lock await. Never recapture a later utterance.
        admitted = (
            self.approval_input()
            if self.approval_input
            else (
                (self.input_generation(), bool(self.input_active and self.input_active()))
                if self.input_generation
                else None
            )
        )
        task = self.current(ref, revision)
        if isinstance(task, Rejected):
            return task
        async with task.lock:
            if task.revision != revision:
                return _refusal("draft_stale", "The draft changed. Use its current review.")
            if task.state in {"sent", "outcome_unknown", "failed", "sending"}:
                return self.result(
                    task,
                    status=task.state,
                    spoken_facts=["That send was already attempted. I won't send another copy."],
                )
            prepared = self.prepare_send(ref, revision)
            if isinstance(prepared, Rejected):
                return prepared
            approval = dict(ctx.prepared or {})
            proposed_generation = approval.pop("proposal_input_generation", None)
            expected = dict(prepared.snapshot)
            expected.pop("proposal_input_generation", None)
            if self.input_generation is not None and (
                type(proposed_generation) is not int
                or admitted is None
                or admitted[1]
                or admitted[0] <= proposed_generation
                or self.input_generation() != admitted[0]
                or (self.input_active and self.input_active())
            ):
                return _refusal(
                    "send_approval_required",
                    "Please answer the send-specific review before sending.",
                )
            if approval != expected:
                return _refusal(
                    "review_binding_changed", "This approval belongs to a different email review."
                )
            expected_epoch = task.review_epoch
            approval_generation = admitted[0] if admitted else None
            approval_epoch = task.review_epoch

            def authorization_check() -> bool:
                return (
                    (
                        self.input_generation is None
                        or self.input_generation() == approval_generation
                    )
                    and not (self.input_active and self.input_active())
                    and task.review_epoch == approval_epoch
                    and task.revision == revision
                )

            if task.recipients is not None:
                from hushh_mcp.one_voice.tools.mail_recipients import revalidate_recipient_sources

                checked = await revalidate_recipient_sources(ctx, task.recipients)
                if isinstance(checked, Rejected):
                    task.rendered = False
                    return checked
            # A local edit/cancel can arrive while recipient validation awaits
            # I/O. Its synchronous fence takes priority over the old approval.
            if not task.rendered or task.review_epoch != expected_epoch:
                return _refusal(
                    "draft_changed", "The draft changed. Review it again before sending."
                )
            task.state, task.rendered = "sending", False
            try:
                result = await self.delivery(ctx).execute(
                    user_id=ctx.user_id,
                    action_id=task.prepared["action_id"],
                    authorization_check=authorization_check,
                    draft_payload={
                        **task.draft,
                        "draft_ref": ref,
                        "revision": revision,
                        "sender_token": task.prepared["sender_token"],
                    },
                )
                state = (
                    "sent"
                    if result.get("state") == "sent"
                    and result.get("action_id") == task.prepared["action_id"]
                    else "outcome_unknown"
                )
                reason = None
            except (GmailDeliveryError, GmailApiError) as exc:
                state = (
                    "failed"
                    if exc.code
                    in {
                        *_RECOVERY,
                        "RECIPIENT_CHANGED",
                        "GMAIL_SEND_FAILED",
                        "DELIVERY_FAILED",
                        "SENDER_REVIEW_REQUIRED",
                        "SENDER_REVIEW_INVALID",
                    }
                    else "outcome_unknown"
                )
                reason = exc.code
                if reason == "VOICE_APPROVAL_SUPERSEDED":
                    state = "needs_input"
            except Exception:
                state, reason = "outcome_unknown", "delivery_unverified"
            task.state = state
            fact = (
                "Review the current email again. Nothing was sent."
                if reason == "VOICE_APPROVAL_SUPERSEDED"
                else "Gmail accepted your email."
                if state == "sent"
                else "I couldn't confirm the final result. I won't send another copy automatically."
                if state == "outcome_unknown"
                else _RECOVERY.get(
                    reason or "", "The send failed. Check the draft's status before trying again."
                )
            )
            return self.result(
                task,
                status=state,
                reason_code=reason,
                spoken_facts=[fact],
                client_step={
                    "kind": "mail_draft_outcome",
                    "draft_ref": ref,
                    "revision": revision,
                    "action_id": task.prepared["action_id"],
                    "status": state,
                    "reason_code": reason,
                },
            )


def runtime(ctx: ToolContext) -> MailComposeRuntime | None:
    value = ctx.services.get("mail_compose")
    return value if isinstance(value, MailComposeRuntime) and value.review_supported else None


class ComposeInput(ToolInput):
    recipients: list[RecipientSource] = Field(default_factory=list, max_length=50)
    subject: str = Field(default="", max_length=256)
    message: str = Field(default="", max_length=4000)


class DraftRefInput(ToolInput):
    draft_ref: str = Field(min_length=16, max_length=64)
    revision: int = Field(ge=1, le=10000)


class EditDraftInput(DraftRefInput):
    subject: str | None = Field(default=None, max_length=256)
    message: str | None = Field(default=None, max_length=4000)
    recipients: list[RecipientSource] | None = Field(default=None, max_length=50)
    cancel: bool = False


class DraftStatusInput(ToolInput):
    draft_ref: str = Field(default="", max_length=64)


async def _compose(ctx: ToolContext, args: ComposeInput) -> ToolResult:
    owner = runtime(ctx)
    if owner is None:
        return _refusal("review_unavailable", "Use the Mail review card to compose this email.")
    draft = {"subject": args.subject, "body": args.message}
    recipients = await resolve_recipient_sources(ctx, args.recipients) if args.recipients else None
    if isinstance(recipients, Rejected):
        held = await owner.create(ctx, draft)
        if isinstance(held, ComposeResult) and held.status != "draft_already_open":
            held.reason_code, held.spoken_facts = recipients.reason_code, recipients.spoken_facts
        return held
    if recipients is not None:
        draft.update({key: ", ".join(value) for key, value in recipients.draft_fields().items()})
    return await owner.create(ctx, draft, recipients=recipients)


async def _prepare_send(ctx: ToolContext, args: DraftRefInput) -> Prepared | ToolResult:
    owner = runtime(ctx)
    return (
        owner.prepare_send(args.draft_ref, args.revision)
        if owner
        else _refusal("review_unavailable", "Open the private Mail review first.")
    )


async def _send(ctx: ToolContext, args: DraftRefInput) -> ToolResult:
    owner = runtime(ctx)
    return (
        await owner.send(ctx, args.draft_ref, args.revision)
        if owner
        else _refusal("review_unavailable", "Open the private Mail review first.")
    )


async def _edit(ctx: ToolContext, args: EditDraftInput) -> ToolResult:
    owner = runtime(ctx)
    if owner is None:
        return _refusal("review_unavailable", "Open the private Mail review first.")
    if args.cancel:
        return await owner.cancel(ctx, args.draft_ref, args.revision)
    # Accept the issued edit envelope before fallible lookup; old authority is gone.
    refused = await owner.invalidate(ctx, args.draft_ref, args.revision)
    if refused is not None:
        return refused
    patch = {
        k: v for k, v in {"subject": args.subject, "body": args.message}.items() if v is not None
    }
    recipients = None
    if args.recipients is not None:
        recipients = await resolve_recipient_sources(ctx, args.recipients)
        if isinstance(recipients, Rejected):
            # A rejected replacement must not let a later body-only edit
            # silently revive the recipient the owner just changed.
            held = await owner.edit(
                ctx,
                args.draft_ref,
                args.revision,
                {**patch, "to": "", "cc": "", "bcc": ""},
                operation_id=secrets.token_urlsafe(12),
            )
            if isinstance(held, ComposeResult) and held.status == "needs_input":
                held.reason_code, held.spoken_facts = (
                    recipients.reason_code,
                    recipients.spoken_facts,
                )
                if held.client_step:
                    held.client_step["reason_code"] = recipients.reason_code
            return held
        patch.update({key: ", ".join(value) for key, value in recipients.draft_fields().items()})
    return await owner.edit(
        ctx,
        args.draft_ref,
        args.revision,
        patch,
        operation_id=secrets.token_urlsafe(12),
        recipients=recipients,
    )


async def _status(ctx: ToolContext, args: DraftStatusInput) -> ToolResult:
    owner = runtime(ctx)
    if owner is None or not owner.tasks:
        return ToolResult(
            status="none", spoken_facts=["There is no email draft in this voice session."]
        )
    task = (
        owner.tasks.get(args.draft_ref) if args.draft_ref else next(reversed(owner.tasks.values()))
    )
    if task is None:
        return _refusal("draft_unavailable", "That email draft is unavailable.")
    async with task.lock:
        action = task.prepared.get("action_id")
        if action:
            try:
                reader = ctx.services.get("mail_delivery_status", get_owner_send_action)
                row = await reader(user_id=ctx.user_id, action_id=action)
            except Exception:
                row = None
            if not isinstance(row, dict) or row.get("action_id") != action:
                return owner.result(
                    task,
                    status="unverified",
                    spoken_facts=["I couldn't check the email status. I won't send another copy."],
                )
            if row.get("state") in {
                "sent",
                "sending",
                "failed",
                "outcome_unknown",
                "cancelled",
                "expired",
            }:
                if task.state == "blocked" and row["state"] in {"failed", "cancelled", "expired"}:
                    task.prepared = {}
                    task.state = "needs_input"
                else:
                    task.state = str(row["state"])
                task.rendered = False
    return owner.result(
        task,
        status=task.state,
        spoken_facts=[
            "Gmail accepted your email."
            if task.state == "sent"
            else f"The email status is {task.state.replace('_', ' ')}. This is not a delivery receipt."
        ],
    )


TOOLS: tuple[ToolSpec, ...] = (
    ToolSpec(
        name="compose_mail",
        gateway_action_id="email.chat.turn",
        policy=ToolPolicy.direct,
        input_model=ComposeInput,
        output_model=ComposeResult,
        description="Compose a new email for private review; never sends. Preserve dictated message and blank subject. Recipients are confirmed connections, explicit dictated addresses or self, with explicit To/Cc/Bcc roles. Missing fields remain in this draft for edit_mail_draft. For future times use schedule_mail.",
        handler=_compose,
        private_args=("recipients", "subject", "message"),
    ),
    ToolSpec(
        name="edit_mail_draft",
        gateway_action_id="email.chat.turn",
        policy=ToolPolicy.direct,
        input_model=EditDraftInput,
        output_model=ComposeResult,
        description="Edit only supplied fields of the issued email draft/revision, or cancel it. Preserves other fields and revokes old send review; never sends.",
        handler=_edit,
        private_args=("recipients", "subject", "message"),
    ),
    ToolSpec(
        name="send_reviewed_mail",
        gateway_action_id="email.chat.turn",
        policy=ToolPolicy.confirm_voice,
        input_model=DraftRefInput,
        output_model=ComposeResult,
        description="Request final send approval for the exact rendered email draft/revision. Only confirmation of this send-specific review delivers it; identity or draft-open approval never sends.",
        handler=_send,
        prepare=_prepare_send,
        firebase_plane=True,
        device_step=True,
        correction_group="mail_compose",
        lookup_targets=("person",),
    ),
    ToolSpec(
        name="get_mail_draft_status",
        gateway_action_id="email.chat.turn",
        policy=ToolPolicy.read,
        input_model=DraftStatusInput,
        output_model=ComposeResult,
        description="Read the current issued email draft reference, revision and send state; does not authorize or retry sending.",
        handler=_status,
    ),
)
