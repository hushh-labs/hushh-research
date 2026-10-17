"""Eligible owner Wallet access; full numbers remain recipient-encrypted.

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
from hushh_mcp.services.wallet_card_access_envelope import validate_recipient_card
from hushh_mcp.services.wallet_card_access_projection import (
    WalletCardSourceCipher,
    masked_card_projection,
)
from hushh_mcp.services.wallet_sharing_sources import (
    PAYMENT,
    PROFILE,
    locate_source,
    profile_projection,
    source_for_card,
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
        if not self.flag_enabled():
            raise WalletCardAccessError("WALLET_CARD_ACCESS_DISABLED", 503)
        if not self.available(conn):
            raise WalletCardAccessError("WALLET_CARD_ACCESS_NOT_READY", 503)

    @staticmethod
    def _universal_installed(conn):
        return bool(
            conn.execute(
                text("SELECT to_regclass('public.wallet_profile_access_grants') IS NOT NULL")
            ).scalar_one()
        )

    def history(self, viewer, **options):
        from hushh_mcp.services.wallet_sharing_history import history

        return history(self, viewer, **options)

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
    def _audit(conn, grant_id, actor, event, source=PAYMENT):
        key = (
            "COALESCE(grant_id,profile_grant_id)"
            if WalletCardAccessService._universal_installed(conn)
            else "grant_id"
        )
        conn.execute(
            text(
                (
                    # Only fixed sharing-source identifiers/fragments; request values are bound.
                    f"INSERT INTO wallet_card_access_audit({source.audit_key},actor_user_id,event_type)\n"  # nosec B608
                    f" SELECT CAST(:id AS uuid),:actor,:event WHERE NOT EXISTS(SELECT 1 FROM wallet_card_access_audit\n"
                    f" WHERE {key}=CAST(:id AS uuid) AND actor_user_id=:actor AND event_type=:event)"
                )
            ),
            {"id": grant_id, "actor": actor, "event": event},
        )

    def _source_card(self, conn, owner, card_id, source, *, lock=False):
        if source == PAYMENT:
            if lock:
                self._registration_lock(conn, owner, card_id)
            return self._card(conn, owner, card_id)
        if not self._universal_installed(conn):
            raise WalletCardAccessError("WALLET_CARD_ACCESS_UNAVAILABLE", 503)
        card = profile_projection(conn, owner, card_id, lock=lock)
        if card is None:
            raise WalletCardAccessError("WALLET_CARD_INELIGIBLE")
        return card

    def profile_access(self, owner):
        with self.db.engine.begin() as conn:
            self.require_available(conn)
            if not self._universal_installed(conn):
                return {"eligible": False, "cardId": None}
            row = one(
                conn,
                "SELECT 'profile_'||pass_serial::text AS card_id FROM one_wallet_cards WHERE user_id=:owner",
                {"owner": owner},
            )
            if not row or profile_projection(conn, owner, row["card_id"]) is None:
                return {"eligible": False, "cardId": None}
            return {"eligible": True, "cardId": row["card_id"]}

    @staticmethod
    def _expire(conn, row, source):
        # The grant row lock makes lazy expiry logging idempotent across instances.
        if row["revoked_at"] or row["expires_at"] > row["server_now"]:
            return
        if not WalletCardAccessService._universal_installed(conn):
            return
        conn.execute(
            # Only fixed sharing-source identifiers/fragments; request values are bound.
            text(
                (
                    f"INSERT INTO wallet_card_access_audit({source.audit_key},actor_user_id,event_type,created_at)\n"  # nosec B608
                    f" SELECT CAST(:id AS uuid),:owner,'expired',:expires WHERE NOT EXISTS(\n"
                    f" SELECT 1 FROM wallet_card_access_audit WHERE COALESCE(grant_id,profile_grant_id)=CAST(:id AS uuid) AND event_type='expired')"
                )
            ),
            {"id": str(row["id"]), "owner": row["owner_user_id"], "expires": row["expires_at"]},
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

    def _owner_grants(self, conn, owner, card_id, cursor=None):
        source = source_for_card(card_id)
        values = {"owner": owner, "card": card_id, "limit": 21}
        # Only fixed sharing-source identifiers/fragments; request values are bound.
        query = (
            f"SELECT g.id,g.created_at,g.expires_at,g.revoked_at,a.display_name,clock_timestamp() AS server_now\n"  # nosec B608
            f" FROM {source.grants} g LEFT JOIN actor_identity_cache a ON a.user_id=g.recipient_user_id\n"
            f" WHERE g.owner_user_id=:owner AND g.card_id=:card\n"
            f" ORDER BY g.created_at DESC,g.id ASC LIMIT :limit"
        )
        if cursor is not None:
            try:
                grant_id = str(uuid.UUID(cursor))
            except (ValueError, AttributeError):
                raise WalletCardAccessError("WALLET_CARD_REQUEST_INVALID", 422) from None
            anchor = one(
                conn,
                # Only fixed sharing-source identifiers/fragments; request values are bound.
                (
                    f"SELECT created_at FROM {source.grants}\n"  # nosec B608
                    f" WHERE owner_user_id=:owner AND card_id=:card AND id=CAST(:grant_id AS uuid)"
                ),
                {"owner": owner, "card": card_id, "grant_id": grant_id},
            )
            if not anchor:
                raise WalletCardAccessError("WALLET_CARD_REQUEST_INVALID", 422)
            values.update(created=anchor["created_at"], grant_id=grant_id)
            # Only fixed sharing-source identifiers/fragments; request values are bound.
            query = (
                f"SELECT g.id,g.created_at,g.expires_at,g.revoked_at,a.display_name,clock_timestamp() AS server_now\n"  # nosec B608
                f" FROM {source.grants} g LEFT JOIN actor_identity_cache a ON a.user_id=g.recipient_user_id\n"
                f" WHERE g.owner_user_id=:owner AND g.card_id=:card\n"
                f" AND (g.created_at < :created OR (g.created_at=:created AND g.id>CAST(:grant_id AS uuid)))\n"
                f" ORDER BY g.created_at DESC,g.id ASC LIMIT :limit"
            )
        rows = many(
            conn,
            query,
            values,
        )
        page = rows[:20]
        more = len(rows) > 20
        return {
            "grants": [
                {
                    "id": str(r["id"]),
                    "recipientName": r.get("display_name") or "A connection",
                    "createdAt": iso(r["created_at"]),
                    "expiresAt": iso(r["expires_at"]),
                    "status": self._grant_status(r, r["server_now"]),
                }
                for r in page
            ],
            "hasMore": more,
            "nextCursor": str(page[-1]["id"]) if more else None,
        }

    def card_access(self, owner, card_id, cursor=None):
        with self.db.engine.begin() as conn:
            self.require_available(conn)
            try:
                self._source_card(conn, owner, card_id, source_for_card(card_id))
            except WalletCardAccessError:
                return {
                    "eligible": False,
                    "reason": "card_not_ready",
                    "grants": [],
                    "hasMore": False,
                    "nextCursor": None,
                }
            return {"eligible": True, **self._owner_grants(conn, owner, card_id, cursor)}

    def connections(self, owner, query=""):
        with self.db.engine.begin() as conn:
            # Recipient discovery reads the owner's existing connection graph,
            # not card grants. Grant rollout state must not break this list;
            # create_grants still enforces availability before granting access.
            rows = many(
                conn,
                """SELECT p.public_person_ref,a.display_name,
 COALESCE(NULLIF(a.custom_photo_url,''),a.photo_url) AS photo_url,
 EXISTS(SELECT 1 FROM one_location_circles tc JOIN one_location_circle_memberships tm ON tm.circle_id=tc.id
 WHERE tc.owner_user_id=:owner AND tc.system_kind='trusted' AND tc.status='active' AND tm.user_id=p.user_id AND tm.status='active'
 AND tm.metadata @> jsonb_build_object('addedVia','direct_add','addedBy',tc.owner_user_id)) AS trusted
 FROM connections c JOIN actor_profiles p ON p.user_id=CASE WHEN c.user_a_id=:owner THEN c.user_b_id ELSE c.user_a_id END
 LEFT JOIN actor_identity_cache a ON a.user_id=p.user_id
 WHERE c.status='active' AND :owner IN(c.user_a_id,c.user_b_id) AND p.public_person_ref IS NOT NULL
 AND (:query='' OR COALESCE(a.display_name,'') ILIKE '%'||:query||'%')
 AND NOT EXISTS(SELECT 1 FROM direct_message_blocks b WHERE (b.blocker_user_id=:owner AND b.blocked_user_id=p.user_id) OR (b.blocker_user_id=p.user_id AND b.blocked_user_id=:owner))
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

    def _request_grants(self, conn, owner, request_id, source=PAYMENT):
        rows = many(
            conn,
            # Only fixed sharing-source identifiers/fragments; request values are bound.
            (
                f"SELECT g.id,g.created_at,g.expires_at,g.revoked_at,a.display_name,clock_timestamp() AS server_now\n"  # nosec B608
                f" FROM {source.grants} g LEFT JOIN actor_identity_cache a ON a.user_id=g.recipient_user_id\n"
                f" WHERE g.owner_user_id=:owner AND g.request_id=CAST(:request AS uuid) ORDER BY g.id"
            ),
            {"owner": owner, "request": request_id},
        )
        return [
            {
                "id": str(r["id"]),
                "recipientName": r.get("display_name") or "A connection",
                "createdAt": iso(r["created_at"]),
                "expiresAt": iso(r["expires_at"]),
                "status": self._grant_status(r, r["server_now"]),
            }
            for r in rows
        ]

    def create_grants(
        self,
        owner,
        card_id,
        request_id,
        person_refs,
        duration_minutes,
        *,
        encrypted_cards=None,
        card_request_id=None,
    ):
        source = source_for_card(card_id)
        refs = sorted({str(uuid.UUID(str(ref))) for ref in person_refs})
        if duration_minutes not in (5, 10, 15, 60, 120) or not refs or len(refs) > 20:
            raise WalletCardAccessError("WALLET_CARD_SHARE_INVALID", 422)
        if encrypted_cards is not None:
            try:
                if set(encrypted_cards) != set(refs):
                    raise ValueError("recipient mismatch")
                for content in encrypted_cards.values():
                    validate_recipient_card(content, card_id)
            except (ValueError, TypeError, KeyError, AttributeError):
                raise WalletCardAccessError("WALLET_CARD_SHARE_INVALID", 422) from None
        fingerprint = hashlib.sha256(
            json.dumps(
                [card_id, refs, duration_minutes]
                + (["recipient-encrypted-v1"] if encrypted_cards is not None else [])
                + (["card-request-v1", card_request_id] if card_request_id else []),
                separators=(",", ":"),
            ).encode()
        ).hexdigest()
        with self.db.engine.begin() as conn:
            self.require_available(conn)
            universal = self._universal_installed(conn)
            conn.execute(
                text("SELECT pg_advisory_xact_lock(hashtextextended(:key,0))"),
                {"key": "wallet-share:" + owner + ":" + request_id},
            )
            if one(
                conn, "SELECT to_regclass('public.wallet_profile_share_requests') IS NOT NULL AS ok"
            )["ok"]:
                other = PROFILE if source == PAYMENT else PAYMENT
                if one(
                    conn,
                    # Only fixed sharing-source identifiers/fragments; request values are bound.
                    f"SELECT 1 FROM {other.requests} WHERE owner_user_id=:owner AND request_id=CAST(:request AS uuid)",  # nosec B608
                    {"owner": owner, "request": request_id},
                ):
                    raise WalletCardAccessError("WALLET_CARD_RETRY_CONFLICT", 409)
            previous = one(
                conn,
                # Only fixed sharing-source identifiers/fragments; request values are bound.
                f"SELECT fingerprint FROM {source.requests} WHERE owner_user_id=:owner AND request_id=CAST(:request AS uuid)",  # nosec B608
                {"owner": owner, "request": request_id},
            )
            if previous:
                if previous["fingerprint"] != fingerprint:
                    raise WalletCardAccessError("WALLET_CARD_RETRY_CONFLICT", 409)
                return {"grants": self._request_grants(conn, owner, request_id, source)}
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
            if card_request_id:
                from hushh_mcp.services.wallet_card_request_service import lock_card_request

                if len(recipients) != 1:
                    raise WalletCardAccessError("WALLET_CARD_SHARE_INVALID", 422)
                lock_card_request(conn, owner, card_request_id, recipients[0]["user_id"])
            card = self._source_card(conn, owner, card_id, source, lock=True)
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
                # Only fixed sharing-source identifiers/fragments; request values are bound.
                (
                    f"INSERT INTO {source.requests}(owner_user_id,request_id,card_id,fingerprint,created_at,expires_at,duration_minutes)\n"  # nosec B608
                    f" VALUES(:owner,CAST(:request AS uuid),:card,:fingerprint,:created,:created+(:minutes*interval '1 minute'),:minutes)\n"
                    f" RETURNING created_at,expires_at"
                ),
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
                contents = dict(card)
                if encrypted_cards is not None:
                    ref = next(
                        str(r["public_person_ref"]) for r in recipients if r["user_id"] == recipient
                    )
                    contents["encryptedCard"] = encrypted_cards[ref]
                envelope = (
                    self.cipher.seal(
                        json.dumps(contents, separators=(",", ":")),
                        conversation_id=recipient,
                        message_id=grant_id,
                        sender_user_id=owner,
                    )
                    if source == PAYMENT
                    else {}
                )
                dm.send_message(
                    owner,
                    recipient_user_id=recipient,
                    content=f"[wallet-access:{grant_id}]",
                    client_message_id=message_id,
                )
                columns = (
                    "content_ciphertext,content_iv,content_algorithm"
                    if source == PAYMENT
                    else "permitted_fields"
                )
                values = (
                    ":content_ciphertext,:content_iv,:content_algorithm"
                    if source == PAYMENT
                    else "CAST(:fields AS text[])"
                )
                trust_column = ",trusted_at_creation" if universal else ""
                trust_value = ",:trusted" if universal else ""
                conn.execute(
                    # Only fixed sharing-source identifiers/fragments; request values are bound.
                    text(
                        (
                            f"INSERT INTO {source.grants}\n"  # nosec B608
                            f" (id,owner_user_id,recipient_user_id,request_id,card_id,message_id,created_at,expires_at,verification_required{trust_column},{columns})\n"
                            f" VALUES(CAST(:id AS uuid),:owner,:recipient,CAST(:request AS uuid),:card,CAST(:message AS uuid),:created,:expires,:verification{trust_value},{values})"
                        )
                    ),
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
                        "trusted": not verification_required,
                        "fields": sorted(card),
                        **envelope,
                    },
                )
                self._audit(conn, grant_id, owner, "created", source)
                # Delivered means accepted by transactional Messages/Feed/outbox, not a push receipt.
                if universal:
                    self._audit(conn, grant_id, owner, "delivered", source)
            if card_request_id:
                from hushh_mcp.services.wallet_card_request_service import resolve_request_feed

                conn.execute(
                    text(
                        "UPDATE wallet_card_requests SET status='fulfilled',resolved_at=clock_timestamp(),"
                        "payment_grant_id=CASE WHEN :payment THEN CAST(:grant AS uuid) ELSE NULL END,"
                        "profile_grant_id=CASE WHEN :payment THEN NULL ELSE CAST(:grant AS uuid) END "
                        "WHERE id=CAST(:id AS uuid)"
                    ),
                    {"id": card_request_id, "grant": grant_id, "payment": source == PAYMENT},
                )
                resolve_request_feed(conn, card_request_id)
            return {"grants": self._request_grants(conn, owner, request_id, source)}

    def view_grant(self, recipient, grant_id, *, verified_auth_time=None):
        with self.db.engine.begin() as conn:
            self.require_available(conn)
            universal = self._universal_installed(conn)
            source = locate_source(conn, grant_id)
            locator = one(
                conn,
                # Only fixed sharing-source identifiers/fragments; request values are bound.
                f"SELECT owner_user_id,card_id FROM {source.grants} WHERE id=CAST(:id AS uuid) AND recipient_user_id=:recipient",  # nosec B608
                {"id": grant_id, "recipient": recipient},
            )
            if not locator:
                raise WalletCardAccessError("WALLET_CARD_ACCESS_NOT_FOUND", 404)
            owner = locator["owner_user_id"]
            lock_connection_graph_users(conn, user_ids=[owner, recipient])
            if source == PAYMENT:
                self._registration_lock(conn, owner, locator["card_id"], require_active=False)
            else:
                # Lock source before grant: same ordering as Profile revoke/delete.
                one(
                    conn,
                    "SELECT user_id FROM one_wallet_cards WHERE user_id=:owner FOR SHARE",
                    {"owner": owner},
                )
            row = one(
                conn,
                # Only fixed sharing-source identifiers/fragments; request values are bound.
                (
                    f"SELECT g.*,a.display_name AS sender_name,clock_timestamp() AS server_now\n"  # nosec B608
                    f" FROM {source.grants} g LEFT JOIN actor_identity_cache a ON a.user_id=g.owner_user_id\n"
                    f" WHERE g.id=CAST(:id AS uuid) AND g.recipient_user_id=:recipient FOR UPDATE OF g"
                ),
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
            self._expire(conn, {**row, "server_now": now}, source)
            if result["status"] != "active":
                self._audit(conn, grant_id, recipient, "denied", source)
                return result
            try:
                self._source_card(conn, owner, row["card_id"], source)
            except WalletCardAccessError:
                if source == PROFILE:
                    self._audit(conn, grant_id, recipient, "denied", source)
                    return {**result, "status": "unavailable"}
                conn.execute(
                    text(
                        # Only fixed sharing-source identifiers/fragments; request values are bound.
                        f"UPDATE {source.grants} SET revoked_at=clock_timestamp() WHERE id=CAST(:id AS uuid)"  # nosec B608
                    ),
                    {"id": grant_id},
                )
                self._audit(conn, grant_id, recipient, "denied", source)
                return {**result, "status": "revoked"}
            dm = DirectMessagesService(db=self.db, connection=conn, defer_notifications=True)
            try:
                dm.require_active_connection(owner, recipient)
            except Exception:
                self._audit(conn, grant_id, recipient, "denied", source)
                return {**result, "status": "unavailable"}
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
                        # Only fixed sharing-source identifiers/fragments; request values are bound.
                        (
                            f"UPDATE {source.grants} SET verification_required=true,\n"  # nosec B608
                            f" verification_started_at=clock_timestamp() WHERE id=CAST(:id AS uuid) RETURNING verification_started_at"
                        ),
                        {"id": grant_id},
                    )["verification_started_at"]
                if universal and verified_auth_time is not None:
                    # Shared Postgres attempt window; this seam can move to Redis.
                    attempted = row.get("verification_attempted_at")
                    count = (
                        (row.get("verification_attempts") or 0)
                        if attempted and (now - attempted).total_seconds() < 300
                        else 0
                    )
                    if count >= 5:
                        return {
                            **result,
                            "status": "verification_required",
                            "verificationStartedAt": iso(started),
                        }
                    conn.execute(
                        text(
                            # Only fixed sharing-source identifiers/fragments; request values are bound.
                            f"UPDATE {source.grants} SET verification_attempts=:count,verification_attempted_at=:attempted WHERE id=CAST(:id AS uuid)"  # nosec B608
                        ),
                        {
                            "count": count + 1,
                            "attempted": attempted if count else now,
                            "id": grant_id,
                        },
                    )
                valid_auth = (
                    isinstance(verified_auth_time, (int, float))
                    and not isinstance(verified_auth_time, bool)
                    and verified_auth_time >= started.timestamp()
                    and now.timestamp() - 300 <= verified_auth_time <= now.timestamp() + 30
                )
                if not valid_auth:
                    if verified_auth_time is not None:
                        self._audit(conn, grant_id, recipient, "denied", source)
                    return {
                        **result,
                        "status": "verification_required",
                        "verificationStartedAt": iso(started),
                    }
                conn.execute(
                    text(
                        # Only fixed sharing-source identifiers/fragments; request values are bound.
                        f"UPDATE {source.grants} SET verified_at=clock_timestamp() WHERE id=CAST(:id AS uuid)"  # nosec B608
                    ),
                    {"id": grant_id},
                )
                self._audit(conn, grant_id, recipient, "verified", source)
            if source == PROFILE:
                payload = self._source_card(conn, owner, row["card_id"], source)
                payload = {key: payload[key] for key in row["permitted_fields"] if key in payload}
                contents = {"profileCard": payload, "cardType": "profile"}
            else:
                payload = json.loads(
                    self.cipher.open(
                        {
                            **row,
                            "id": grant_id,
                            "conversation_id": recipient,
                            "sender_user_id": owner,
                        }
                    )
                )
                allowed = {"brand", "last4", "expiryMonth", "expiryYear", "issuingRegion"}
                if not isinstance(payload, dict) or set(payload) not in (
                    allowed,
                    allowed | {"encryptedCard"},
                ):
                    raise WalletCardAccessError("WALLET_CARD_CONTENT_UNAVAILABLE", 503)
                encrypted = {}
                if "encryptedCard" in payload:
                    try:
                        validate_recipient_card(payload["encryptedCard"], row["card_id"])
                    except (ValueError, TypeError, KeyError, AttributeError):
                        raise WalletCardAccessError(
                            "WALLET_CARD_CONTENT_UNAVAILABLE", 503
                        ) from None
                    encrypted = {"encryptedCard": payload["encryptedCard"], "senderUserId": owner}
                contents = {
                    "card": {key: payload[key] for key in allowed},
                    "cardType": "payment",
                    **encrypted,
                }
            final_now = one(conn, "SELECT clock_timestamp() AS now")["now"]
            if row["expires_at"] <= final_now:
                self._expire(conn, {**row, "server_now": final_now}, source)
                return {**result, "status": "expired", "serverNow": iso(final_now)}
            if row.get("last_accessed_at") is None:
                self._audit(conn, grant_id, recipient, "viewed", source)
            if universal:
                conn.execute(
                    text(
                        # Only fixed sharing-source identifiers/fragments; request values are bound.
                        f"UPDATE {source.grants} SET last_accessed_at=clock_timestamp() WHERE id=CAST(:id AS uuid)"  # nosec B608
                    ),
                    {"id": grant_id},
                )
            return {**result, **contents}

    def revoke(self, owner, grant_id):
        with self.db.engine.begin() as conn:
            self.require_available(conn)
            source = locate_source(conn, grant_id)
            grant = one(
                conn,
                # Only fixed sharing-source identifiers/fragments; request values are bound.
                f"SELECT recipient_user_id FROM {source.grants} WHERE id=CAST(:id AS uuid) AND owner_user_id=:owner",  # nosec B608
                {"id": grant_id, "owner": owner},
            )
            if not grant:
                raise WalletCardAccessError("WALLET_CARD_ACCESS_NOT_FOUND", 404)
            lock_connection_graph_users(conn, user_ids=[owner, grant["recipient_user_id"]])
            row = one(
                conn,
                # Only fixed sharing-source identifiers/fragments; request values are bound.
                (
                    f"UPDATE {source.grants} SET revoked_at=COALESCE(revoked_at,clock_timestamp())\n"  # nosec B608
                    f" WHERE id=CAST(:id AS uuid) AND owner_user_id=:owner RETURNING id"
                ),
                {"id": grant_id, "owner": owner},
            )
            if not row:
                raise WalletCardAccessError("WALLET_CARD_ACCESS_NOT_FOUND", 404)
            if not self._universal_installed(conn):
                self._audit(conn, grant_id, owner, "revoked", source)
            return {"revoked": True}
