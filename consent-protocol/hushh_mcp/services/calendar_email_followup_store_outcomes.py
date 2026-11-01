"""Per-message scan outcomes: skip-before-fetch, deletions and reassessment queue.

These methods let the scanner avoid re-reading mail it has already handled,
retire follow-ups whose source email was deleted, and find the earlier
follow-ups that were created before relevance was assessed. Nothing here sees
message content; threads and messages are addressed by keyed digests.
"""

from __future__ import annotations

import asyncio
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Literal

from sqlalchemy import text

from hushh_mcp.services.calendar_email_followup_relevance import ASSESSMENT_VERSION
from hushh_mcp.services.calendar_email_followup_store_types import FollowupStateError, Monitor

Outcome = Literal["assessed", "unreadable", "gone"]
# Stored where the body digest is unknown: nothing was read, so nothing to hash.
_NO_DIGEST = "0" * 64


@dataclass(frozen=True)
class ScannedState:
    body_digest: str
    assessment_version: int
    outcome: Outcome

    @property
    def current(self) -> bool:
        """True when this message needs no further reading or model work."""
        return self.assessment_version >= ASSESSMENT_VERSION


def _lease_fence(conn: Any, monitor: Monitor) -> None:
    active = conn.execute(
        text("""SELECT 1 FROM calendar_email_followup_monitors
        WHERE user_id=:user_id AND account_id=:account_id AND enabled=TRUE
          AND generation=CAST(:generation AS UUID) AND grant_epoch_digest=:grant
          AND lease_id=CAST(:lease_id AS UUID) FOR UPDATE"""),
        {
            "user_id": monitor.user_id,
            "account_id": monitor.account_id,
            "generation": monitor.generation,
            "grant": monitor.grant_epoch_digest,
            "lease_id": monitor.lease_id,
        },
    ).first()
    if not active:
        raise FollowupStateError("monitor_changed")


def _retire(
    conn: Any,
    monitor: Monitor,
    *,
    message_hmac: str | None = None,
    thread_hmac: str | None = None,
) -> int:
    """Take follow-ups off the owner's list and cancel their pending reminders.

    Only active rows change. A request the owner already finished or dismissed
    keeps that decision. Exactly one of the two keyed digests selects the rows.
    """
    ids = (
        conn.execute(
            text("""UPDATE calendar_email_followup_requests SET
            state='source_unavailable', reminder_at=NULL, revision=revision+1,
            reminder_lease_id=NULL, reminder_lease_until=NULL, updated_at=NOW()
            WHERE user_id=:user_id AND account_id=:account_id
              AND state IN ('needs_review','pending','snoozed')
              AND (
                (CAST(:message_hmac AS TEXT) IS NOT NULL
                 AND source_message_hmac=CAST(:message_hmac AS TEXT))
                OR (CAST(:thread_hmac AS TEXT) IS NOT NULL
                 AND conversation_id IN (
                   SELECT id FROM calendar_email_followup_conversations
                   WHERE user_id=:user_id AND account_id=:account_id
                     AND thread_hmac=CAST(:thread_hmac AS TEXT)))
              ) RETURNING id"""),
            {
                "user_id": monitor.user_id,
                "account_id": monitor.account_id,
                "message_hmac": message_hmac,
                "thread_hmac": thread_hmac,
            },
        )
        .scalars()
        .all()
    )
    if ids:
        conn.execute(
            text("""DELETE FROM feed_events WHERE user_id=:user_id
            AND source_domain='calendar_email_followup'
            AND metadata->>'request_id'=ANY(CAST(:ids AS TEXT[]))"""),
            {"user_id": monitor.user_id, "ids": [str(item) for item in ids]},
        )
    return len(ids)


