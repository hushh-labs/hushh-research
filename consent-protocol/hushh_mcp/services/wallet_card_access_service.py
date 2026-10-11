"""Owner-manual Wallet card access; grants never contain payment credentials.

PKM owns card storage; its commit trigger owns provenance activation. Postgres
remains authorization authority even if future metadata caching moves to Redis.
"""

from __future__ import annotations

import hashlib
import json
import os
import uuid
from datetime import datetime

from sqlalchemy import text

from db.db_client import get_db
from hushh_mcp.services.connection_graph_service import lock_connection_graph_users
from hushh_mcp.services.direct_messages_service import DirectMessageCipher, DirectMessagesService
from hushh_mcp.services.wallet_card_access_projection import (
    WalletCardSourceCipher,
    masked_card_projection,
)


class WalletCardAccessError(RuntimeError):
    def __init__(self, code: str, status_code: int = 403):
        self.code, self.status_code = code, status_code
        super().__init__(code)


class WalletCardAccessCipher(DirectMessageCipher):
    @staticmethod
    def _aad(*, conversation_id: str, message_id: str, sender_user_id: str) -> bytes:
        return json.dumps(
            ["wallet-card-access-v1", sender_user_id, conversation_id, message_id],
            separators=(",", ":"),
        ).encode()


TRUSTED_SQL = """EXISTS(SELECT 1 FROM one_location_circles tc
 JOIN one_location_circle_memberships tm ON tm.circle_id=tc.id
 WHERE tc.owner_user_id=:owner AND tc.system_kind='trusted' AND tc.status='active'
 AND tm.user_id=:recipient AND tm.status='active'
 AND tm.metadata @> jsonb_build_object('addedVia','direct_add','addedBy',tc.owner_user_id))"""


def one(conn, sql, values=None):
    row = conn.execute(text(sql), values or {}).mappings().first()
    return dict(row) if row is not None else None


def many(conn, sql, values=None):
    return [dict(row) for row in conn.execute(text(sql), values or {}).mappings().all()]


def iso(value):
    return value.isoformat() if isinstance(value, datetime) else value


