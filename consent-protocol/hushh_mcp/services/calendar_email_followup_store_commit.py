"""Statements that make one assessed message durable.

Each function runs inside the caller's transaction, after the caller has locked
the monitor under its scan lease. Nothing here sees raw mail beyond the sealed
values it is handed; sealing stays with the store that owns the cipher.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Mapping, Sequence
from dataclasses import replace
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import text

from hushh_mcp.services.calendar_email_followup_extraction import (
    ValidatedCandidate,
    ValidatedUpdate,
)
from hushh_mcp.services.calendar_email_followup_reader import CompleteMailMessage
from hushh_mcp.services.calendar_email_followup_relevance import (
    ASSESSMENT_VERSION,
    same_obligation_wording,
    same_sender_domain,
    similar_titles,
    title_tokens,
)
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
            text("""SELECT id,evidence_hmac,assessment_version,
            (suppressed_at IS NOT NULL OR merged_into IS NOT NULL) AS hidden
            FROM calendar_email_followup_requests
            WHERE user_id=:user_id AND account_id=:account_id
              AND evidence_hmac=ANY(CAST(:keys AS TEXT[]))"""),
            {"user_id": monitor.user_id, "account_id": monitor.account_id, "keys": list(keys)},
        )
        .mappings()
        .all()
    )
    return {row["evidence_hmac"]: row for row in rows}


# Opens one sealed field of an existing row: (ciphertext, row id, purpose) -> value.
Open = Callable[[str, str, str], str]


def _same_dates(row: Mapping[str, Any], candidate: ValidatedCandidate) -> bool:
    def day(value: Any) -> str | None:
        return value.isoformat() if value else None

    proposed_at = row["proposed_at"]
    return (
        day(row["due_date"]) == candidate.due_date
        and day(row["proposed_date"]) == candidate.proposed_date
        and (
            proposed_at is None
            if candidate.proposed_at is None
            else proposed_at == datetime.fromisoformat(candidate.proposed_at)
        )
    )


def _squash(value: str) -> str:
    return " ".join(value.casefold().split())


def adopt_legacy_rows(
    conn: Any,
    monitor: Monitor,
    message_hmac: str,
    candidates: Sequence[ValidatedCandidate],
    known: dict[str, Mapping[str, Any]],
    open_value: Open,
) -> None:
    """Let a reassessed candidate take over the earlier-contract row it restates.

    The evidence key includes the model's title, so a fresh assessment of the
    same sentence usually has a new key. Without this step the earlier row would
    be hidden and a new pending one created, so a task the owner already marked
    done, snoozed or dismissed would come back. A candidate adopts a row of the
    same message when kind and dates are identical and it quotes the same words
    or titles the same obligation; the row keeps its decision and reminders.
    """
    rows = (
        conn.execute(
            text("""SELECT id,kind,due_date,proposed_date,proposed_at,
            quote_ciphertext,title_ciphertext,assessment_version,
            (suppressed_at IS NOT NULL OR merged_into IS NOT NULL) AS hidden
            FROM calendar_email_followup_requests
            WHERE user_id=:user_id AND account_id=:account_id
              AND source_message_hmac=:message_hmac
              AND assessment_version<:version
            ORDER BY hidden,created_at,id"""),
            {
                "user_id": monitor.user_id,
                "account_id": monitor.account_id,
                "message_hmac": message_hmac,
                "version": ASSESSMENT_VERSION,
            },
        )
        .mappings()
        .all()
    )
    claimed = {str(row["id"]) for row in known.values()}
    rows = [row for row in rows if str(row["id"]) not in claimed]
    for candidate in candidates:
        if candidate.evidence_key in known:
            continue
        for row in rows:
            row_id = str(row["id"])
            if row["kind"] != candidate.kind or not _same_dates(row, candidate):
                continue
            quote = open_value(row["quote_ciphertext"], row_id, "quote")
            if _squash(quote) != _squash(candidate.quote):
                if row["hidden"]:
                    continue
                title = open_value(row["title_ciphertext"], row_id, "title")
                if not similar_titles(title, candidate.title):
                    continue
            known[candidate.evidence_key] = row
            rows.remove(row)
            # A matching settled source stays sealed under its original evidence key.
            if row["hidden"]:
                break
            conn.execute(
                text("""UPDATE calendar_email_followup_requests SET evidence_hmac=:key
                WHERE id=CAST(:id AS UUID)"""),
                {"id": row_id, "key": candidate.evidence_key},
            )
            break


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
    conn: Any,
    row_id: str,
    candidate: ValidatedCandidate,
    linked_event: str | None,
    title: str,
) -> None:
    """A row from the earlier contract that the new assessment still supports."""
    conn.execute(
        text("""UPDATE calendar_email_followup_requests SET
        relevance='actionable', category=:category, urgency=:urgency,
        meeting_state=:meeting_state, after_date=:after_date, assessment_version=:version,
        title_ciphertext=:title, linked_event_ciphertext=:linked_event, updated_at=NOW()
        WHERE id=CAST(:id AS UUID) AND suppressed_at IS NULL AND merged_into IS NULL"""),
        {
            "id": row_id,
            "category": candidate.category,
            "urgency": candidate.urgency,
            "meeting_state": candidate.meeting_state,
            "after_date": candidate.after_date,
            "version": ASSESSMENT_VERSION,
            "linked_event": linked_event,
            "title": title,
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
         urgency,meeting_state,after_date,assessment_version,linked_event_ciphertext)
        VALUES (CAST(:id AS UUID),CAST(:conversation_id AS UUID),:user_id,:account_id,
                :evidence_hmac,:source_message_hmac,:source_message_ref_ciphertext,
                :source_body_digest,:source_internal_date_ms,:kind,:state,
                :title_ciphertext,:quote_ciphertext,:due_wording_ciphertext,
                :due_date,:due_relation,:proposed_date,:proposed_at,:time_zone,
                :responsibility,CAST(:ambiguities AS JSONB),:reminder_at,
                :source_internal_date_ms,'actionable',:category,:urgency,
                :meeting_state,:after_date,:version,:linked_event)
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
            "state": "pending" if reminder_at else "needs_review",
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
            "after_date": candidate.after_date,
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


_ACTIVE = ("needs_review", "pending", "snoozed")
_CLOSED = ("done", "dismissed")
_ROW = """SELECT r.id,r.kind,r.state,r.reminder_at,r.reminder_is_manual,r.due_date,
    r.proposed_date,r.proposed_at,r.after_date,r.source_internal_date_ms,
    r.last_source_internal_date_ms,r.category,r.responsibility,r.due_relation,
    r.title_ciphertext,r.conversation_id,c.sender_ciphertext
    FROM calendar_email_followup_requests r
    JOIN calendar_email_followup_conversations c ON c.id=r.conversation_id"""


def _forget_feed(conn: Any, monitor: Monitor, ids: Sequence[str]) -> None:
    """A reminder already in the Feed for a request that no longer stands alone must not linger."""
    if ids:
        conn.execute(
            text("""DELETE FROM feed_events WHERE user_id=:user_id
            AND source_domain='calendar_email_followup'
            AND metadata->>'request_id'=ANY(CAST(:ids AS TEXT[]))"""),
            {"user_id": monitor.user_id, "ids": [str(item) for item in ids]},
        )


def _carry_decision(
    conn: Any, monitor: Monitor, *, keep: Mapping[str, Any], from_row: Mapping[str, Any]
) -> bool:
    """Give ``keep`` the owner's decision recorded on ``from_row``; True when it changed.

    Done and dismissed always carry: the owner already decided this obligation.
    A snooze or a manual reminder carries only while it is still in the future.
    """
    if keep["state"] not in _ACTIVE:
        return False
    now = datetime.now(UTC)
    state, reminder, manual = None, None, False
    if from_row["state"] in _CLOSED:
        state = from_row["state"]
    elif (
        from_row["state"] == "snoozed"
        and from_row["reminder_at"]
        and from_row["reminder_at"] > now
        and keep["state"] != "snoozed"
    ):
        state, reminder, manual = "snoozed", from_row["reminder_at"], True
    elif (
        from_row["reminder_is_manual"]
        and from_row["reminder_at"]
        and from_row["reminder_at"] > now
        and (
            not keep["reminder_is_manual"]
            or keep["reminder_at"] is None
            or keep["reminder_at"] <= now
        )
    ):
        state, reminder, manual = "pending", from_row["reminder_at"], True
    if state is None:
        return False
    conn.execute(
        text("""UPDATE calendar_email_followup_requests SET state=:state,
        reminder_at=:reminder_at,
        reminder_is_manual=CASE WHEN :manual THEN TRUE ELSE reminder_is_manual END,
        revision=revision+1,reminder_lease_id=NULL,reminder_lease_until=NULL,updated_at=NOW()
        WHERE id=CAST(:id AS UUID)"""),
        {"id": str(keep["id"]), "state": state, "reminder_at": reminder, "manual": manual},
    )
    if state in _CLOSED:
        _forget_feed(conn, monitor, [str(keep["id"])])
    return True


def _absorb(
    conn: Any, monitor: Monitor, *, primary: Mapping[str, Any], other_id: str, why: str
) -> None:
    conn.execute(
        text("""UPDATE calendar_email_followup_requests SET merged_into=CAST(:primary AS UUID),
        suppressed_at=COALESCE(suppressed_at,NOW()),
        suppression_reason=COALESCE(suppression_reason,:why),
        reminder_at=NULL,revision=revision+1,
        reminder_lease_id=NULL,reminder_lease_until=NULL,updated_at=NOW()
        WHERE id=CAST(:id AS UUID)"""),
        {"primary": str(primary["id"]), "why": why, "id": other_id},
    )
    _forget_feed(conn, monitor, [other_id])


def apply_replacement(
    conn: Any, monitor: Monitor, *, new_id: str, target_id: str, open_value: Open
) -> bool:
    """The new request restates an earlier one with a changed date, as the model proved.

    The model names the earlier request, but a name is not proof. Both rows must
    belong to this owner and account, sit in one conversation, be one kind, and
    word one obligation (same numbers: a second exam round is not the first). An
    ambiguous or mismatched claim leaves both requests separate; showing two is
    recoverable, merging into the wrong one is not.

    The earlier request keeps its sealed source and leaves the live list; the new
    one carries the owner's decision, so a dismissed, completed or snoozed
    obligation does not come back because its deadline moved.
    """
    if new_id == target_id:
        return False
    rows = {
        str(row["id"]): row
        for row in conn.execute(
            text(
                _ROW
                + """ WHERE r.user_id=:user_id AND r.account_id=:account_id
            AND r.suppressed_at IS NULL AND r.merged_into IS NULL
            AND r.id IN (CAST(:new AS UUID),CAST(:target AS UUID)) FOR UPDATE OF r"""
            ),
            {
                "user_id": monitor.user_id,
                "account_id": monitor.account_id,
                "new": new_id,
                "target": target_id,
            },
        )
        .mappings()
        .all()
    }
    new, target = rows.get(new_id), rows.get(target_id)
    if (
        not new
        or not target
        or new["conversation_id"] != target["conversation_id"]
        or new["kind"] != target["kind"]
        or new["source_internal_date_ms"] <= target["last_source_internal_date_ms"]
        or target["state"] == "source_unavailable"
        or not same_obligation_wording(
            open_value(new["title_ciphertext"], new_id, "title"),
            open_value(target["title_ciphertext"], target_id, "title"),
        )
    ):
        return False
    _carry_decision(conn, monitor, keep=new, from_row=target)
    conn.execute(
        text("""UPDATE calendar_email_followup_requests SET merged_into=CAST(:new AS UUID),
        state=CASE WHEN state IN ('done','dismissed') THEN state ELSE 'cancelled' END,
        reminder_at=NULL,revision=revision+1,reminder_lease_id=NULL,
        reminder_lease_until=NULL,updated_at=NOW()
        WHERE id=CAST(:id AS UUID)"""),
        {"new": new_id, "id": target_id},
    )
    _forget_feed(conn, monitor, [target_id])
    return True


def merge_duplicates(conn: Any, monitor: Monitor, row_id: str, *, open_value: Open) -> int:
    """Fold restatements of one obligation, across emails, into its earliest request.

    Only consider requests with the same typed deadline and responsibility,
    matching sender domains and no conflicting terms or numbers in their titles.
    A different exam, assignment or meeting differs in at least one. Only
    requests assessed under the current contract take part, so a row waiting
    for reassessment is never judged by an older reading. Each merged request
    keeps its own source, and the owner's decision moves onto the survivor.
    """
    own = (
        conn.execute(
            text(
                _ROW
                + """ WHERE r.id=CAST(:id AS UUID) AND r.user_id=:user_id
            AND r.account_id=:account_id AND r.suppressed_at IS NULL AND r.merged_into IS NULL
            AND r.assessment_version>=:version"""
            ),
            {
                "id": row_id,
                "user_id": monitor.user_id,
                "account_id": monitor.account_id,
                "version": ASSESSMENT_VERSION,
            },
        )
        .mappings()
        .first()
    )
    if not own:
        return 0
    peers = (
        conn.execute(
            text(
                _ROW
                + """ WHERE r.user_id=:user_id AND r.account_id=:account_id
            AND r.id<>CAST(:id AS UUID) AND r.suppressed_at IS NULL AND r.merged_into IS NULL
            AND r.assessment_version>=:version AND r.kind=:kind
            AND r.state<>'source_unavailable'
            AND r.due_date IS NOT DISTINCT FROM :due_date
            AND r.proposed_date IS NOT DISTINCT FROM :proposed_date
            AND r.proposed_at IS NOT DISTINCT FROM :proposed_at
            AND r.after_date=:after_date AND r.category IS NOT DISTINCT FROM :category
            AND r.responsibility=:responsibility
            AND r.due_relation IS NOT DISTINCT FROM :due_relation
            ORDER BY r.source_internal_date_ms,r.id LIMIT 25 FOR UPDATE OF r"""
            ),
            {
                "id": row_id,
                "user_id": monitor.user_id,
                "account_id": monitor.account_id,
                "version": ASSESSMENT_VERSION,
                "kind": own["kind"],
                "due_date": own["due_date"],
                "proposed_date": own["proposed_date"],
                "proposed_at": own["proposed_at"],
                "after_date": own["after_date"],
                "category": own["category"],
                "responsibility": own["responsibility"],
                "due_relation": own["due_relation"],
            },
        )
        .mappings()
        .all()
    )
    if not peers:
        return 0

    def identity(row: Mapping[str, Any]) -> tuple[str, str]:
        return (
            open_value(row["title_ciphertext"], str(row["id"]), "title"),
            open_value(row["sender_ciphertext"], str(row["conversation_id"]), "sender"),
        )

    def same_obligation(left: tuple[str, str], right: tuple[str, str]) -> bool:
        left_terms, right_terms = title_tokens(left[0]), title_tokens(right[0])
        return (
            (left_terms <= right_terms or right_terms <= left_terms)
            and same_obligation_wording(left[0], right[0])
            and same_sender_domain(left[1], right[1])
        )

    known = {str(row["id"]): identity(row) for row in (own, *peers)}
    own_identity = known[str(own["id"])]
    group = [own] + [
        peer for peer in peers if same_obligation(own_identity, known[str(peer["id"])])
    ]
    if len(group) == 1:
        return 0
    group.sort(key=lambda row: (row["source_internal_date_ms"], str(row["id"])))
    survivor = group[0]
    merged = 0
    for other in group[1:]:
        # Matching `own` is not transitive: every absorbed request must match the
        # survivor itself, or it stays a separate request.
        if not same_obligation(known[str(survivor["id"])], known[str(other["id"])]):
            continue
        _carry_decision(conn, monitor, keep=survivor, from_row=other)
        survivor = (
            conn.execute(text(_ROW + " WHERE r.id=CAST(:id AS UUID)"), {"id": str(survivor["id"])})
            .mappings()
            .one()
        )
        _absorb(
            conn,
            monitor,
            primary=survivor,
            other_id=str(other["id"]),
            why="repeat_of_other_message",
        )
        merged += 1
    return merged
