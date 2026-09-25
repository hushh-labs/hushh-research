"""Durable, metadata-only outbox state for Drive-sharing notifications.

The request transaction only writes ``drive_share_events``. A separate worker
claims an event in a short transaction, calls the generic push adapter after
that transaction has committed, then records that the dispatch attempt has
settled. A settled event is deliberately *not* evidence that a device showed
the notification or that a person read it.
"""

from __future__ import annotations

from typing import Any, cast
from uuid import UUID, uuid4

from sqlalchemy import text

from hushh_mcp.services.external_connector_lifecycle_store import ExternalConnectorLifecycleStore

MAX_NOTIFICATION_ATTEMPTS = 3
NOTIFICATION_LEASE_SECONDS = 90
MAX_NOTIFICATION_RETRY_SECONDS = 300
# Every outbox with the 232 + 235 column shape; nothing else may be leased.
OUTBOX_TABLES = frozenset({"drive_share_events", "drive_query_events"})


class DriveShareNotificationStore(ExternalConnectorLifecycleStore):
    """Lease-only authority for the opaque ``drive_share_events`` outbox.

    Subclasses bind the same lease protocol to another outbox table with the
    same columns; the table name is a fixed, allowlisted class constant.
    """

    TABLE = "drive_share_events"

    def _sql(self, statement: str) -> str:
        if self.TABLE not in OUTBOX_TABLES:
            raise ValueError("unknown notification outbox")
        return statement.replace("{table}", self.TABLE)

    @staticmethod
    def _event_id(value: str) -> str:
        return str(UUID(str(value)))

    async def due(self, limit: int = 8) -> list[dict[str, Any]]:
        """Inspect a fair, bounded set without handing provider authority to it."""
        if type(limit) is not int or not 1 <= limit <= 100:
            raise ValueError("invalid notification outbox limit")

        def operation(connection: Any) -> list[dict[str, Any]]:
            # A process can die after claiming a dispatch. Once all bounded
            # attempts have been consumed, close it as unavailable instead of
            # retaining an unbounded retry loop. This remains an attempted
            # dispatch record, never a user-delivery or read receipt.
            connection.execute(
                text(
                    self._sql("""
                UPDATE {table}
                SET notification_state='settled', notification_lease_id=NULL,
                    notification_lease_expires_at=NULL,
                    notification_settled_at=clock_timestamp(),
                    delivered_at=COALESCE(delivered_at,clock_timestamp()),
                    notification_error_code=COALESCE(notification_error_code,'notification_unavailable')
                WHERE notification_state IN ('queued','dispatching')
                  AND notification_attempt_count>=:attempts
                  AND (notification_lease_id IS NULL
                    OR notification_lease_expires_at<=clock_timestamp())
            """)
                ),
                {"attempts": MAX_NOTIFICATION_ATTEMPTS},
            )
            return [
                dict(row)
                for row in connection.execute(
                    text(
                        self._sql("""
                    WITH due AS (
                      SELECT event_id FROM {table}
                      WHERE notification_state IN ('queued','dispatching')
                        AND notification_attempt_count<:attempts
                        AND notification_next_attempt_at<=clock_timestamp()
                        AND (notification_lease_id IS NULL
                          OR notification_lease_expires_at<=clock_timestamp())
                      ORDER BY notification_inspected_at,created_at,event_id
                      LIMIT :limit FOR UPDATE SKIP LOCKED
                    )
                    UPDATE {table} event SET notification_inspected_at=clock_timestamp()
                    FROM due WHERE event.event_id=due.event_id
                    RETURNING event.event_id,event.user_id,event.request_id,event.event_type,
                      event.notification_state,event.notification_attempt_count
                """)
                    ),
                    {"attempts": MAX_NOTIFICATION_ATTEMPTS, "limit": limit},
                ).mappings()
            ]

        return cast(list[dict[str, Any]], await self._transaction(operation))

    async def claim(self, *, event_id: str) -> dict[str, Any] | None:
        """Make one durable dispatch attempt; never call a provider here."""
        event_id = self._event_id(event_id)

        def operation(connection: Any) -> dict[str, Any] | None:
            row = self._row(
                connection,
                self._sql("""
                SELECT event_id,user_id,request_id,event_type,notification_state,
                  notification_attempt_count,notification_next_attempt_at,
                  notification_lease_id,notification_lease_expires_at
                FROM {table} WHERE event_id=:event FOR UPDATE
                """),
                {"event": event_id},
            )
            if row is None or row["notification_state"] not in {"queued", "dispatching"}:
                return None
            if int(row["notification_attempt_count"]) >= MAX_NOTIFICATION_ATTEMPTS:
                return None
            now = connection.execute(text("SELECT clock_timestamp()")).scalar_one()
            if (
                row["notification_next_attempt_at"] > now
                or row["notification_lease_expires_at"] is not None
                and row["notification_lease_expires_at"] > now
            ):
                return None
            lease_id = str(uuid4())
            return cast(
                dict[str, Any] | None,
                self._row(
                    connection,
                    self._sql("""
                    UPDATE {table}
                    SET notification_state='dispatching', notification_lease_id=:lease,
                        notification_lease_expires_at=clock_timestamp()+make_interval(secs=>:seconds),
                        notification_attempt_count=notification_attempt_count+1,
                        notification_error_code=NULL
                    WHERE event_id=:event
                    RETURNING event_id,user_id,request_id,event_type,notification_lease_id,
                      notification_attempt_count
                    """),
                    {
                        "event": event_id,
                        "lease": lease_id,
                        "seconds": NOTIFICATION_LEASE_SECONDS,
                    },
                ),
            )

        return cast(dict[str, Any] | None, await self._transaction(operation))

    async def settle(self, job: dict[str, Any]) -> bool:
        """Record that the generic dispatch call returned, not user receipt."""
        event_id = self._event_id(str(job["event_id"]))
        lease_id = self._event_id(str(job["notification_lease_id"]))

        def operation(connection: Any) -> bool:
            row = self._row(
                connection,
                self._sql("""
                UPDATE {table}
                SET notification_state='settled', notification_lease_id=NULL,
                    notification_lease_expires_at=NULL,
                    notification_settled_at=clock_timestamp(),
                    delivered_at=COALESCE(delivered_at,clock_timestamp()),
                    notification_error_code=NULL
                WHERE event_id=:event AND notification_state='dispatching'
                  AND notification_lease_id=:lease
                  AND notification_lease_expires_at>clock_timestamp()
                RETURNING event_id
                """),
                {"event": event_id, "lease": lease_id},
            )
            return row is not None

        return cast(bool, await self._transaction(operation))

    async def suppress(self, job: dict[str, Any]) -> bool:
        """Terminally suppress an unreviewed event type without dispatching it."""
        event_id = self._event_id(str(job["event_id"]))
        lease_id = self._event_id(str(job["notification_lease_id"]))

        def operation(connection: Any) -> bool:
            row = self._row(
                connection,
                self._sql("""
                UPDATE {table}
                SET notification_state='suppressed', notification_lease_id=NULL,
                    notification_lease_expires_at=NULL,
                    notification_error_code='notification_type_unavailable'
                WHERE event_id=:event AND notification_state='dispatching'
                  AND notification_lease_id=:lease
                  AND notification_lease_expires_at>clock_timestamp()
                RETURNING event_id
                """),
                {"event": event_id, "lease": lease_id},
            )
            return row is not None

        return cast(bool, await self._transaction(operation))

    async def retry(self, job: dict[str, Any]) -> str:
        """Release a current lease with capped exponential retry scheduling."""
        event_id = self._event_id(str(job["event_id"]))
        lease_id = self._event_id(str(job["notification_lease_id"]))

        def operation(connection: Any) -> str:
            row = self._row(
                connection,
                self._sql("""
                SELECT notification_attempt_count FROM {table}
                WHERE event_id=:event AND notification_state='dispatching'
                  AND notification_lease_id=:lease
                  AND notification_lease_expires_at>clock_timestamp()
                FOR UPDATE
                """),
                {"event": event_id, "lease": lease_id},
            )
            if row is None:
                return "not_claimed"
            if int(row["notification_attempt_count"]) >= MAX_NOTIFICATION_ATTEMPTS:
                connection.execute(
                    text(
                        self._sql("""
                    UPDATE {table}
                    SET notification_state='settled', notification_lease_id=NULL,
                        notification_lease_expires_at=NULL,
                        notification_settled_at=clock_timestamp(),
                        delivered_at=COALESCE(delivered_at,clock_timestamp()),
                        notification_error_code='notification_unavailable'
                    WHERE event_id=:event AND notification_lease_id=:lease
                """)
                    ),
                    {"event": event_id, "lease": lease_id},
                )
                return "settled_unavailable"
            connection.execute(
                text(
                    self._sql("""
                UPDATE {table}
                SET notification_state='queued', notification_lease_id=NULL,
                    notification_lease_expires_at=NULL,
                    notification_next_attempt_at=clock_timestamp()+make_interval(
                      secs=>LEAST(:max_delay,30*POWER(2,notification_attempt_count-1)::INTEGER)
                    ), notification_error_code='notification_unavailable'
                WHERE event_id=:event AND notification_lease_id=:lease
            """)
                ),
                {
                    "event": event_id,
                    "lease": lease_id,
                    "max_delay": MAX_NOTIFICATION_RETRY_SECONDS,
                },
            )
            return "retry_scheduled"

        return cast(str, await self._transaction(operation))


class DriveQueryNotificationStore(DriveShareNotificationStore):
    """The same lease protocol for Drive-question events (migration 244)."""

    TABLE = "drive_query_events"
