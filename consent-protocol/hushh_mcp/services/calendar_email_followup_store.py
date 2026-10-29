"""Durable owner/account-scoped follow-up state; no full email body is stored."""

from __future__ import annotations

import asyncio
import json
import uuid
from dataclasses import dataclass, replace
from datetime import UTC, date, datetime, time, timedelta
from typing import Any, Literal
from zoneinfo import ZoneInfo

from sqlalchemy import text

from db.db_client import get_db
from hushh_mcp.services.calendar_email_followup_crypto import FollowupCipher
from hushh_mcp.services.calendar_email_followup_extraction import (
    CompleteAssessment,
    ValidatedCandidate,
)
from hushh_mcp.services.calendar_email_followup_reader import CompleteMailMessage


class FollowupStateError(RuntimeError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class Monitor:
    user_id: str
    account_id: str
    generation: str
    grant_epoch_digest: str
    provider_subject_sha256: str
    mail_generation: str
    calendar_connected_at: datetime
    calendar_grant_revision: str | None
    historical_start_at: datetime
    time_zone: str
    reminder_lead_days: int
    reminder_hour: int
    notifications_enabled: bool
    checkpoint: dict[str, Any] | None
    scan_state: str
    lease_id: str | None


@dataclass(frozen=True)
class DueClaim:
    monitor: Monitor
    request_id: str
    revision: int
    lease_id: str
    source_message_id: str
    thread_id: str
    source_body_digest: str
    source_internal_date_ms: int
    due_date: date | None
    due_relation: str | None


def candidate_reminder_at(
    candidate: ValidatedCandidate, monitor: Monitor, *, now: datetime | None = None
) -> datetime | None:
    """Apply the owner's configured local reminder policy to a model-declared date."""
    return _reminder_at_from_fields(
        due_date=candidate.due_date,
        due_relation=candidate.due_relation,
        time_zone=candidate.time_zone,
        responsibility=candidate.responsibility,
        ambiguities=candidate.ambiguities,
        monitor=monitor,
        now=now,
    )


def _reminder_at_from_fields(
    *,
    due_date: str | date | None,
    due_relation: str | None,
    time_zone: str | None,
    responsibility: str,
    ambiguities: list[str] | tuple[str, ...],
    monitor: Monitor,
    now: datetime | None = None,
) -> datetime | None:
    if not due_date or responsibility != "owner":
        return None
    if set(ambiguities) & {"date", "time_zone", "responsibility"}:
        return None
    if time_zone and time_zone != monitor.time_zone:
        return None
    due = date.fromisoformat(due_date) if isinstance(due_date, str) else due_date
    lead_days = (
        max(monitor.reminder_lead_days, 1)
        if due_relation == "before"
        else monitor.reminder_lead_days
    )
    local = datetime.combine(
        due - timedelta(days=lead_days),
        time(hour=monitor.reminder_hour),
        tzinfo=ZoneInfo(monitor.time_zone),
    )
    reminder = local.astimezone(UTC)
    return reminder if reminder > (now or datetime.now(UTC)) else None


class CalendarEmailFollowupStore:
    def __init__(self, *, db: Any = None, cipher: FollowupCipher | None = None) -> None:
        self.db = db or get_db()
        self.cipher = cipher or FollowupCipher()

    def _seal(self, value: Any, monitor: Monitor, row: str, purpose: str) -> str:
        return self.cipher.seal(
            value, owner=monitor.user_id, account_id=monitor.account_id, row=row, purpose=purpose
        )

    def _open(self, value: str, monitor: Monitor, row: str, purpose: str) -> Any:
        return self.cipher.open(
            value, owner=monitor.user_id, account_id=monitor.account_id, row=row, purpose=purpose
        )

    def _monitor(self, row: dict[str, Any]) -> Monitor:
        checkpoint = (
            self.cipher.open(
                row["checkpoint_ciphertext"],
                owner=row["user_id"],
                account_id=row["account_id"],
                row=str(row["generation"]),
                purpose="checkpoint",
            )
            if row.get("checkpoint_ciphertext")
            else None
        )
        if checkpoint is not None and not isinstance(checkpoint, dict):
            raise FollowupStateError("invalid_checkpoint")
        return Monitor(
            user_id=row["user_id"],
            account_id=row["account_id"],
            generation=str(row["generation"]),
            grant_epoch_digest=row["grant_epoch_digest"],
            provider_subject_sha256=row["provider_subject_sha256"],
            mail_generation=str(row["mail_generation"]),
            calendar_connected_at=row["calendar_connected_at"],
            calendar_grant_revision=row["calendar_grant_revision"],
            historical_start_at=row["historical_start_at"],
            time_zone=row["time_zone"],
            reminder_lead_days=row["reminder_lead_days"],
            reminder_hour=row["reminder_hour"],
            notifications_enabled=row["notifications_enabled"],
            checkpoint=checkpoint,
            scan_state=row["scan_state"],
            lease_id=str(row["lease_id"]) if row.get("lease_id") else None,
        )

    async def monitor(self, *, user_id: str, account_id: str) -> Monitor | None:
        def read() -> Monitor | None:
            with self.db.engine.begin() as conn:
                row = (
                    conn.execute(
                        text("""SELECT * FROM calendar_email_followup_monitors
                    WHERE user_id=:user_id AND account_id=:account_id AND enabled=TRUE"""),
                        {"user_id": user_id, "account_id": account_id},
                    )
                    .mappings()
                    .first()
                )
            return self._monitor(dict(row)) if row else None

        return await asyncio.to_thread(read)

    async def require_monitor_current(self, monitor: Monitor) -> None:
        """Fence opt-out or a changed consent generation during a read."""

        def read() -> bool:
            with self.db.engine.begin() as conn:
                return bool(
                    conn.execute(
                        text("""SELECT 1 FROM calendar_email_followup_monitors
                    WHERE user_id=:user_id AND account_id=:account_id AND enabled=TRUE
                    AND generation=CAST(:generation AS UUID) AND grant_epoch_digest=:grant"""),
                        {
                            "user_id": monitor.user_id,
                            "account_id": monitor.account_id,
                            "generation": monitor.generation,
                            "grant": monitor.grant_epoch_digest,
                        },
                    ).first()
                )

        if not await asyncio.to_thread(read):
            raise FollowupStateError("monitor_changed")

    async def due_accounts(self, *, limit: int = 10) -> list[tuple[str, str]]:
        if not 1 <= limit <= 20:
            raise FollowupStateError("invalid_limit")

        def read() -> list[tuple[str, str]]:
            with self.db.engine.begin() as conn:
                rows = conn.execute(
                    text("""SELECT user_id,account_id FROM calendar_email_followup_monitors
                    WHERE enabled=TRUE AND next_scan_at<=NOW()
                    AND (lease_until IS NULL OR lease_until<NOW())
                    ORDER BY next_scan_at,user_id,account_id LIMIT :limit"""),
                    {"limit": limit},
                ).all()
            return [(row[0], row[1]) for row in rows]

        return await asyncio.to_thread(read)

    async def acquire_scan(self, *, user_id: str, account_id: str) -> Monitor | None:
        lease_id = str(uuid.uuid4())

        def claim() -> Monitor | None:
            with self.db.engine.begin() as conn:
                row = (
                    conn.execute(
                        text("""UPDATE calendar_email_followup_monitors SET
                        lease_id=CAST(:lease_id AS UUID), lease_until=NOW()+interval '5 minutes'
                        WHERE user_id=:user_id AND account_id=:account_id AND enabled=TRUE
                          AND next_scan_at<=NOW() AND (lease_until IS NULL OR lease_until<NOW())
                        RETURNING *"""),
                        {"user_id": user_id, "account_id": account_id, "lease_id": lease_id},
                    )
                    .mappings()
                    .first()
                )
            return self._monitor(dict(row)) if row else None

        return await asyncio.to_thread(claim)

    async def release_scan(self, monitor: Monitor) -> None:
        if not monitor.lease_id:
            return

        def release() -> None:
            with self.db.engine.begin() as conn:
                conn.execute(
                    text("""UPDATE calendar_email_followup_monitors SET
                    lease_id=NULL, lease_until=NULL WHERE user_id=:user_id AND account_id=:account_id
                    AND generation=CAST(:generation AS UUID) AND lease_id=CAST(:lease_id AS UUID)"""),
                    {
                        "user_id": monitor.user_id,
                        "account_id": monitor.account_id,
                        "generation": monitor.generation,
                        "lease_id": monitor.lease_id,
                    },
                )

        await asyncio.to_thread(release)

    async def configure(
        self,
        *,
        user_id: str,
        account_id: str,
        enabled: bool,
        grant_epoch_digest: str,
        provider_subject_sha256: str,
        mail_generation: str,
        calendar_connected_at: datetime,
        calendar_grant_revision: str | None,
        historical_start_at: datetime,
        time_zone: str,
        notifications_enabled: bool,
        reminder_lead_days: int = 1,
        reminder_hour: int = 9,
    ) -> Monitor | None:
        if enabled:
            ZoneInfo(time_zone)
            if (
                historical_start_at.tzinfo is None
                or not 0 <= reminder_lead_days <= 14
                or not 0 <= reminder_hour <= 23
            ):
                raise FollowupStateError("invalid_preference")
            if historical_start_at > datetime.now(UTC):
                raise FollowupStateError("invalid_historical_period")

        def write() -> Monitor | None:
            with self.db.engine.begin() as conn:
                if enabled:
                    # Serialize consent publication, replacement and revoke
                    # with an opt-in even when no monitor row exists yet.
                    conn.execute(
                        text("SELECT pg_advisory_xact_lock(hashtextextended(:lock_key, 0))"),
                        {"lock_key": f"google-connection:{user_id}"},
                    )
                current = (
                    conn.execute(
                        text("""SELECT * FROM calendar_email_followup_monitors
                    WHERE user_id=:user_id AND account_id=:account_id FOR UPDATE"""),
                        {"user_id": user_id, "account_id": account_id},
                    )
                    .mappings()
                    .first()
                )
                if not enabled:
                    conn.execute(
                        text("""DELETE FROM calendar_email_followup_monitors
                        WHERE user_id=:user_id AND account_id=:account_id"""),
                        {"user_id": user_id, "account_id": account_id},
                    )
                    return None
                if current and (
                    current["grant_epoch_digest"] != grant_epoch_digest
                    or current["historical_start_at"] != historical_start_at
                ):
                    # A new consent period or grant begins a new isolated scan.
                    conn.execute(
                        text("""DELETE FROM calendar_email_followup_monitors
                        WHERE user_id=:user_id AND account_id=:account_id"""),
                        {"user_id": user_id, "account_id": account_id},
                    )
                    current = None
                if current:
                    schedule_changed = (
                        current["time_zone"] != time_zone
                        or current["reminder_lead_days"] != reminder_lead_days
                        or current["reminder_hour"] != reminder_hour
                    )
                    if schedule_changed:
                        updated_monitor = replace(
                            self._monitor(dict(current)),
                            time_zone=time_zone,
                            reminder_lead_days=reminder_lead_days,
                            reminder_hour=reminder_hour,
                        )
                        requests = (
                            conn.execute(
                                text("""SELECT id,due_date,due_relation,time_zone,responsibility,
                            ambiguities FROM calendar_email_followup_requests
                            WHERE user_id=:user_id AND account_id=:account_id
                            AND kind<>'meeting' AND state IN ('pending','needs_review')
                            AND reminder_is_manual=FALSE FOR UPDATE"""),
                                {"user_id": user_id, "account_id": account_id},
                            )
                            .mappings()
                            .all()
                        )
                        for request in requests:
                            next_at = _reminder_at_from_fields(
                                due_date=request["due_date"],
                                due_relation=request["due_relation"],
                                time_zone=request["time_zone"],
                                responsibility=request["responsibility"],
                                ambiguities=request["ambiguities"],
                                monitor=updated_monitor,
                            )
                            conn.execute(
                                text("""UPDATE calendar_email_followup_requests SET
                                reminder_at=:reminder_at,
                                state=:state, revision=revision+1, updated_at=NOW()
                                WHERE id=CAST(:id AS UUID)"""),
                                {
                                    "id": str(request["id"]),
                                    "reminder_at": next_at,
                                    "state": "pending" if next_at else "needs_review",
                                },
                            )
                    row = (
                        conn.execute(
                            text("""UPDATE calendar_email_followup_monitors SET
                        notifications_enabled=:notifications_enabled, time_zone=:time_zone,
                        provider_subject_sha256=:subject_hash, mail_generation=CAST(:mail_generation AS UUID),
                        calendar_connected_at=:calendar_connected_at,
                        calendar_grant_revision=:calendar_grant_revision,
                        reminder_lead_days=:lead_days, reminder_hour=:reminder_hour,
                        generation=CASE WHEN :schedule_changed THEN gen_random_uuid() ELSE generation END,
                        checkpoint_ciphertext=CASE WHEN :schedule_changed THEN NULL ELSE checkpoint_ciphertext END,
                        scan_state=CASE WHEN :schedule_changed THEN 'pending' ELSE scan_state END,
                        lease_id=CASE WHEN :schedule_changed THEN NULL ELSE lease_id END,
                        lease_until=CASE WHEN :schedule_changed THEN NULL ELSE lease_until END,
                        updated_at=NOW(), next_scan_at=NOW()
                        WHERE user_id=:user_id AND account_id=:account_id RETURNING *"""),
                            {
                                "user_id": user_id,
                                "account_id": account_id,
                                "notifications_enabled": notifications_enabled,
                                "time_zone": time_zone,
                                "subject_hash": provider_subject_sha256,
                                "mail_generation": mail_generation,
                                "calendar_connected_at": calendar_connected_at,
                                "calendar_grant_revision": calendar_grant_revision,
                                "lead_days": reminder_lead_days,
                                "reminder_hour": reminder_hour,
                                "schedule_changed": schedule_changed,
                            },
                        )
                        .mappings()
                        .one()
                    )
                else:
                    row = (
                        conn.execute(
                            text("""INSERT INTO calendar_email_followup_monitors
                        (user_id,account_id,enabled,notifications_enabled,historical_start_at,
                         time_zone,reminder_lead_days,reminder_hour,grant_epoch_digest,
                         provider_subject_sha256,mail_generation,calendar_connected_at,
                         calendar_grant_revision)
                        VALUES (:user_id,:account_id,TRUE,:notifications_enabled,:historical_start_at,
                                :time_zone,:lead_days,:reminder_hour,:grant_epoch_digest,
                                :subject_hash,CAST(:mail_generation AS UUID),:calendar_connected_at,
                                :calendar_grant_revision)
                        RETURNING *"""),
                            {
                                "user_id": user_id,
                                "account_id": account_id,
                                "notifications_enabled": notifications_enabled,
                                "historical_start_at": historical_start_at,
                                "time_zone": time_zone,
                                "lead_days": reminder_lead_days,
                                "reminder_hour": reminder_hour,
                                "grant_epoch_digest": grant_epoch_digest,
                                "subject_hash": provider_subject_sha256,
                                "mail_generation": mail_generation,
                                "calendar_connected_at": calendar_connected_at,
                                "calendar_grant_revision": calendar_grant_revision,
                            },
                        )
                        .mappings()
                        .one()
                    )
                if not conn.execute(
                    text("""SELECT calendar_email_followup_grant_current(m)
                    FROM calendar_email_followup_monitors m
                    WHERE m.user_id=:user_id AND m.account_id=:account_id"""),
                    {"user_id": user_id, "account_id": account_id},
                ).scalar_one():
                    raise FollowupStateError("monitor_changed")
            return self._monitor(dict(row))

        return await asyncio.to_thread(write)

    async def save_checkpoint(
        self,
        monitor: Monitor,
        checkpoint: dict[str, Any],
        *,
        state: Literal["pending", "partial", "complete"],
        error_code: str | None = None,
    ) -> None:
        sealed = self._seal(checkpoint, monitor, monitor.generation, "checkpoint")

        def write() -> None:
            with self.db.engine.begin() as conn:
                updated = conn.execute(
                    text("""UPDATE calendar_email_followup_monitors SET
                    checkpoint_ciphertext=:checkpoint, scan_state=:state, scan_error_code=:error,
                    last_complete_at=CASE WHEN :state='complete' THEN NOW() ELSE last_complete_at END,
                    next_scan_at=CASE WHEN :state='complete' THEN NOW()+interval '1 minute' ELSE NOW() END,
                    lease_until=NOW()+interval '5 minutes', updated_at=NOW()
                    WHERE user_id=:user_id AND account_id=:account_id
                    AND generation=CAST(:generation AS UUID) AND enabled=TRUE
                    AND grant_epoch_digest=:grant AND lease_id=CAST(:lease_id AS UUID)
                    RETURNING user_id"""),
                    {
                        "checkpoint": sealed,
                        "state": state,
                        "error": error_code,
                        "user_id": monitor.user_id,
                        "account_id": monitor.account_id,
                        "generation": monitor.generation,
                        "grant": monitor.grant_epoch_digest,
                        "lease_id": monitor.lease_id,
                    },
                ).first()
                if not updated:
                    raise FollowupStateError("monitor_changed")

        await asyncio.to_thread(write)

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

    async def prior_requests(self, monitor: Monitor, thread_id: str) -> list[dict[str, str]]:
        thread_hmac = self.cipher.digest(monitor.user_id, monitor.account_id, "thread", thread_id)

        def read() -> list[dict[str, str]]:
            with self.db.engine.begin() as conn:
                rows = (
                    conn.execute(
                        text("""SELECT r.id,r.title_ciphertext,r.quote_ciphertext,r.state
                    FROM calendar_email_followup_requests r
                    JOIN calendar_email_followup_conversations c ON c.id=r.conversation_id
                    WHERE c.user_id=:user_id AND c.account_id=:account_id AND c.thread_hmac=:thread_hmac
                    ORDER BY r.source_internal_date_ms, r.id LIMIT 21"""),
                        {
                            "user_id": monitor.user_id,
                            "account_id": monitor.account_id,
                            "thread_hmac": thread_hmac,
                        },
                    )
                    .mappings()
                    .all()
                )
            if len(rows) > 20:
                raise FollowupStateError("incomplete_thread_context")
            return [
                {
                    "request_id": str(row["id"]),
                    "title": self._open(row["title_ciphertext"], monitor, str(row["id"]), "title"),
                    "quote": self._open(row["quote_ciphertext"], monitor, str(row["id"]), "quote"),
                    "state": row["state"],
                }
                for row in rows
            ]

        return await asyncio.to_thread(read)

    async def scanned_digest(self, monitor: Monitor, message_id: str) -> str | None:
        message_hmac = self.cipher.digest(
            monitor.user_id, monitor.account_id, "message", message_id
        )

        def read() -> str | None:
            with self.db.engine.begin() as conn:
                return conn.execute(
                    text("""SELECT body_digest FROM calendar_email_followup_scanned_messages
                    WHERE user_id=:user_id AND account_id=:account_id AND message_hmac=:message_hmac"""),
                    {
                        "user_id": monitor.user_id,
                        "account_id": monitor.account_id,
                        "message_hmac": message_hmac,
                    },
                ).scalar()

        return await asyncio.to_thread(read)

    async def commit_message(
        self,
        monitor: Monitor,
        message: CompleteMailMessage,
        assessment: CompleteAssessment,
        *,
        now: datetime | None = None,
    ) -> None:
        if assessment.expected_sections != len(
            message.sections
        ) or assessment.completed_sections != len(message.sections):
            raise FollowupStateError("incomplete_assessment")
        thread_hmac = self.cipher.digest(
            monitor.user_id, monitor.account_id, "thread", message.thread_id
        )
        message_hmac = self.cipher.digest(
            monitor.user_id, monitor.account_id, "message", message.message_id
        )
        conversation_id = str(uuid.uuid4())
        thread_ref = self._seal(message.thread_id, monitor, conversation_id, "thread_ref")
        subject = self._seal(message.subject, monitor, conversation_id, "subject")
        sender = self._seal(message.sender, monitor, conversation_id, "sender")
        prepared: list[dict[str, Any]] = []
        for candidate in assessment.candidates:
            if (
                candidate.message_id != message.message_id
                or candidate.thread_id != message.thread_id
            ):
                raise FollowupStateError("source_mismatch")
            request_id = str(uuid.uuid4())
            reminder_at = candidate_reminder_at(candidate, monitor, now=now)
            state = "pending" if reminder_at and candidate.kind != "meeting" else "needs_review"
            prepared.append(
                {
                    "id": request_id,
                    "evidence_hmac": candidate.evidence_key,
                    "source_message_hmac": message_hmac,
                    "source_message_ref_ciphertext": self._seal(
                        message.message_id, monitor, request_id, "source_ref"
                    ),
                    "source_body_digest": message.body_digest,
                    "source_internal_date_ms": message.internal_date_ms,
                    "kind": candidate.kind,
                    "state": state,
                    "title_ciphertext": self._seal(candidate.title, monitor, request_id, "title"),
                    "quote_ciphertext": self._seal(candidate.quote, monitor, request_id, "quote"),
                    "due_wording_ciphertext": self._seal(
                        candidate.original_due_wording, monitor, request_id, "due_wording"
                    )
                    if candidate.original_due_wording
                    else None,
                    "due_date": candidate.due_date,
                    "due_relation": candidate.due_relation,
                    "proposed_date": candidate.proposed_date,
                    "proposed_at": candidate.proposed_at,
                    "time_zone": candidate.time_zone,
                    "responsibility": candidate.responsibility,
                    "ambiguities": list(candidate.ambiguities),
                    "reminder_at": reminder_at,
                }
            )

        def write() -> None:
            with self.db.engine.begin() as conn:
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
                existing = conn.execute(
                    text("""SELECT id FROM calendar_email_followup_conversations
                    WHERE user_id=:user_id AND account_id=:account_id AND thread_hmac=:thread_hmac FOR UPDATE"""),
                    {
                        "user_id": monitor.user_id,
                        "account_id": monitor.account_id,
                        "thread_hmac": thread_hmac,
                    },
                ).scalar()
                if existing:
                    actual_conversation_id = str(existing)
                    conn.execute(
                        text("""UPDATE calendar_email_followup_conversations SET
                        latest_internal_date_ms=GREATEST(latest_internal_date_ms,:internal_date_ms),
                        updated_at=NOW() WHERE id=CAST(:id AS UUID)"""),
                        {
                            "id": actual_conversation_id,
                            "internal_date_ms": message.internal_date_ms,
                        },
                    )
                else:
                    actual_conversation_id = conversation_id
                    conn.execute(
                        text("""INSERT INTO calendar_email_followup_conversations
                        (id,user_id,account_id,thread_hmac,thread_ref_ciphertext,
                         subject_ciphertext,sender_ciphertext,latest_internal_date_ms)
                        VALUES (CAST(:id AS UUID),:user_id,:account_id,:thread_hmac,:thread_ref,
                                :subject,:sender,:internal_date_ms)"""),
                        {
                            "id": conversation_id,
                            "user_id": monitor.user_id,
                            "account_id": monitor.account_id,
                            "thread_hmac": thread_hmac,
                            "thread_ref": thread_ref,
                            "subject": subject,
                            "sender": sender,
                            "internal_date_ms": message.internal_date_ms,
                        },
                    )
                for item in prepared:
                    conn.execute(
                        text("""INSERT INTO calendar_email_followup_requests
                        (id,conversation_id,user_id,account_id,evidence_hmac,source_message_hmac,
                         source_message_ref_ciphertext,source_body_digest,source_internal_date_ms,
                         kind,state,title_ciphertext,quote_ciphertext,due_wording_ciphertext,
                         due_date,due_relation,proposed_date,proposed_at,time_zone,responsibility,
                         ambiguities,reminder_at,last_source_internal_date_ms)
                        VALUES (CAST(:id AS UUID),CAST(:conversation_id AS UUID),:user_id,:account_id,
                                :evidence_hmac,:source_message_hmac,:source_message_ref_ciphertext,
                                :source_body_digest,:source_internal_date_ms,:kind,:state,
                                :title_ciphertext,:quote_ciphertext,:due_wording_ciphertext,
                                :due_date,:due_relation,:proposed_date,:proposed_at,:time_zone,
                                :responsibility,CAST(:ambiguities AS JSONB),:reminder_at,
                                :source_internal_date_ms)
                        ON CONFLICT(user_id,account_id,evidence_hmac) DO NOTHING"""),
                        {
                            **item,
                            "conversation_id": actual_conversation_id,
                            "user_id": monitor.user_id,
                            "account_id": monitor.account_id,
                            "ambiguities": json.dumps(item["ambiguities"]),
                        },
                    )
                for update in assessment.updates:
                    target_state = {
                        "corrected": "cancelled",
                        "cancelled": "cancelled",
                        "completed": "done",
                    }[update.outcome]
                    conn.execute(
                        text("""UPDATE calendar_email_followup_requests SET state=:state,
                        reminder_at=NULL,revision=revision+1,
                        last_source_internal_date_ms=:source_date,updated_at=NOW()
                        WHERE id=CAST(:id AS UUID) AND conversation_id=CAST(:conversation_id AS UUID)
                          AND last_source_internal_date_ms<:source_date
                          AND state NOT IN ('dismissed','done','cancelled')"""),
                        {
                            "id": update.target_request_id,
                            "conversation_id": actual_conversation_id,
                            "state": target_state,
                            "source_date": update.source_internal_date_ms,
                        },
                    )
                conn.execute(
                    text("""INSERT INTO calendar_email_followup_scanned_messages
                    (user_id,account_id,message_hmac,thread_hmac,body_digest,internal_date_ms)
                    VALUES (:user_id,:account_id,:message_hmac,:thread_hmac,:body_digest,:internal_date_ms)
                    ON CONFLICT(user_id,account_id,message_hmac) DO UPDATE SET
                    body_digest=EXCLUDED.body_digest,processed_at=NOW()"""),
                    {
                        "user_id": monitor.user_id,
                        "account_id": monitor.account_id,
                        "message_hmac": message_hmac,
                        "thread_hmac": thread_hmac,
                        "body_digest": message.body_digest,
                        "internal_date_ms": message.internal_date_ms,
                    },
                )

        await asyncio.to_thread(write)
