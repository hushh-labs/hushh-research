"""Reviewed Gmail mailbox changes: archive, labels, read state and trash.

The Calendar proposal pattern, applied to Gmail. ``propose`` resolves the exact
messages under the owner's read grant and stores a short-lived proposal that
holds message IDs only. Nothing changes in Gmail until ``execute`` runs from the
owner's confirmation control, with the incrementally granted ``gmail.modify``
scope. Trash moves messages to Gmail's Trash (recoverable for 30 days); this
service has no permanent-delete path.
"""

from __future__ import annotations

import asyncio
import json
import logging
import secrets
from contextlib import suppress
from datetime import UTC, datetime, timedelta
from typing import Any, Literal, get_args

import httpx
from opentelemetry.instrumentation.utils import suppress_instrumentation

from db.db_client import get_db
from hushh_mcp.services.gmail_metadata_reader import (
    GmailMetadataReader,
    RequireAccess,
    in_listing_order,
)
from hushh_mcp.services.gmail_receipts_service import (
    GmailApiError,
    GmailReceiptsService,
    get_gmail_receipts_service,
)

MailboxAction = Literal["archive", "add_label", "remove_label", "mark_read", "mark_unread", "trash"]
MAILBOX_ACTIONS: frozenset[str] = frozenset(get_args(MailboxAction))
LABEL_ACTIONS = frozenset({"add_label", "remove_label"})
_BASE = "https://gmail.googleapis.com/gmail/v1/users/me"
_TTL = timedelta(minutes=10)
logger = logging.getLogger(__name__)
# (addLabelIds, removeLabelIds) for the actions whose labels are fixed.
_FIXED_LABEL_CHANGES: dict[str, tuple[list[str], list[str]]] = {
    "archive": ([], ["INBOX"]),
    "mark_read": ([], ["UNREAD"]),
    "mark_unread": (["UNREAD"], []),
}


def _error(code: str, message: str, status_code: int = 409) -> GmailApiError:
    return GmailApiError(message, status_code=status_code, code=code)


