"""Private, full-history filename lookup over confirmed request deliveries.

Encrypted candidates are consumed with a query-bound cursor, including pages
without a match. Names are opened only after current participant authority;
source records are reread set-wise after external identity verification.
"""

from __future__ import annotations

import base64
import json
import unicodedata
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import text

from hushh_mcp.services.drive_bulk_share_store import DriveBulkShareStore
from hushh_mcp.services.drive_packet_display import packet_file_label
from hushh_mcp.services.drive_permission_executor import require_recipient_identity
from hushh_mcp.services.drive_request_payment_store import DriveRequestPaymentStore
from hushh_mcp.services.drive_sharing_contract import DriveSharingError
from hushh_mcp.services.feed_file_query import CANDIDATES_SQL
from hushh_mcp.services.google_drive_adapter import FILE_ID, valid_metadata_name

SCAN_LIMIT = 100
RESULT_LIMIT = 20


def _words(value: str) -> list[str]:
    value = unicodedata.normalize("NFKC", value).casefold()
    return "".join(char if char.isalnum() else " " for char in value).split()


def _key(row):
    return f"{row['source_kind']}:{row['source_id']}:{row['position']}"


def _reference(value):
    try:
        kind, source, position = value.split(":")
        if kind not in {"bulk", "legacy"} or str(UUID(source)) != source:
            raise ValueError()
        position = int(position)
        if not (kind == "legacy" and position == 0 or kind == "bulk" and 1 <= position <= 10000):
            raise ValueError()
        return kind, source, position
    except (ValueError, TypeError, AttributeError):
        raise DriveSharingError("invalid_argument") from None


