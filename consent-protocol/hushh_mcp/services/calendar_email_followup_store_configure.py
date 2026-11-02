"""Statements behind turning follow-up monitoring on, off or re-pointing it.

They run in the caller's transaction, with the owner's Google-connection
advisory lock already held. Reconfiguring never deletes what the owner already
decided: only a different Google identity, or an owner-narrowed period, removes
stored rows, and then only the rows that no longer belong.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import text

from hushh_mcp.services.calendar_email_followup_store_types import (
    Monitor,
    _reminder_at_from_fields,
)


def delete_monitor(conn: Any, user_id: str, account_id: str) -> None:
    conn.execute(
        text("""DELETE FROM calendar_email_followup_monitors
        WHERE user_id=:user_id AND account_id=:account_id"""),
        {"user_id": user_id, "account_id": account_id},
    )


def drop_out_of_period(
    conn: Any, user_id: str, account_id: str, historical_start_at: datetime
) -> None:
    """The owner narrowed the approved period: nothing older may remain.

    Everything inside the period, and every decision the owner made about it, is
    kept.
    """
    scope = {
        "user_id": user_id,
        "account_id": account_id,
        "cutoff": int(historical_start_at.timestamp() * 1000),
    }
    conn.execute(
        text("""DELETE FROM calendar_email_followup_requests
        WHERE user_id=:user_id AND account_id=:account_id
          AND source_internal_date_ms<:cutoff"""),
        scope,
    )
    conn.execute(
        text("""DELETE FROM calendar_email_followup_conversations c
        WHERE c.user_id=:user_id AND c.account_id=:account_id
          AND c.latest_internal_date_ms<:cutoff
          AND NOT EXISTS (SELECT 1 FROM calendar_email_followup_requests r
                          WHERE r.conversation_id=c.id)"""),
        scope,
    )
    conn.execute(
        text("""DELETE FROM calendar_email_followup_scanned_messages
        WHERE user_id=:user_id AND account_id=:account_id
          AND internal_date_ms<:cutoff"""),
        scope,
    )


def recompute_reminders(conn: Any, user_id: str, account_id: str, monitor: Monitor) -> None:
    """New reminder timing: recompute unsent, non-manual reminders only."""
    requests = (
        conn.execute(
            text("""SELECT id,due_date,due_relation,time_zone,responsibility,
        ambiguities FROM calendar_email_followup_requests
        WHERE user_id=:user_id AND account_id=:account_id
        AND kind<>'meeting' AND state IN ('pending','needs_review')
        AND suppressed_at IS NULL
        AND reminder_sent_revision IS DISTINCT FROM revision
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
            monitor=monitor,
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


def update_monitor(
    conn: Any, values: dict[str, Any], *, period_changed: bool, grant_changed: bool
) -> dict[str, Any]:
    """Re-point an existing monitor in place.

    A new period restarts the scan; a new grant clears the previous failure; a
    reminder-timing change touches neither.
    """
    return dict(
        conn.execute(
            text("""UPDATE calendar_email_followup_monitors SET
        notifications_enabled=:notifications_enabled, time_zone=:time_zone,
        provider_subject_sha256=:subject_hash, mail_generation=CAST(:mail_generation AS UUID),
        calendar_connected_at=:calendar_connected_at,
        calendar_grant_revision=:calendar_grant_revision,
        reminder_lead_days=:lead_days, reminder_hour=:reminder_hour,
        grant_epoch_digest=:grant_epoch_digest,
        historical_start_at=:historical_start_at,
        generation=CASE WHEN :period_changed THEN gen_random_uuid() ELSE generation END,
        checkpoint_ciphertext=CASE WHEN :period_changed THEN NULL ELSE checkpoint_ciphertext END,
        scan_state=CASE WHEN :period_changed THEN 'pending' ELSE scan_state END,
        lease_id=CASE WHEN :period_changed THEN NULL ELSE lease_id END,
        lease_until=CASE WHEN :period_changed THEN NULL ELSE lease_until END,
        scan_error_code=CASE WHEN :grant_changed OR :period_changed
          THEN NULL ELSE scan_error_code END,
        consecutive_failures=CASE WHEN :grant_changed OR :period_changed
          THEN 0 ELSE consecutive_failures END,
        updated_at=NOW(), next_scan_at=NOW()
        WHERE user_id=:user_id AND account_id=:account_id RETURNING *"""),
            {**values, "period_changed": period_changed, "grant_changed": grant_changed},
        )
        .mappings()
        .one()
    )


def insert_monitor(conn: Any, values: dict[str, Any]) -> dict[str, Any]:
    return dict(
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
            values,
        )
        .mappings()
        .one()
    )
