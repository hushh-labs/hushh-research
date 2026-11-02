"""Focused durable follow-up store adapter; composed by the public facade."""

from __future__ import annotations

import asyncio
import uuid
from datetime import datetime

from sqlalchemy import text

from hushh_mcp.services import calendar_email_followup_store_commit as commit
from hushh_mcp.services.calendar_email_followup_extraction import CompleteAssessment
from hushh_mcp.services.calendar_email_followup_reader import CompleteMailMessage
from hushh_mcp.services.calendar_email_followup_relevance import ASSESSMENT_VERSION
from hushh_mcp.services.calendar_email_followup_store_types import FollowupStateError, Monitor


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
        reassess: bool = False,
    ) -> None:
        """Make one fully assessed message durable.

        ``reassess`` marks a re-read of a message first assessed before the
        relevance contract existed. Its earlier follow-ups are upgraded in place
        when the new assessment still stands behind them and hidden otherwise;
        a decision the owner already made (done, snoozed, dismissed) is never
        rewritten.
        """
        if assessment.expected_sections != len(
            message.sections
        ) or assessment.completed_sections != len(message.sections):
            raise FollowupStateError("incomplete_assessment")
        for candidate in assessment.candidates:
            if (
                candidate.message_id != message.message_id
                or candidate.thread_id != message.thread_id
            ):
                raise FollowupStateError("source_mismatch")
        thread_hmac = self.cipher.digest(
            monitor.user_id, monitor.account_id, "thread", message.thread_id
        )
        message_hmac = self.cipher.digest(
            monitor.user_id, monitor.account_id, "message", message.message_id
        )
        conversation_id = str(uuid.uuid4())
        sealed = {
            "thread_ref": self._seal(message.thread_id, monitor, conversation_id, "thread_ref"),
            "subject": self._seal(message.subject, monitor, conversation_id, "subject"),
            "sender": self._seal(message.sender, monitor, conversation_id, "sender"),
        }

        def write() -> None:
            with self.db.engine.begin() as conn:
                policy = commit.lock_policy(conn, monitor)
                known = commit.known_requests(
                    conn, monitor, [item.evidence_key for item in assessment.candidates]
                )
                actual_id = commit.upsert_conversation(
                    conn,
                    monitor,
                    message,
                    thread_hmac=thread_hmac,
                    new_id=conversation_id,
                    sealed=sealed,
                )
                if reassess:
                    commit.adopt_legacy_rows(
                        conn,
                        monitor,
                        message_hmac,
                        assessment.candidates,
                        known,
                        lambda ciphertext, row_id, purpose: self._open(
                            ciphertext, monitor, row_id, purpose
                        ),
                    )
                for candidate in assessment.candidates:
                    prior = known.get(candidate.evidence_key)
                    if prior is None:
                        commit.insert_request(
                            conn,
                            monitor,
                            policy,
                            seal=self._seal,
                            candidate=candidate,
                            message=message,
                            message_hmac=message_hmac,
                            conversation_id=actual_id,
                            request_id=str(uuid.uuid4()),
                            now=now,
                        )
                    elif int(prior["assessment_version"]) < ASSESSMENT_VERSION:
                        row_id = str(prior["id"])
                        event = commit.sealed_event(self._seal, monitor, candidate, row_id)
                        commit.upgrade_request(conn, row_id, candidate, event)
                if reassess:
                    commit.suppress_unsupported(conn, monitor, message_hmac)
                commit.apply_updates(conn, assessment.updates, actual_id)
                commit.record_assessed(
                    conn, monitor, message, message_hmac=message_hmac, thread_hmac=thread_hmac
                )

        await asyncio.to_thread(write)