class WalletCardAccessService:
    def __init__(self, db=None, cipher=None):
        self.db = db or get_db()
        self.cipher = cipher or WalletCardAccessCipher()

    @staticmethod
    def flag_enabled():
        return os.getenv("WALLET_CARD_ACCESS_ENABLED", "").lower() in {"1", "true", "yes"}

    def available(self, conn):
        if not self.flag_enabled():
            return False
        return bool(
            one(
                conn,
                "SELECT to_regclass('public.wallet_card_access_grants') IS NOT NULL AND to_regclass('public.wallet_card_registrations') IS NOT NULL AS ok",
            )["ok"]
        )

    def require_available(self, conn):
        if not self.available(conn):
            raise WalletCardAccessError("WALLET_CARD_ACCESS_UNAVAILABLE", 503)

    @staticmethod
    def _registration_lock(conn, owner, card_id, *, require_active=True):
        row = one(
            conn,
            "SELECT card_id FROM wallet_card_registrations WHERE owner_user_id=:owner AND card_id=:card AND (NOT :require_active OR state='active') FOR SHARE",
            {"owner": owner, "card": card_id, "require_active": require_active},
        )
        if not row:
            raise WalletCardAccessError("WALLET_CARD_INELIGIBLE")

    @staticmethod
    def _audit(conn, grant_id, actor, event):
        conn.execute(
            text(
                "INSERT INTO wallet_card_access_audit(grant_id,actor_user_id,event_type) VALUES(CAST(:id AS uuid),:actor,:event)"
            ),
            {"id": grant_id, "actor": actor, "event": event},
        )

    def reserve(self, owner: str, request_id: str):
        if not self.flag_enabled():
            return {"enabled": False, "cardId": None}
        with self.db.engine.begin() as conn:
            if not self.available(conn):
                return {"enabled": False, "cardId": None}
            lock_connection_graph_users(conn, user_ids=[owner])
            saved = one(
                conn,
                "SELECT card_id FROM wallet_card_registrations WHERE owner_user_id=:owner AND registration_request_id=CAST(:request AS uuid)",
                {"owner": owner, "request": request_id},
            )
            if saved:
                return {"enabled": True, "cardId": saved["card_id"]}
            card_id = "card_" + str(uuid.uuid4())
            conn.execute(
                text(
                    "INSERT INTO wallet_card_registrations(owner_user_id,card_id,registration_request_id) VALUES(:owner,:card,CAST(:request AS uuid))"
                ),
                {"owner": owner, "card": card_id, "request": request_id},
            )
            return {"enabled": True, "cardId": card_id}

    @staticmethod
    def _card(conn, owner, card_id):
        row = one(
            conn,
            """SELECT r.source_projection FROM wallet_card_registrations r
 JOIN pkm_manifests m ON m.user_id=r.owner_user_id AND m.domain='wallet'
 WHERE r.owner_user_id=:owner AND r.card_id=:card AND r.state='active'
 AND r.origin IN ('owner_manual_add_v1','owner_saved_card_v1') AND r.source_commit_id IS NOT NULL
 AND r.source_projection_revision=m.manifest_version
 AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(
 CASE WHEN jsonb_typeof(m.summary_projection->'wallet_card_access_projection'->'cardIds')='array'
 THEN m.summary_projection->'wallet_card_access_projection'->'cardIds' ELSE '[]'::jsonb END) c(card_id)
 WHERE c.card_id=r.card_id)""",
            {"owner": owner, "card": card_id},
        )
        if not row:
            raise WalletCardAccessError("WALLET_CARD_INELIGIBLE")
        entry = json.loads(
            WalletCardSourceCipher().open(
                {
                    **row["source_projection"],
                    "id": card_id,
                    "sender_user_id": owner,
                    "conversation_id": "",
                }
            )
        )
        if not isinstance(entry, dict) or set(entry) != {
            "brand",
            "last4",
            "expiryMonth",
            "expiryYear",
            "issuingRegion",
        }:
            raise WalletCardAccessError("WALLET_CARD_SOURCE_INVALID", 503)
        return masked_card_projection(
            {
                "card_id": card_id,
                "brand": entry["brand"],
                "last4": entry["last4"],
                "expiry_month": entry["expiryMonth"],
                "expiry_year": entry["expiryYear"],
                "issuing_region": entry["issuingRegion"],
            }
        )

    @staticmethod
    def _grant_status(row, now):
        if row.get("revoked_at"):
            return "revoked"
        if row["expires_at"] <= now:
            return "expired"
        return "active"

    def _owner_grants(self, conn, owner, card_id):
        rows = many(
            conn,
            """SELECT g.id,g.expires_at,g.revoked_at,a.display_name,clock_timestamp() AS server_now
 FROM wallet_card_access_grants g LEFT JOIN actor_identity_cache a ON a.user_id=g.recipient_user_id
 WHERE g.owner_user_id=:owner AND g.card_id=:card ORDER BY g.created_at DESC,g.id""",
            {"owner": owner, "card": card_id},
        )
        return [
            {
                "id": str(r["id"]),
                "recipientName": r.get("display_name") or "A connection",
                "expiresAt": iso(r["expires_at"]),
                "status": self._grant_status(r, r["server_now"]),
            }
            for r in rows
        ]

    def card_access(self, owner, card_id):
        with self.db.engine.begin() as conn:
            self.require_available(conn)
            try:
                self._card(conn, owner, card_id)
            except WalletCardAccessError:
                return {"eligible": False, "reason": "card_not_ready", "grants": []}
            return {"eligible": True, "grants": self._owner_grants(conn, owner, card_id)}

    def connections(self, owner, query=""):
        with self.db.engine.begin() as conn:
            self.require_available(conn)
            rows = many(
                conn,
                """SELECT p.public_person_ref,a.display_name,
 COALESCE(NULLIF(a.custom_photo_url,''),a.photo_url) AS photo_url,
 EXISTS(SELECT 1 FROM one_location_circles tc JOIN one_location_circle_memberships tm ON tm.circle_id=tc.id
 WHERE tc.owner_user_id=:owner AND tc.system_kind='trusted' AND tc.status='active' AND tm.user_id=a.user_id AND tm.status='active'
 AND tm.metadata @> jsonb_build_object('addedVia','direct_add','addedBy',tc.owner_user_id)) AS trusted
 FROM connections c JOIN actor_identity_cache a ON a.user_id=CASE WHEN c.user_a_id=:owner THEN c.user_b_id ELSE c.user_a_id END
 JOIN actor_profiles p ON p.user_id=a.user_id
 WHERE c.status='active' AND :owner IN(c.user_a_id,c.user_b_id) AND p.public_person_ref IS NOT NULL
 AND (:query='' OR COALESCE(a.display_name,'') ILIKE '%'||:query||'%')
 AND NOT EXISTS(SELECT 1 FROM direct_message_blocks b WHERE (b.blocker_user_id=:owner AND b.blocked_user_id=a.user_id) OR (b.blocker_user_id=a.user_id AND b.blocked_user_id=:owner))
 ORDER BY lower(COALESCE(a.display_name,'')),p.public_person_ref LIMIT 101""",
                {"owner": owner, "query": query.strip()},
            )
            return {
                "items": [
                    {
                        "personRef": str(r["public_person_ref"]),
                        "displayName": r.get("display_name") or "A connection",
                        "photoUrl": r.get("photo_url"),
                        "trusted": r["trusted"],
                    }
                    for r in rows[:100]
                ],
                "hasMore": len(rows) > 100,
            }

    def _request_grants(self, conn, owner, request_id):
        rows = many(
            conn,
            """SELECT g.id,g.expires_at,g.revoked_at,a.display_name,clock_timestamp() AS server_now
 FROM wallet_card_access_grants g LEFT JOIN actor_identity_cache a ON a.user_id=g.recipient_user_id
 WHERE g.owner_user_id=:owner AND g.request_id=CAST(:request AS uuid) ORDER BY g.id""",
            {"owner": owner, "request": request_id},
        )
        return [
            {
                "id": str(r["id"]),
                "recipientName": r.get("display_name") or "A connection",
                "expiresAt": iso(r["expires_at"]),
                "status": self._grant_status(r, r["server_now"]),
            }
            for r in rows
        ]

    def create_grants(self, owner, card_id, request_id, person_refs, duration_minutes):
        refs = sorted({str(uuid.UUID(str(ref))) for ref in person_refs})
        if duration_minutes not in (5, 10, 15) or not refs or len(refs) > 20:
            raise WalletCardAccessError("WALLET_CARD_SHARE_INVALID", 422)
        fingerprint = hashlib.sha256(
            json.dumps([card_id, refs, duration_minutes], separators=(",", ":")).encode()
        ).hexdigest()
        with self.db.engine.begin() as conn:
            self.require_available(conn)
            conn.execute(
                text("SELECT pg_advisory_xact_lock(hashtextextended(:key,0))"),
                {"key": "wallet-share:" + owner + ":" + request_id},
            )
            previous = one(
                conn,
                "SELECT fingerprint FROM wallet_card_share_requests WHERE owner_user_id=:owner AND request_id=CAST(:request AS uuid)",
                {"owner": owner, "request": request_id},
            )
            if previous:
                if previous["fingerprint"] != fingerprint:
                    raise WalletCardAccessError("WALLET_CARD_RETRY_CONFLICT", 409)
                return {"grants": self._request_grants(conn, owner, request_id)}
            recipients = many(
                conn,
                """SELECT user_id,public_person_ref FROM actor_profiles
 WHERE public_person_ref=ANY(CAST(:refs AS uuid[]))""",
                {"refs": refs},
            )
            if len(recipients) != len(refs) or any(r["user_id"] == owner for r in recipients):
                raise WalletCardAccessError("WALLET_CARD_RECIPIENT_INVALID")
            recipients.sort(key=lambda r: r["user_id"])
            lock_connection_graph_users(conn, user_ids=[owner, *[r["user_id"] for r in recipients]])
            self._registration_lock(conn, owner, card_id)
            card = self._card(conn, owner, card_id)
            dm = DirectMessagesService(db=self.db, connection=conn, defer_notifications=True)
            policies = []
            for recipient in recipients:
                uid = recipient["user_id"]
                dm.require_active_connection(owner, uid)
                trusted = one(
                    conn,
                    "SELECT " + TRUSTED_SQL + " AS trusted",
                    {"owner": owner, "recipient": uid},
                )["trusted"]
                policies.append((uid, not trusted))
            created_at = one(conn, "SELECT clock_timestamp() AS created_at")["created_at"]
            request = one(
                conn,
                """INSERT INTO wallet_card_share_requests(owner_user_id,request_id,card_id,fingerprint,created_at,expires_at,duration_minutes)
 VALUES(:owner,CAST(:request AS uuid),:card,:fingerprint,:created,:created+(:minutes*interval '1 minute'),:minutes)
 RETURNING created_at,expires_at""",
                {
                    "owner": owner,
                    "request": request_id,
                    "card": card_id,
                    "fingerprint": fingerprint,
                    "created": created_at,
                    "minutes": duration_minutes,
                },
            )
            for recipient, verification_required in policies:
                grant_id, message_id = str(uuid.uuid4()), str(uuid.uuid4())
                envelope = self.cipher.seal(
                    json.dumps(card, separators=(",", ":")),
                    conversation_id=recipient,
                    message_id=grant_id,
                    sender_user_id=owner,
                )
                dm.send_message(
                    owner,
                    recipient_user_id=recipient,
                    content=f"[wallet-access:{grant_id}]",
                    client_message_id=message_id,
                )
                conn.execute(
                    text("""INSERT INTO wallet_card_access_grants
 (id,owner_user_id,recipient_user_id,request_id,card_id,message_id,created_at,expires_at,verification_required,content_ciphertext,content_iv,content_algorithm)
 VALUES(CAST(:id AS uuid),:owner,:recipient,CAST(:request AS uuid),:card,CAST(:message AS uuid),:created,:expires,:verification,:content_ciphertext,:content_iv,:content_algorithm)"""),
                    {
                        "id": grant_id,
                        "owner": owner,
                        "recipient": recipient,
                        "request": request_id,
                        "card": card_id,
                        "message": message_id,
                        "created": request["created_at"],
                        "expires": request["expires_at"],
                        "verification": verification_required,
                        **envelope,
                    },
                )
                self._audit(conn, grant_id, owner, "created")
            return {"grants": self._request_grants(conn, owner, request_id)}

    def view_grant(self, recipient, grant_id, *, verified_auth_time=None):
        with self.db.engine.begin() as conn:
            self.require_available(conn)
            locator = one(
                conn,
                "SELECT owner_user_id,card_id FROM wallet_card_access_grants WHERE id=CAST(:id AS uuid) AND recipient_user_id=:recipient",
                {"id": grant_id, "recipient": recipient},
            )
            if not locator:
                raise WalletCardAccessError("WALLET_CARD_ACCESS_NOT_FOUND", 404)
            owner = locator["owner_user_id"]
            lock_connection_graph_users(conn, user_ids=[owner, recipient])
            self._registration_lock(conn, owner, locator["card_id"], require_active=False)
            row = one(
                conn,
                """SELECT g.*,a.display_name AS sender_name,clock_timestamp() AS server_now
 FROM wallet_card_access_grants g LEFT JOIN actor_identity_cache a ON a.user_id=g.owner_user_id
 WHERE g.id=CAST(:id AS uuid) AND g.recipient_user_id=:recipient FOR UPDATE OF g""",
                {"id": grant_id, "recipient": recipient},
            )
            if not row:
                raise WalletCardAccessError("WALLET_CARD_ACCESS_NOT_FOUND", 404)
            now = one(conn, "SELECT clock_timestamp() AS now")["now"]
            result = {
                "status": self._grant_status(row, now),
                "expiresAt": iso(row["expires_at"]),
                "serverNow": iso(now),
                "senderName": row.get("sender_name") or "A connection",
            }
            if result["status"] != "active":
                self._audit(conn, grant_id, recipient, "denied")
                return result
            try:
                self._card(conn, owner, row["card_id"])
            except WalletCardAccessError:
                conn.execute(
                    text(
                        "UPDATE wallet_card_access_grants SET revoked_at=clock_timestamp() WHERE id=CAST(:id AS uuid)"
                    ),
                    {"id": grant_id},
                )
                self._audit(conn, grant_id, recipient, "denied")
                return {**result, "status": "revoked"}
            dm = DirectMessagesService(db=self.db, connection=conn, defer_notifications=True)
            dm.require_active_connection(owner, recipient)
            trusted = one(
                conn,
                "SELECT " + TRUSTED_SQL + " AS trusted",
                {"owner": owner, "recipient": recipient},
            )["trusted"]
            must_verify = row["verification_required"] or not trusted
            if must_verify and row["verified_at"] is None:
                started = row["verification_started_at"]
                if started is None:
                    started = one(
                        conn,
                        """UPDATE wallet_card_access_grants SET verification_required=true,
 verification_started_at=clock_timestamp() WHERE id=CAST(:id AS uuid) RETURNING verification_started_at""",
                        {"id": grant_id},
                    )["verification_started_at"]
                valid_auth = (
                    isinstance(verified_auth_time, (int, float))
                    and not isinstance(verified_auth_time, bool)
                    and verified_auth_time >= started.timestamp()
                    and now.timestamp() - 300 <= verified_auth_time <= now.timestamp() + 30
                )
                if not valid_auth:
                    return {
                        **result,
                        "status": "verification_required",
                        "verificationStartedAt": iso(started),
                    }
                conn.execute(
                    text(
                        "UPDATE wallet_card_access_grants SET verified_at=clock_timestamp() WHERE id=CAST(:id AS uuid)"
                    ),
                    {"id": grant_id},
                )
                self._audit(conn, grant_id, recipient, "verified")
            payload = json.loads(
                self.cipher.open(
                    {**row, "id": grant_id, "conversation_id": recipient, "sender_user_id": owner}
                )
            )
            allowed = {"brand", "last4", "expiryMonth", "expiryYear", "issuingRegion"}
            if not isinstance(payload, dict) or set(payload) != allowed:
                raise WalletCardAccessError("WALLET_CARD_CONTENT_UNAVAILABLE", 503)
            self._audit(conn, grant_id, recipient, "viewed")
            return {**result, "card": {key: payload[key] for key in allowed}}

    def revoke(self, owner, grant_id):
        with self.db.engine.begin() as conn:
            self.require_available(conn)
            lock_connection_graph_users(conn, user_ids=[owner])
            row = one(
                conn,
                """UPDATE wallet_card_access_grants SET revoked_at=COALESCE(revoked_at,clock_timestamp())
 WHERE id=CAST(:id AS uuid) AND owner_user_id=:owner RETURNING id""",
                {"id": grant_id, "owner": owner},
            )
            if not row:
                raise WalletCardAccessError("WALLET_CARD_ACCESS_NOT_FOUND", 404)
            self._audit(conn, grant_id, owner, "revoked")
            return {"revoked": True}
