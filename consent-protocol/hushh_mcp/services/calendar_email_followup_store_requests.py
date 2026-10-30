"""Focused durable follow-up store adapter; composed by the public facade."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from typing import Any, Literal

from sqlalchemy import text

from hushh_mcp.services.calendar_email_followup_store_types import (
    FollowupStateError,
    Monitor,
)


class _RequestRead:
    async def list_conversations(
        self, monitor: Monitor, *, limit: int = 3, offset: int = 0
    ) -> dict[str, Any]:
        if not 1 <= limit <= 50 or not 0 <= offset <= 100000:
            raise FollowupStateError("invalid_limit")

        def read() -> dict[str, Any]:
            with self.db.engine.begin() as conn:
                count = conn.execute(
                    text("""SELECT count(*) FROM calendar_email_followup_conversations c
                    WHERE c.user_id=:user_id AND c.account_id=:account_id
                    AND EXISTS (SELECT 1 FROM calendar_email_followup_requests r
                      WHERE r.conversation_id=c.id
                        AND r.state IN ('pending','snoozed','needs_review'))"""),
                    {"user_id": monitor.user_id, "account_id": monitor.account_id},
                ).scalar_one()
                rows = (
                    conn.execute(
                        text("""SELECT c.id,c.subject_ciphertext,c.sender_ciphertext,c.thread_ref_ciphertext,
                    c.latest_internal_date_ms,
                    count(r.id) AS request_count,
                    count(r.id) FILTER (WHERE r.state IN ('pending','snoozed','needs_review')) AS active_count,
                    min(COALESCE(r.due_date,r.proposed_date)) FILTER
                      (WHERE r.state IN ('pending','snoozed','needs_review')) AS next_date,
                    min(CASE WHEN r.state='needs_review' AND r.due_date IS NULL
                      AND r.proposed_date IS NULL THEN 0 ELSE 1 END) FILTER
                      (WHERE r.state IN ('pending','snoozed','needs_review')) AS review_rank
                    FROM calendar_email_followup_conversations c
                    JOIN calendar_email_followup_requests r ON r.conversation_id=c.id
                    WHERE c.user_id=:user_id AND c.account_id=:account_id
                    GROUP BY c.id HAVING count(r.id) FILTER
                      (WHERE r.state IN ('pending','snoozed','needs_review'))>0
                    ORDER BY review_rank,next_date ASC NULLS LAST,
                      c.latest_internal_date_ms DESC,c.id DESC LIMIT :limit OFFSET :offset"""),
                        {
                            "user_id": monitor.user_id,
                            "account_id": monitor.account_id,
                            "limit": limit,
                            "offset": offset,
                        },
                    )
                    .mappings()
                    .all()
                )
                previews = (
                    conn.execute(
                        text("""SELECT r.* FROM calendar_email_followup_requests r
                        WHERE r.conversation_id=ANY(CAST(:conversation_ids AS UUID[]))
                          AND r.state IN ('pending','snoozed','needs_review')
                        ORDER BY COALESCE(r.due_date,r.proposed_date) ASC NULLS LAST,
                          r.source_internal_date_ms,r.id"""),
                        {"conversation_ids": [str(row["id"]) for row in rows]},
                    )
                    .mappings()
                    .all()
                    if rows
                    else []
                )
            previews_by_conversation: dict[str, list[dict[str, Any]]] = {}
            for preview in previews:
                row_id = str(preview["id"])
                previews_by_conversation.setdefault(str(preview["conversation_id"]), []).append(
                    {
                        "id": row_id,
                        "kind": preview["kind"],
                        "state": preview["state"],
                        "title": self._open(preview["title_ciphertext"], monitor, row_id, "title"),
                        "original_due_wording": self._open(
                            preview["due_wording_ciphertext"], monitor, row_id, "due_wording"
                        )
                        if preview["due_wording_ciphertext"]
                        else None,
                        "due_date": preview["due_date"].isoformat()
                        if preview["due_date"]
                        else None,
                        "proposed_date": preview["proposed_date"].isoformat()
                        if preview["proposed_date"]
                        else None,
                        "ambiguities": preview["ambiguities"],
                    }
                )
            return {
                "account_id": monitor.account_id,
                "scan_state": monitor.scan_state,
                "incomplete_source_count": len(
                    (monitor.checkpoint or {}).get("incomplete_sources", {})
                ),
                "total_conversations": int(count),
                "next_offset": offset + len(rows) if offset + len(rows) < int(count) else None,
                "conversations": [
                    {
                        "id": str(row["id"]),
                        "subject": self._open(
                            row["subject_ciphertext"], monitor, str(row["id"]), "subject"
                        ),
                        "sender": self._open(
                            row["sender_ciphertext"], monitor, str(row["id"]), "sender"
                        ),
                        "latest_internal_date_ms": row["latest_internal_date_ms"],
                        "request_count": int(row["request_count"]),
                        "active_count": int(row["active_count"]),
                        "preview_requests": previews_by_conversation.get(str(row["id"]), [])[:3],
                        "source_completeness": "partial"
                        if self._open(
                            row["thread_ref_ciphertext"], monitor, str(row["id"]), "thread_ref"
                        )
                        in (monitor.checkpoint or {}).get("incomplete_sources", {})
                        else "complete",
                    }
                    for row in rows
                ],
            }

        return await asyncio.to_thread(read)

    async def detail(self, monitor: Monitor, conversation_id: str) -> dict[str, Any]:
        def read() -> dict[str, Any]:
            with self.db.engine.begin() as conn:
                conversation = (
                    conn.execute(
                        text("""SELECT * FROM calendar_email_followup_conversations
                    WHERE id=CAST(:id AS UUID) AND user_id=:user_id AND account_id=:account_id"""),
                        {
                            "id": conversation_id,
                            "user_id": monitor.user_id,
                            "account_id": monitor.account_id,
                        },
                    )
                    .mappings()
                    .first()
                )
                if not conversation:
                    raise FollowupStateError("conversation_unavailable")
                rows = (
                    conn.execute(
                        text("""SELECT * FROM calendar_email_followup_requests
                    WHERE conversation_id=CAST(:id AS UUID) AND user_id=:user_id
                    AND account_id=:account_id ORDER BY source_internal_date_ms,id"""),
                        {
                            "id": conversation_id,
                            "user_id": monitor.user_id,
                            "account_id": monitor.account_id,
                        },
                    )
                    .mappings()
                    .all()
                )
            c = dict(conversation)
            return {
                "id": conversation_id,
                "account_id": monitor.account_id,
                "subject": self._open(c["subject_ciphertext"], monitor, conversation_id, "subject"),
                "sender": self._open(c["sender_ciphertext"], monitor, conversation_id, "sender"),
                "latest_internal_date_ms": c["latest_internal_date_ms"],
                "source_completeness": "partial"
                if self._open(c["thread_ref_ciphertext"], monitor, conversation_id, "thread_ref")
                in (monitor.checkpoint or {}).get("incomplete_sources", {})
                else "complete",
                "requests": [self._request_view(monitor, dict(row)) for row in rows],
            }

        return await asyncio.to_thread(read)

    def _request_view(self, monitor: Monitor, row: dict[str, Any]) -> dict[str, Any]:
        row_id = str(row["id"])
        return {
            "id": row_id,
            "kind": row["kind"],
            "state": row["state"],
            "title": self._open(row["title_ciphertext"], monitor, row_id, "title"),
            "source_excerpt": self._open(row["quote_ciphertext"], monitor, row_id, "quote"),
            "original_due_wording": self._open(
                row["due_wording_ciphertext"], monitor, row_id, "due_wording"
            )
            if row["due_wording_ciphertext"]
            else None,
            "due_date": row["due_date"].isoformat() if row["due_date"] else None,
            "due_relation": row["due_relation"],
            "proposed_date": row["proposed_date"].isoformat() if row["proposed_date"] else None,
            "proposed_at": row["proposed_at"].isoformat() if row["proposed_at"] else None,
            "time_zone": row["time_zone"],
            "responsibility": row["responsibility"],
            "ambiguities": row["ambiguities"],
            "reminder_at": row["reminder_at"].isoformat() if row["reminder_at"] else None,
            "source_internal_date_ms": row["source_internal_date_ms"],
            "revision": row["revision"],
            "booking_state": ("booked" if row["booking_event_ref_ciphertext"] else "not_booked")
            if row["kind"] == "meeting"
            else None,
        }

    async def conversation_for_request(self, monitor: Monitor, request_id: str) -> str:
        def read() -> str:
            with self.db.engine.begin() as conn:
                conversation_id = conn.execute(
                    text("""SELECT conversation_id FROM calendar_email_followup_requests
                    WHERE id=CAST(:id AS UUID) AND user_id=:user_id AND account_id=:account_id"""),
                    {
                        "id": request_id,
                        "user_id": monitor.user_id,
                        "account_id": monitor.account_id,
                    },
                ).scalar()
            if not conversation_id:
                raise FollowupStateError("request_unavailable")
            return str(conversation_id)

        return await asyncio.to_thread(read)

    async def source_message_id(self, monitor: Monitor, request_id: str) -> str:
        def read() -> str:
            with self.db.engine.begin() as conn:
                row = (
                    conn.execute(
                        text("""SELECT source_message_ref_ciphertext FROM calendar_email_followup_requests
                    WHERE id=CAST(:id AS UUID) AND user_id=:user_id AND account_id=:account_id"""),
                        {
                            "id": request_id,
                            "user_id": monitor.user_id,
                            "account_id": monitor.account_id,
                        },
                    )
                    .mappings()
                    .first()
                )
            if not row:
                raise FollowupStateError("request_unavailable")
            value = self._open(
                row["source_message_ref_ciphertext"], monitor, request_id, "source_ref"
            )
            if not isinstance(value, str):
                raise FollowupStateError("request_unavailable")
            return value

        return await asyncio.to_thread(read)


class _RequestMutate:
    async def mutate_request(
        self,
        monitor: Monitor,
        *,
        request_id: str,
        expected_revision: int,
        idempotency_key: str,
        action: Literal["done", "dismiss", "snooze", "set_reminder"],
        reminder_at: datetime | None = None,
    ) -> dict[str, Any]:
        if action in {"snooze", "set_reminder"} and (
            reminder_at is None or reminder_at.tzinfo is None or reminder_at <= datetime.now(UTC)
        ):
            raise FollowupStateError("invalid_reminder_time")

        def write() -> dict[str, Any]:
            with self.db.engine.begin() as conn:
                active = conn.execute(
                    text("""SELECT 1 FROM calendar_email_followup_monitors
                    WHERE user_id=:user_id AND account_id=:account_id AND enabled=TRUE
                    AND generation=CAST(:generation AS UUID) AND grant_epoch_digest=:grant FOR UPDATE"""),
                    {
                        "user_id": monitor.user_id,
                        "account_id": monitor.account_id,
                        "generation": monitor.generation,
                        "grant": monitor.grant_epoch_digest,
                    },
                ).first()
                if not active:
                    raise FollowupStateError("monitor_changed")
                row = (
                    conn.execute(
                        text("""SELECT * FROM calendar_email_followup_requests
                    WHERE id=CAST(:id AS UUID) AND user_id=:user_id AND account_id=:account_id FOR UPDATE"""),
                        {
                            "id": request_id,
                            "user_id": monitor.user_id,
                            "account_id": monitor.account_id,
                        },
                    )
                    .mappings()
                    .first()
                )
                if not row:
                    raise FollowupStateError("request_unavailable")
                prior = conn.execute(
                    text("""SELECT resulting_revision FROM calendar_email_followup_mutations
                    WHERE request_id=CAST(:id AS UUID) AND idempotency_key=CAST(:key AS UUID)"""),
                    {"id": request_id, "key": idempotency_key},
                ).scalar()
                if prior is not None:
                    return {
                        "id": request_id,
                        # A replay reports the live row as a coherent snapshot.
                        # A later action may already have advanced it again.
                        "revision": int(row["revision"]),
                        "state": row["state"],
                        "reminder_at": row["reminder_at"].isoformat()
                        if row["reminder_at"]
                        else None,
                    }
                if row["revision"] != expected_revision:
                    raise FollowupStateError("request_changed")
                if row["state"] in {"cancelled", "source_unavailable"}:
                    raise FollowupStateError("request_unavailable")
                state = {
                    "done": "done",
                    "dismiss": "dismissed",
                    "snooze": "snoozed",
                    "set_reminder": "pending",
                }[action]
                changed = (
                    conn.execute(
                        text("""UPDATE calendar_email_followup_requests SET
                    state=:state, reminder_at=:reminder_at,
                    reminder_is_manual=CASE WHEN :manual THEN TRUE ELSE reminder_is_manual END,
                    revision=revision+1, updated_at=NOW()
                    WHERE id=CAST(:id AS UUID) RETURNING revision,state,reminder_at"""),
                        {
                            "id": request_id,
                            "state": state,
                            "manual": action in {"snooze", "set_reminder"},
                            "reminder_at": reminder_at
                            if action in {"snooze", "set_reminder"}
                            else None,
                        },
                    )
                    .mappings()
                    .one()
                )
                conn.execute(
                    text("""INSERT INTO calendar_email_followup_mutations
                    (request_id,idempotency_key,resulting_revision)
                    VALUES (CAST(:id AS UUID),CAST(:key AS UUID),:revision)"""),
                    {"id": request_id, "key": idempotency_key, "revision": changed["revision"]},
                )
            return {
                "id": request_id,
                "revision": changed["revision"],
                "state": changed["state"],
                "reminder_at": changed["reminder_at"].isoformat()
                if changed["reminder_at"]
                else None,
            }

        return await asyncio.to_thread(write)

    async def record_booking(
        self,
        monitor: Monitor,
        *,
        request_id: str,
        expected_revision: int,
        idempotency_key: str,
        event_id: str,
    ) -> dict[str, Any]:
        if not event_id or len(event_id) > 2048:
            raise FollowupStateError("invalid_booking_event")
        event_ref = self._seal(event_id, monitor, request_id, "booking_event_ref")

        def write() -> dict[str, Any]:
            with self.db.engine.begin() as conn:
                active = conn.execute(
                    text("""SELECT 1 FROM calendar_email_followup_monitors
                    WHERE user_id=:user_id AND account_id=:account_id AND enabled=TRUE
                      AND generation=CAST(:generation AS UUID) AND grant_epoch_digest=:grant
                      AND calendar_email_followup_grant_current(calendar_email_followup_monitors)
                    FOR UPDATE"""),
                    {
                        "user_id": monitor.user_id,
                        "account_id": monitor.account_id,
                        "generation": monitor.generation,
                        "grant": monitor.grant_epoch_digest,
                    },
                ).first()
                if not active:
                    raise FollowupStateError("monitor_changed")
                row = (
                    conn.execute(
                        text("""SELECT * FROM calendar_email_followup_requests
                    WHERE id=CAST(:id AS UUID) AND user_id=:user_id AND account_id=:account_id
                    FOR UPDATE"""),
                        {
                            "id": request_id,
                            "user_id": monitor.user_id,
                            "account_id": monitor.account_id,
                        },
                    )
                    .mappings()
                    .first()
                )
                if not row or row["kind"] != "meeting":
                    raise FollowupStateError("request_unavailable")
                prior = conn.execute(
                    text("""SELECT 1 FROM calendar_email_followup_mutations
                    WHERE request_id=CAST(:id AS UUID) AND idempotency_key=CAST(:key AS UUID)"""),
                    {"id": request_id, "key": idempotency_key},
                ).first()
                if prior:
                    return {
                        "id": request_id,
                        "revision": row["revision"],
                        "booking_state": "booked"
                        if row["booking_event_ref_ciphertext"]
                        else "not_booked",
                    }
                if row["revision"] != expected_revision or row["state"] in {
                    "done",
                    "cancelled",
                    "dismissed",
                    "source_unavailable",
                }:
                    raise FollowupStateError("request_changed")
                changed = conn.execute(
                    text("""UPDATE calendar_email_followup_requests SET
                    booking_event_ref_ciphertext=:event_ref,booking_confirmed_at=NOW(),
                    state='done',reminder_at=NULL,revision=revision+1,updated_at=NOW()
                    WHERE id=CAST(:id AS UUID) RETURNING revision"""),
                    {"id": request_id, "event_ref": event_ref},
                ).scalar_one()
                conn.execute(
                    text("""INSERT INTO calendar_email_followup_mutations
                    (request_id,idempotency_key,resulting_revision)
                    VALUES (CAST(:id AS UUID),CAST(:key AS UUID),:revision)"""),
                    {"id": request_id, "key": idempotency_key, "revision": changed},
                )
                conn.execute(
                    text("""DELETE FROM feed_events WHERE user_id=:user_id
                    AND source_domain='calendar_email_followup'
                    AND metadata->>'request_id'=:id"""),
                    {"user_id": monitor.user_id, "id": request_id},
                )
                return {"id": request_id, "revision": changed, "booking_state": "booked"}

        return await asyncio.to_thread(write)
