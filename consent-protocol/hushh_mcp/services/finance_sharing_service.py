"""One authority for owner-confirmed encrypted Finance sharing with connections.

This service cannot decrypt Finance. Selected contents are projected and sealed
by the unlocked owner. A connection or ciphertext alone never authorizes a read.
"""

import hashlib
import json
from uuid import uuid4

from sqlalchemy import text

from db.db_client import get_db
from hushh_mcp.consent.model_processing import model_processing_allowed
from hushh_mcp.services.connection_graph_service import lock_connection_graph_users
from hushh_mcp.services.direct_messages_service import DirectMessagesService
from hushh_mcp.services.finance_sharing_contract import CreateFinanceShare, RefreshFinanceShare


class FinanceSharingError(RuntimeError):
    def __init__(self, code="FINANCE_SHARE_UNAVAILABLE", status_code=403):
        self.code, self.status_code = code, status_code
        super().__init__(code)


def one(conn, sql, params=None):
    row = conn.execute(text(sql), params or {}).mappings().first()
    return dict(row) if row is not None else None


def rows(conn, sql, params=None):
    return [dict(r) for r in conn.execute(text(sql), params or {}).mappings().all()]


def decoded(value):
    return json.loads(value) if isinstance(value, str) else value


def iso(value):
    return value.isoformat() if value is not None else None


def grant_status(row):
    if row["revoked_at"] is not None:
        return "stopped"
    if row["expires_at"] is not None and row["expires_at"] <= row["server_now"]:
        return "expired"
    return "active"


def grant_projection(row, viewer, *, include_envelope=False):
    owner = row["owner_user_id"] == viewer
    policy = decoded(row["policy"])
    result = {
        "id": str(row["id"]),
        "requestId": str(row["request_id"]),
        "ownerUserId": row["owner_user_id"],
        "recipientUserId": row["recipient_user_id"],
        "recipientKeyId": row["recipient_key_id"],
        "recipientPersonRef": str(row["recipient_person_ref"]),
        "senderName": row.get("sender_name") or "A connection",
        "recipientName": row.get("recipient_name") or "A connection",
        "policy": policy,
        "revision": row["revision"],
        "contentHash": row["content_hash"],
        "createdAt": iso(row["created_at"]),
        "updatedAt": iso(row["updated_at"]),
        "expiresAt": iso(row["expires_at"]),
        "serverNow": iso(row["server_now"]),
        "status": grant_status(row),
        "direction": "outgoing" if owner else "received",
    }
    if include_envelope and result["status"] == "active":
        result["envelope"] = decoded(row["owner_envelope"] if owner else row["envelope"])
        if owner:
            result["ownerConfig"] = decoded(row["owner_config"])
    return result


def request_grants(conn, select, owner, request_id):
    return {
        "items": [
            grant_projection(row, owner)
            for row in rows(
                conn,
                select
                + " WHERE g.owner_user_id=:owner AND g.request_id=CAST(:id AS uuid) ORDER BY g.id",
                {"owner": owner, "id": request_id},
            )
        ]
    }