class GmailMailboxActions:
    def __init__(
        self,
        *,
        gmail: GmailReceiptsService | None = None,
        db: Any | None = None,
        reader_factory: Any = GmailMetadataReader,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._gmail = gmail or get_gmail_receipts_service()
        self._db = db
        self._reader_factory = reader_factory
        self._transport = transport

    @property
    def db(self) -> Any:
        if self._db is None:
            self._db = get_db()
        return self._db

    async def _sql(self, sql: str, params: dict[str, Any]) -> Any:
        return await asyncio.to_thread(self.db.execute_raw, sql, params)

    async def _purge(self, *, user_id: str) -> None:
        """A confirmation hand-off, not an audit log: drop used and stale rows."""
        await self._sql(
            """DELETE FROM gmail_mailbox_action_proposals
               WHERE user_id = :user_id
                 AND (expires_at <= NOW() OR status IN ('executed', 'failed'))""",
            {"user_id": user_id},
        )

    async def assert_modify_ready(self, *, user_id: str) -> None:
        """Check the grant without a token refresh, before any provider work."""
        row = await asyncio.to_thread(self._gmail._fetch_connection_row, user_id=user_id)
        if not row or self._gmail._derive_connection_state(row) != "connected":
            raise _error("GMAIL_NOT_CONNECTED", "Connect Gmail first.")
        if not self._gmail.modify_permission_granted(row):
            raise _error(
                "GMAIL_MODIFY_PERMISSION_REQUIRED", "Allow Gmail changes before organizing mail."
            )

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
        if action not in MAILBOX_ACTIONS or (action in LABEL_ACTIONS) != bool(label.strip()):
            raise _error("GMAIL_MAILBOX_INVALID", "Choose one mailbox change.", 422)
        await self._purge(user_id=user_id)
        await self.assert_modify_ready(user_id=user_id)
        # Archiving removes the Inbox label, so its targets are Inbox messages.
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
        proposal_id = f"gmod_{secrets.token_urlsafe(24)}"
        expires_at = datetime.now(UTC) + _TTL
        await self._sql(
            """INSERT INTO gmail_mailbox_action_proposals
               (proposal_id, user_id, google_sub, action, message_ids, label_id, expires_at)
               VALUES (:proposal_id, :user_id, :google_sub, :action,
                       CAST(:message_ids AS jsonb), :label_id, :expires_at)""",
            {
                "proposal_id": proposal_id,
                "user_id": user_id,
                "google_sub": targets.account,
                "action": action,
                "message_ids": json.dumps(list(targets.message_ids)),
                "label_id": targets.label_id,
                "expires_at": expires_at,
            },
        )
        return {
            "status": "confirmation_required",
            "proposal_id": proposal_id,
            "action": action,
            "expires_at": expires_at.isoformat(),
            "preview": targets.preview,
        }

    async def execute(self, *, user_id: str, proposal_id: str) -> dict[str, Any]:
        await self._purge(user_id=user_id)
        claim = await self._sql(
            """UPDATE gmail_mailbox_action_proposals SET status = 'executing'
               WHERE proposal_id = :proposal_id AND user_id = :user_id
                 AND status = 'pending' AND expires_at > NOW()
               RETURNING action, message_ids, label_id, google_sub""",
            {"proposal_id": proposal_id, "user_id": user_id},
        )
        if not claim.data:
            raise _error(
                "GMAIL_MAILBOX_PROPOSAL_UNAVAILABLE",
                "That mailbox change is no longer available. Check Gmail before preparing another change.",
            )
        proposal = claim.data[0]
        raw_ids = proposal["message_ids"]
        message_ids = raw_ids if isinstance(raw_ids, list) else json.loads(raw_ids)
        try:
            row = await asyncio.to_thread(self._gmail._fetch_connection_row, user_id=user_id)
            # The IDs were resolved in one mailbox; never apply them to another.
            if not row or row.get("google_sub") != proposal["google_sub"]:
                raise _error(
                    "GMAIL_MAILBOX_CONNECTION_CHANGED",
                    "Your Gmail connection changed. Ask again to review this change.",
                )
            token = await self._gmail.get_modify_access_token(
                user_id=user_id, expected_google_sub=proposal["google_sub"]
            )
            await self._apply(
                token, proposal["action"], [str(i) for i in message_ids], proposal["label_id"]
            )
        except httpx.TransportError:
            with suppress(Exception):
                await self._mark_failed(user_id, proposal_id)
            raise _unknown_outcome() from None
        except Exception:
            # Preserve the original provider/authority error if the status write
            # also fails. The already-claimed row cannot execute a second time.
            with suppress(Exception):
                await self._mark_failed(user_id, proposal_id)
            raise
        try:
            await self._sql(
                """DELETE FROM gmail_mailbox_action_proposals
                   WHERE proposal_id = :proposal_id AND user_id = :user_id""",
                {"proposal_id": proposal_id, "user_id": user_id},
            )
        except Exception:
            logger.warning("gmail_mailbox.completed_receipt_cleanup_pending")
        return {"status": "executed", "action": proposal["action"], "count": len(message_ids)}

    async def _mark_failed(self, user_id: str, proposal_id: str) -> None:
        await self._sql(
            """UPDATE gmail_mailbox_action_proposals SET status = 'failed'
               WHERE proposal_id = :proposal_id AND user_id = :user_id""",
            {"proposal_id": proposal_id, "user_id": user_id},
        )

    async def _apply(
        self, token: str, action: str, message_ids: list[str], label_id: str | None
    ) -> None:
        headers = {"Authorization": f"Bearer {token}"}
        async with httpx.AsyncClient(
            transport=self._transport, timeout=15, follow_redirects=False
        ) as client:
            # HTTPX spans would otherwise record message IDs from the URL.
            with suppress_instrumentation():
                if action == "trash":

                    async def trash(message_id: str) -> dict[str, Any]:
                        response = await client.post(
                            f"{_BASE}/messages/{message_id}/trash", headers=headers
                        )
                        _check(response)
                        return {}

                    try:
                        await in_listing_order(message_ids, trash)
                    except Exception:
                        # Siblings may already have completed, including when
                        # another request lost permission. Never claim no effect.
                        raise _unknown_outcome() from None
                    return
                if action in LABEL_ACTIONS:
                    add, remove = ([label_id], []) if action == "add_label" else ([], [label_id])
                else:
                    add, remove = _FIXED_LABEL_CHANGES[action]
                response = await client.post(
                    f"{_BASE}/messages/batchModify",
                    headers=headers,
                    json={"ids": message_ids, "addLabelIds": add, "removeLabelIds": remove},
                )
                _check(response)


def _check(response: httpx.Response) -> None:
    """Authored errors only; provider bodies never leave this module."""
    if response.status_code in {200, 204}:
        return
    if response.status_code == 401:
        raise _error("GMAIL_RECONNECT_REQUIRED", "Reconnect Gmail to continue.")
    if response.status_code == 403:
        raise _error(
            "GMAIL_MODIFY_PERMISSION_REQUIRED", "Allow Gmail changes before organizing mail."
        )
    if response.status_code in {400, 404}:
        raise _error(
            "GMAIL_MAILBOX_SOURCE_CHANGED",
            "Some of those messages changed in Gmail. Ask again to review the change.",
        )
    raise _unknown_outcome()


def _unknown_outcome() -> GmailApiError:
    return _error(
        "GMAIL_MAILBOX_OUTCOME_UNKNOWN",
        "Gmail may have applied some or all of this change. Check Gmail before preparing another change.",
        502,
    )


_service: GmailMailboxActions | None = None


def get_gmail_mailbox_actions() -> GmailMailboxActions:
    global _service
    if _service is None:
        _service = GmailMailboxActions()
    return _service
