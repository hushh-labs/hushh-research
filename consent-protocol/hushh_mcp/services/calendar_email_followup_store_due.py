"""Focused durable follow-up store adapter; composed by the public facade."""

from __future__ import annotations

import asyncio
import json
import uuid
from datetime import UTC, datetime, time, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import text

from hushh_mcp.services.calendar_email_followup_store_types import (
    DueClaim,
)


class _DueClaims:
    async def claim_due(self, *, now: datetime | None = None) -> DueClaim | None:
        instant = now or datetime.now(UTC)
        lease_id = str(uuid.uuid4())

        def claim() -> DueClaim | None:
            with self.db.engine.begin() as conn:
                row = (
                    conn.execute(
                        text("""WITH due AS (
                      SELECT r.id FROM calendar_email_followup_requests r
                      JOIN calendar_email_followup_monitors m
                        ON m.user_id=r.user_id AND m.account_id=r.account_id
                      WHERE m.enabled=TRUE AND m.notifications_enabled=TRUE
                        AND r.state IN ('pending','snoozed') AND r.reminder_at<=:now
                        AND r.reminder_sent_revision IS DISTINCT FROM r.revision
                        AND (r.reminder_lease_until IS NULL OR r.reminder_lease_until<:now)
                        AND (r.reminder_retry_at IS NULL OR r.reminder_retry_at<=:now)
                      ORDER BY r.reminder_at,r.id LIMIT 1 FOR UPDATE OF r SKIP LOCKED
                    ) UPDATE calendar_email_followup_requests r SET
                      reminder_lease_id=CAST(:lease_id AS UUID),
                      reminder_lease_until=:lease_until
                    FROM due WHERE r.id=due.id RETURNING r.*"""),
                        {
                            "now": instant,
                            "lease_id": lease_id,
                            "lease_until": instant + timedelta(minutes=5),
                        },
                    )
                    .mappings()
                    .first()
                )
                if not row:
                    return None
                monitor_row = (
                    conn.execute(
                        text("""SELECT * FROM calendar_email_followup_monitors
                    WHERE user_id=:user_id AND account_id=:account_id"""),
                        {"user_id": row["user_id"], "account_id": row["account_id"]},
                    )
                    .mappings()
                    .one()
                )
                conversation = (
                    conn.execute(
                        text("""SELECT thread_ref_ciphertext FROM calendar_email_followup_conversations
                    WHERE id=:id AND user_id=:user_id AND account_id=:account_id"""),
                        {
                            "id": row["conversation_id"],
                            "user_id": row["user_id"],
                            "account_id": row["account_id"],
                        },
                    )
                    .mappings()
                    .one()
                )
            monitor = self._monitor(dict(monitor_row))
            request_id = str(row["id"])
            conversation_id = str(row["conversation_id"])
            return DueClaim(
                monitor=monitor,
                request_id=request_id,
                revision=int(row["revision"]),
                lease_id=lease_id,
                source_message_id=self._open(
                    row["source_message_ref_ciphertext"], monitor, request_id, "source_ref"
                ),
                thread_id=self._open(
                    conversation["thread_ref_ciphertext"], monitor, conversation_id, "thread_ref"
                ),
                source_body_digest=row["source_body_digest"],
                source_internal_date_ms=int(row["source_internal_date_ms"]),
                due_date=row["due_date"],
                due_relation=row["due_relation"],
            )

        return await asyncio.to_thread(claim)

    async def source_claim_for_push(
        self, *, user_id: str, request_id: str, revision: int
    ) -> DueClaim | None:
        """Recover only the exact queued request for a fresh provider check."""

        def read() -> DueClaim | None:
            with self.db.engine.begin() as conn:
                row = (
                    conn.execute(
                        text("""SELECT r.*,c.thread_ref_ciphertext FROM calendar_email_followup_requests r
                    JOIN calendar_email_followup_conversations c ON c.id=r.conversation_id
                    WHERE r.id=CAST(:id AS UUID) AND r.user_id=:user_id
                      AND r.revision=:revision AND r.reminder_sent_revision=:revision
                      AND r.state IN ('pending','snoozed')"""),
                        {"id": request_id, "user_id": user_id, "revision": revision},
                    )
                    .mappings()
                    .first()
                )
                if not row:
                    return None
                monitor_row = (
                    conn.execute(
                        text("""SELECT * FROM calendar_email_followup_monitors
                    WHERE user_id=:user_id AND account_id=:account_id AND enabled=TRUE
                      AND notifications_enabled=TRUE"""),
                        {"user_id": user_id, "account_id": row["account_id"]},
                    )
                    .mappings()
                    .first()
                )
            if not monitor_row:
                return None
            monitor = self._monitor(dict(monitor_row))
            conversation_id = str(row["conversation_id"])
            return DueClaim(
                monitor=monitor,
                request_id=request_id,
                revision=revision,
                lease_id="",
                source_message_id=self._open(
                    row["source_message_ref_ciphertext"], monitor, request_id, "source_ref"
                ),
                thread_id=self._open(
                    row["thread_ref_ciphertext"], monitor, conversation_id, "thread_ref"
                ),
                source_body_digest=row["source_body_digest"],
                source_internal_date_ms=int(row["source_internal_date_ms"]),
                due_date=row["due_date"],
                due_relation=row["due_relation"],
            )

        return await asyncio.to_thread(read)

    async def defer_due(self, claim: DueClaim, *, now: datetime | None = None) -> None:
        instant = now or datetime.now(UTC)

        def defer() -> None:
            with self.db.engine.begin() as conn:
                conn.execute(
                    text("""UPDATE calendar_email_followup_requests SET
                    reminder_lease_id=NULL, reminder_lease_until=NULL,
                    reminder_retry_at=:retry_at
                    WHERE id=CAST(:id AS UUID) AND revision=:revision
                      AND reminder_lease_id=CAST(:lease_id AS UUID)"""),
                    {
                        "id": claim.request_id,
                        "revision": claim.revision,
                        "lease_id": claim.lease_id,
                        "retry_at": instant + timedelta(minutes=5),
                    },
                )

        await asyncio.to_thread(defer)

    async def mark_source_unavailable(self, claim: DueClaim) -> None:
        def mark() -> None:
            with self.db.engine.begin() as conn:
                conn.execute(
                    text("""UPDATE calendar_email_followup_requests SET
                    state='source_unavailable', reminder_at=NULL, revision=revision+1,
                    reminder_lease_id=NULL, reminder_lease_until=NULL, updated_at=NOW()
                    WHERE id=CAST(:id AS UUID) AND revision=:revision
                      AND reminder_lease_id=CAST(:lease_id AS UUID)"""),
                    {
                        "id": claim.request_id,
                        "revision": claim.revision,
                        "lease_id": claim.lease_id,
                    },
                )

        await asyncio.to_thread(mark)

    async def expire_due(self, claim: DueClaim) -> None:
        """Keep an overdue request for review without claiming its source vanished."""

        def expire() -> None:
            with self.db.engine.begin() as conn:
                conn.execute(
                    text("""UPDATE calendar_email_followup_requests SET
                    state='needs_review', reminder_at=NULL, revision=revision+1,
                    reminder_lease_id=NULL, reminder_lease_until=NULL, updated_at=NOW()
                    WHERE id=CAST(:id AS UUID) AND revision=:revision
                      AND reminder_lease_id=CAST(:lease_id AS UUID)"""),
                    {
                        "id": claim.request_id,
                        "revision": claim.revision,
                        "lease_id": claim.lease_id,
                    },
                )

        await asyncio.to_thread(expire)


