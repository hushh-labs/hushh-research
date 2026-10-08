"""Hub-owned reply delivery receipts; identifiers only, bounded at-least-once retry."""

from __future__ import annotations

import json


class OneReplyDelivery:
    def __init__(self, db=None):
        if db is None:
            from db.db_client import get_db

            db = get_db()
        self.db = db

    def _rows(self, sql, params):
        result = self.db.execute_raw(sql, params)
        if result.error:
            raise RuntimeError("Reply delivery unavailable.")
        return result.data or []

    def accept(self, *, owner_id, hushh_id, signal):
        params = {
            "owner": owner_id,
            "pod": hushh_id,
            "event": signal.eventId,
            "conversation": signal.conversationId,
            "run": signal.runId,
            "created": signal.createdAt,
            "expires": signal.expiresAt,
        }
        # Expired signals are refused by the route, so retiring old receipts
        # cannot let a later replay trigger another notification.
        self._rows(
            "DELETE FROM one_reply_deliveries WHERE expires_at < NOW() - INTERVAL '1 day'", {}
        )
        self._rows(
            """
            INSERT INTO one_reply_deliveries
                (user_id, hushh_id, event_id, conversation_id, run_id, created_at, expires_at)
            VALUES (:owner, :pod, :event, :conversation, :run,
                    to_timestamp(:created), to_timestamp(:expires))
            ON CONFLICT (user_id, event_id) DO NOTHING
        """,
            params,
        )
        rows = self._rows(
            """
            SELECT * FROM one_reply_deliveries WHERE user_id=:owner AND event_id=:event
        """,
            params,
        )
        if (
            not rows
            or rows[0]["hushh_id"] != hushh_id
            or rows[0]["conversation_id"] != signal.conversationId
            or rows[0]["run_id"] != signal.runId
        ):
            raise RuntimeError("Reply receipt binding changed.")
        if signal.read:
            self._rows(
                """
                UPDATE one_reply_deliveries SET state='read', updated_at=NOW()
                WHERE user_id=:owner AND event_id=:event AND state='pending'
            """,
                params,
            )
            return None, "read"
        row = rows[0]
        if row["state"] != "pending":
            return None, row["state"]
        claimed = self._rows(
            """
            UPDATE one_reply_deliveries SET attempts=attempts+1,
                leased_until=NOW()+INTERVAL '2 minutes', updated_at=NOW()
            WHERE user_id=:owner AND event_id=:event AND state='pending'
              AND attempts<8 AND expires_at>NOW() AND next_attempt_at<=NOW()
              AND (leased_until IS NULL OR leased_until<NOW())
            RETURNING *
        """,
            params,
        )
        return (claimed[0] if claimed else None), "pending"

    def finish(self, *, owner_id, event_id, attempt, report):
        accepted = sorted(report.accepted)
        state = (
            "pending"
            if not report.configured or report.retryable
            else "sent"
            if accepted
            else "no_device"
        )
        rows = self._rows(
            """
            UPDATE one_reply_deliveries SET state=:state, accepted_devices=CAST(:accepted AS jsonb),
                leased_until=NULL, next_attempt_at=NOW()+make_interval(secs => LEAST(3600, CAST(:delay AS int))),
                updated_at=NOW()
            WHERE user_id=:owner AND event_id=:event AND state='pending' AND attempts=:attempt
            RETURNING state
        """,
            {
                "state": state,
                "accepted": json.dumps(accepted),
                "delay": 10 * 2 ** min(attempt, 8),
                "owner": owner_id,
                "event": event_id,
                "attempt": attempt,
            },
        )
        return rows[0]["state"] if rows else self.state(owner_id=owner_id, event_id=event_id)

    def state(self, *, owner_id, event_id):
        rows = self._rows(
            "SELECT state FROM one_reply_deliveries WHERE user_id=:owner AND event_id=:event",
            {"owner": owner_id, "event": event_id},
        )
        return rows[0]["state"] if rows else "pending"

    def record_accepted(self, *, owner_id, event_id, attempt, token_hash):
        self._rows(
            """
            UPDATE one_reply_deliveries SET accepted_devices=accepted_devices || CAST(:device AS jsonb)
            WHERE user_id=:owner AND event_id=:event AND attempts=:attempt AND state='pending'
        """,
            {
                "owner": owner_id,
                "event": event_id,
                "attempt": attempt,
                "device": json.dumps([token_hash]),
            },
        )

    def is_sendable(self, *, owner_id, event_id, attempt):
        return bool(
            self._rows(
                """
            SELECT 1 FROM one_reply_deliveries
            WHERE user_id=:owner AND event_id=:event AND state='pending'
              AND attempts=:attempt AND leased_until>NOW() AND expires_at>NOW()
        """,
                {"owner": owner_id, "event": event_id, "attempt": attempt},
            )
        )
