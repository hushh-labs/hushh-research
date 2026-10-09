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
from datetime import UTC, datetime, timedelta
from typing import Any, Literal, get_args

import httpx
from opentelemetry.instrumentation.utils import suppress_instrumentation

from db.db_client import get_db
from hushh_mcp.services.gmail_metadata_reader import GmailMetadataReader, RequireAccess
from hushh_mcp.services.gmail_receipts_service import (
    GmailApiError,
    GmailReceiptsService,
    get_gmail_receipts_service,
)

MailboxAction = Literal["archive", "add_label", "remove_label", "mark_read", "mark_unread", "trash"]
logger = logging.getLogger(__name__)
MAILBOX_ACTIONS: frozenset[str] = frozenset(get_args(MailboxAction))
LABEL_ACTIONS = frozenset({"add_label", "remove_label"})
_BASE = "https://gmail.googleapis.com/gmail/v1/users/me"
_TTL = timedelta(minutes=10)
_TRASH_TIMEOUT_SECONDS = 20
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
                "That mailbox change expired or was already used. Ask again to review it.",
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
            token = await self._gmail.get_modify_access_token(user_id=user_id)
            outcome = await self._apply(
                token, proposal["action"], [str(i) for i in message_ids], proposal["label_id"]
            )
        except Exception:
            await self._sql(
                """UPDATE gmail_mailbox_action_proposals SET status = 'failed'
                   WHERE proposal_id = :proposal_id AND user_id = :user_id""",
                {"proposal_id": proposal_id, "user_id": user_id},
            )
            raise
        if outcome["status"] != "executed":
            # The executing claim is intentionally retained: a provider POST
            # may have succeeded, so this exact review must never be replayed.
            return {"action": proposal["action"], "total": len(message_ids), **outcome}
        # A receipt/cleanup outage must not turn provider success into a
        # retryable write. The consumed proposal remains unavailable until TTL.
        try:
            await self._sql(
                """UPDATE gmail_mailbox_action_proposals SET status = 'executed'
                   WHERE proposal_id = :proposal_id AND user_id = :user_id
                     AND status = 'executing'""",
                {"proposal_id": proposal_id, "user_id": user_id},
            )
            await self._sql(
                """DELETE FROM gmail_mailbox_action_proposals
                   WHERE proposal_id = :proposal_id AND user_id = :user_id""",
                {"proposal_id": proposal_id, "user_id": user_id},
            )
        except Exception:
            logger.warning("gmail_mailbox_receipt_cleanup_failed")
        return {"status": "executed", "action": proposal["action"], "count": len(message_ids)}

    async def _apply(
        self, token: str, action: str, message_ids: list[str], label_id: str | None
    ) -> dict[str, Any]:
        headers = {"Authorization": f"Bearer {token}"}
        async with httpx.AsyncClient(
            transport=self._transport, timeout=15, follow_redirects=False
        ) as client:
            # HTTPX spans would otherwise record message IDs from the URL.
            with suppress_instrumentation():
                if action == "trash":
                    # Gmail has no batch Trash endpoint. Bound fanout and the
                    # whole operation: each result is recorded separately, and
                    # a timed-out POST is unknown even if the local task stopped.
                    semaphore = asyncio.Semaphore(4)

                    async def trash(message_id: str) -> tuple[str, GmailApiError | None]:
                        async with semaphore:
                            try:
                                response = await client.post(
                                    f"{_BASE}/messages/{message_id}/trash", headers=headers
                                )
                                _check(response)
                                return "confirmed", None
                            except GmailApiError as exc:
                                return ("unknown" if exc.status_code >= 500 else "rejected"), exc
                            except Exception as exc:
                                logger.warning(
                                    "gmail_mailbox_trash_unconfirmed error=%s", type(exc).__name__
                                )
                                return "unknown", None

                    tasks = [asyncio.create_task(trash(message_id)) for message_id in message_ids]
                    try:
                        await asyncio.wait_for(
                            asyncio.gather(*tasks), timeout=_TRASH_TIMEOUT_SECONDS
                        )
                    except TimeoutError:
                        await asyncio.gather(*tasks, return_exceptions=True)
                    outcomes = [
                        task.result() if task.done() and not task.cancelled() else ("unknown", None)
                        for task in tasks
                    ]
                    confirmed = sum(state == "confirmed" for state, _ in outcomes)
                    if confirmed == len(message_ids):
                        return {"status": "executed", "count": confirmed}
                    if any(state == "unknown" for state, _ in outcomes):
                        return {"status": "outcome_unknown", "count": confirmed}
                    if confirmed:
                        return {"status": "partially_executed", "count": confirmed}
                    rejection = next(error for _, error in outcomes if error is not None)
                    raise rejection
                if action in LABEL_ACTIONS:
                    add, remove = ([label_id], []) if action == "add_label" else ([], [label_id])
                else:
                    add, remove = _FIXED_LABEL_CHANGES[action]
                try:
                    response = await client.post(
                        f"{_BASE}/messages/batchModify",
                        headers=headers,
                        json={"ids": message_ids, "addLabelIds": add, "removeLabelIds": remove},
                    )
                    _check(response)
                except GmailApiError as exc:
                    if exc.status_code < 500:
                        raise
                    return {"status": "outcome_unknown", "count": 0}
                except httpx.RequestError:
                    return {"status": "outcome_unknown", "count": 0}
                return {"status": "executed", "count": len(message_ids)}


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
    raise _error(
        "GMAIL_MAILBOX_UNAVAILABLE",
        "Gmail could not confirm that change. Check Gmail before trying again.",
        502,
    )


_service: GmailMailboxActions | None = None


def get_gmail_mailbox_actions() -> GmailMailboxActions:
    global _service
    if _service is None:
        _service = GmailMailboxActions()
    return _service