class FinanceSharingService:
    def __init__(self, db=None):
        self.db = db or get_db()

    @staticmethod
    def _ready(conn):
        if not one(conn, "SELECT to_regclass('public.finance_access_grants') IS NOT NULL AS ok")[
            "ok"
        ]:
            raise FinanceSharingError("FINANCE_SHARE_NOT_READY", 503)

    @staticmethod
    def _key(conn, uid, key_id):
        key = one(
            conn,
            """SELECT key_id,public_key_jwk FROM one_location_recipient_keys
          WHERE user_id=:uid AND status='active' ORDER BY created_at DESC LIMIT 1 FOR SHARE""",
            {"uid": uid},
        )
        if not key or key["key_id"] != key_id:
            raise FinanceSharingError("FINANCE_SHARE_KEY_CHANGED", 409)

    @staticmethod
    def _connection(conn, db, owner, recipient):
        lock_connection_graph_users(conn, user_ids=sorted([owner, recipient]))
        DirectMessagesService(
            db=db, connection=conn, defer_notifications=True
        ).require_active_connection(owner, recipient)

    @staticmethod
    def _purge(conn, viewer):
        # No retained expired Finance ciphertext. Invoked on both history and access.
        conn.execute(
            text("""UPDATE finance_access_grants g SET envelope=NULL,owner_envelope=NULL
          FROM finance_share_requests r WHERE r.owner_user_id=g.owner_user_id AND r.id=g.request_id
          AND :viewer IN(g.owner_user_id,g.recipient_user_id)
          AND (g.revoked_at IS NOT NULL OR r.expires_at<=clock_timestamp())
          AND (g.envelope IS NOT NULL OR g.owner_envelope IS NOT NULL)"""),
            {"viewer": viewer},
        )
        conn.execute(
            text("""UPDATE finance_share_requests r SET owner_config=NULL
          WHERE owner_user_id=:viewer AND owner_config IS NOT NULL AND
          (expires_at<=clock_timestamp() OR NOT EXISTS(SELECT 1 FROM finance_access_grants g
             WHERE g.owner_user_id=r.owner_user_id AND g.request_id=r.id AND g.revoked_at IS NULL))"""),
            {"viewer": viewer},
        )

    _SELECT = """SELECT g.*,r.policy,r.expires_at,r.owner_config,clock_timestamp() AS server_now,
      rp.public_person_ref AS recipient_person_ref,s.display_name AS sender_name,a.display_name AS recipient_name
      FROM finance_access_grants g JOIN finance_share_requests r
        ON r.owner_user_id=g.owner_user_id AND r.id=g.request_id
      JOIN actor_profiles rp ON rp.user_id=g.recipient_user_id
      LEFT JOIN actor_identity_cache s ON s.user_id=g.owner_user_id
      LEFT JOIN actor_identity_cache a ON a.user_id=g.recipient_user_id """

    def create(self, owner, body: CreateFinanceShare):
        payload = body.model_dump(mode="json")
        fingerprint = hashlib.sha256(
            json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        request_id = str(body.requestId)
        with self.db.engine.begin() as conn:
            self._ready(conn)
            conn.execute(
                text("SELECT pg_advisory_xact_lock(hashtextextended(:key,0))"),
                {"key": "finance-share:" + owner + ":" + request_id},
            )
            previous = one(
                conn,
                "SELECT fingerprint FROM finance_share_requests WHERE owner_user_id=:owner AND id=CAST(:id AS uuid)",
                {"owner": owner, "id": request_id},
            )
            if previous:
                if previous["fingerprint"] != fingerprint:
                    raise FinanceSharingError("FINANCE_SHARE_RETRY_CONFLICT", 409)
                return request_grants(conn, self._SELECT, owner, request_id)
            recipients = []
            for item in body.recipients:
                person = one(
                    conn,
                    "SELECT user_id FROM actor_profiles WHERE public_person_ref=CAST(:ref AS uuid)",
                    {"ref": str(item.personRef)},
                )
                if not person or person["user_id"] == owner:
                    raise FinanceSharingError("FINANCE_SHARE_RECIPIENT_INVALID")
                recipients.append((person["user_id"], item))
            lock_connection_graph_users(conn, user_ids=sorted([owner, *[r[0] for r in recipients]]))
            self._key(conn, owner, body.ownerConfig.recipientKeyId)
            dm = DirectMessagesService(db=self.db, connection=conn, defer_notifications=True)
            for uid, item in recipients:
                dm.require_active_connection(owner, uid)
                self._key(conn, uid, item.envelope.recipientKeyId)
                self._key(conn, owner, item.ownerEnvelope.recipientKeyId)
            conn.execute(
                text("""INSERT INTO finance_share_requests(owner_user_id,id,fingerprint,policy,owner_config,expires_at)
              VALUES(:owner,CAST(:id AS uuid),:fingerprint,CAST(:policy AS jsonb),CAST(:config AS jsonb),
                CASE WHEN :duration IS NULL THEN NULL ELSE clock_timestamp()+make_interval(secs=>:duration) END)"""),
                {
                    "owner": owner,
                    "id": request_id,
                    "fingerprint": fingerprint,
                    "policy": json.dumps(payload["policy"]),
                    "config": json.dumps(payload["ownerConfig"]),
                    "duration": body.policy.durationSeconds,
                },
            )
            for uid, item in recipients:
                message_id = str(uuid4())
                dm.send_message(
                    owner,
                    recipient_user_id=uid,
                    content=f"[finance-share:{item.grantId}]",
                    client_message_id=message_id,
                )
                conn.execute(
                    text("""INSERT INTO finance_access_grants(id,owner_user_id,recipient_user_id,request_id,
                    recipient_key_id,envelope,owner_envelope,content_hash,message_id)
                  VALUES(CAST(:grant AS uuid),:owner,:recipient,CAST(:request AS uuid),:key,
                    CAST(:envelope AS jsonb),CAST(:owner_envelope AS jsonb),:hash,CAST(:message AS uuid))"""),
                    {
                        "grant": str(item.grantId),
                        "owner": owner,
                        "recipient": uid,
                        "request": request_id,
                        "key": item.envelope.recipientKeyId,
                        "envelope": item.envelope.model_dump_json(),
                        "owner_envelope": item.ownerEnvelope.model_dump_json(),
                        "hash": item.contentHash,
                        "message": message_id,
                    },
                )
            return request_grants(conn, self._SELECT, owner, request_id)

    def history(self, viewer, *, direction="outgoing", cursor=None):
        with self.db.engine.begin() as conn:
            self._ready(conn)
            self._purge(conn, viewer)
            column = "g.owner_user_id" if direction == "outgoing" else "g.recipient_user_id"
            found = rows(
                conn,
                self._SELECT
                + f" WHERE {column}=:viewer AND (CAST(:cursor AS uuid) IS NULL OR g.id>CAST(:cursor AS uuid)) ORDER BY g.id LIMIT 51",
                {"viewer": viewer, "cursor": cursor},
            )  # nosec B608 - fixed column
            return {
                "items": [grant_projection(r, viewer) for r in found[:50]],
                "nextCursor": str(found[49]["id"]) if len(found) > 50 else None,
            }

    def view(self, viewer, grant_id):
        with self.db.engine.begin() as conn:
            self._ready(conn)
            row = one(
                conn,
                self._SELECT
                + " WHERE g.id=CAST(:id AS uuid) AND :viewer IN(g.owner_user_id,g.recipient_user_id)",
                {"id": grant_id, "viewer": viewer},
            )
            if not row:
                raise FinanceSharingError("FINANCE_SHARE_NOT_FOUND", 404)
            # Acquire graph locks before grant locks, exactly as create/refresh/revoke.
            self._connection(conn, self.db, row["owner_user_id"], row["recipient_user_id"])
            self._purge(conn, viewer)
            row = one(
                conn,
                self._SELECT + " WHERE g.id=CAST(:id AS uuid) FOR SHARE OF g,r",
                {"id": grant_id},
            )
            if grant_status(row) == "active":
                self._key(conn, row["recipient_user_id"], row["recipient_key_id"])
            row["server_now"] = one(conn, "SELECT clock_timestamp() AS now")["now"]
            return grant_projection(row, viewer, include_envelope=True)

    def refresh(self, owner, grant_id, body: RefreshFinanceShare):
        with self.db.engine.begin() as conn:
            self._ready(conn)
            row = one(
                conn,
                self._SELECT + " WHERE g.id=CAST(:id AS uuid) AND g.owner_user_id=:owner",
                {"id": grant_id, "owner": owner},
            )
            if not row:
                raise FinanceSharingError("FINANCE_SHARE_NOT_FOUND", 404)
            self._connection(conn, self.db, owner, row["recipient_user_id"])
            row = one(
                conn,
                self._SELECT + " WHERE g.id=CAST(:id AS uuid) FOR UPDATE OF g",
                {"id": grant_id},
            )
            if grant_status(row) != "active" or decoded(row["policy"])["mode"] != "ongoing":
                raise FinanceSharingError("FINANCE_SHARE_ENDED", 410)
            if (
                row["revision"] != body.expectedRevision
                or row["recipient_key_id"] != body.envelope.recipientKeyId
            ):
                raise FinanceSharingError("FINANCE_SHARE_REVISION_CHANGED", 409)
            self._key(conn, row["recipient_user_id"], body.envelope.recipientKeyId)
            self._key(conn, owner, body.ownerEnvelope.recipientKeyId)
            updated = conn.execute(
                text("""UPDATE finance_access_grants SET envelope=CAST(:envelope AS jsonb),
              owner_envelope=CAST(:owner_envelope AS jsonb),content_hash=:hash,revision=revision+1,updated_at=clock_timestamp()
              WHERE id=CAST(:id AS uuid) AND revoked_at IS NULL AND revision=:expected
              AND EXISTS(SELECT 1 FROM finance_share_requests r WHERE r.owner_user_id=finance_access_grants.owner_user_id
                AND r.id=finance_access_grants.request_id AND (r.expires_at IS NULL OR r.expires_at>clock_timestamp()))"""),
                {
                    "id": grant_id,
                    "expected": body.expectedRevision,
                    "envelope": body.envelope.model_dump_json(),
                    "owner_envelope": body.ownerEnvelope.model_dump_json(),
                    "hash": body.contentHash,
                },
            )
            if updated.rowcount != 1:
                raise FinanceSharingError("FINANCE_SHARE_ENDED", 410)
            return {"revision": row["revision"] + 1}

    def revoke(self, owner, grant_id):
        with self.db.engine.begin() as conn:
            self._ready(conn)
            row = one(
                conn,
                "SELECT recipient_user_id FROM finance_access_grants WHERE id=CAST(:id AS uuid) AND owner_user_id=:owner",
                {"id": grant_id, "owner": owner},
            )
            if not row:
                raise FinanceSharingError("FINANCE_SHARE_NOT_FOUND", 404)
            lock_connection_graph_users(conn, user_ids=sorted([owner, row["recipient_user_id"]]))
            conn.execute(
                text("""UPDATE finance_access_grants SET revoked_at=COALESCE(revoked_at,clock_timestamp()),
              envelope=NULL,owner_envelope=NULL WHERE id=CAST(:id AS uuid) AND owner_user_id=:owner"""),
                {"id": grant_id, "owner": owner},
            )
            self._purge(conn, owner)
            return {"stopped": True}


async def finance_review_authority(recipient, source_ref):
    """Fresh, metadata-only adapter for hub and signed private-pod reads."""
    import asyncio

    from hushh_mcp.one_adk.finance_share_context import FINANCE_SOURCE, FinanceReviewAuthority

    match = FINANCE_SOURCE.fullmatch(source_ref)
    if not match:
        raise FinanceSharingError("FINANCE_SHARE_NOT_FOUND", 404)
    grant_id, expected_revision = match.groups()
    row = await asyncio.to_thread(FinanceSharingService().view, recipient, grant_id)
    if row["direction"] != "received":
        raise FinanceSharingError("FINANCE_SHARE_NOT_FOUND", 404)
    status = row["status"] if row["revision"] == int(expected_revision) else "changed"
    return FinanceReviewAuthority.model_validate(
        {
            "sourceRef": source_ref,
            "recipientUserId": recipient,
            "senderName": row["senderName"],
            "revision": row["revision"],
            "contentHash": row["contentHash"],
            "status": status,
            "modelProcessingAllowed": status == "active"
            and model_processing_allowed(row["policy"]),
            "sections": row["policy"]["sections"],
            "showAmounts": row["policy"]["showAmounts"],
        }
    ).model_dump()
