"""Where a prepared Calendar change waits for the owner's confirmation.

``GoogleCalendarService`` prepares a change (``propose``) and runs it only after the
owner confirms (``execute``). The waiting plan lives in a proposal store:

* :class:`SqlCalendarProposalStore`, the hub's ``google_calendar_action_proposals``
  table, with the exact statements the service used before;
* ``pod_google_connections.PodCalendarProposalStore``, the owner's own sealed log,
  for an agent that runs in the owner's own cloud and has no hub table.

Both answer the same four questions, so the service's review, conflict and etag
checks are shared code rather than two copies.
"""

from __future__ import annotations

import json
import secrets
from datetime import UTC, datetime, timedelta
from typing import Any, Awaitable, Callable, Literal, Optional, Protocol

PROPOSAL_TTL = timedelta(minutes=10)


class CalendarTokens(Protocol):
    """What the service needs from a Google connection: one access token."""

    async def access_token(
        self, *, user_id: str, service: Any, access_level: Literal["read", "manage"]
    ) -> str: ...


class CalendarProposalStore(Protocol):
    async def purge(self, *, user_id: str) -> None: ...

    async def issue(
        self, *, user_id: str, action: str, plan: dict[str, Any], expected_etag: Optional[str]
    ) -> tuple[str, datetime]: ...

    async def claim(self, *, user_id: str, proposal_id: str) -> Optional[dict[str, Any]]: ...

    async def finish(self, *, user_id: str, proposal_id: str, executed: bool) -> None: ...

    async def forget_executed(self, *, user_id: str, proposal_id: str) -> None: ...


Execute = Callable[[str, Optional[dict[str, Any]]], Awaitable[Any]]


class SqlCalendarProposalStore:
    """The hub table, through the service's own non-blocking ``execute_raw``."""

    def __init__(self, execute: Execute) -> None:
        self._execute = execute

    async def purge(self, *, user_id: str) -> None:
        """Remove terminal and expired plans on the next Calendar mutation.

        The proposal table is a confirmation hand-off, not a Calendar cache or
        audit log. PostgreSQL is the current shared cleanup seam.
        """
        await self._execute(
            """DELETE FROM google_calendar_action_proposals
               WHERE user_id = :user_id
                 AND (expires_at <= NOW() OR status IN ('executed', 'failed', 'expired'))""",
            {"user_id": user_id},
        )

    async def issue(
        self, *, user_id: str, action: str, plan: dict[str, Any], expected_etag: Optional[str]
    ) -> tuple[str, datetime]:
        proposal_id = f"gcal_{secrets.token_urlsafe(24)}"
        expires_at = datetime.now(UTC) + PROPOSAL_TTL
        await self._execute(
            """INSERT INTO google_calendar_action_proposals
               (proposal_id, user_id, action, payload_json, expected_event_etag, expires_at)
               VALUES (:proposal_id, :user_id, :action, CAST(:payload_json AS jsonb), :etag, :expires_at)""",
            {
                "proposal_id": proposal_id,
                "user_id": user_id,
                "action": action,
                "payload_json": json.dumps(plan),
                "etag": expected_etag,
                "expires_at": expires_at,
            },
        )
        return proposal_id, expires_at

    async def claim(self, *, user_id: str, proposal_id: str) -> Optional[dict[str, Any]]:
        claim = await self._execute(
            """UPDATE google_calendar_action_proposals SET status = 'executing'
               WHERE proposal_id = :proposal_id AND user_id = :user_id AND status = 'pending' AND expires_at > NOW()
               RETURNING action, payload_json, expected_event_etag""",
            {"proposal_id": proposal_id, "user_id": user_id},
        )
        if not claim.data:
            return None
        row = claim.data[0]
        raw = row["payload_json"]
        return {
            "action": row["action"],
            "plan": raw if isinstance(raw, dict) else json.loads(raw),
            "expected_event_etag": row.get("expected_event_etag"),
        }

    async def finish(self, *, user_id: str, proposal_id: str, executed: bool) -> None:
        if not executed:
            await self._execute(
                "UPDATE google_calendar_action_proposals SET status = 'failed' WHERE proposal_id = :proposal_id",
                {"proposal_id": proposal_id},
            )
            return
        await self._execute(
            """UPDATE google_calendar_action_proposals
                   SET status = 'executed', executed_at = NOW()
                   WHERE proposal_id = :proposal_id AND user_id = :user_id
                     AND status = 'executing'""",
            {"proposal_id": proposal_id, "user_id": user_id},
        )

    async def forget_executed(self, *, user_id: str, proposal_id: str) -> None:
        """Drop the content-bearing plan once the change is done."""
        await self._execute(
            """DELETE FROM google_calendar_action_proposals
                   WHERE proposal_id = :proposal_id AND user_id = :user_id
                     AND status = 'executed'""",
            {"proposal_id": proposal_id, "user_id": user_id},
        )


__all__ = [
    "PROPOSAL_TTL",
    "CalendarProposalStore",
    "CalendarTokens",
    "SqlCalendarProposalStore",
]
