"""Owner-only "possible matches" for one automatic document request (D3).

GET  /api/connectors/google_drive/sharing/requests/{request_id}/possible-matches
POST /api/connectors/google_drive/sharing/requests/{request_id}/possible-matches/send

A possible match passed the request's kind, period and Drive canShare checks
but its own title does not name what the requester typed: it was found by its
content, by a spelling fix, by a loose synonym, or by walking a shared folder.
Autoshare never sends it. The owner sees it here and may send it with one tap.

Send is the owner's authority for that exact file and nothing more. It writes
a marker into the result's own AES-GCM envelope (no new table, nothing in
plaintext) and makes the request due for the scheduled Drive drain. The drain
claims the file into the next 25-file batch: after payment when the requester
has not paid yet, otherwise in the next batch. No Drive call and no wake runs
in the API process, so the operator kill switch stays authoritative.

Only the request's owner gets an answer; the requester and anyone else get
``request_unavailable``. The requester's status, outcome and file lists read
only batches and grants, so they never learn the list exists or its length.
Sends are accepted while the request is open; a finished request lists its
possible matches with ``canSend: false``.
"""

from __future__ import annotations

import re
from uuid import UUID

from sqlalchemy import text

from hushh_mcp.services.drive_bulk_share_store import DriveBulkShareStore
from hushh_mcp.services.drive_match_evidence import (
    automatic_claims,
    is_possible_match,
    owner_sent,
    owner_sent_fields,
    possible_kind,
)
from hushh_mcp.services.drive_sharing_contract import DriveSharingError
from hushh_mcp.services.google_drive_adapter import DriveReadError

PAGE_LIMIT = 100
SEND_LIMIT = 100
_MATCH_REF = re.compile(
    r"^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(\d{1,5})$"
)
_SEARCH_STATUSES = frozenset({"queued", "running", "completed"})

_REQUEST_SQL = """SELECT request_id,recipient_user_id,status,revision,access_stop_requested_at,
  expires_at>clock_timestamp() AS live
FROM drive_share_requests WHERE request_id=:request AND user_id=:user"""
_REQUEST_FOR_UPDATE_SQL = """SELECT request_id,recipient_user_id,status,revision,
  access_stop_requested_at,expires_at>clock_timestamp() AS live
FROM drive_share_requests WHERE request_id=:request AND user_id=:user FOR UPDATE"""
_SEARCH_SQL = """SELECT job_id,status,incomplete_search,connection_generation,checkpoint_envelope
FROM drive_owner_search_jobs
WHERE user_id=:user AND client_request_id=:request AND expires_at>clock_timestamp()"""
_LIST_SQL = """SELECT r.position,r.metadata_envelope,
  EXISTS(SELECT 1 FROM drive_bulk_share_files f
    WHERE f.user_id=:user AND f.origin_request_id=:request
      AND f.source_position=r.position) AS claimed
FROM drive_owner_search_results r
WHERE r.job_id=:job AND r.user_id=:user
ORDER BY r.position LIMIT 10000"""
_SEND_ROWS_SQL = """SELECT position,metadata_envelope FROM drive_owner_search_results
WHERE job_id=:job AND user_id=:user AND position=ANY(CAST(:positions AS integer[]))
ORDER BY position FOR UPDATE"""
_CLAIMED_SQL = """SELECT source_position FROM drive_bulk_share_files
WHERE user_id=:user AND origin_request_id=:request
  AND source_position=ANY(CAST(:positions AS integer[]))"""
_MARK_SENT_SQL = """UPDATE drive_owner_search_results
SET metadata_envelope=CAST(:envelope AS jsonb)
WHERE job_id=:job AND user_id=:user AND position=:position"""
# Due for the next scheduled drain only; never a wake. LEAST never delays it.
_MAKE_DUE_SQL = """UPDATE drive_share_requests
SET preparation_next_at=LEAST(preparation_next_at,clock_timestamp())
WHERE request_id=:request AND user_id=:user AND status='pending'
  AND preparation_error_code='trusted_auto_active'"""


