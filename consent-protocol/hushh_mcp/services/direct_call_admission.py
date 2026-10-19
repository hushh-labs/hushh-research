"""Device enrollment and durable call admission on the caller's transaction."""

from __future__ import annotations

import base64
import hashlib
import time

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from hushh_mcp.services.connection_graph_service import lock_connection_graph_users
from hushh_mcp.services.direct_call_authority import CallAuthority, canonical
from hushh_mcp.services.direct_call_policy import RING_SECONDS, CallError
from hushh_mcp.services.direct_messages_service import DirectMessagesService


def register_key(authority: CallAuthority, user: str, payload: dict, proof: dict) -> dict:
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
    authority.proof(user, "register-key", payload, proof)
    old = authority.one(
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
    authority.conn.execute(
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


def directory(authority: CallAuthority, user: str, payload: dict, proof: dict) -> dict:
    authority.conversation(user, payload["conversationId"])
    authority.proof(user, "directory", payload, proof)
    rows = (
        authority.conn.execute(
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


def resolve_conversation(authority: CallAuthority, db, user: str, payload: dict) -> str:
    conversation_id = payload.get("conversationId")
    if not conversation_id:
        messages = DirectMessagesService(db=db, connection=authority.conn, defer_notifications=True)
        peer, _ = messages._resolve_recipient(recipient_person_ref=payload["recipientPersonRef"])
        messages._reject_self(user, peer)
        lock_connection_graph_users(authority.conn, user_ids=[user, peer])
        # Same canonical pair/trigger contract as the first message,
        # without manufacturing a text message just to enable a call.
        conversation = authority.one(
            """INSERT INTO conversations(id,participant_a_user_id,participant_b_user_id)
            VALUES(gen_random_uuid(),LEAST(:owner,:peer),GREATEST(:owner,:peer))
            ON CONFLICT(participant_a_user_id,participant_b_user_id)
            DO UPDATE SET participant_a_user_id=EXCLUDED.participant_a_user_id RETURNING id""",
            {"owner": user, "peer": peer},
        )
        if not conversation:
            raise CallError("CALL_NOT_FOUND", "Conversation not found.", 404)
        conversation_id = str(conversation["id"])
    return conversation_id


def create(authority: CallAuthority, db, user: str, payload: dict, proof: dict) -> dict:
    conversation_id = resolve_conversation(authority, db, user, payload)
    a, b = authority.conversation(user, conversation_id)
    authority.proof(user, "create", payload, proof)
    peer = b if user == a else a
    # Pair/user locks serialize busy admission, account erasure and blocks.
    authority.conn.execute(
        text("""UPDATE direct_calls SET state='expired',revision=revision+1,offers='[]',caller_proof='{}'
        WHERE id IN(SELECT call_id FROM direct_call_slots WHERE user_id IN(:owner,:peer))
        AND expires_at<=clock_timestamp() AND state IN ('preparing','ringing','connecting','active')"""),
        {"owner": user, "peer": peer},
    )
    authority.conn.execute(
        text("""DELETE FROM direct_call_signals WHERE call_id IN
        (SELECT c.id FROM direct_calls c JOIN direct_call_slots s ON s.call_id=c.id
         WHERE s.user_id IN(:owner,:peer) AND c.state IN ('declined','cancelled','ended','expired'))"""),
        {"owner": user, "peer": peer},
    )
    authority.conn.execute(
        text("""DELETE FROM direct_call_slots WHERE user_id IN(:owner,:peer) AND call_id IN
        (SELECT id FROM direct_calls WHERE state IN ('declined','cancelled','ended','expired'))"""),
        {"owner": user, "peer": peer},
    )
    recipients = (
        authority.conn.execute(
            text("""SELECT k.device_id,k.key_id FROM direct_communication_keys k
        JOIN trusted_devices d ON d.device_id=k.device_id AND d.user_id=k.user_id
        WHERE k.user_id=:peer AND d.status='active' ORDER BY k.device_id FOR UPDATE OF d"""),
            {"peer": peer},
        )
        .mappings()
        .all()
    )
    expected = {(r["device_id"], str(r["key_id"])) for r in recipients}
    if not expected or not authority.one(
        "SELECT 1 FROM direct_communication_keys WHERE device_id=:device",
        {"device": proof["deviceId"]},
    ):
        raise CallError(
            "CALL_ROSTER_CHANGED", "Both participants need enrolled communications keys."
        )
    row = authority.one(
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
        authority.conn.execute(
            text("""INSERT INTO direct_call_slots(user_id,call_id)
            VALUES(:owner,CAST(:call AS UUID)),(:peer,CAST(:call AS UUID))"""),
            {"owner": user, "peer": peer, "call": payload["callId"]},
        )
    except IntegrityError as exc:
        raise CallError("CALL_BUSY", "One participant is already in a call.") from exc
    return authority.project(row, user)


def offer(authority: CallAuthority, user: str, payload: dict, proof: dict) -> dict:
    authority.validate_envelopes(payload["offers"])
    row = authority.call(user, payload["callId"])
    authority.proof(user, "offer", payload, proof)
    call = authority.snapshot(row)
    if (
        user != call.caller
        or proof["deviceId"] != call.caller_device
        or call.state != "preparing"
        or int(time.time()) >= call.expires_at
    ):
        raise CallError("CALL_ACTION_INVALID", "This call can no longer ring.")
    devices = (
        authority.conn.execute(
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
    row = authority.one(
        """UPDATE direct_calls SET state='ringing',revision=revision+1,
        offers=CAST(:offers AS JSONB),caller_proof=CAST(:proof AS JSONB)
        WHERE id=CAST(:id AS UUID) RETURNING *""",
        {
            "id": call.id,
            "offers": canonical(payload["offers"]),
            "proof": canonical({"payload": payload, "proof": proof}),
        },
    )
    return authority.project(row, user)