class _ScanOutcomes:
    async def scanned_state(self, monitor: Monitor, message_id: str) -> ScannedState | None:
        message_hmac = self.cipher.digest(  # type: ignore[attr-defined]
            monitor.user_id, monitor.account_id, "message", message_id
        )

        def read() -> ScannedState | None:
            with self.db.engine.begin() as conn:  # type: ignore[attr-defined]
                row = (
                    conn.execute(
                        text("""SELECT body_digest,assessment_version,outcome
                        FROM calendar_email_followup_scanned_messages
                        WHERE user_id=:user_id AND account_id=:account_id
                          AND message_hmac=:message_hmac"""),
                        {
                            "user_id": monitor.user_id,
                            "account_id": monitor.account_id,
                            "message_hmac": message_hmac,
                        },
                    )
                    .mappings()
                    .first()
                )
            if not row:
                return None
            return ScannedState(
                body_digest=row["body_digest"],
                assessment_version=int(row["assessment_version"]),
                outcome=row["outcome"],
            )

        return await asyncio.to_thread(read)

    async def record_message_outcome(
        self,
        monitor: Monitor,
        *,
        message_id: str,
        thread_id: str,
        internal_date_ms: int,
        outcome: Literal["unreadable", "gone"],
    ) -> None:
        """Remember a message nobody can read, so it is never fetched again."""
        message_hmac = self.cipher.digest(  # type: ignore[attr-defined]
            monitor.user_id, monitor.account_id, "message", message_id
        )
        thread_hmac = self.cipher.digest(  # type: ignore[attr-defined]
            monitor.user_id, monitor.account_id, "thread", thread_id
        )

        def write() -> None:
            with self.db.engine.begin() as conn:  # type: ignore[attr-defined]
                _lease_fence(conn, monitor)
                conn.execute(
                    text("""INSERT INTO calendar_email_followup_scanned_messages
                    (user_id,account_id,message_hmac,thread_hmac,body_digest,internal_date_ms,
                     assessment_version,outcome)
                    VALUES (:user_id,:account_id,:message_hmac,:thread_hmac,:digest,:internal_date_ms,
                            :version,:outcome)
                    ON CONFLICT(user_id,account_id,message_hmac) DO UPDATE SET
                    outcome=EXCLUDED.outcome, assessment_version=EXCLUDED.assessment_version,
                    processed_at=NOW()"""),
                    {
                        "user_id": monitor.user_id,
                        "account_id": monitor.account_id,
                        "message_hmac": message_hmac,
                        "thread_hmac": thread_hmac,
                        "digest": _NO_DIGEST,
                        "internal_date_ms": internal_date_ms,
                        "version": ASSESSMENT_VERSION,
                        "outcome": outcome,
                    },
                )

        await asyncio.to_thread(write)

    async def mark_messages_gone(
        self, monitor: Monitor, messages: Sequence[tuple[str, str]]
    ) -> int:
        """History reported these messages deleted: retire what depended on them.

        Idempotent, so a restart that replays the same history page is a no-op.
        """
        if not messages:
            return 0
        pairs = [
            (
                self.cipher.digest(  # type: ignore[attr-defined]
                    monitor.user_id, monitor.account_id, "message", message_id
                ),
                self.cipher.digest(  # type: ignore[attr-defined]
                    monitor.user_id, monitor.account_id, "thread", thread_id
                ),
            )
            for message_id, thread_id in messages
        ]

        def write() -> int:
            retired = 0
            with self.db.engine.begin() as conn:  # type: ignore[attr-defined]
                _lease_fence(conn, monitor)
                for message_hmac, thread_hmac in pairs:
                    retired += _retire(conn, monitor, message_hmac=message_hmac)
                    conn.execute(
                        text("""INSERT INTO calendar_email_followup_scanned_messages
                        (user_id,account_id,message_hmac,thread_hmac,body_digest,internal_date_ms,
                         assessment_version,outcome)
                        VALUES (:user_id,:account_id,:message_hmac,:thread_hmac,:digest,0,
                                :version,'gone')
                        ON CONFLICT(user_id,account_id,message_hmac) DO UPDATE SET
                        outcome='gone', processed_at=NOW()"""),
                        {
                            "user_id": monitor.user_id,
                            "account_id": monitor.account_id,
                            "message_hmac": message_hmac,
                            "thread_hmac": thread_hmac,
                            "digest": _NO_DIGEST,
                            "version": ASSESSMENT_VERSION,
                        },
                    )
            return retired

        return await asyncio.to_thread(write)

    async def mark_thread_gone(self, monitor: Monitor, thread_id: str) -> int:
        """The provider no longer has this thread: nothing in it can be acted on."""
        thread_hmac = self.cipher.digest(  # type: ignore[attr-defined]
            monitor.user_id, monitor.account_id, "thread", thread_id
        )

        def write() -> int:
            with self.db.engine.begin() as conn:  # type: ignore[attr-defined]
                _lease_fence(conn, monitor)
                retired = _retire(conn, monitor, thread_hmac=thread_hmac)
                # Nothing in a vanished thread is stale or worth reading again.
                conn.execute(
                    text("""UPDATE calendar_email_followup_scanned_messages SET
                    outcome='gone', assessment_version=:version, processed_at=NOW()
                    WHERE user_id=:user_id AND account_id=:account_id AND thread_hmac=:thread_hmac"""),
                    {
                        "user_id": monitor.user_id,
                        "account_id": monitor.account_id,
                        "thread_hmac": thread_hmac,
                        "version": ASSESSMENT_VERSION,
                    },
                )
                return retired

        return await asyncio.to_thread(write)

    async def stale_assessment_threads(
        self,
        monitor: Monitor,
        *,
        cutoff_ms: int,
        limit: int = 2,
        exclude: frozenset[str] = frozenset(),
    ) -> list[str]:
        """Threads whose follow-ups predate the relevance assessment.

        Only messages that produced a follow-up under the earlier contract are
        marked stale, so this never queues the owner's whole mailbox.
        """
        if not 1 <= limit <= 10:
            raise FollowupStateError("invalid_limit")

        def read() -> list[str]:
            with self.db.engine.begin() as conn:  # type: ignore[attr-defined]
                rows = (
                    conn.execute(
                        text("""SELECT c.id,c.thread_ref_ciphertext,max(s.internal_date_ms) AS latest
                        FROM calendar_email_followup_scanned_messages s
                        JOIN calendar_email_followup_conversations c
                          ON c.user_id=s.user_id AND c.account_id=s.account_id
                         AND c.thread_hmac=s.thread_hmac
                        WHERE s.user_id=:user_id AND s.account_id=:account_id
                          AND s.outcome='assessed' AND s.assessment_version<:version
                          AND s.internal_date_ms>=:cutoff
                        GROUP BY c.id,c.thread_ref_ciphertext
                        ORDER BY latest DESC,c.id LIMIT :fetch"""),
                        {
                            "user_id": monitor.user_id,
                            "account_id": monitor.account_id,
                            "version": ASSESSMENT_VERSION,
                            "cutoff": cutoff_ms,
                            "fetch": limit + len(exclude),
                        },
                    )
                    .mappings()
                    .all()
                )
            threads = [
                self._open(  # type: ignore[attr-defined]
                    row["thread_ref_ciphertext"], monitor, str(row["id"]), "thread_ref"
                )
                for row in rows
            ]
            return [thread for thread in threads if thread not in exclude][:limit]

        return await asyncio.to_thread(read)