def _uuid(value: object) -> str:
    try:
        return str(UUID(str(value)))
    except (TypeError, ValueError):
        raise DriveSharingError("invalid_argument") from None


def _match_ref(job_id: object, position: int) -> str:
    return f"{job_id}:{position}"


def _parse_refs(values: object) -> list[tuple[str, int]]:
    if (
        not isinstance(values, list)
        or not 1 <= len(values) <= SEND_LIMIT
        or len(set(map(str, values))) != len(values)
    ):
        raise DriveSharingError("invalid_argument")
    refs = []
    for value in values:
        match = _MATCH_REF.fullmatch(value) if isinstance(value, str) else None
        if match is None or not 1 <= int(match.group(2)) <= 10000:
            raise DriveSharingError("invalid_argument")
        refs.append((match.group(1), int(match.group(2))))
    return refs


def _bound(checkpoint: dict, request, search) -> bool:
    """The current automatic search of this exact request revision."""
    return bool(
        automatic_claims(checkpoint)
        and checkpoint.get("request_origin_id") == str(request["request_id"])
        and checkpoint.get("request_revision") == request["revision"]
        and checkpoint.get("request_shareability_version") == 1
        and search["status"] in _SEARCH_STATUSES
        and not search["incomplete_search"]
    )


def _positions_final(checkpoint: dict, search) -> bool:
    """A bounded newest-N search may re-rank positions until it is final."""
    return checkpoint.get("request_result_limit") is None or (
        search["status"] == "completed" and checkpoint.get("request_results_finalized") is True
    )


def _request_open(request) -> bool:
    return bool(
        request["status"] == "pending"
        and request["access_stop_requested_at"] is None
        and request["live"] is True
    )