class FeedFileSearch(DriveBulkShareStore):
    def __init__(self, *, db=None, cipher=None, verify_recipient=None):
        super().__init__(db, cipher=cipher)
        self.verify_recipient = verify_recipient or require_recipient_identity

    def _search_cursor(self, user, binding, snapshot, after):
        envelope = self.cipher.seal(
            {"version": 1, "binding": binding, "snapshot": snapshot.isoformat(), "after": after},
            user_id=user,
            resource_id="file-history-search",
            purpose="file-history-cursor",
        )
        return base64.urlsafe_b64encode(json.dumps(envelope).encode()).decode()

    def _search_after(self, user, binding, cursor):
        if cursor is None:
            return None, None
        try:
            if not isinstance(cursor, str) or len(cursor) > 4096:
                raise ValueError()
            envelope = json.loads(base64.b64decode(cursor, altchars=b"-_", validate=True))
            value = self.cipher.open(
                envelope,
                user_id=user,
                resource_id="file-history-search",
                purpose="file-history-cursor",
            )
            if (
                set(value) != {"version", "binding", "snapshot", "after"}
                or value["version"] != 1
                or value["binding"] != binding
            ):
                raise ValueError()
            snapshot = datetime.fromisoformat(value["snapshot"])
            stamp, kind, source, position = value["after"]
            _reference(f"{kind}:{source}:{position}")
            after = (datetime.fromisoformat(stamp), kind, source, position)
            if snapshot.tzinfo is None or after[0].tzinfo is None or after[0] > snapshot:
                raise ValueError()
            return snapshot, after
        except (ValueError, TypeError, KeyError, UnicodeError, DriveSharingError):
            raise DriveSharingError("invalid_argument") from None

    def _admitted(self, row, audience, now):
        if audience == "owner":
            return True
        if row["access_stop_requested_at"] is not None or (
            row["access_expires_at"] is not None and row["access_expires_at"] <= now
        ):
            return False
        if row["source_kind"] == "bulk":
            return row["expires_at"] > now and not row["removal_exists"]
        # Protected-document legacy grants keep their actual Drive deadline in
        # the sealed plan even when the request has no access_expires_at.
        plan = self._legacy_plan(row)
        deadline = plan.get("expiration_time")
        if deadline is not None:
            try:
                expiry = datetime.fromisoformat(deadline)
                if expiry.tzinfo is None:
                    raise ValueError()
            except (ValueError, TypeError):
                raise DriveSharingError("sharing_storage_unavailable") from None
            if expiry <= now:
                return False
        return not row["removal_exists"]

    def _authorize_rows(self, connection, rows, audience, user, now):
        """Reuse payment authority under request locks; never reconcile or settle."""
        allowed = set()
        if audience == "requester" and rows:
            requests = connection.execute(
                text("""SELECT request_id,payment_required,access_stop_requested_at,access_expires_at FROM drive_share_requests
                  WHERE recipient_user_id=:viewer AND request_id=ANY(CAST(:ids AS uuid[]))
                  ORDER BY request_id FOR SHARE"""),
                {"viewer": user, "ids": sorted({str(row["request_id"]) for row in rows})},
            ).mappings()
            for request in requests:
                if request["access_stop_requested_at"] is not None or (
                    request["access_expires_at"] is not None and request["access_expires_at"] <= now
                ):
                    continue
                try:
                    DriveRequestPaymentStore.require_paid_if_required(connection, request)
                    allowed.add(str(request["request_id"]))
                except DriveSharingError as error:
                    if str(error) != "payment_required":
                        raise
        for row in rows:
            row["feed_authorized"] = (
                audience == "owner" or str(row["request_id"]) in allowed
            ) and self._admitted(row, audience, now)
        return rows

    def _recipient(self, row, user):
        private = self.cipher.open(
            row["request_envelope"],
            user_id=row["owner_user_id"],
            resource_id=str(row["request_id"]),
            purpose="request",
        )
        recipient = private.get("recipient")
        if not isinstance(recipient, dict) or recipient.get("user_id") != user:
            raise DriveSharingError("recipient_changed")
        if row["source_kind"] == "bulk":
            bound = self.cipher.open(
                row["identity_envelope"],
                user_id=row["owner_user_id"],
                resource_id=f"{row['source_id']}:{user}",
                purpose="bulk-share-recipient",
            )
            if (
                any(bound.get(field) != recipient.get(field) for field in ("user_id", "subject"))
                or str(bound.get("email", "")).casefold()
                != str(recipient.get("email", "")).casefold()
            ):
                raise DriveSharingError("recipient_changed")
        return recipient

    def _legacy_plan(self, row):
        return self.cipher.open(
            row["plan_envelope"],
            user_id=row["owner_user_id"],
            resource_id=str(row["source_id"]),
            purpose="permission-plan",
        )

    def _file_view(self, row, audience):
        if row["source_kind"] == "bulk":
            metadata = self._file(row, row["owner_user_id"])
            file_id, name = metadata.get("id"), metadata.get("name")
        else:
            metadata = self._legacy_plan(row)
            file_id, name = metadata.get("file_id"), metadata.get("file_name")
        if (
            not isinstance(file_id, str)
            or not FILE_ID.fullmatch(file_id)
            or not valid_metadata_name(name)
        ):
            raise DriveSharingError("sharing_storage_unavailable")
        return {
            "requestId": str(row["request_id"]),
            "fileRef": _key(row),
            "audience": audience,
            "name": packet_file_label(name),
            "recordedAt": row["recorded_at"].astimezone(UTC).isoformat(),
            "status": "shared"
            if self._admitted(row, "requester", row["server_now"])
            else "access_changed",
            "openUrl": f"https://drive.google.com/file/d/{file_id}/view",
        }, name

    async def search(
        self,
        *,
        user_id,
        audience,
        query="",
        cursor=None,
        person=None,
        from_at=None,
        before_at=None,
        exact=None,
    ):
        if audience not in {"owner", "requester"} or not isinstance(query, str) or len(query) > 120:
            raise DriveSharingError("invalid_argument")
        terms = _words(query)
        if exact is None and not terms and not person:
            return {"files": [], "nextCursor": None}
        binding = self.cipher.digest(
            "file-history-query", [audience, query, person, str(from_at), str(before_at)]
        )
        snapshot, after = self._search_after(user_id, binding, cursor)
        exact_parts = _reference(exact["fileRef"]) if exact else None
        params = {
            "viewer": user_id,
            "audience": audience,
            "person": person,
            "snapshot_at": snapshot,
            "from_at": from_at,
            "before_at": before_at,
            "after_at": after[0] if after else None,
            "after_kind": after[1] if after else None,
            "after_id": after[2] if after else None,
            "after_position": after[3] if after else None,
            "exact_kind": exact_parts[0] if exact_parts else None,
            "exact_id": exact_parts[1] if exact_parts else None,
            "exact_position": exact_parts[2] if exact_parts else None,
            "exact_request": str(UUID(exact["requestId"])) if exact else None,
            "keys": None,
            "scan_limit": SCAN_LIMIT + 1,
        }

        def read(connection):
            now = connection.execute(text("SELECT clock_timestamp()")).scalar_one()
            params["snapshot_at"] = snapshot or now
            rows = [
                dict(row) for row in connection.execute(text(CANDIDATES_SQL), params).mappings()
            ]
            return now, self._authorize_rows(connection, rows, audience, user_id, now)

        now, rows = await self._transaction(read)
        verified, rejected = set(), set()
        consumed, matches = [], []
        for row in rows[:SCAN_LIMIT]:
            consumed.append(row)
            if not row["feed_authorized"]:
                continue
            if audience == "requester":
                try:
                    identity = None
                    recipient = self._recipient(row, user_id)
                    # Observation timestamps and display labels are not identity authority.
                    authority = {
                        field: recipient.get(field)
                        for field in ("user_id", "subject", "email", "account_id", "grant_id")
                    }
                    authority["kind"] = recipient.get("kind", "google_provider")
                    identity = self.cipher.digest("file-history-recipient", authority)
                    if identity in rejected:
                        continue
                    if identity not in verified:
                        await self.verify_recipient(recipient)
                        verified.add(identity)
                except DriveSharingError as error:
                    if str(error) in {"recipient_changed", "verify_google_identity_required"}:
                        if identity is not None:
                            rejected.add(identity)
                        continue
                    raise
            view, full_name = self._file_view(row, audience)
            words = " ".join(
                _words(
                    full_name
                    + " "
                    + str(row.get("counterpart_label") or "")
                    + " document file files shared request"
                )
            )
            if exact or all(term in words for term in terms):
                matches.append((row, view))
            if len(matches) == RESULT_LIMIT:
                break
        if matches:

            def recheck(connection):
                # Stop/removal writers serialize on the request. Lock before
                # reading the final source facts, not after a stale candidate read.
                if audience == "requester":
                    shares = sorted(
                        {
                            str(row["source_id"])
                            for row, _ in matches
                            if row["source_kind"] == "bulk"
                        }
                    )
                    if shares:
                        connection.execute(
                            text("""SELECT b.share_id FROM drive_bulk_shares b
                          JOIN drive_share_requests q ON q.request_id=b.origin_request_id AND q.user_id=b.user_id
                          WHERE q.recipient_user_id=:viewer AND b.share_id=ANY(CAST(:shares AS uuid[]))
                          ORDER BY b.share_id FOR SHARE OF b"""),
                            {"viewer": user_id, "shares": shares},
                        ).all()
                        connection.execute(
                            text("""SELECT e.share_id,e.position FROM drive_bulk_share_effects e
                          JOIN drive_bulk_shares b ON b.share_id=e.share_id AND b.user_id=e.user_id
                          WHERE e.recipient_user_id=:viewer AND e.share_id=ANY(CAST(:shares AS uuid[]))
                            AND e.share_id::text||':'||e.position::text=ANY(CAST(:keys AS text[]))
                          ORDER BY e.share_id,e.position FOR SHARE OF e"""),
                            {
                                "viewer": user_id,
                                "shares": shares,
                                "keys": [
                                    str(row["source_id"]) + ":" + str(row["position"])
                                    for row, _ in matches
                                    if row["source_kind"] == "bulk"
                                ],
                            },
                        ).all()
                    connection.execute(
                        text("""SELECT request_id FROM drive_share_requests
                          WHERE recipient_user_id=:viewer AND request_id=ANY(CAST(:ids AS uuid[]))
                          ORDER BY request_id FOR SHARE"""),
                        {
                            "viewer": user_id,
                            "ids": sorted({str(row["request_id"]) for row, _ in matches}),
                        },
                    ).all()
                current_time = connection.execute(text("SELECT clock_timestamp()")).scalar_one()
                found = connection.execute(
                    text(CANDIDATES_SQL),
                    {
                        **params,
                        "keys": [_key(row) for row, _ in matches],
                        "scan_limit": RESULT_LIMIT,
                    },
                ).mappings()
                rows = self._authorize_rows(
                    connection, [dict(row) for row in found], audience, user_id, current_time
                )
                return {_key(row): row for row in rows if row["feed_authorized"]}

            fresh = await self._transaction(recheck)
            matches = [
                (row, self._file_view(fresh[_key(row)], audience)[0])
                for row, _ in matches
                if _key(row) in fresh
                and all(
                    fresh[_key(row)].get(field) == row.get(field)
                    for field in (
                        "request_envelope",
                        "identity_envelope",
                        "metadata_envelope",
                        "plan_envelope",
                    )
                )
            ]
        next_cursor = None
        if consumed and len(rows) > len(consumed):
            last = consumed[-1]
            next_cursor = self._search_cursor(
                user_id,
                binding,
                params["snapshot_at"],
                [
                    last["source_at"].isoformat(),
                    last["source_kind"],
                    str(last["source_id"]),
                    last["position"],
                ],
            )
        return {"files": [view for _, view in matches], "nextCursor": next_cursor}
