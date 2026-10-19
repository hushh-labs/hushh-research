"""Stable calling facade; every operation keeps one durable transaction."""

from __future__ import annotations

import os
import time

from sqlalchemy import text

from db.db_client import get_db
from hushh_mcp.services import direct_call_admission as admission
from hushh_mcp.services import direct_call_voip as voip
from hushh_mcp.services.direct_call_authority import CallAuthority, canonical
from hushh_mcp.services.direct_call_authority import proof_bytes as proof_bytes
from hushh_mcp.services.direct_call_authority import verify_proof as verify_proof
from hushh_mcp.services.direct_call_policy import (
    TERMINAL_STATES,
    CallError,
    RelayConfig,
    transition,
)


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
            "iosAvailable": available
            and os.getenv("DIRECT_CALLS_VOIP_WORKER_QUALIFIED") == "1"
            and voip.available(),
            "relayOnly": True,
            "agentParticipation": False,
            "reason": None if available else "Calling is awaiting release verification.",
        }

    @staticmethod
    def _require_release():
        if not release_available():
            raise CallError("CALL_NOT_QUALIFIED", "Calling is awaiting release verification.", 503)
        relay_config()

    def register_key(self, user: str, payload: dict, proof: dict) -> dict:
        with self.db.engine.begin() as conn:
            authority = CallAuthority(conn)
            return admission.register_key(authority, user, payload, proof)

    def register_voip(self, user: str, payload: dict, proof: dict) -> dict:
        self._require_release()
        with self.db.engine.begin() as conn:
            return voip.register(CallAuthority(conn), user, payload, proof)

    def directory(self, user: str, payload: dict, proof: dict) -> dict:
        with self.db.engine.begin() as conn:
            authority = CallAuthority(conn)
            return admission.directory(authority, user, payload, proof)

    def create(self, user: str, payload: dict, proof: dict) -> dict:
        self._require_release()
        with self.db.engine.begin() as conn:
            authority = CallAuthority(conn)
            return admission.create(authority, self.db, user, payload, proof)

    def offer(self, user: str, payload: dict, proof: dict) -> dict:
        self._require_release()
        with self.db.engine.begin() as conn:
            authority = CallAuthority(conn)
            return admission.offer(authority, user, payload, proof)

    def read(self, user: str, payload: dict, proof: dict) -> dict:
        self._require_release()
        with self.db.engine.begin() as conn:
            authority = CallAuthority(conn)
            row = authority.call(user, payload["callId"])
            authority.proof(user, "read", payload, proof)
            call = authority.snapshot(row)
            if (
                user == call.caller
                and proof["deviceId"] != call.caller_device
                or user == call.callee
                and call.callee_device
                and proof["deviceId"] != call.callee_device
            ):
                raise CallError("CALL_DEVICE_MISMATCH", "This call belongs to another device.", 403)
            # Revoke either endpoint => stop delivery/credentials immediately.
            authority.endpoints_active(call)
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
                **authority.project(row, user),
                "offers": offers,
                "offerProof": row["caller_proof"],
                "signals": [dict(signal) for signal in signals],
            }

    def inbox(self, user: str, payload: dict, proof: dict) -> dict:
        self._require_release()
        with self.db.engine.begin() as conn:
            authority = CallAuthority(conn)
            authority.proof(user, "inbox", payload, proof)
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
            return {"items": [authority.project(dict(row), user) for row in rows]}

    def action(self, user: str, payload: dict, proof: dict) -> dict:
        self._require_release()
        with self.db.engine.begin() as conn:
            authority = CallAuthority(conn)
            row = authority.call(user, payload["callId"], allow_finished=payload["action"] == "end")
            authority.proof(user, "action", payload, proof)
            call = authority.snapshot(row)
            if payload["action"] != "end":
                authority.endpoints_active(call)
            state, device, expiry = transition(
                call,
                actor=user,
                device=proof["deviceId"],
                action=payload["action"],
                revision=payload["revision"],
                now=int(time.time()),
            )
            row = authority.one(
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
                    text("DELETE FROM direct_call_voip_outbox WHERE call_id=CAST(:id AS UUID)"),
                    {"id": call.id},
                )
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
            return authority.project(row, user)

    def signal(self, user: str, payload: dict, proof: dict) -> dict:
        self._require_release()
        with self.db.engine.begin() as conn:
            authority = CallAuthority(conn)
            row = authority.call(user, payload["callId"])
            authority.proof(user, "signal", payload, proof)
            call = authority.snapshot(row)
            authority.endpoints_active(call)
            if call.state not in {"connecting", "active"} or int(time.time()) >= call.expires_at:
                raise CallError("CALL_NOT_CONNECTED", "This call cannot receive signaling.")
            device = call.caller_device if user == call.caller else call.callee_device
            if device != proof["deviceId"]:
                raise CallError("CALL_DEVICE_MISMATCH", "Use the device in this call.", 403)
            target = call.callee_device if user == call.caller else call.caller_device
            key = authority.one(
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
            authority = CallAuthority(conn)
            row = authority.call(user, payload["callId"])
            authority.proof(user, "credentials", payload, proof)
            call = authority.snapshot(row)
            authority.endpoints_active(call)
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
