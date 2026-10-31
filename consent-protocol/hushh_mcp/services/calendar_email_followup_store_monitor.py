"""Focused durable follow-up store adapter; composed by the public facade."""

from __future__ import annotations

import asyncio
import uuid
from dataclasses import replace
from datetime import UTC, datetime
from typing import Any, Literal
from zoneinfo import ZoneInfo

from sqlalchemy import text

from hushh_mcp.services.calendar_email_followup_store_types import (
    FollowupStateError,
    Monitor,
    _reminder_at_from_fields,
)


class _MonitorState:
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


class _MonitorConfig:
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