class _DueQueue:
    async def queue_due(self, claim: DueClaim, *, now: datetime | None = None) -> bool:
        instant = now or datetime.now(UTC)
        expires_at = instant + timedelta(days=1)
        if claim.due_date:
            end_day = (
                claim.due_date
                if claim.due_relation == "before"
                else claim.due_date + timedelta(days=1)
            )
            deadline = datetime.combine(
                end_day, time.min, tzinfo=ZoneInfo(claim.monitor.time_zone)
            ).astimezone(UTC)
            expires_at = min(expires_at, deadline)
        if expires_at <= instant:
            await self.expire_due(claim)
            return False

        def queue() -> bool:
            with self.db.engine.begin() as conn:
                live = conn.execute(
                    text("""SELECT r.id FROM calendar_email_followup_requests r
                    JOIN calendar_email_followup_monitors m
                      ON m.user_id=r.user_id AND m.account_id=r.account_id
                    WHERE r.id=CAST(:id AS UUID) AND r.revision=:revision
                      AND r.reminder_lease_id=CAST(:lease_id AS UUID)
                      AND r.state IN ('pending','snoozed') AND r.reminder_at<=:now
                      AND r.reminder_sent_revision IS DISTINCT FROM r.revision
                      AND m.enabled=TRUE AND m.notifications_enabled=TRUE
                      AND m.generation=CAST(:generation AS UUID)
                      AND m.grant_epoch_digest=:grant
                      AND calendar_email_followup_grant_current(m)
                    FOR UPDATE OF r,m"""),
                    {
                        "id": claim.request_id,
                        "revision": claim.revision,
                        "lease_id": claim.lease_id,
                        "now": instant,
                        "generation": claim.monitor.generation,
                        "grant": claim.monitor.grant_epoch_digest,
                    },
                ).first()
                if not live:
                    return False
                conn.execute(
                    text("""UPDATE calendar_email_followup_requests SET
                    reminder_sent_revision=revision, reminder_lease_id=NULL,
                    reminder_lease_until=NULL, reminder_retry_at=NULL,
                    last_checked_at=:now, updated_at=NOW()
                    WHERE id=CAST(:id AS UUID)"""),
                    {"id": claim.request_id, "now": instant},
                )
                conn.execute(
                    text("""INSERT INTO system_push_outbox
                    (source_kind,source_id,source_revision,recipient_user_id,due_at,expires_at)
                    VALUES ('calendar_email_followup',CAST(:id AS UUID),:revision,:user_id,:now,:expires_at)
                    ON CONFLICT(source_kind,source_id,source_revision,recipient_user_id)
                    DO NOTHING"""),
                    {
                        "id": claim.request_id,
                        "revision": str(claim.revision),
                        "user_id": claim.monitor.user_id,
                        "now": instant,
                        "expires_at": expires_at,
                    },
                )
                conn.execute(
                    text("""INSERT INTO feed_events
                    (user_id,source_domain,event_type,source_row_id,metadata)
                    VALUES (:user_id,'calendar_email_followup','followup_reminder',
                            :source_row_id,CAST(:metadata AS JSONB))
                    ON CONFLICT (user_id,source_domain,event_type,source_row_id)
                    WHERE source_row_id IS NOT NULL DO NOTHING"""),
                    {
                        "user_id": claim.monitor.user_id,
                        "source_row_id": f"{claim.request_id}:{claim.revision}",
                        "metadata": json.dumps(
                            {
                                "account_id": claim.monitor.account_id,
                                "request_id": claim.request_id,
                            }
                        ),
                    },
                )
            return True

        return await asyncio.to_thread(queue)
