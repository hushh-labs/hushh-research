"""The owner's one Feed card per document request, and per-file access removal.

After One confirms the first shared file of a request, the owner gets exactly
one Feed row for that request ("One sent 12 files to Ankit"). The row is keyed
by the request id, so a retried settle or a concurrent batch can never add a
second row; each finished batch updates the same row's count in place.

From that card the owner lists the files shared for the request (their own
file names) and may remove the requester's access to one file. Removal is a
durable row in ``drive_request_bulk_removals``, the queue an owner's Stop
already uses, with the original authenticated create receipt as provenance.
It becomes due after a short undo window and the scheduled Drive drain deletes
the Google permission. No Drive call runs in the API process.
"""

from __future__ import annotations

import json
import logging
import re
from uuid import UUID, uuid4

from sqlalchemy import text

from hushh_mcp.services.drive_request_bulk_removal_store import (
    OWNER_FILE_REMOVAL_SCOPE,
    DriveRequestBulkRemovalStore,
    managed_bulk_plan,
)
from hushh_mcp.services.drive_sharing_contract import DriveSharingError
from hushh_mcp.services.requester_identity import label_from_identity_row

logger = logging.getLogger(__name__)

FILES_SENT_EVENT = "document_share_files_sent"
# A removal waits this long before the drain may claim it, so Undo can cancel
# it before anything reaches Google. The client's Undo is shorter.
UNDO_SECONDS = 8
PAGE_LIMIT = 50
_MAX_LABEL_LENGTH = 160
_FILE_REF = re.compile(
    r"^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(\d{1,5})$"
)
_IN_FLIGHT_REMOVAL = frozenset({"queued", "dispatching", "unknown"})
_DONE_REMOVAL = frozenset({"removed", "absent"})

# Every confirmed file of one request for its recipient, in approved
# progressive batches. A file counts once it is shared, even if later removed.
_GRANTED_COUNT_SQL = """
SELECT count(*) FROM drive_bulk_share_effects e
JOIN drive_bulk_shares b ON b.share_id=e.share_id
WHERE b.origin_request_id=:request AND b.user_id=:owner
  AND b.progressive_batch=TRUE AND b.approved_at IS NOT NULL
  AND e.recipient_user_id=:recipient
  AND e.state IN ('succeeded','preexisting')
"""

# While a batch settles, a repeated first file leaves the card alone.
_FILES_SENT_CREATE_SQL = """
INSERT INTO feed_events(user_id,source_domain,event_type,actor_label,metadata,source_row_id)
VALUES(:owner,'connected_systems',:event,CAST(:label AS text),CAST(:metadata AS jsonb),:source)
ON CONFLICT (user_id,source_domain,event_type,source_row_id) WHERE source_row_id IS NOT NULL
DO NOTHING
RETURNING id
"""
# A finished batch writes the count; GREATEST keeps it from going down.
_FILES_SENT_UPSERT_SQL = """
INSERT INTO feed_events(user_id,source_domain,event_type,actor_label,metadata,source_row_id)
VALUES(:owner,'connected_systems',:event,CAST(:label AS text),CAST(:metadata AS jsonb),:source)
ON CONFLICT (user_id,source_domain,event_type,source_row_id) WHERE source_row_id IS NOT NULL
DO UPDATE SET metadata=feed_events.metadata || jsonb_build_object(
    'shared_count', GREATEST(
      COALESCE((feed_events.metadata->>'shared_count')::int, 0), :count))
    || CASE WHEN CAST(:label AS text) IS NULL THEN '{}'::jsonb
       ELSE jsonb_build_object('counterpart_label', CAST(:label AS text)) END,
  actor_label=COALESCE(CAST(:label AS text), feed_events.actor_label)
RETURNING id
"""


def _file_ref(share_id: object, position: int) -> str:
    return f"{share_id}:{position}"


def _parse_file_ref(value: object) -> tuple[str, int]:
    match = _FILE_REF.fullmatch(value) if isinstance(value, str) else None
    if match is None or not 1 <= int(match.group(2)) <= 10000:
        raise DriveSharingError("invalid_argument")
    return match.group(1), int(match.group(2))


def _uuid(value: object) -> str:
    try:
        return str(UUID(str(value)))
    except (TypeError, ValueError):
        raise DriveSharingError("invalid_argument") from None


def _requester_label(connection, recipient_user_id: str) -> str | None:
    row = (
        connection.execute(
            text("""SELECT user_id,display_name,email FROM actor_identity_cache
            WHERE user_id=:user"""),
            {"user": recipient_user_id},
        )
        .mappings()
        .first()
    )
    label = label_from_identity_row(dict(row) if row else None).strip()
    return label[:_MAX_LABEL_LENGTH] or None


