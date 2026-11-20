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
from hushh_mcp.services.drive_request_payment_store import current_paid_order
from hushh_mcp.services.drive_shared_file_query import CANDIDATES_SQL
from hushh_mcp.services.drive_sharing_contract import DriveSharingError
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


class DriveSharedFileSearch(DriveBulkShareStore):
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

    @staticmethod
    def _admitted(row, audience, now):
        if audience == "owner":
            return True
        if row["access_stop_requested_at"] is not None:
            return False
        if row["payment_required"] and not current_paid_order(
            {
                "status": row["payment_status"],
                "paid_at": row["paid_at"],
                "stripe_mode": row["stripe_mode"],
                "reconciliation_required": row["reconciliation_required"],
            }
        ):
            return False
        if row["source_kind"] == "bulk":
            return row["expires_at"] > now and not row["removal_exists"]
        # A pending revoke is a current access change, not a new file result.
        return not row["removal_exists"]

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

    def _file_view(self, row, audience):
        if row["source_kind"] == "bulk":
            metadata = self._file(row, row["owner_user_id"])
            file_id, name = metadata.get("id"), metadata.get("name")
        else:
            metadata = self.cipher.open(
                row["plan_envelope"],
                user_id=row["owner_user_id"],
                resource_id=str(row["source_id"]),
                purpose="permission-plan",
            )
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
            "status": "access_changed"
            if row["removal_exists"]
            or row["access_stop_requested_at"]
            or row["expires_at"] is not None
            and row["expires_at"] <= row["server_now"]
            else "shared",
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
            return now, [
                dict(row) for row in connection.execute(text(CANDIDATES_SQL), params).mappings()
            ]

        now, rows = await self._transaction(read)
        verified, rejected = set(), set()
        consumed, matches = [], []
        for row in rows[:SCAN_LIMIT]:
            consumed.append(row)
            if not self._admitted(row, audience, now):
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
                current_time = connection.execute(text("SELECT clock_timestamp()")).scalar_one()
                found = connection.execute(
                    text(CANDIDATES_SQL),
                    {
                        **params,
                        "keys": [_key(row) for row, _ in matches],
                        "scan_limit": RESULT_LIMIT,
                    },
                ).mappings()
                return {
                    _key(row): dict(row)
                    for row in found
                    if self._admitted(row, audience, current_time)
                }

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
