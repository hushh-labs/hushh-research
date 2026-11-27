"""Reviewed Gmail mailbox changes inside the owner's own agent.

``GmailMailboxActions`` resolves the exact messages a change would touch, keeps the
plan in a hub table until the owner confirms, then applies it with the
``gmail.modify`` grant. :class:`PodGmailMailboxActions` is the same review in an
owner-cloud agent: the agent's own Gmail login (``PodGmailConnection``), the plan in
the owner's own sealed log (``pod_action_proposals``, kind ``gmail_mailbox``), and the
same ``_apply`` that talks to Gmail. Nothing changes in Gmail until the owner's own
session confirms through ``POST /api/one/pod/actions/{proposal_id}/confirm``.
"""

from __future__ import annotations

import base64
import json
import logging
from collections.abc import Sequence
from dataclasses import asdict
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any, Optional, cast

import httpx

from hushh_mcp.services import pod_connector_credentials as credentials
from hushh_mcp.services.gmail_delivery_service import (
    GmailReplyContext,
    _message_for,
    normalize_draft,
)
from hushh_mcp.services.gmail_mailbox_actions import (
    LABEL_ACTIONS,
    MAILBOX_ACTIONS,
    GmailMailboxActions,
    _error,
    _unknown_outcome,
)
from hushh_mcp.services.gmail_metadata_reader import GmailMetadataReader, RequireAccess
from hushh_mcp.services.pod_action_proposals import PodActionProposalStore, pod_action_proposals
from hushh_mcp.services.pod_gmail_local import HubTableRefused, PodGmailConnection

if TYPE_CHECKING:
    from hushh_mcp.services.gmail_reply_source_service import GmailReplySource

logger = logging.getLogger(__name__)
KIND = "gmail_mailbox"
EMAIL_ACTIONS = frozenset({"save_draft", "send_email"})
_BASE = "https://gmail.googleapis.com/gmail/v1/users/me"


