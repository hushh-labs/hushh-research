"""Single transaction-bound authority for calling proofs, participants and locks."""

from __future__ import annotations

import base64
import hashlib
import json
import time
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from hushh_mcp.services.connection_graph_service import lock_connection_graph_users
from hushh_mcp.services.direct_call_policy import CallError, CallSnapshot
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


class CallAuthority:
    def __init__(self, conn):
        self.conn = conn

    def one(self, sql: str, params: dict) -> dict | None:
        row = self.conn.execute(text(sql), params).mappings().first()
        return dict(row) if row else None

    def proof(self, user: str, operation: str, payload: dict, proof: dict) -> dict:
        lock_connection_graph_users(self.conn, user_ids=[user])
        row = self.one(
            """SELECT device_public_key FROM trusted_devices
            WHERE device_id=:device AND user_id=:owner AND status='active' FOR UPDATE""",
            {"device": proof["deviceId"], "owner": user},
        )
        if not row:
            raise CallError("CALL_DEVICE_REVOKED", "This device is no longer authorized.", 403)
        verify_proof(row["device_public_key"], user, operation, payload, proof, int(time.time()))
        consumed = self.one(
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
        self.conn.execute(
            text("""DELETE FROM direct_call_commands WHERE nonce IN
            (SELECT nonce FROM direct_call_commands WHERE expires_at<clock_timestamp()
             ORDER BY expires_at LIMIT 256 FOR UPDATE SKIP LOCKED)""")
        )
        return row

    def conversation(self, user: str, conversation: str) -> tuple[str, str]:
        row = self.one(
            """SELECT participant_a_user_id AS a, participant_b_user_id AS b
            FROM conversations WHERE id=CAST(:id AS UUID) AND :owner IN
            (participant_a_user_id, participant_b_user_id)""",
            {"id": conversation, "owner": user},
        )
        if not row:
            raise CallError("CALL_NOT_FOUND", "Conversation not found.", 404)
        lock_connection_graph_users(self.conn, user_ids=[row["a"], row["b"]])
        try:
            self.conn.execute(
                text("SELECT public.require_active_direct_message_connection(:a,:b)"), row
            )
        except DBAPIError as exc:
            mapped = DirectMessagesService._connection_gate_error(exc)
            if mapped:
                raise CallError(mapped.code, mapped.message, mapped.status_code) from None
            raise
        return row["a"], row["b"]

    def call(self, user: str, call_id: str, *, allow_finished=False) -> dict:
        row = self.one(
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
                self.conn, user_ids=[row["caller_user_id"], row["callee_user_id"]]
            )
        else:
            self.conversation(user, str(row["conversation_id"]))
        row = self.one(
            "SELECT * FROM direct_calls WHERE id=CAST(:id AS UUID) FOR UPDATE",
            {"id": call_id},
        )
        if not row:
            raise CallError("CALL_NOT_FOUND", "Call not found.", 404)
        row["peer_display_name"] = peer_name
        return row

    @staticmethod
    def snapshot(row) -> CallSnapshot:
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

    def project(self, row, user: str) -> dict:
        call = self.snapshot(row)
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

    def endpoints_active(self, call):
        for owner, device in ((call.caller, call.caller_device), (call.callee, call.callee_device)):
            if (
                device
                and not self.conn.execute(
                    text("""SELECT 1 FROM trusted_devices
                WHERE user_id=:owner AND device_id=:device AND status='active' FOR UPDATE"""),
                    {"owner": owner, "device": device},
                ).first()
            ):
                raise CallError(
                    "CALL_DEVICE_REVOKED", "A call device is no longer authorized.", 403
                )

    @staticmethod
    def validate_envelopes(envelopes: list) -> None:
        if not 1 <= len(envelopes) <= 20 or len(canonical(envelopes).encode()) > 512_000:
            raise CallError("CALL_SIGNAL_INVALID", "Call signaling is too large.", 422)
