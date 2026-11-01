"""Statements that make one assessed message durable.

Each function runs inside the caller's transaction, after the caller has locked
the monitor under its scan lease. Nothing here sees raw mail beyond the sealed
values it is handed; sealing stays with the store that owns the cipher.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Mapping, Sequence
from dataclasses import replace
from datetime import datetime
from typing import Any

from sqlalchemy import text

from hushh_mcp.services.calendar_email_followup_extraction import (
    ValidatedCandidate,
    ValidatedUpdate,
)
from hushh_mcp.services.calendar_email_followup_reader import CompleteMailMessage
from hushh_mcp.services.calendar_email_followup_relevance import ASSESSMENT_VERSION
from hushh_mcp.services.calendar_email_followup_store_types import (
    FollowupStateError,
    Monitor,
    candidate_reminder_at,
)

Seal = Callable[[Any, Monitor, str, str], str]
_UPDATE_STATE = {"corrected": "cancelled", "cancelled": "cancelled", "completed": "done"}


def lock_policy(conn: Any, monitor: Monitor) -> Monitor:
    """Lock the live monitor and return it with the owner's current reminder policy.

    Reminder timing follows the settings as locked now, not the snapshot the
    scan started with.
    """
    live = (
        conn.execute(
            text("""SELECT time_zone,reminder_lead_days,reminder_hour
        FROM calendar_email_followup_monitors
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
        )
        .mappings()
        .first()
    )
    if not live:
        raise FollowupStateError("monitor_changed")
    return replace(
        monitor,
        time_zone=live["time_zone"],
        reminder_lead_days=live["reminder_lead_days"],
        reminder_hour=live["reminder_hour"],
    )


def known_requests(
    conn: Any, monitor: Monitor, keys: Sequence[str]
) -> dict[str, Mapping[str, Any]]:
    """Requests this account already holds for the given evidence keys."""
    if not keys:
        return {}
    rows = (
        conn.execute(
            text("""SELECT id,evidence_hmac,assessment_version
            FROM calendar_email_followup_requests
            WHERE user_id=:user_id AND account_id=:account_id
              AND evidence_hmac=ANY(CAST(:keys AS TEXT[]))"""),
            {"user_id": monitor.user_id, "account_id": monitor.account_id, "keys": list(keys)},
        )
        .mappings()
        .all()
    )
    return {row["evidence_hmac"]: row for row in rows}


def upsert_conversation(
    conn: Any,
    monitor: Monitor,
    message: CompleteMailMessage,
    *,
    thread_hmac: str,
    new_id: str,
    sealed: Mapping[str, str],
) -> str:
    """Return the thread's conversation id, creating it on first sight."""
    found = conn.execute(
        text("""SELECT id FROM calendar_email_followup_conversations
        WHERE user_id=:user_id AND account_id=:account_id AND thread_hmac=:thread_hmac FOR UPDATE"""),
        {"user_id": monitor.user_id, "account_id": monitor.account_id, "thread_hmac": thread_hmac},
    ).scalar()
    if found:
        conn.execute(
            text("""UPDATE calendar_email_followup_conversations SET
            latest_internal_date_ms=GREATEST(latest_internal_date_ms,:internal_date_ms),
            updated_at=NOW() WHERE id=CAST(:id AS UUID)"""),
            {"id": str(found), "internal_date_ms": message.internal_date_ms},
        )
        return str(found)
    conn.execute(
        text("""INSERT INTO calendar_email_followup_conversations
        (id,user_id,account_id,thread_hmac,thread_ref_ciphertext,
         subject_ciphertext,sender_ciphertext,latest_internal_date_ms)
        VALUES (CAST(:id AS UUID),:user_id,:account_id,:thread_hmac,:thread_ref,
                :subject,:sender,:internal_date_ms)"""),
        {
            "id": new_id,
            "user_id": monitor.user_id,
            "account_id": monitor.account_id,
            "thread_hmac": thread_hmac,
            "thread_ref": sealed["thread_ref"],
            "subject": sealed["subject"],
            "sender": sealed["sender"],
            "internal_date_ms": message.internal_date_ms,
        },
    )
    return new_id


