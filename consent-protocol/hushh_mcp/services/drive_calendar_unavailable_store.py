"""The organizer's "Don't have" answer for a Calendar meeting-file request."""

import json
from typing import cast
from uuid import UUID

from sqlalchemy import text

from hushh_mcp.services.drive_sharing_contract import DriveSharingError
from hushh_mcp.services.drive_sharing_projection_store import DriveSharingProjectionStore

_KINDS = frozenset({"recording", "notes"})


class CalendarUnavailableStore(DriveSharingProjectionStore):
    @staticmethod
    def _calendar_answerable(private, wanted):
        """The request's meeting details, only if it asked for every type being answered."""
        calendar = private.get("calendar")
        if private.get("request_type") != "calendar_meeting" or not isinstance(calendar, dict):
            raise DriveSharingError("request_unavailable")
        if any(kind not in calendar["requested_types"] for kind in wanted):
            raise DriveSharingError("invalid_argument")
        return calendar

    @staticmethod
    def _require_answerable(connection, locked, row, revision):
        from hushh_mcp.services.drive_request_withdrawal_store import (
            require_unpaid_and_undispatched,
        )

        if row["revision"] != revision:
            raise DriveSharingError("review_changed")
        now = connection.execute(text("SELECT clock_timestamp()")).scalar_one()
        if (
            row["status"] not in {"pending", "preparing", "review_ready"}
            or row["expires_at"] <= now
        ):
            raise DriveSharingError("request_already_decided")
        require_unpaid_and_undispatched(connection, locked)

    @staticmethod
    def _void_review(connection, row, request_id, *, everything):
        """An older review or push cannot approve files for a type just ruled out."""
        connection.execute(
            text("""
            UPDATE one_action_directive_ledger SET state='cancelled',settled_at=clock_timestamp(),
              settlement_status='cancelled',settlement_reason_code='document_request_cancelled'
            WHERE channel='document_review' AND document_request_id=:id AND user_id=:owner
              AND state IN ('issued','confirmed')
        """),
            {"id": request_id, "owner": row["user_id"]},
        )
        if everything:
            connection.execute(
                text("""
                UPDATE drive_share_reviews SET decision='declined',decided_at=clock_timestamp()
                WHERE request_id=:id AND revision=:revision AND decision IS NULL
            """),
                {"id": request_id, "revision": row["revision"]},
            )

    async def mark_calendar_not_available(self, *, user_id, request_id, revision, types):
        """The organizer says they do not have these requested meeting files.

        Only the sealed request changes: no Drive is read and nothing is shared.
        Each type is tracked on its own. A request whose every requested type is
        now unavailable closes as declined; otherwise it stays open for the
        remaining types with a new revision, so an older review cannot approve
        files for a type the organizer has just ruled out. Repeating an answer
        that is already recorded is not an error.
        """
        self._sharing_admission(user_id)
        request_id = str(UUID(request_id))
        wanted = sorted({str(kind) for kind in types})
        if not wanted or any(kind not in _KINDS for kind in wanted):
            raise DriveSharingError("invalid_argument")
        from hushh_mcp.services.drive_request_withdrawal_store import lock_closable_request

        def operation(connection):
            locked = lock_closable_request(
                self, connection, user_id=user_id, request_id=request_id, recipient=False
            )
            row = locked["request"]
            private = self._open_request(row)
            calendar = self._calendar_answerable(private, wanted)
            known = list(calendar.get("not_available_types") or [])
            if set(wanted) <= set(known):
                return {**self._summary(row), "notAvailableTypes": known}
            self._require_answerable(connection, locked, row, revision)
            merged = [kind for kind in calendar["requested_types"] if kind in {*known, *wanted}]
            envelope = self.sharing_cipher.seal(
                {**private, "calendar": {**calendar, "not_available_types": merged}},
                user_id=row["user_id"],
                resource_id=request_id,
                purpose="request",
            )
            everything = set(merged) >= set(calendar["requested_types"])
            self._void_review(connection, row, request_id, everything=everything)
            updated = self._row(
                connection,
                """
                UPDATE drive_share_requests SET request_envelope=CAST(:envelope AS jsonb),
                  status=:status,revision=revision+1,updated_at=clock_timestamp(),
                  preparation_attempts=0,preparation_error_code=NULL,preparation_lease_id=NULL,
                  preparation_lease_expires_at=NULL,preparation_next_at=expires_at
                WHERE request_id=:id RETURNING *
            """,
                {
                    "id": request_id,
                    "envelope": json.dumps(envelope),
                    "status": "declined" if everything else "pending",
                },
            )
            # B reads this on the Feed and Calendar; the owner's own answer
            # needs no notification of its own.
            self._event(connection, updated, row["recipient_user_id"], "document_share_decided")
            return {**self._summary(updated), "notAvailableTypes": merged}

        return cast(dict, await self._transaction(operation))
