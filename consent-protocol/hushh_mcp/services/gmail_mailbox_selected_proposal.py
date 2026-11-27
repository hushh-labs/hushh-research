"""Exact-message proposal preparation over the existing Gmail action owner.

The mixin preserves GmailMailboxActions.propose_selected as the public facade;
its injected SQL, grant checks, label reader and execution ledger stay unchanged.
"""

from __future__ import annotations

import json
import re
import secrets
from datetime import UTC, datetime
from typing import Any

from hushh_mcp.services.gmail_metadata_reader import RequireAccess


async def _resolve_selected_label(
    owner: Any, user_id: str, label_id: str, expected_account: str, require_access: RequireAccess
) -> str:
    from hushh_mcp.services.gmail_mailbox_actions import _error

    # Reuse the existing native label resolver. Accept the exact provider
    # ID as well as its name, without introducing an LLM or label index.
    reader = owner._reader_factory(
        gmail=owner._gmail,
        user_id=user_id,
        require_access=require_access,
        expect_account=expected_account,
        transport=owner._transport,
    )

    async def resolve(client, token):
        listing = await reader._get(client, token, "/labels", {"fields": "labels(id,name,type)"})
        for label in listing.get("labels", []):
            if (
                label.get("id") == label_id
                or str(label.get("name", "")).casefold() == label_id.casefold()
            ) and label.get("type") == "user":
                return str(label["id"])
        raise _error("GMAIL_MAILBOX_INVALID_LABEL", "Choose an existing Gmail label.")

    return await reader._session(resolve, reads_bodies=False)


class SelectedMailboxProposalMixin:
    async def propose_selected(
        self,
        *,
        user_id: str,
        action: str,
        message_ids: list[str],
        label_id: str,
        expected_account: str,
        require_access: RequireAccess,
    ) -> dict[str, Any]:
        """Park current-run provider IDs in the same existing confirmation ledger.

        The Email execution port admits only IDs it actually observed. No source
        body is fetched or assessed to prepare this review; execution still owns
        fresh modify permission, account binding, single claim and uncertainty.
        """
        from hushh_mcp.services.gmail_mailbox_actions import (
            _TTL,
            LABEL_ACTIONS,
            MAILBOX_ACTIONS,
            _error,
        )

        if (
            action not in MAILBOX_ACTIONS
            or (action in LABEL_ACTIONS) != bool(label_id)
            or not 1 <= len(message_ids) <= 25
            or len(set(message_ids)) != len(message_ids)
            or any(
                not isinstance(identity, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,256}", identity)
                for identity in message_ids
            )
        ):
            raise _error(
                "GMAIL_MAILBOX_INVALID", "Choose up to 25 exact messages and one change.", 422
            )
        await require_access()
        await self.assert_modify_ready(user_id=user_id)
        binding = await self._gmail.read_grant_binding(user_id=user_id)
        if not binding or binding[2] != expected_account:
            raise _error("GMAIL_MAILBOX_CONNECTION_CHANGED", "Your Gmail connection changed.")
        if label_id:
            label_id = await _resolve_selected_label(
                self, user_id, label_id, expected_account, require_access
            )
        await require_access()
        if await self._gmail.read_grant_binding(user_id=user_id) != binding:
            raise _error("GMAIL_MAILBOX_CONNECTION_CHANGED", "Your Gmail connection changed.")
        await self._purge(user_id=user_id)
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
                "google_sub": expected_account,
                "action": action,
                "message_ids": json.dumps(message_ids),
                "label_id": label_id or None,
                "expires_at": expires_at,
            },
        )
        return {"proposal_id": proposal_id, "expires_at": expires_at.isoformat(), "action": action}