def sealed_event(
    seal: Seal, monitor: Monitor, candidate: ValidatedCandidate, request_id: str
) -> str | None:
    if not candidate.linked_event:
        return None
    event_id, title, start = candidate.linked_event
    return seal(
        {"id": event_id, "title": title, "start": start}, monitor, request_id, "linked_event"
    )


def upgrade_request(
    conn: Any, row_id: str, candidate: ValidatedCandidate, linked_event: str | None
) -> None:
    """A row from the earlier contract that the new assessment still supports."""
    conn.execute(
        text("""UPDATE calendar_email_followup_requests SET
        relevance='actionable', category=:category, urgency=:urgency,
        meeting_state=:meeting_state, assessment_version=:version,
        suppressed_at=NULL, suppression_reason=NULL,
        linked_event_ciphertext=:linked_event, updated_at=NOW()
        WHERE id=CAST(:id AS UUID)"""),
        {
            "id": row_id,
            "category": candidate.category,
            "urgency": candidate.urgency,
            "meeting_state": candidate.meeting_state,
            "version": ASSESSMENT_VERSION,
            "linked_event": linked_event,
        },
    )


def insert_request(
    conn: Any,
    monitor: Monitor,
    policy: Monitor,
    *,
    seal: Seal,
    candidate: ValidatedCandidate,
    message: CompleteMailMessage,
    message_hmac: str,
    conversation_id: str,
    request_id: str,
    now: datetime | None,
) -> None:
    reminder_at = candidate_reminder_at(candidate, policy, now=now)
    wording = (
        seal(candidate.original_due_wording, monitor, request_id, "due_wording")
        if candidate.original_due_wording
        else None
    )
    conn.execute(
        text("""INSERT INTO calendar_email_followup_requests
        (id,conversation_id,user_id,account_id,evidence_hmac,source_message_hmac,
         source_message_ref_ciphertext,source_body_digest,source_internal_date_ms,
         kind,state,title_ciphertext,quote_ciphertext,due_wording_ciphertext,
         due_date,due_relation,proposed_date,proposed_at,time_zone,responsibility,
         ambiguities,reminder_at,last_source_internal_date_ms,relevance,category,
         urgency,meeting_state,assessment_version,linked_event_ciphertext)
        VALUES (CAST(:id AS UUID),CAST(:conversation_id AS UUID),:user_id,:account_id,
                :evidence_hmac,:source_message_hmac,:source_message_ref_ciphertext,
                :source_body_digest,:source_internal_date_ms,:kind,:state,
                :title_ciphertext,:quote_ciphertext,:due_wording_ciphertext,
                :due_date,:due_relation,:proposed_date,:proposed_at,:time_zone,
                :responsibility,CAST(:ambiguities AS JSONB),:reminder_at,
                :source_internal_date_ms,'actionable',:category,:urgency,
                :meeting_state,:version,:linked_event)
        ON CONFLICT(user_id,account_id,evidence_hmac) DO NOTHING"""),
        {
            "id": request_id,
            "conversation_id": conversation_id,
            "user_id": monitor.user_id,
            "account_id": monitor.account_id,
            "evidence_hmac": candidate.evidence_key,
            "source_message_hmac": message_hmac,
            "source_message_ref_ciphertext": seal(
                message.message_id, monitor, request_id, "source_ref"
            ),
            "source_body_digest": message.body_digest,
            "source_internal_date_ms": message.internal_date_ms,
            "kind": candidate.kind,
            "state": "pending" if reminder_at and candidate.kind != "meeting" else "needs_review",
            "title_ciphertext": seal(candidate.title, monitor, request_id, "title"),
            "quote_ciphertext": seal(candidate.quote, monitor, request_id, "quote"),
            "due_wording_ciphertext": wording,
            "due_date": candidate.due_date,
            "due_relation": candidate.due_relation,
            "proposed_date": candidate.proposed_date,
            "proposed_at": candidate.proposed_at,
            "time_zone": candidate.time_zone,
            "responsibility": candidate.responsibility,
            "ambiguities": json.dumps(list(candidate.ambiguities)),
            "reminder_at": reminder_at,
            "category": candidate.category,
            "urgency": candidate.urgency,
            "meeting_state": candidate.meeting_state,
            "version": ASSESSMENT_VERSION,
            "linked_event": sealed_event(seal, monitor, candidate, request_id),
        },
    )