class PodGmailMailboxActions(GmailMailboxActions):
    """``GmailMailboxActions`` with the agent's own login and the owner's own log."""

    def __init__(
        self,
        owner_user_id: str,
        *,
        connection: Optional[PodGmailConnection] = None,
        store: Optional[PodActionProposalStore] = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        super().__init__(
            gmail=connection or PodGmailConnection(owner_user_id),
            reader_factory=GmailMetadataReader,
            transport=transport,
        )
        self._owner = owner_user_id
        self._store = store

    @property
    def db(self) -> Any:
        raise HubTableRefused("gmail_mailbox_action_proposals is a hub table")

    def _proposals(self) -> PodActionProposalStore:
        return self._store if self._store is not None else pod_action_proposals()

    @staticmethod
    def _credential(credential_id: Optional[str] = None) -> credentials.ConnectorCredential:
        try:
            held = credentials.active_connector_credential("gmail")
        except credentials.ConnectorCredentialsUnavailable:
            raise _error("GMAIL_CONNECTION_UNAVAILABLE", "Gmail is unavailable.", 503) from None
        if held is None or held.status != credentials.STATUS_CONNECTED:
            raise _error("GMAIL_NOT_CONNECTED", "Connect Gmail first.")
        if credential_id is not None and held.credential_id != credential_id:
            raise _error("GMAIL_MAILBOX_CONNECTION_CHANGED", "Review this change again.")
        return held

    async def _purge(self, *, user_id: str) -> None:
        # Expiry is checked on every claim; the owner's log is append-only.
        return None

    async def propose(
        self,
        *,
        user_id: str,
        action: str,
        query: str,
        mailbox: str,
        limit: int,
        label: str,
        require_access: RequireAccess,
        message_ids: Sequence[str] | None = None,
        expect_account: str | None = None,
    ) -> dict[str, Any]:
        if user_id != self._owner:
            raise _error("GMAIL_NOT_CONNECTED", "Connect Gmail first.")
        if action not in MAILBOX_ACTIONS or (action in LABEL_ACTIONS) != bool(label.strip()):
            raise _error("GMAIL_MAILBOX_INVALID", "Choose one mailbox change.", 422)
        bound = self._credential().credential_id
        await self.assert_modify_ready(user_id=user_id)
        target_mailbox = "inbox" if action == "archive" else mailbox
        label_name = label.strip() if action in LABEL_ACTIONS else None
        if message_ids:
            reader = self._reader_factory(
                gmail=self._gmail,
                user_id=user_id,
                require_access=require_access,
                transport=self._transport,
                expect_account=expect_account,
            )
            targets = await reader.resolve_targets_by_ids(
                message_ids,
                mailbox=target_mailbox,
                label_name=label_name,
            )
        else:
            arguments: dict[str, Any] = {
                "limit": limit,
                "mailbox": target_mailbox,
            }
            if query.strip():
                arguments["query"] = query.strip()
            reader = self._reader_factory(
                gmail=self._gmail,
                user_id=user_id,
                require_access=require_access,
                transport=self._transport,
            )
            targets = await reader.resolve_targets(arguments, label_name=label_name)
        if not targets.message_ids:
            return {"status": "no_match", "preview": targets.preview}
        self._credential(bound)
        await require_access()
        issued = await self._proposals().issue(
            kind=KIND,
            owner_id=user_id,
            payload={
                "action": action,
                "message_ids": list(targets.message_ids),
                "label_id": targets.label_id,
                "google_sub": targets.account,
                "credential_id": bound,
            },
        )
        return {
            "status": "confirmation_required",
            "proposal_id": issued["proposal_id"],
            "action": action,
            "expires_at": datetime.fromtimestamp(issued["expires_at_ms"] / 1000, UTC).isoformat(),
            "preview": targets.preview,
        }

    async def propose_email(
        self,
        *,
        user_id: str,
        action: str,
        draft_payload: dict[str, Any],
        require_access: RequireAccess,
    ) -> dict[str, Any]:
        """Keep the exact reviewed draft/send envelope in this owner's sealed log."""
        if user_id != self._owner or action not in EMAIL_ACTIONS:
            raise _error("GMAIL_DELIVERY_INVALID", "Choose a Gmail draft or send action.", 422)
        if not isinstance(draft_payload, dict) or set(draft_payload) - {
            "to",
            "cc",
            "bcc",
            "subject",
            "body",
            "html_body",
        }:
            raise _error("GMAIL_DELIVERY_UNSUPPORTED", "Review an email without attachments.", 422)
        draft = normalize_draft(draft_payload)
        await require_access()
        bound = self._credential()
        await self.assert_modify_ready(user_id=user_id)
        self._credential(bound.credential_id)
        exact = json.loads(draft.canonical_json())
        issued = await self._proposals().issue(
            kind=KIND,
            owner_id=user_id,
            payload={
                "action": action,
                "draft": exact,
                "google_sub": bound.account_subject,
                "credential_id": bound.credential_id,
            },
        )
        await require_access()
        self._credential(bound.credential_id)
        return {
            "status": "confirmation_required",
            "proposal_id": issued["proposal_id"],
            "action": action,
            "preview": exact,
            "expires_at": datetime.fromtimestamp(issued["expires_at_ms"] / 1000, UTC).isoformat(),
        }

    async def _reply_envelope(
        self, selection: Any, require_access: RequireAccess
    ) -> tuple[GmailReplySource, PodGmailConnection, credentials.ConnectorCredential]:
        from hushh_mcp.services.pod_mail_followups import run_mail

        result = await run_mail(
            "envelope",
            selection,
            owner=self._owner,
            check=require_access,
            consent_token=None,
            model_factory=None,
        )
        return cast(
            "tuple[GmailReplySource, PodGmailConnection, credentials.ConnectorCredential]",
            result,
        )

    async def propose_thread_reply(
        self, *, selection: Any, body: str, require_access: RequireAccess
    ) -> dict[str, Any]:
        source, _, held = await self._reply_envelope(selection, require_access)
        if not credentials.connector_permissions(held)["capabilities"]["manage"]:
            raise _error(
                "GMAIL_MODIFY_PERMISSION_REQUIRED", "Reconnect this mailbox with send access.", 403
            )
        draft = normalize_draft(
            {"to": source.recipient_email, "subject": source.subject, "body": body}
        )
        exact = json.loads(draft.canonical_json())
        issued = await self._proposals().issue(
            kind=KIND,
            owner_id=self._owner,
            payload={
                "action": "send_email",
                "draft": exact,
                "source": selection.model_dump(),
                "reply_fingerprint": source.fingerprint,
                "credential_id": held.credential_id,
            },
        )
        await require_access()
        return {
            "status": "confirmation_required",
            "proposal_id": issued["proposal_id"],
            "action": "send_email",
            "preview": exact,
            "expires_at": datetime.fromtimestamp(issued["expires_at_ms"] / 1000, UTC).isoformat(),
        }

    async def _send_scoped_reply(
        self, proposal: dict[str, Any], require_access: RequireAccess | None
    ) -> dict[str, Any]:
        from hushh_mcp.services.pod_mail_followups import Source

        if require_access is None:
            raise _error("GMAIL_DELIVERY_INVALID", "Open Mail and review this reply again.", 403)
        selection = Source.model_validate(proposal["source"])
        source, connection, held = await self._reply_envelope(selection, require_access)
        draft = normalize_draft(proposal["draft"])
        if (
            source.fingerprint != proposal["reply_fingerprint"]
            or held.credential_id != proposal["credential_id"]
            or draft.to != (source.recipient_email,)
            or draft.cc
            or draft.bcc
            or draft.subject != source.subject
        ):
            raise _error("GMAIL_MAILBOX_CONNECTION_CHANGED", "Review this reply again.")
        token = await connection.get_modify_access_token(
            user_id=self._owner,
            expected_google_sub=held.account_subject,
        )
        await require_access()
        current = credentials.active_mail_account(selection.account)
        if (
            not current
            or current.status != credentials.STATUS_CONNECTED
            or current.credential_id != held.credential_id
        ):
            raise _error("GMAIL_MAILBOX_CONNECTION_CHANGED", "Review this reply again.")
        return await self.deliver_thread_reply(
            token,
            proposal["draft"],
            asdict(source.reply_context),
        )

    async def execute(
        self,
        *,
        user_id: str,
        proposal_id: str,
        require_access: RequireAccess | None = None,
    ) -> dict[str, Any]:
        proposal = (
            await self._proposals().claim(proposal_id=proposal_id, owner_id=user_id, kind=KIND)
            if user_id == self._owner
            else None
        )
        if not proposal:
            raise _error(
                "GMAIL_MAILBOX_PROPOSAL_UNAVAILABLE",
                "That mailbox change is no longer available. Check Gmail before preparing another change.",
            )
        if "reply_fingerprint" in proposal:
            try:
                result = await self._send_scoped_reply(proposal, require_access)
            except httpx.TransportError:
                await self._proposals().settle(proposal_id=proposal_id, status="failed")
                raise _unknown_outcome() from None
            except Exception:
                await self._proposals().settle(proposal_id=proposal_id, status="failed")
                raise
            await self._proposals().settle(proposal_id=proposal_id, status="executed")
            return result
        message_ids = [str(item) for item in proposal.get("message_ids") or []]
        try:
            # Old proposals without a custody binding fail closed too.
            bound = self._credential(str(proposal.get("credential_id") or ""))
            token = await self._gmail.get_modify_access_token(
                user_id=user_id, expected_google_sub=str(proposal.get("google_sub") or "")
            )
            self._credential(bound.credential_id)
            if proposal["action"] in EMAIL_ACTIONS:
                result = await self._deliver(token, proposal)
            else:
                outcome = await self._apply(
                    token, str(proposal["action"]), message_ids, proposal.get("label_id")
                )
                result = {
                    "action": proposal["action"],
                    **outcome,
                }
                if outcome["status"] != "executed":
                    result["total"] = len(message_ids)
            try:
                self._credential(bound.credential_id)
            except Exception:
                raise _unknown_outcome() from None
        except httpx.TransportError:
            await self._proposals().settle(proposal_id=proposal_id, status="failed")
            raise _unknown_outcome() from None
        except Exception:
            await self._proposals().settle(proposal_id=proposal_id, status="failed")
            raise
        if proposal["action"] in EMAIL_ACTIONS or result["status"] == "executed":
            await self._proposals().settle(proposal_id=proposal_id, status="executed")
        return result

    async def linked_calendar_token(self, *, credential_id: str, account: str) -> str:
        self._credential(credential_id)
        token = await self._gmail.get_modify_access_token(
            user_id=self._owner, expected_google_sub=account
        )
        self._credential(credential_id)
        return token

    async def send_linked_calendar_reply(
        self, *, credential_id: str, account: str, envelope: dict[str, Any]
    ) -> dict[str, Any]:
        token = await self.linked_calendar_token(credential_id=credential_id, account=account)
        return await self.deliver_thread_reply(token, envelope["draft"], envelope["reply"])

    async def deliver_thread_reply(
        self, token: str, draft: dict[str, Any], reply: dict[str, Any]
    ) -> dict[str, Any]:
        return await self._deliver(
            token,
            {"action": "send_email", "draft": draft},
            reply_context=GmailReplyContext(**reply),
        )

    async def _deliver(
        self,
        token: str,
        proposal: dict[str, Any],
        *,
        reply_context: GmailReplyContext | None = None,
    ) -> dict[str, Any]:
        draft = normalize_draft(proposal["draft"])
        raw = base64.urlsafe_b64encode(
            _message_for(draft, reply_context=reply_context).as_bytes()
        ).decode("ascii")
        save = proposal["action"] == "save_draft"
        path = "/drafts" if save else "/messages/send"
        payload = {"message": {"raw": raw}} if save else {"raw": raw}
        if reply_context is not None:
            payload["threadId"] = reply_context.thread_id
        from opentelemetry.instrumentation.utils import suppress_instrumentation  # noqa: PLC0415

        with suppress_instrumentation():
            async with httpx.AsyncClient(
                transport=self._transport, timeout=20, follow_redirects=False
            ) as client:
                response = await client.post(
                    f"{_BASE}{path}", headers={"Authorization": f"Bearer {token}"}, json=payload
                )
        if response.status_code in {401, 403}:
            raise _error(
                "GMAIL_MODIFY_PERMISSION_REQUIRED", "Reconnect Gmail with changes allowed."
            )
        if response.status_code in {400, 404}:
            raise _error("GMAIL_DELIVERY_REFUSED", "Review the email again.", 422)
        if response.status_code != 200:
            raise _unknown_outcome()
        try:
            body = response.json()
        except ValueError:
            raise _unknown_outcome() from None
        identifier = body.get("id") if isinstance(body, dict) else None
        if (
            not isinstance(identifier, str)
            or not 1 <= len(identifier) <= 256
            or (reply_context is not None and body.get("threadId") != reply_context.thread_id)
        ):
            raise _unknown_outcome()
        return {
            "status": "saved" if save else "sent",
            "draft_id" if save else "message_id": identifier,
            "action": proposal["action"],
        }


def pod_mailbox_actions() -> Optional[PodGmailMailboxActions]:
    """The owner-cloud or Personal Sandbox mailbox actions, or None anywhere else."""
    from hushh_mcp.services.pod_owner_cloud import (
        personal_sandbox_workspace_runtime,
        pod_owner_user_id,
    )

    if not personal_sandbox_workspace_runtime():
        return None
    return PodGmailMailboxActions(pod_owner_user_id())


__all__ = ["PodGmailMailboxActions", "pod_mailbox_actions"]