def _upsert_files_sent_card(connection, *, request_id, share_id) -> None:
    request = (
        connection.execute(
            text("""SELECT request_id,user_id,recipient_user_id FROM drive_share_requests
            WHERE request_id=:request"""),
            {"request": request_id},
        )
        .mappings()
        .first()
    )
    if request is None:
        return
    owner, recipient = request["user_id"], request["recipient_user_id"]
    count = connection.execute(
        text(_GRANTED_COUNT_SQL),
        {"request": request_id, "owner": owner, "recipient": recipient},
    ).scalar_one()
    if count < 1:
        return
    batch_done = not connection.execute(
        text("""SELECT EXISTS(SELECT 1 FROM drive_bulk_share_effects
        WHERE share_id=:share AND state IN ('queued','dispatching','unknown'))"""),
        {"share": share_id},
    ).scalar_one()
    label = _requester_label(connection, recipient)
    metadata = {"request_id": str(request_id), "shared_count": int(count)}
    if label:
        metadata["counterpart_label"] = label
    # The first confirmed file creates the card. While a batch is still
    # settling, later files leave it alone (one Feed wake per batch, not per
    # file); a finished batch writes the count. GREATEST keeps the count from
    # ever going down; read, dismissal and Clear state are never touched.
    feed_id = connection.execute(
        text(_FILES_SENT_UPSERT_SQL if batch_done else _FILES_SENT_CREATE_SQL),
        {
            "owner": owner,
            "event": FILES_SENT_EVENT,
            "label": label,
            "metadata": json.dumps(metadata),
            "source": str(request_id),
            "count": int(count),
        },
    ).scalar()
    if feed_id is not None:
        # Server-only link so the Feed shows the requester's current photo.
        connection.execute(
            text("""INSERT INTO feed_event_counterparts(feed_event_id,counterpart_user_id)
            SELECT :feed,p.user_id FROM actor_profiles p WHERE p.user_id=:recipient
            ON CONFLICT DO NOTHING"""),
            {"feed": feed_id, "recipient": recipient},
        )


def record_owner_files_sent(connection, *, request_id, share_id) -> None:
    """Create or update the owner's one Feed card for a request. Never raises.

    Runs inside the settle transaction after the request row is locked, so
    concurrent batches of one request serialize and each count sees every
    committed grant. The Feed is presentation: its failure never fails a share.
    """
    try:
        with connection.begin_nested():
            _upsert_files_sent_card(connection, request_id=request_id, share_id=share_id)
    except Exception as error:  # noqa: BLE001 - the Feed can never fail a share.
        logger.warning("drive_feed.files_sent_card_failed %s", type(error).__name__)


def _file_status(row) -> str:
    removal = row["removal_state"]
    if removal in _IN_FLIGHT_REMOVAL:
        return "removing"
    if removal in _DONE_REMOVAL:
        return "removed"
    if removal is not None:
        return "needs_attention"
    return "had_access" if row["grant_state"] == "preexisting" else "shared"


