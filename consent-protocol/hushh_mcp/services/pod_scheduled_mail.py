"""One reviewed reminder on the original Gmail account and thread."""

from __future__ import annotations

import asyncio
from dataclasses import asdict

from pydantic import BaseModel, ConfigDict, Field

from hushh_mcp.one_adk.request_secrets import resolve_request_secret
from hushh_mcp.services.byoc_key_custody import resolve_pod_log_key
from hushh_mcp.services.gmail_delivery_service import normalize_draft
from hushh_mcp.services.mail_source_identity import seal_source_id
from hushh_mcp.services.pod_gmail_mailbox import PodGmailMailboxActions
from hushh_mcp.services.pod_mail_followups import Tracked, obligation_key, run_mail
from hushh_mcp.services.pod_scheduled_contracts import ScheduleRefused
from hushh_mcp.services.pod_scheduled_model import resolve_scheduled_model

CAPABILITY = "agent_email.send_followup.v1"


class ApprovedDraft(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    to: str = Field(min_length=3, max_length=320)
    subject: str = Field(max_length=998)
    body: str = Field(min_length=1, max_length=12000)


class MailTerms(Tracked):
    draft: ApprovedDraft
    address: str = Field(min_length=3, max_length=320)
    due: int = Field(gt=0)


class ScheduledMailFollowup:
    allow_run_now = False
    max_active_seconds = 150
    required_scopes = ("pod.act", "pkm.read")

    def __init__(self, grants, log, check):
        self.grants, self.log, self.check = grants, log, check

    async def prepare(self, parameters):
        request = MailTerms.model_validate(parameters)
        source, connection, held = await self.envelope(request, self.check)
        if not connection.modify_permission_granted(
            connection._fetch_connection_row(user_id=self.grants.owner_id)
        ):
            raise ScheduleRefused("SCHEDULE_GMAIL_MANAGE_REQUIRED")
        draft = normalize_draft(request.draft.model_dump())
        if (
            draft.to != (source.recipient_email,)
            or draft.subject != request.draft.subject
            or request.address != connection._email
            or not draft.body.strip()
        ):
            raise ScheduleRefused("SCHEDULE_MAIL_ENVELOPE_CHANGED")
        model = await resolve_scheduled_model(
            self.log, pod_id=self.grants.authority.hushh_id, check=self.check
        )
        return {
            "request": request.model_dump(),
            "fingerprint": source.fingerprint,
            "model": model.binding.model_dump(),
        }

    async def envelope(self, request, check):
        return await run_mail(
            "envelope",
            request,
            owner=self.grants.owner_id,
            check=check,
            consent_token=None,
            model_factory=None,
        )

    async def run_claimed(self, lease):
        row = lease.claimed
        terms = row["terms"]
        request = MailTerms.model_validate(terms["request"])
        if (
            row["repeat"] != "once"
            or row["first_run_at"] != request.due
            or row["next_run_at"] != request.due
        ):
            return "needs_review"
        model = await resolve_scheduled_model(
            self.log, pod_id=self.grants.authority.hushh_id, check=lease.check
        )
        if model.binding.model_dump() != terms["model"]:
            return "needs_review"
        with self.grants.invocation(lease).bind() as ref:
            matched = await run_mail(
                "check",
                request,
                owner=self.grants.owner_id,
                check=lease.check,
                consent_token=resolve_request_secret(ref),
                model_factory=model.build,
            )
        if matched["source"]:
            return "cancelled"
        envelope, connection, held = await self.envelope(request, lease.check)
        if (
            terms["fingerprint"] != envelope.fingerprint
            or request.address != connection._email
            or request.draft.to != envelope.recipient_email
        ):
            return "needs_review"
        actions = PodGmailMailboxActions(self.grants.owner_id, connection=connection)
        token = await connection.get_modify_access_token(
            user_id=self.grants.owner_id, expected_google_sub=held.account_subject
        )
        key = await asyncio.to_thread(resolve_pod_log_key)
        await lease.check()
        from hushh_mcp.services.pod_connector_credentials import active_mail_account

        current = active_mail_account(request.account)
        if (
            not current
            or current.status != "connected"
            or current.credential_id != held.credential_id
        ):
            return "needs_review"
        result = await actions.deliver_thread_reply(
            token, request.draft.model_dump(), asdict(envelope.reply_context)
        )
        if result["status"] != "sent":
            return "needs_review"
        sent = seal_source_id(
            key=key,
            owner_user_id=self.grants.owner_id,
            account=held.credential_id,
            message_id=result["message_id"],
        )

        def receipt(rows):
            active = lease._current(rows)
            active["last_run"]["sent_source"] = sent
            active["revision"] += 1
            return active

        await lease.journal.change(receipt, authorize=lease.journal.check_horizon)
        return "completed"

    @staticmethod
    def validate_request(request):
        terms = MailTerms.model_validate(request.parameters)
        identity = obligation_key(terms.connection, terms.source, terms.quote)
        if (
            request.request_id != identity
            or request.repeat != "once"
            or request.first_run_at != terms.due
        ):
            raise ScheduleRefused("SCHEDULE_MAIL_APPROVAL_INVALID")
