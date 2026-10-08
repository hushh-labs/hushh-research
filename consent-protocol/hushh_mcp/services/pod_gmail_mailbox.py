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
from datetime import UTC, datetime
from typing import Any, Optional

import httpx

from hushh_mcp.services import pod_connector_credentials as credentials
from hushh_mcp.services.gmail_delivery_service import _message_for, normalize_draft
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
    ) -> dict[str, Any]:
        if user_id != self._owner:
            raise _error("GMAIL_NOT_CONNECTED", "Connect Gmail first.")
        if action not in MAILBOX_ACTIONS or (action in LABEL_ACTIONS) != bool(label.strip()):
            raise _error("GMAIL_MAILBOX_INVALID", "Choose one mailbox change.", 422)
        bound = self._credential().credential_id
        await self.assert_modify_ready(user_id=user_id)
        arguments: dict[str, Any] = {
            "limit": limit,
            "mailbox": "inbox" if action == "archive" else mailbox,
        }
        if query.strip():
            arguments["query"] = query.strip()
        reader = self._reader_factory(
            gmail=self._gmail,
            user_id=user_id,
            require_access=require_access,
            transport=self._transport,
        )
        targets = await reader.resolve_targets(
            arguments, label_name=label.strip() if action in LABEL_ACTIONS else None
        )
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

    async def execute(self, *, user_id: str, proposal_id: str) -> dict[str, Any]:
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
                await self._apply(
                    token, str(proposal["action"]), message_ids, proposal.get("label_id")
                )
                result = {
                    "status": "executed",
                    "action": proposal["action"],
                    "count": len(message_ids),
                }
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
        await self._proposals().settle(proposal_id=proposal_id, status="executed")
        return result

    async def _deliver(self, token: str, proposal: dict[str, Any]) -> dict[str, Any]:
        draft = normalize_draft(proposal["draft"])
        raw = base64.urlsafe_b64encode(_message_for(draft).as_bytes()).decode("ascii")
        save = proposal["action"] == "save_draft"
        path = "/drafts" if save else "/messages/send"
        payload = {"message": {"raw": raw}} if save else {"raw": raw}
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
        if not isinstance(identifier, str) or not 1 <= len(identifier) <= 256:
            raise _unknown_outcome()
        return {
            "status": "saved" if save else "sent",
            "draft_id" if save else "message_id": identifier,
            "action": proposal["action"],
        }


def pod_mailbox_actions() -> Optional[PodGmailMailboxActions]:
    """The owner-cloud agent's mailbox actions, or None anywhere else (the hub's are used)."""
    from hushh_mcp.services.pod_owner_cloud import owner_cloud_agent, pod_owner_user_id

    if not owner_cloud_agent():
        return None
    return PodGmailMailboxActions(pod_owner_user_id())


__all__ = ["PodGmailMailboxActions", "pod_mailbox_actions"]