class DrivePossibleMatchesStore(DriveBulkShareStore):
    """The owner's possible-matches list and one-tap Send for one request."""

    def _owned_request(self, connection, *, user_id, request_id, lock=False):
        row = self._row(
            connection,
            _REQUEST_FOR_UPDATE_SQL if lock else _REQUEST_SQL,
            {"request": request_id, "user": user_id},
        )
        if row is None:
            # The requester, or anyone else, gets the same answer as a
            # request that does not exist.
            raise DriveSharingError("request_unavailable")
        return row

    def _request_search(self, connection, *, user_id, request_id):
        search = self._row(connection, _SEARCH_SQL, {"user": user_id, "request": request_id})
        if search is None:
            return None, None
        checkpoint = self._open(
            search["checkpoint_envelope"],
            user_id=user_id,
            resource_id=str(search["job_id"]),
            purpose="owner-search-checkpoint",
        )
        return search, checkpoint if isinstance(checkpoint, dict) else {}

    def _connection_current(self, connection, *, user_id, generation) -> bool:
        try:
            current = self.live_active(connection, user_id=user_id, read_only=True)
        except DriveReadError:
            return False
        return current["connection_generation"] == generation

    async def possible_matches(self, *, user_id, request_id):
        request_id = _uuid(request_id)

        def operation(connection):
            request = self._owned_request(connection, user_id=user_id, request_id=request_id)
            view = {"requestId": request_id, "canSend": False, "count": 0, "matches": []}
            search, checkpoint = self._request_search(
                connection, user_id=user_id, request_id=request_id
            )
            if (
                search is None
                or not _bound(checkpoint, request, search)
                or not _positions_final(checkpoint, search)
            ):
                return view
            rows = connection.execute(
                text(_LIST_SQL),
                {"job": search["job_id"], "user": user_id, "request": request_id},
            ).mappings()
            matches, count = [], 0
            for row in rows:
                if row["claimed"]:
                    # In a batch now; it appears under the shared files once
                    # Google confirms it, like every other sent file.
                    continue
                metadata = self._open(
                    row["metadata_envelope"],
                    user_id=user_id,
                    resource_id=f"{search['job_id']}:{row['position']}",
                    purpose="owner-search-result",
                )
                if not is_possible_match(checkpoint, metadata):
                    continue
                count += 1
                if len(matches) < PAGE_LIMIT:
                    modified = metadata.get("modifiedTime")
                    matches.append(
                        {
                            "matchRef": _match_ref(search["job_id"], row["position"]),
                            # The owner's own file names; never sent to the requester.
                            "name": str(metadata.get("name") or "Untitled file")[:300],
                            "modifiedTime": modified if isinstance(modified, str) else None,
                            "kind": possible_kind(metadata),
                            "status": "queued" if owner_sent(metadata) else "possible",
                        }
                    )
            view.update(
                count=count,
                matches=matches,
                canSend=bool(
                    count
                    and _request_open(request)
                    and self._connection_current(
                        connection, user_id=user_id, generation=search["connection_generation"]
                    )
                ),
            )
            return view

        return await self._transaction(operation)

    async def send(self, *, user_id, request_id, match_refs):
        """Mark the owner's chosen possible matches for the next batch. Idempotent."""
        request_id = _uuid(request_id)
        refs = _parse_refs(match_refs)

        def operation(connection):
            # Refuse anyone but the owner before touching connector state:
            # live_active would lock (and could create) the caller's row.
            self._owned_request(connection, user_id=user_id, request_id=request_id)
            # Identity guards, then the owner's connector lock (the same order
            # a batch claim takes), then the request row.
            self._gate_graph_for_request(connection, user_id=user_id, request_id=request_id)
            current = self.live_active(connection, user_id=user_id)
            request = self._owned_request(
                connection, user_id=user_id, request_id=request_id, lock=True
            )
            if not _request_open(request):
                raise DriveSharingError("request_changed")
            search, checkpoint = self._request_search(
                connection, user_id=user_id, request_id=request_id
            )
            if search is None or not _bound(checkpoint, request, search):
                raise DriveSharingError("request_changed")
            if not _positions_final(checkpoint, search):
                raise DriveSharingError("search_in_progress")
            if search["connection_generation"] != current["connection_generation"]:
                raise DriveSharingError("connection_changed")
            job_id = str(search["job_id"])
            if any(job != job_id for job, _ in refs):
                # A ref from an earlier search of this request.
                raise DriveSharingError("request_changed")
            positions = sorted({position for _, position in refs})
            rows = list(
                connection.execute(
                    text(_SEND_ROWS_SQL),
                    {"job": job_id, "user": user_id, "positions": positions},
                ).mappings()
            )
            if [row["position"] for row in rows] != positions:
                raise DriveSharingError("invalid_argument")
            claimed = set(
                connection.execute(
                    text(_CLAIMED_SQL),
                    {"user": user_id, "request": request_id, "positions": positions},
                ).scalars()
            )
            results, queued = [], 0
            for row in rows:
                position = row["position"]
                resource = f"{job_id}:{position}"
                metadata = self._open(
                    row["metadata_envelope"],
                    user_id=user_id,
                    resource_id=resource,
                    purpose="owner-search-result",
                )
                if not is_possible_match(checkpoint, metadata):
                    # A title match already shares itself; an unshareable file
                    # cannot be sent. Neither is a possible match.
                    raise DriveSharingError("invalid_argument")
                ref = _match_ref(job_id, position)
                if position in claimed:
                    results.append({"matchRef": ref, "status": "sending"})
                    continue
                if not owner_sent(metadata):
                    connection.execute(
                        text(_MARK_SENT_SQL),
                        {
                            "job": job_id,
                            "user": user_id,
                            "position": position,
                            "envelope": self._seal(
                                {**metadata, **owner_sent_fields()},
                                user_id=user_id,
                                resource_id=resource,
                                purpose="owner-search-result",
                            ),
                        },
                    )
                    queued += 1
                results.append({"matchRef": ref, "status": "queued"})
            if queued:
                connection.execute(text(_MAKE_DUE_SQL), {"request": request_id, "user": user_id})
            return {"requestId": request_id, "queued": queued, "matches": results}

        return await self._transaction(operation)
