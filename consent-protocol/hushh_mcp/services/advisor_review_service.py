"""One confirmed request; advisor acceptance connects and unlocks atomically."""

import hashlib
import json
from uuid import uuid4

from sqlalchemy import text

from db.db_client import get_db
from hushh_mcp.services.advisor_review_connections import connect_for_review
from hushh_mcp.services.advisor_review_notifications import notify_review
from hushh_mcp.services.advisor_review_store import (
    AdvisorReviewError,
    expire,
    load,
    pair_gate,
    project,
    require_accepted,
)
from hushh_mcp.services.direct_messages_service import DirectMessagesError, DirectMessagesService
from hushh_mcp.services.finance_sharing_service import FinanceSharingService, one, require_advisor


class AdvisorReviewService:
    def __init__(self, db=None):
        self.db = db or get_db()

    def create(self, owner, body):
        payload = body.model_dump(mode="json")
        fingerprint = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
        with self.db.engine.begin() as conn:
            person = one(
                conn,
                "SELECT user_id FROM actor_profiles WHERE public_person_ref=CAST(:ref AS uuid)",
                {"ref": str(body.advisorPersonRef)},
            )
            if not person or person["user_id"] == owner:
                raise AdvisorReviewError("ADVISOR_NOT_ELIGIBLE", 403)
            advisor = person["user_id"]
            pair_gate(conn, owner, advisor)
            expire(conn, owner, advisor=advisor)
            previous = one(
                conn,
                "SELECT id,fingerprint,owner_user_id FROM advisor_review_requests WHERE id=CAST(:id AS uuid)",
                {"id": str(body.requestId)},
            )
            if previous:
                if previous["owner_user_id"] != owner or previous["fingerprint"] != fingerprint:
                    raise AdvisorReviewError("ADVISOR_RETRY_CONFLICT", 409)
                return project(load(conn, owner, str(body.requestId)), owner)
            require_advisor(conn, advisor)
            # Reuse the owner-controlled discoverability boundary, rather than
            # treating a guessed public reference as permission to make contact.
            from hushh_mcp.services.one_location_agent_service import OneLocationAgentService

            if not OneLocationAgentService().is_directory_candidate(
                owner_user_id=owner, candidate_user_id=advisor
            ):
                raise AdvisorReviewError("ADVISOR_NOT_ELIGIBLE", 403)
            FinanceSharingService._key(conn, advisor, body.envelope.recipientKeyId)
            FinanceSharingService._key(conn, owner, body.ownerEnvelope.recipientKeyId)
            active = one(
                conn,
                """SELECT id FROM advisor_review_requests WHERE owner_user_id=:owner
                AND advisor_user_id=:advisor AND status IN ('pending','accepted')""",
                {"owner": owner, "advisor": advisor},
            )
            if active:
                raise AdvisorReviewError("ADVISOR_REQUEST_EXISTS", 409)
            conn.execute(
                text("""INSERT INTO advisor_review_requests(id,owner_user_id,advisor_user_id,advisor_person_ref,
                fingerprint,content_hash,envelope,owner_envelope,introduction,expires_at)
                VALUES(CAST(:id AS uuid),:owner,:advisor,CAST(:ref AS uuid),:fingerprint,:hash,CAST(:envelope AS jsonb),
                CAST(:owner_envelope AS jsonb),:introduction,clock_timestamp()+interval '7 days')"""),
                {
                    "id": str(body.requestId),
                    "owner": owner,
                    "advisor": advisor,
                    "ref": str(body.advisorPersonRef),
                    "fingerprint": fingerprint,
                    "hash": body.contentHash,
                    "envelope": json.dumps(payload["envelope"]),
                    "owner_envelope": json.dumps(payload["ownerEnvelope"]),
                    "introduction": body.introduction.strip(),
                },
            )
            notify_review(
                conn,
                advisor,
                str(body.requestId),
                "advisor_review_requested",
                role="advisor",
            )
            return project(load(conn, owner, str(body.requestId)), owner)

    def history(self, viewer, current_ui=False):
        with self.db.engine.begin() as conn:
            expire(conn, viewer)
            ids = (
                conn.execute(
                    text("""SELECT id FROM advisor_review_requests
                WHERE :viewer IN(owner_user_id,advisor_user_id) ORDER BY created_at DESC,id DESC LIMIT 50"""),
                    {"viewer": viewer},
                )
                .scalars()
                .all()
            )
            return {
                "items": [
                    project(load(conn, viewer, str(key)), viewer, current_ui=current_ui)
                    for key in ids
                ]
            }

    def view(self, viewer, request_id, current_ui=False):
        from hushh_mcp.services.advisor_review_store import lock_review
        from hushh_mcp.services.finance_sharing_service import FinanceSharingError

        with self.db.engine.begin() as conn:
            row = lock_review(conn, viewer, request_id)
            expire(conn, viewer, request_id=request_id)
            row = load(conn, viewer, request_id, locked=True)
            if row["status"] == "accepted":
                try:
                    require_accepted(conn, row)
                except (FinanceSharingError, DirectMessagesError) as exc:
                    if exc.status_code >= 500:
                        raise
                    conn.execute(
                        text(
                            "UPDATE advisor_review_requests SET status='stopped',envelope=NULL,owner_envelope=NULL WHERE id=CAST(:id AS uuid)"
                        ),
                        {"id": request_id},
                    )
                    row = load(conn, viewer, request_id, locked=True)
            if row["envelope"] and (viewer == row["owner_user_id"] or row["status"] == "accepted"):
                envelope = (
                    row["owner_envelope"] if viewer == row["owner_user_id"] else row["envelope"]
                )
                if isinstance(envelope, str):
                    envelope = json.loads(envelope)
                try:
                    FinanceSharingService._key(conn, viewer, envelope["recipientKeyId"])
                except FinanceSharingError as exc:
                    if exc.status_code != 409:
                        raise
                    conn.execute(
                        text(
                            "UPDATE advisor_review_requests SET envelope=NULL,owner_envelope=NULL WHERE id=CAST(:id AS uuid)"
                        ),
                        {"id": request_id},
                    )
                    row = load(conn, viewer, request_id, locked=True)
            result = project(row, viewer, snapshot=True, current_ui=current_ui)
            if current_ui and row["status"] == "pending" and viewer == row["advisor_user_id"]:
                result["alreadyConnected"] = (
                    self._active_connection(conn, row["owner_user_id"], row["advisor_user_id"])
                    is not None
                )
            return result

    def _active_connection(self, conn, owner, advisor):
        try:
            return DirectMessagesService(
                db=self.db, connection=conn, defer_notifications=True
            ).require_active_connection(owner, advisor)
        except DirectMessagesError as exc:
            if exc.code in {"DIRECT_MESSAGE_CONNECTION_REQUIRED", "DIRECT_MESSAGE_BLOCKED"}:
                return None
            raise

    def decide(self, viewer, request_id, action, require_existing_connection=False):
        with self.db.engine.begin() as conn:
            candidate = load(conn, viewer, request_id)
            pair_gate(conn, candidate["owner_user_id"], candidate["advisor_user_id"])
            expire(conn, viewer, request_id=request_id)
            row = load(conn, viewer, request_id, locked=True)
            owner, advisor = row["owner_user_id"], row["advisor_user_id"]
            recipient_action = action in ("accept", "decline")
            # Either participant can end an accepted review: it only removes access.
            allowed = (
                {advisor} if recipient_action else {owner, advisor} if action == "stop" else {owner}
            )
            if viewer not in allowed:
                raise AdvisorReviewError("ADVISOR_WRONG_PARTICIPANT", 403)
            next_status = {
                "accept": "accepted",
                "decline": "declined",
                "withdraw": "withdrawn",
                "stop": "stopped",
            }[action]
            if row["status"] == next_status:
                return project(row, viewer)
            if row["status"] != ("accepted" if action == "stop" else "pending"):
                raise AdvisorReviewError("ADVISOR_REQUEST_CHANGED", 409)
            connection_id = None
            if action == "accept":
                require_advisor(conn, advisor)
                envelope = (
                    json.loads(row["envelope"])
                    if isinstance(row["envelope"], str)
                    else row["envelope"]
                )
                FinanceSharingService._key(conn, advisor, envelope["recipientKeyId"])
                connection_id = self._active_connection(conn, owner, advisor)
                if connection_id is None:
                    if require_existing_connection:
                        raise AdvisorReviewError("ADVISOR_REQUEST_CHANGED", 409)
                    connection_id = connect_for_review(conn, owner, advisor, request_id)
                _message(self.db, conn, owner, advisor, request_id)
            conn.execute(
                text("""UPDATE advisor_review_requests SET status=:status,
                connection_id=COALESCE(CAST(:connection AS uuid),connection_id),
                accepted_at=CASE WHEN :status='accepted' THEN clock_timestamp() ELSE accepted_at END,
                envelope=CASE WHEN :status='accepted' THEN envelope ELSE NULL END,
                owner_envelope=CASE WHEN :status='accepted' THEN owner_envelope ELSE NULL END,
                updated_at=clock_timestamp() WHERE id=CAST(:id AS uuid)"""),
                {"id": request_id, "status": next_status, "connection": connection_id},
            )
            counterpart_is_owner = viewer == advisor
            notify_review(
                conn,
                owner if counterpart_is_owner else advisor,
                request_id,
                "advisor_review_accepted" if action == "accept" else "advisor_review_updated",
                role="owner" if counterpart_is_owner else "advisor",
            )
            return project(load(conn, viewer, request_id), viewer)


def _message(db, conn, owner, advisor, request_id):
    DirectMessagesService(db=db, connection=conn, defer_notifications=True).send_message(
        owner,
        recipient_user_id=advisor,
        content=f"[advisor-review:{request_id}]",
        client_message_id=str(uuid4()),
    )
