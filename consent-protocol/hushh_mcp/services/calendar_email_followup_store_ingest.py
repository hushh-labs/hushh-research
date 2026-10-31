"""Focused durable follow-up store adapter; composed by the public facade."""

from __future__ import annotations

import asyncio
import json
import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import text

from hushh_mcp.services.calendar_email_followup_extraction import CompleteAssessment
from hushh_mcp.services.calendar_email_followup_reader import CompleteMailMessage
from hushh_mcp.services.calendar_email_followup_store_types import (
    FollowupStateError,
    Monitor,
    candidate_reminder_at,
)


class _MessageIngest:
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
