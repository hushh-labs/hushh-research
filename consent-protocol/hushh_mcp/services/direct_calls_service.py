"""Participant/device-gated durable calling; signaling stays client ciphertext.

No in-process busy registry: account slots and answer CAS share the DB transaction.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import time
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError, IntegrityError

from db.db_client import get_db
from hushh_mcp.services.connection_graph_service import lock_connection_graph_users
from hushh_mcp.services.direct_call_policy import (
    RING_SECONDS,
    TERMINAL_STATES,
    CallError,
    CallSnapshot,
    RelayConfig,
    transition,
)
from hushh_mcp.services.direct_messages_service import DirectMessagesService


def canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def proof_bytes(user: str, operation: str, payload: dict, proof: dict) -> bytes:
    digest = hashlib.sha256(canonical(payload).encode()).hexdigest()
    return canonical(
        [
            "hussh-communications-command-v1",
            user,
            operation,
            proof["deviceId"],
            proof["nonce"],
            proof["expiresAt"],
            digest,
        ]
    ).encode()


def verify_proof(key: str, user: str, operation: str, payload: dict, proof: dict, now: int) -> None:
    if not now < proof["expiresAt"] <= now + 120:
        raise CallError("CALL_PROOF_EXPIRED", "Refresh your device authorization.", 403)
    try:
        public = serialization.load_der_public_key(base64.b64decode(key, validate=True))
        if not isinstance(public, ec.EllipticCurvePublicKey) or not isinstance(
            public.curve, ec.SECP256R1
        ):
            raise ValueError("unsupported signing key")
        public.verify(
            base64.b64decode(proof["signature"], validate=True),
            proof_bytes(user, operation, payload, proof),
            ec.ECDSA(hashes.SHA256()),
        )
    except (ValueError, TypeError, InvalidSignature) as exc:
        raise CallError("CALL_PROOF_INVALID", "This device could not be verified.", 403) from exc


def relay_config() -> RelayConfig:
    return RelayConfig(
        os.getenv("DIRECT_CALLS_TURN_HOST", ""), os.getenv("DIRECT_CALLS_TURN_SECRET", "")
    )


def release_available() -> bool:
    # Separate release attestations: a working TURN host does not qualify the
    # historical-message migration or physical native call lifetime.
    return all(
        os.getenv(key) == "1"
        for key in (
            "DIRECT_CALLS_ENABLED",
            "DIRECT_MESSAGES_E2EE_QUALIFIED",
            "DIRECT_CALLS_NATIVE_QUALIFIED",
        )
    )


class DirectCallsService:
    def __init__(self, db=None):
        self.db = db or get_db()

    @staticmethod
    def capabilities() -> dict:
        available = release_available()
        if available:
            try:
                relay_config()
            except CallError:
                available = False
        return {
            "available": available,
            "relayOnly": True,
            "agentParticipation": False,
            "reason": None if available else "Calling is awaiting release verification.",
        }

    @staticmethod
    def _require_release():
        if not DirectCallsService.capabilities()["available"]:
            raise CallError("CALL_NOT_QUALIFIED", "Calling is awaiting release verification.", 503)

    @staticmethod
    def _one(conn, sql: str, params: dict) -> dict | None:
        row = conn.execute(text(sql), params).mappings().first()
        return dict(row) if row else None

    def _proof(self, conn, user: str, operation: str, payload: dict, proof: dict) -> dict:
        lock_connection_graph_users(conn, user_ids=[user])
        row = self._one(
            conn,
            """SELECT device_public_key FROM trusted_devices
            WHERE device_id=:device AND user_id=:owner AND status='active' FOR UPDATE""",
            {"device": proof["deviceId"], "owner": user},
        )
        if not row:
            raise CallError("CALL_DEVICE_REVOKED", "This device is no longer authorized.", 403)
        verify_proof(row["device_public_key"], user, operation, payload, proof, int(time.time()))
        consumed = self._one(
            conn,
            """INSERT INTO direct_call_commands(nonce, user_id, device_id, expires_at)
            VALUES(CAST(:nonce AS UUID), :owner, :device, to_timestamp(:expires))
            ON CONFLICT DO NOTHING RETURNING nonce""",
            {
                "nonce": proof["nonce"],
                "owner": user,
                "device": proof["deviceId"],
                "expires": proof["expiresAt"],
            },
        )
        if not consumed:
            raise CallError("CALL_PROOF_REPLAYED", "Refresh your device authorization.", 409)
        conn.execute(
            text("""DELETE FROM direct_call_commands WHERE nonce IN
            (SELECT nonce FROM direct_call_commands WHERE expires_at<clock_timestamp()
             ORDER BY expires_at LIMIT 256 FOR UPDATE SKIP LOCKED)""")
        )
        return row

    def _conversation(self, conn, user: str, conversation: str) -> tuple[str, str]:
        row = self._one(
            conn,
            """SELECT participant_a_user_id AS a, participant_b_user_id AS b
            FROM conversations WHERE id=CAST(:id AS UUID) AND :owner IN
            (participant_a_user_id, participant_b_user_id)""",
            {"id": conversation, "owner": user},
        )
        if not row:
            raise CallError("CALL_NOT_FOUND", "Conversation not found.", 404)
        lock_connection_graph_users(conn, user_ids=[row["a"], row["b"]])
        try:
            conn.execute(text("SELECT public.require_active_direct_message_connection(:a,:b)"), row)
        except DBAPIError as exc:
            mapped = DirectMessagesService._connection_gate_error(exc)
            if mapped:
                raise CallError(mapped.code, mapped.message, mapped.status_code) from None
            raise
        return row["a"], row["b"]

    def register_key(self, user: str, payload: dict, proof: dict) -> dict:
        # A new purpose-bound encryption key lives below canonical device trust.
        try:
            public = serialization.load_der_public_key(
                base64.b64decode(payload["publicKey"], validate=True)
            )
            if not isinstance(public, ec.EllipticCurvePublicKey) or not isinstance(
                public.curve, ec.SECP256R1
            ):
                raise ValueError("unsupported encryption key")
        except (ValueError, TypeError) as exc:
            raise CallError(
                "CALL_KEY_INVALID", "Choose a supported device encryption key.", 422
            ) from exc
        with self.db.engine.begin() as conn:
            self._proof(conn, user, "register-key", payload, proof)
            old = self._one(
                conn,
                """SELECT * FROM direct_communication_keys
                WHERE device_id=:device FOR UPDATE""",
                {"device": proof["deviceId"]},
            )
            if old and (
                str(old["key_id"]) != payload["keyId"] or old["public_key"] != payload["publicKey"]
            ):
                # No silent replacement that would strand ciphertext/history.
                raise CallError(
                    "CALL_KEY_RECOVERY_REQUIRED",
                    "Recover this device's communications key before continuing.",
                )
            conn.execute(
                text("""INSERT INTO direct_communication_keys
                (device_id,user_id,key_id,public_key,enrollment_proof)
                VALUES(:device,:owner,CAST(:key AS UUID),:public,CAST(:proof AS JSONB))
                ON CONFLICT(device_id) DO NOTHING"""),
                {
                    "device": proof["deviceId"],
                    "owner": user,
                    "key": payload["keyId"],
                    "public": payload["publicKey"],
                    "proof": canonical({"payload": payload, "proof": proof}),
                },
            )
        return {"registered": True}

    def directory(self, user: str, payload: dict, proof: dict) -> dict:
        with self.db.engine.begin() as conn:
            self._conversation(conn, user, payload["conversationId"])
            self._proof(conn, user, "directory", payload, proof)
            rows = (
                conn.execute(
                    text("""SELECT k.user_id AS "userId", k.device_id AS "deviceId",
                k.key_id AS "keyId",k.public_key AS "publicKey",k.enrollment_proof AS enrollment,
                d.device_public_key AS "signingKey" FROM direct_communication_keys k
                JOIN trusted_devices d ON d.device_id=k.device_id AND d.user_id=k.user_id AND d.status='active'
                JOIN conversations c ON k.user_id IN (c.participant_a_user_id,c.participant_b_user_id)
                WHERE c.id=CAST(:id AS UUID) ORDER BY k.user_id,k.device_id"""),
                    {"id": payload["conversationId"]},
                )
                .mappings()
                .all()
            )
            items = [
                {key: str(value) if key == "keyId" else value for key, value in dict(row).items()}
                for row in rows
            ]
            return {
                "items": items,
                "rosterVersion": hashlib.sha256(canonical(items).encode()).hexdigest(),
            }

    def create(self, user: str, payload: dict, proof: dict) -> dict:
        self._require_release()
        with self.db.engine.begin() as conn:
            conversation_id = payload.get("conversationId")
            if not conversation_id:
                messages = DirectMessagesService(
                    db=self.db, connection=conn, defer_notifications=True
                )
                peer, _ = messages._resolve_recipient(
                    recipient_person_ref=payload["recipientPersonRef"]
                )
                messages._reject_self(user, peer)
                lock_connection_graph_users(conn, user_ids=[user, peer])
                # Same canonical pair/trigger contract as the first message,
                # without manufacturing a text message just to enable a call.
                conversation = self._one(
                    conn,
                    """INSERT INTO conversations(id,participant_a_user_id,participant_b_user_id)
                    VALUES(gen_random_uuid(),LEAST(:owner,:peer),GREATEST(:owner,:peer))
                    ON CONFLICT(participant_a_user_id,participant_b_user_id)
                    DO UPDATE SET participant_a_user_id=EXCLUDED.participant_a_user_id RETURNING id""",
                    {"owner": user, "peer": peer},
                )
                if not conversation:
                    raise CallError("CALL_NOT_FOUND", "Conversation not found.", 404)
                conversation_id = str(conversation["id"])
            a, b = self._conversation(conn, user, conversation_id)
            self._proof(conn, user, "create", payload, proof)
            peer = b if user == a else a
            # Pair/user locks serialize busy admission, account erasure and blocks.
            conn.execute(
                text("""UPDATE direct_calls SET state='expired',revision=revision+1,offers='[]',caller_proof='{}'
                WHERE id IN(SELECT call_id FROM direct_call_slots WHERE user_id IN(:owner,:peer))
                AND expires_at<=clock_timestamp() AND state IN ('preparing','ringing','connecting','active')"""),
                {"owner": user, "peer": peer},
            )
            conn.execute(
                text("""DELETE FROM direct_call_signals WHERE call_id IN
                (SELECT c.id FROM direct_calls c JOIN direct_call_slots s ON s.call_id=c.id
                 WHERE s.user_id IN(:owner,:peer) AND c.state IN ('declined','cancelled','ended','expired'))"""),
                {"owner": user, "peer": peer},
            )
            conn.execute(
                text("""DELETE FROM direct_call_slots WHERE user_id IN(:owner,:peer) AND call_id IN
                (SELECT id FROM direct_calls WHERE state IN ('declined','cancelled','ended','expired'))"""),
                {"owner": user, "peer": peer},
            )
            recipients = (
                conn.execute(
                    text("""SELECT k.device_id,k.key_id FROM direct_communication_keys k
                JOIN trusted_devices d ON d.device_id=k.device_id AND d.user_id=k.user_id
                WHERE k.user_id=:peer AND d.status='active' ORDER BY k.device_id FOR UPDATE OF d"""),
                    {"peer": peer},
                )
                .mappings()
                .all()
            )
            expected = {(r["device_id"], str(r["key_id"])) for r in recipients}
            if not expected or not self._one(
                conn,
                "SELECT 1 FROM direct_communication_keys WHERE device_id=:device",
                {"device": proof["deviceId"]},
            ):
                raise CallError(
                    "CALL_ROSTER_CHANGED", "Both participants need enrolled communications keys."
                )
            row = self._one(
                conn,
                """INSERT INTO direct_calls(id,conversation_id,caller_user_id,callee_user_id,
                caller_device_id,state,revision,expires_at,offers,caller_proof)
                VALUES(CAST(:id AS UUID),CAST(:conversation AS UUID),:owner,:peer,:device,'preparing',0,
                clock_timestamp()+make_interval(secs=>:ring),CAST(:offers AS JSONB),CAST(:proof AS JSONB)) RETURNING *""",
                {
                    "id": payload["callId"],
                    "conversation": conversation_id,
                    "owner": user,
                    "peer": peer,
                    "device": proof["deviceId"],
                    "ring": RING_SECONDS,
                    "offers": "[]",
                    "proof": "{}",
                },
            )
            try:
                conn.execute(
                    text("""INSERT INTO direct_call_slots(user_id,call_id)
                    VALUES(:owner,CAST(:call AS UUID)),(:peer,CAST(:call AS UUID))"""),
                    {"owner": user, "peer": peer, "call": payload["callId"]},
                )
            except IntegrityError as exc:
                raise CallError("CALL_BUSY", "One participant is already in a call.") from exc
            return self._project(row, user)

    def offer(self, user: str, payload: dict, proof: dict) -> dict:
        self._require_release()
        self._validate_envelopes(payload["offers"])
        with self.db.engine.begin() as conn:
            row = self._call(conn, user, payload["callId"])
            self._proof(conn, user, "offer", payload, proof)
            call = self._snapshot(row)
            if (
                user != call.caller
                or proof["deviceId"] != call.caller_device
                or call.state != "preparing"
                or int(time.time()) >= call.expires_at
            ):
                raise CallError("CALL_ACTION_INVALID", "This call can no longer ring.")
            devices = (
                conn.execute(
                    text("""SELECT k.device_id,k.key_id FROM direct_communication_keys k
                JOIN trusted_devices d ON d.device_id=k.device_id AND d.user_id=k.user_id AND d.status='active'
                WHERE k.user_id=:peer ORDER BY k.device_id FOR UPDATE OF d"""),
                    {"peer": call.callee},
                )
                .mappings()
                .all()
            )
            expected = {(device["device_id"], str(device["key_id"])) for device in devices}
            supplied = {(offer["deviceId"], offer["keyId"]) for offer in payload["offers"]}
            if not expected or expected != supplied or len(supplied) != len(payload["offers"]):
                raise CallError("CALL_ROSTER_CHANGED", "The recipient devices changed.")
            row = self._one(
                conn,
                """UPDATE direct_calls SET state='ringing',revision=revision+1,
                offers=CAST(:offers AS JSONB),caller_proof=CAST(:proof AS JSONB)
                WHERE id=CAST(:id AS UUID) RETURNING *""",
                {
                    "id": call.id,
                    "offers": canonical(payload["offers"]),
                    "proof": canonical({"payload": payload, "proof": proof}),
                },
            )
            return self._project(row, user)

    @staticmethod
    def _validate_envelopes(envelopes: list) -> None:
        if not 1 <= len(envelopes) <= 20 or len(canonical(envelopes).encode()) > 512_000:
            raise CallError("CALL_SIGNAL_INVALID", "Call signaling is too large.", 422)

    def _call(self, conn, user: str, call_id: str, *, allow_finished=False) -> dict:
        row = self._one(
            conn,
            """SELECT c.*,p.display_name AS peer_display_name FROM direct_calls c
            LEFT JOIN actor_identity_cache p ON p.user_id=CASE WHEN c.caller_user_id=:owner THEN c.callee_user_id ELSE c.caller_user_id END
            WHERE c.id=CAST(:id AS UUID) AND :owner IN(c.caller_user_id,c.callee_user_id)""",
            {"id": call_id, "owner": user},
        )
        if not row:
            raise CallError("CALL_NOT_FOUND", "Call not found.", 404)
        peer_name = row.get("peer_display_name")
        # Same lock order as create: graph, relationship, call, then device.
        if allow_finished:
            lock_connection_graph_users(
                conn, user_ids=[row["caller_user_id"], row["callee_user_id"]]
            )
        else:
            self._conversation(conn, user, str(row["conversation_id"]))
        row = self._one(
            conn,
            "SELECT * FROM direct_calls WHERE id=CAST(:id AS UUID) FOR UPDATE",
            {"id": call_id},
        )
        if not row:
            raise CallError("CALL_NOT_FOUND", "Call not found.", 404)
        row["peer_display_name"] = peer_name
        return row

    @staticmethod
    def _snapshot(row) -> CallSnapshot:
        return CallSnapshot(
            str(row["id"]),
            str(row["conversation_id"]),
            row["caller_user_id"],
            row["callee_user_id"],
            row["caller_device_id"],
            row["callee_device_id"],
            row["state"],
            row["revision"],
            int(row["expires_at"].timestamp()),
            row["caller_connected"],
            row["callee_connected"],
        )

    def _project(self, row, user: str) -> dict:
        call = self._snapshot(row)
        return {
            "id": call.id,
            "conversationId": call.conversation_id,
            "state": call.state,
            "revision": call.revision,
            "expiresAt": call.expires_at,
            "isCaller": user == call.caller,
            "callerDeviceId": call.caller_device,
            "calleeDeviceId": call.callee_device,
            "peerDisplayName": row.get("peer_display_name"),
        }

    def read(self, user: str, payload: dict, proof: dict) -> dict:
        self._require_release()
        with self.db.engine.begin() as conn:
            row = self._call(conn, user, payload["callId"])
            self._proof(conn, user, "read", payload, proof)
            call = self._snapshot(row)
            if (
                user == call.caller
                and proof["deviceId"] != call.caller_device
                or user == call.callee
                and call.callee_device
                and proof["deviceId"] != call.callee_device
            ):
                raise CallError("CALL_DEVICE_MISMATCH", "This call belongs to another device.", 403)
            # Revoke either endpoint => stop delivery/credentials immediately.
            self._endpoints_active(conn, call)
            offers = [offer for offer in row["offers"] if offer["deviceId"] == proof["deviceId"]]
            signals = (
                conn.execute(
                    text("""SELECT sequence,sender_device_id AS "senderDeviceId",envelope,proof
                FROM direct_call_signals WHERE call_id=CAST(:id AS UUID) AND sequence>:after
                AND sender_device_id<>:device ORDER BY sequence LIMIT 100"""),
                    {"id": call.id, "after": payload.get("after", 0), "device": proof["deviceId"]},
                )
                .mappings()
                .all()
            )
            return {
                **self._project(row, user),
                "offers": offers,
                "offerProof": row["caller_proof"],
                "signals": [dict(signal) for signal in signals],
            }

    def inbox(self, user: str, payload: dict, proof: dict) -> dict:
        self._require_release()
        with self.db.engine.begin() as conn:
            self._proof(conn, user, "inbox", payload, proof)
            rows = (
                conn.execute(
                    text("""SELECT c.*,p.display_name AS peer_display_name FROM direct_calls c
                LEFT JOIN actor_identity_cache p ON p.user_id=CASE WHEN c.caller_user_id=:owner THEN c.callee_user_id ELSE c.caller_user_id END
                JOIN conversations v ON v.id=c.conversation_id
                JOIN connections edge ON edge.user_a_id=v.participant_a_user_id AND edge.user_b_id=v.participant_b_user_id
                WHERE :owner IN(c.caller_user_id,c.callee_user_id) AND edge.status='active'
                AND c.state IN ('ringing','connecting','active') AND c.expires_at>clock_timestamp()
                AND NOT EXISTS(SELECT 1 FROM direct_message_blocks b WHERE
                  (b.blocker_user_id=c.caller_user_id AND b.blocked_user_id=c.callee_user_id)
                  OR (b.blocker_user_id=c.callee_user_id AND b.blocked_user_id=c.caller_user_id))
                AND (c.caller_user_id<>:owner OR c.caller_device_id=:device)
                AND (c.callee_user_id<>:owner OR c.callee_device_id IS NULL OR c.callee_device_id=:device)
                ORDER BY c.created_at DESC LIMIT 1"""),
                    {"owner": user, "device": proof["deviceId"]},
                )
                .mappings()
                .all()
            )
            return {"items": [self._project(dict(row), user) for row in rows]}

    @staticmethod
    def _endpoints_active(conn, call):
        for owner, device in ((call.caller, call.caller_device), (call.callee, call.callee_device)):
            if (
                device
                and not conn.execute(
                    text("""SELECT 1 FROM trusted_devices
                WHERE user_id=:owner AND device_id=:device AND status='active' FOR UPDATE"""),
                    {"owner": owner, "device": device},
                ).first()
            ):
                raise CallError(
                    "CALL_DEVICE_REVOKED", "A call device is no longer authorized.", 403
                )

    def action(self, user: str, payload: dict, proof: dict) -> dict:
        self._require_release()
        with self.db.engine.begin() as conn:
            row = self._call(
                conn, user, payload["callId"], allow_finished=payload["action"] == "end"
            )
            self._proof(conn, user, "action", payload, proof)
            call = self._snapshot(row)
            if payload["action"] != "end":
                self._endpoints_active(conn, call)
            state, device, expiry = transition(
                call,
                actor=user,
                device=proof["deviceId"],
                action=payload["action"],
                revision=payload["revision"],
                now=int(time.time()),
            )
            row = self._one(
                conn,
                """UPDATE direct_calls SET state=:state,callee_device_id=:device,
                caller_connected=caller_connected OR :caller_connected,
                callee_connected=callee_connected OR :callee_connected,
                expires_at=to_timestamp(:expiry),revision=revision+1 WHERE id=CAST(:id AS UUID) RETURNING *""",
                {
                    "state": state,
                    "device": device,
                    "expiry": expiry,
                    "id": call.id,
                    "caller_connected": payload["action"] == "connected" and user == call.caller,
                    "callee_connected": payload["action"] == "connected" and user == call.callee,
                },
            )
            if state in TERMINAL_STATES:
                conn.execute(
                    text("DELETE FROM direct_call_slots WHERE call_id=CAST(:id AS UUID)"),
                    {"id": call.id},
                )
                conn.execute(
                    text("DELETE FROM direct_call_signals WHERE call_id=CAST(:id AS UUID)"),
                    {"id": call.id},
                )
                conn.execute(
                    text(
                        "UPDATE direct_calls SET offers='[]',caller_proof='{}' WHERE id=CAST(:id AS UUID)"
                    ),
                    {"id": call.id},
                )
            return self._project(row, user)

    def signal(self, user: str, payload: dict, proof: dict) -> dict:
        self._require_release()
        with self.db.engine.begin() as conn:
            row = self._call(conn, user, payload["callId"])
            self._proof(conn, user, "signal", payload, proof)
            call = self._snapshot(row)
            self._endpoints_active(conn, call)
            if call.state not in {"connecting", "active"} or int(time.time()) >= call.expires_at:
                raise CallError("CALL_NOT_CONNECTED", "This call cannot receive signaling.")
            device = call.caller_device if user == call.caller else call.callee_device
            if device != proof["deviceId"]:
                raise CallError("CALL_DEVICE_MISMATCH", "Use the device in this call.", 403)
            target = call.callee_device if user == call.caller else call.caller_device
            key = self._one(
                conn,
                "SELECT key_id FROM direct_communication_keys WHERE device_id=:device",
                {"device": target},
            )
            if (
                not key
                or payload["envelope"]["deviceId"] != target
                or payload["envelope"]["keyId"] != str(key["key_id"])
            ):
                raise CallError("CALL_ROSTER_CHANGED", "The call recipient changed.")
            prior = conn.execute(
                text("""SELECT COALESCE(MAX(sender_sequence),0) FROM direct_call_signals
                WHERE call_id=CAST(:id AS UUID) AND sender_device_id=:device"""),
                {"id": call.id, "device": device},
            ).scalar_one()
            if payload["sequence"] != prior + 1 or prior >= 100:
                raise CallError("CALL_SIGNAL_SEQUENCE", "Call signaling sequence changed.")
            conn.execute(
                text("""INSERT INTO direct_call_signals(call_id,sender_device_id,sender_sequence,envelope,proof)
                VALUES(CAST(:id AS UUID),:device,:seq,CAST(:envelope AS JSONB),CAST(:proof AS JSONB))"""),
                {
                    "id": call.id,
                    "device": device,
                    "seq": payload["sequence"],
                    "envelope": canonical(payload["envelope"]),
                    "proof": canonical({"payload": payload, "proof": proof}),
                },
            )
        return {"accepted": True}

    def credentials(self, user: str, payload: dict, proof: dict) -> dict:
        self._require_release()
        with self.db.engine.begin() as conn:
            row = self._call(conn, user, payload["callId"])
            self._proof(conn, user, "credentials", payload, proof)
            call = self._snapshot(row)
            self._endpoints_active(conn, call)
            device = call.caller_device if user == call.caller else call.callee_device
            if device != proof["deviceId"] or call.state in TERMINAL_STATES:
                raise CallError("CALL_DEVICE_MISMATCH", "Use the device in this call.", 403)
            if int(time.time()) >= call.expires_at:
                raise CallError("CALL_EXPIRED", "This call has expired.")
            # Allocation admission lasts at most this call's absolute lifetime;
            # it never reveals the relay's deployment secret to a client.
            from hushh_mcp.services.direct_call_policy import CALL_SECONDS

            deadline = int(row["created_at"].timestamp()) + CALL_SECONDS
            return relay_config().credentials(
                call_id=call.id, device_id=device, now=int(time.time()), expires_at=deadline
            )