class DriveOwnerSharedFilesStore(DriveRequestBulkRemovalStore):
    """Owner-only view and per-file removal for one request's shared files."""

    @staticmethod
    def _owned_request(connection, *, user_id, request_id):
        row = (
            connection.execute(
                text("""SELECT request_id,user_id,recipient_user_id FROM drive_share_requests
                WHERE request_id=:request AND user_id=:user"""),
                {"request": request_id, "user": user_id},
            )
            .mappings()
            .first()
        )
        if row is None:
            # The requester, or anyone else, sees the same answer as a
            # request that does not exist.
            raise DriveSharingError("request_unavailable")
        return dict(row)

    async def shared_files(self, *, user_id, request_id, cursor=None, limit=PAGE_LIMIT):
        request = _uuid(request_id)
        if type(limit) is not int or not 1 <= limit <= PAGE_LIMIT:
            raise DriveSharingError("invalid_argument")
        after = _parse_file_ref(cursor) if cursor is not None else None

        def operation(connection):
            owned = self._owned_request(connection, user_id=user_id, request_id=request)
            recipient = owned["recipient_user_id"]
            params = {"request": request, "owner": user_id, "recipient": recipient}
            rows = (
                connection.execute(
                    text("""SELECT f.share_id,f.position,f.metadata_envelope,f.source_job_id,
                      f.source_position,e.state AS grant_state,
                      e.receipt_envelope IS NOT NULL AS has_receipt,
                      removal.state AS removal_state,removal.attempts AS removal_attempts,
                      removal.lease_id AS removal_lease,removal.removal_id AS removal_id,
                      removal.user_id AS removal_user_id,
                      removal.plan_envelope AS removal_plan_envelope
                    FROM drive_bulk_share_files f
                    JOIN drive_bulk_shares b ON b.share_id=f.share_id
                    JOIN drive_bulk_share_effects e
                      ON e.share_id=f.share_id AND e.position=f.position
                    LEFT JOIN drive_request_bulk_removals removal
                      ON removal.share_id=e.share_id AND removal.position=e.position
                        AND removal.recipient_user_id=e.recipient_user_id
                    WHERE b.origin_request_id=:request AND b.user_id=:owner
                      AND b.progressive_batch=TRUE AND b.approved_at IS NOT NULL
                      AND e.recipient_user_id=:recipient
                      AND e.state IN ('succeeded','preexisting')
                      AND (CAST(:after_share AS uuid) IS NULL
                        OR (f.share_id,f.position)>(CAST(:after_share AS uuid),:after_position))
                    ORDER BY f.share_id,f.position LIMIT :limit"""),
                    {
                        **params,
                        "after_share": after[0] if after else None,
                        "after_position": after[1] if after else 0,
                        "limit": limit + 1,
                    },
                )
                .mappings()
                .all()
            )
            count = connection.execute(text(_GRANTED_COUNT_SQL), params).scalar_one()
            files = []
            for row in rows[:limit]:
                metadata = self._file(row, user_id)
                status = _file_status(row)
                files.append(
                    {
                        "fileRef": _file_ref(row["share_id"], row["position"]),
                        # The owner's own file names; never sent to the requester here.
                        "name": str(metadata.get("name") or "Untitled file")[:300],
                        "modifiedTime": metadata.get("modifiedTime")
                        if isinstance(metadata.get("modifiedTime"), str)
                        else None,
                        "status": status,
                        "removable": status == "shared"
                        and row["grant_state"] == "succeeded"
                        and bool(row["has_receipt"]),
                        "undoable": self._undoable(
                            {
                                "state": row["removal_state"],
                                "attempts": row["removal_attempts"],
                                "lease_id": row["removal_lease"],
                                "removal_id": row["removal_id"],
                                "user_id": row["removal_user_id"],
                                "plan_envelope": row["removal_plan_envelope"],
                            }
                        ),
                    }
                )
            return {
                "requestId": request,
                "recipientLabel": _requester_label(connection, recipient),
                "sharedCount": int(count),
                "files": files,
                "nextCursor": _file_ref(rows[limit - 1]["share_id"], rows[limit - 1]["position"])
                if len(rows) > limit
                else None,
                "undoSeconds": UNDO_SECONDS,
            }

        return await self._transaction(operation)

    def _locked_effect(self, connection, *, owner, recipient, request, share, position):
        row = (
            connection.execute(
                text("""SELECT e.*,f.metadata_envelope,f.source_job_id,f.source_position,
                  r.identity_envelope,b.v1_statement_search
                FROM drive_bulk_share_effects e
                JOIN drive_bulk_shares b ON b.share_id=e.share_id
                JOIN drive_bulk_share_files f ON f.share_id=e.share_id AND f.position=e.position
                JOIN drive_bulk_share_recipients r ON r.share_id=e.share_id
                  AND r.recipient_user_id=e.recipient_user_id
                WHERE e.share_id=:share AND e.position=:position
                  AND e.recipient_user_id=:recipient AND e.user_id=:owner
                  AND b.user_id=:owner AND b.origin_request_id=:request
                  AND b.progressive_batch=TRUE AND b.approved_at IS NOT NULL
                FOR UPDATE OF e"""),
                {
                    "share": share,
                    "position": position,
                    "recipient": recipient,
                    "owner": owner,
                    "request": request,
                },
            )
            .mappings()
            .first()
        )
        if row is None:
            raise DriveSharingError("request_unavailable")
        return dict(row)

    @staticmethod
    def _removal(connection, *, share, position, recipient):
        row = (
            connection.execute(
                text("""SELECT removal_id,user_id,plan_envelope,state,attempts,lease_id
                FROM drive_request_bulk_removals
                WHERE share_id=:share AND position=:position AND recipient_user_id=:recipient"""),
                {"share": share, "position": position, "recipient": recipient},
            )
            .mappings()
            .first()
        )
        return dict(row) if row is not None else None

    def _undoable(self, removal) -> bool:
        """Only the owner's own unclaimed one-file removal; never a Stop or expiry."""
        if not (
            removal["state"] == "queued"
            and removal["attempts"] == 0
            and removal["lease_id"] is None
            and removal["plan_envelope"] is not None
        ):
            return False
        try:
            return self._plan(removal).get("scope") == OWNER_FILE_REMOVAL_SCOPE
        except (DriveSharingError, TypeError, ValueError):
            return False

    def _removal_result(self, file_ref, removal):
        status = _file_status({"removal_state": removal["state"], "grant_state": "succeeded"})
        return {
            "fileRef": file_ref,
            "status": status,
            "undoable": self._undoable(removal),
            "undoSeconds": UNDO_SECONDS,
        }

    async def remove_file(self, *, user_id, request_id, file_ref):
        """Queue removal of the requester's access to one file. Idempotent."""
        request = _uuid(request_id)
        share, position = _parse_file_ref(file_ref)

        def operation(connection):
            self._gate_graph_for_request(connection, user_id=user_id, request_id=request)
            # Settle locks an effect before its request, so this path never
            # holds the request row while it waits for the effect lock.
            owned = self._owned_request(connection, user_id=user_id, request_id=request)
            recipient = owned["recipient_user_id"]
            effect = self._locked_effect(
                connection,
                owner=user_id,
                recipient=recipient,
                request=request,
                share=share,
                position=position,
            )
            existing = self._removal(
                connection, share=share, position=position, recipient=recipient
            )
            if existing is not None:
                return self._removal_result(file_ref, existing)
            if effect["state"] != "succeeded" or effect["receipt_envelope"] is None:
                # One never created this permission, so One never deletes it.
                raise DriveSharingError("no_revocable_permissions")
            try:
                receipt = self._open(
                    effect["receipt_envelope"],
                    user_id=user_id,
                    resource_id=f"{share}:{position}:{recipient}",
                    purpose="bulk-share-receipt",
                )
                identity = self._open(
                    effect["identity_envelope"],
                    user_id=user_id,
                    resource_id=f"{share}:{recipient}",
                    purpose="bulk-share-recipient",
                )
                plan = managed_bulk_plan(
                    receipt=receipt, file=self._file(effect, user_id), recipient=identity
                )
            except (DriveSharingError, TypeError, ValueError):
                plan = None
            if plan is None:
                raise DriveSharingError("no_revocable_permissions")
            removal_id = str(uuid4())
            envelope = self.cipher.seal(
                {**plan, "scope": OWNER_FILE_REMOVAL_SCOPE},
                user_id=user_id,
                resource_id=removal_id,
                purpose="bulk-removal-plan",
            )
            connection.execute(
                text("""INSERT INTO drive_request_bulk_removals
                  (removal_id,request_id,user_id,share_id,position,recipient_user_id,
                   plan_envelope,state,next_at,v1_statement_search)
                  VALUES (:id,:request,:user,:share,:position,:recipient,
                    CAST(:plan AS jsonb),'queued',
                    clock_timestamp()+make_interval(secs => :undo),:v1)
                  ON CONFLICT (share_id,position,recipient_user_id) DO NOTHING"""),
                {
                    "id": removal_id,
                    "request": request,
                    "user": user_id,
                    "share": share,
                    "position": position,
                    "recipient": recipient,
                    "plan": json.dumps(envelope),
                    "undo": UNDO_SECONDS,
                    "v1": bool(effect["v1_statement_search"]),
                },
            )
            current = self._removal(connection, share=share, position=position, recipient=recipient)
            return self._removal_result(file_ref, current)

        return await self._transaction(operation)

    async def restore_file(self, *, user_id, request_id, file_ref):
        """Undo a removal that no worker has claimed. Nothing reached Google yet."""
        request = _uuid(request_id)
        share, position = _parse_file_ref(file_ref)

        def operation(connection):
            self._gate_graph_for_request(connection, user_id=user_id, request_id=request)
            # Settle locks an effect before its request, so this path never
            # holds the request row while it waits for the effect lock.
            owned = self._owned_request(connection, user_id=user_id, request_id=request)
            recipient = owned["recipient_user_id"]
            self._locked_effect(
                connection,
                owner=user_id,
                recipient=recipient,
                request=request,
                share=share,
                position=position,
            )
            existing = self._removal(
                connection, share=share, position=position, recipient=recipient
            )
            if existing is None:
                return {"fileRef": file_ref, "status": "shared", "undoable": False}
            if not self._undoable(existing):
                # A claimed removal, or one a Stop or access expiry queued,
                # is not this owner's one-file Undo.
                raise DriveSharingError("revocation_pending")
            deleted = connection.execute(
                text("""DELETE FROM drive_request_bulk_removals
                WHERE share_id=:share AND position=:position AND recipient_user_id=:recipient
                  AND user_id=:user AND request_id=:request
                  AND state='queued' AND attempts=0 AND lease_id IS NULL"""),
                {
                    "share": share,
                    "position": position,
                    "recipient": recipient,
                    "user": user_id,
                    "request": request,
                },
            ).rowcount
            if deleted != 1:
                raise DriveSharingError("revocation_pending")
            return {"fileRef": file_ref, "status": "shared", "undoable": False}

        return await self._transaction(operation)