def suppress_unsupported(conn: Any, monitor: Monitor, message_hmac: str) -> None:
    """Hide this message's earlier-contract rows that the reassessment dropped."""
    suppressed = (
        conn.execute(
            text("""UPDATE calendar_email_followup_requests SET
            suppressed_at=NOW(), suppression_reason='reassessed_not_relevant',
            reminder_at=NULL, revision=revision+1,
            reminder_lease_id=NULL, reminder_lease_until=NULL, updated_at=NOW()
            WHERE user_id=:user_id AND account_id=:account_id
              AND source_message_hmac=:message_hmac
              AND assessment_version<:version AND suppressed_at IS NULL
            RETURNING id"""),
            {
                "user_id": monitor.user_id,
                "account_id": monitor.account_id,
                "message_hmac": message_hmac,
                "version": ASSESSMENT_VERSION,
            },
        )
        .scalars()
        .all()
    )
    if suppressed:
        # A reminder already in the Feed for a false positive must not linger.
        conn.execute(
            text("""DELETE FROM feed_events WHERE user_id=:user_id
            AND source_domain='calendar_email_followup'
            AND metadata->>'request_id'=ANY(CAST(:ids AS TEXT[]))"""),
            {"user_id": monitor.user_id, "ids": [str(item) for item in suppressed]},
        )


def apply_updates(conn: Any, updates: Sequence[ValidatedUpdate], conversation_id: str) -> None:
    """A later message corrected, cancelled or completed an earlier request."""
    for update in updates:
        conn.execute(
            text("""UPDATE calendar_email_followup_requests SET state=:state,
            reminder_at=NULL,revision=revision+1,
            last_source_internal_date_ms=:source_date,updated_at=NOW()
            WHERE id=CAST(:id AS UUID) AND conversation_id=CAST(:conversation_id AS UUID)
              AND last_source_internal_date_ms<:source_date
              AND state NOT IN ('dismissed','done','cancelled')"""),
            {
                "id": update.target_request_id,
                "conversation_id": conversation_id,
                "state": _UPDATE_STATE[update.outcome],
                "source_date": update.source_internal_date_ms,
            },
        )


def record_assessed(
    conn: Any,
    monitor: Monitor,
    message: CompleteMailMessage,
    *,
    message_hmac: str,
    thread_hmac: str,
) -> None:
    conn.execute(
        text("""INSERT INTO calendar_email_followup_scanned_messages
        (user_id,account_id,message_hmac,thread_hmac,body_digest,internal_date_ms,
         assessment_version,outcome)
        VALUES (:user_id,:account_id,:message_hmac,:thread_hmac,:body_digest,
                :internal_date_ms,:version,'assessed')
        ON CONFLICT(user_id,account_id,message_hmac) DO UPDATE SET
        body_digest=EXCLUDED.body_digest,assessment_version=EXCLUDED.assessment_version,
        outcome='assessed',processed_at=NOW()"""),
        {
            "user_id": monitor.user_id,
            "account_id": monitor.account_id,
            "message_hmac": message_hmac,
            "thread_hmac": thread_hmac,
            "body_digest": message.body_digest,
            "internal_date_ms": message.internal_date_ms,
            "version": ASSESSMENT_VERSION,
        },
    )
