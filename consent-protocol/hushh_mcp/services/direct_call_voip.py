"""Purpose-bound PushKit registration and transactional incoming-call outbox.

VoIP pushes carry opaque admission hints, never signaling or relay credentials.
"""

from __future__ import annotations

import os
import re
import threading
import time
from dataclasses import dataclass, field
from uuid import uuid4

import httpx
import jwt
from opentelemetry.instrumentation.utils import suppress_instrumentation
from sqlalchemy import text

from hushh_mcp.services.direct_call_authority import CallAuthority
from hushh_mcp.services.direct_call_policy import CallError

_provider_tokens: dict[APNSConfig, tuple[float, str]] = {}
_provider_lock = threading.Lock()


@dataclass(frozen=True)
class APNSConfig:
    team: str
    key_id: str
    private_key: str = field(repr=False)
    bundle: str
    environment: str

    @classmethod
    def load(cls):
        config = cls(
            *(
                os.getenv("DIRECT_CALLS_APNS_" + name, "")
                for name in ("TEAM_ID", "KEY_ID", "PRIVATE_KEY", "BUNDLE_ID", "ENVIRONMENT")
            )
        )
        if (
            not re.fullmatch(r"[A-Z0-9]{10}", config.team)
            or not re.fullmatch(r"[A-Z0-9]{10}", config.key_id)
            or not re.fullmatch(r"[A-Za-z0-9.-]{3,200}", config.bundle)
            or config.environment not in {"sandbox", "production"}
            or not config.private_key
        ):
            raise CallError(
                "CALL_VOIP_UNAVAILABLE", "Native calling is awaiting push configuration.", 503
            )
        return config

    def headers(self) -> dict[str, str]:
        # Rotate at most once/20min and before the one-hour expiry.
        with _provider_lock:
            cached = _provider_tokens.get(self)
            if cached is None or time.monotonic() - cached[0] >= 2400:
                token = jwt.encode(
                    {"iss": self.team, "iat": int(time.time())},
                    self.private_key,
                    algorithm="ES256",
                    headers={"kid": self.key_id},
                )
                if len(_provider_tokens) >= 8:
                    _provider_tokens.clear()
                _provider_tokens[self] = (time.monotonic(), token)
            else:
                token = cached[1]
        return {
            "authorization": "bearer " + token,
            "apns-topic": self.bundle + ".voip",
            "apns-push-type": "voip",
            "apns-priority": "10",
            "apns-expiration": "0",
        }

    @property
    def origin(self) -> str:
        return (
            "https://api.sandbox.push.apple.com"
            if self.environment == "sandbox"
            else "https://api.push.apple.com"
        )


def available() -> bool:
    try:
        config = APNSConfig.load()
        config.headers()  # Reject malformed/key-type-incompatible provider keys too.
    except (CallError, ValueError, jwt.PyJWTError):
        return False
    return True


def register(authority: CallAuthority, user: str, payload: dict, proof: dict) -> dict:
    config = APNSConfig.load()
    authority.proof(user, "register-voip", payload, proof)
    if payload["environment"] != config.environment:
        raise CallError(
            "CALL_VOIP_ENVIRONMENT", "This build's calling push environment is unavailable.", 409
        )
    device = authority.one(
        "SELECT platform FROM trusted_devices WHERE device_id=:device",
        {"device": proof["deviceId"]},
    )
    key = authority.one(
        "SELECT key_id FROM direct_communication_keys WHERE device_id=:device AND user_id=:owner",
        {"device": proof["deviceId"], "owner": user},
    )
    if not device or device["platform"] != "ios" or not key:
        raise CallError("CALL_DEVICE_MISMATCH", "Use an enrolled iOS calling installation.", 403)
    if payload["token"] is None:
        authority.conn.execute(
            text("DELETE FROM direct_call_voip_tokens WHERE device_id=:device"),
            {"device": proof["deviceId"]},
        )
        return {"registered": False}
    # A PushKit token names ONE installation. Transfer it on account change;
    # best-effort unregister on logout cannot provide this ownership guarantee.
    authority.conn.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:binding,0))"),
        {
            "binding": "direct-call-voip:"
            + config.environment
            + ":"
            + config.bundle
            + ":"
            + payload["token"]
        },
    )
    authority.conn.execute(
        text("""DELETE FROM direct_call_voip_tokens WHERE environment=:env
        AND topic=:topic AND token=:token AND device_id<>:device"""),
        {
            "env": config.environment,
            "topic": config.bundle + ".voip",
            "token": payload["token"],
            "device": proof["deviceId"],
        },
    )
    authority.conn.execute(
        text("""INSERT INTO direct_call_voip_tokens
        (device_id,user_id,key_id,token,generation,environment,topic)
        VALUES(:device,:owner,:key,:token,CAST(:generation AS UUID),:env,:topic)
        ON CONFLICT(device_id) DO UPDATE SET token=EXCLUDED.token,key_id=EXCLUDED.key_id,
        generation=CASE WHEN direct_call_voip_tokens.token=EXCLUDED.token
          AND direct_call_voip_tokens.environment=EXCLUDED.environment
          AND direct_call_voip_tokens.topic=EXCLUDED.topic THEN direct_call_voip_tokens.generation ELSE EXCLUDED.generation END,
        environment=EXCLUDED.environment,topic=EXCLUDED.topic,updated_at=clock_timestamp()"""),
        {
            "device": proof["deviceId"],
            "owner": user,
            "key": key["key_id"],
            "token": payload["token"],
            "generation": str(uuid4()),
            "env": config.environment,
            "topic": config.bundle + ".voip",
        },
    )
    # Never generate a second VoIP alert simply because a token rotated.
    authority.conn.execute(
        text("""DELETE FROM direct_call_voip_outbox o USING direct_call_voip_tokens t
        WHERE o.device_id=t.device_id AND o.device_id=:device AND o.token_generation<>t.generation"""),
        {"device": proof["deviceId"]},
    )
    return {"registered": True}


def enqueue(authority: CallAuthority, call: dict) -> None:
    authority.conn.execute(
        text("""INSERT INTO direct_call_voip_outbox(call_id,device_id,token_generation)
        SELECT CAST(:call AS UUID),t.device_id,t.generation FROM direct_call_voip_tokens t
        JOIN direct_communication_keys k ON k.device_id=t.device_id AND k.key_id=t.key_id
        JOIN trusted_devices d ON d.device_id=t.device_id AND d.user_id=t.user_id AND d.status='active'
        WHERE t.user_id=:peer AND d.platform='ios' ON CONFLICT DO NOTHING"""),
        {"call": call["id"], "peer": call["callee_user_id"]},
    )


def _deliver(db, candidate: dict, config: APNSConfig, client) -> str:
    with db.engine.begin() as conn:
        authority = CallAuthority(conn)
        # Same graph -> call -> device -> outbox lock order as admission/revocation.
        try:
            with conn.begin_nested():
                row = authority.call(candidate["callee_user_id"], str(candidate["call_id"]))
                authority.endpoints_active(authority.snapshot(row))
        except CallError:
            conn.execute(
                text("DELETE FROM direct_call_voip_outbox WHERE call_id=:call"),
                {"call": candidate["call_id"]},
            )
            return "discarded"
        target = authority.one(
            "SELECT status FROM trusted_devices WHERE device_id=:device AND user_id=:owner FOR UPDATE",
            {"device": candidate["device_id"], "owner": candidate["callee_user_id"]},
        )
        if not target or target["status"] != "active":
            conn.execute(
                text(
                    "DELETE FROM direct_call_voip_outbox WHERE call_id=:call AND device_id=:device"
                ),
                {"call": candidate["call_id"], "device": candidate["device_id"]},
            )
            return "discarded"
        pending = authority.one(
            """SELECT o.*,t.token,t.key_id,t.environment,t.topic,d.status FROM direct_call_voip_outbox o
            JOIN direct_call_voip_tokens t ON t.device_id=o.device_id AND t.generation=o.token_generation
            JOIN trusted_devices d ON d.device_id=t.device_id AND d.user_id=t.user_id
            WHERE o.call_id=:call AND o.device_id=:device AND o.attempts<3
            AND o.next_attempt_at<=clock_timestamp() FOR UPDATE OF o SKIP LOCKED""",
            {"call": candidate["call_id"], "device": candidate["device_id"]},
        )
        if not pending:
            return "discarded"
        if (
            row["state"] != "ringing"
            or row["expires_at"].timestamp() <= time.time()
            or pending["status"] != "active"
            or pending["environment"] != config.environment
            or pending["topic"] != config.bundle + ".voip"
        ):
            conn.execute(
                text(
                    "DELETE FROM direct_call_voip_outbox WHERE call_id=:call AND device_id=:device"
                ),
                {"call": candidate["call_id"], "device": candidate["device_id"]},
            )
            return "discarded"
        return _dispatch_pending(conn, row, pending, candidate, config, client)


def _dispatch_pending(conn, row, pending, candidate, config, client) -> str:
    payload = {
        "aps": {"content-available": 1},
        "callId": str(row["id"]),
        "deviceId": pending["device_id"],
        "keyId": str(pending["key_id"]),
        "expiresAt": int(row["expires_at"].timestamp()),
    }
    try:
        with suppress_instrumentation():
            response = client.post(
                config.origin + "/3/device/" + pending["token"],
                headers=config.headers(),
                json=payload,
            )
        status = response.status_code
    except httpx.HTTPError:
        status = 503
    params = {"call": candidate["call_id"], "device": candidate["device_id"]}
    if status == 410:
        conn.execute(
            text(
                "DELETE FROM direct_call_voip_tokens WHERE device_id=:device AND generation=:generation"
            ),
            {"device": pending["device_id"], "generation": pending["token_generation"]},
        )
    if status == 200 or 400 <= status < 500 and status != 429:
        conn.execute(
            text("DELETE FROM direct_call_voip_outbox WHERE call_id=:call AND device_id=:device"),
            params,
        )
    else:
        conn.execute(
            text("""UPDATE direct_call_voip_outbox SET attempts=attempts+1,
            next_attempt_at=clock_timestamp()+interval '3 seconds' WHERE call_id=:call AND device_id=:device"""),
            params,
        )
    return (
        "accepted"
        if status == 200
        else "rejected"
        if 400 <= status < 500 and status != 429
        else "retry"
    )


def drain(db=None, *, client=None) -> dict[str, int]:
    """Bounded best-effort delivery. Run after offer commit and from a retry worker.

    HTTP status/provider acceptance is not evidence of device delivery. Never log
    request paths (PushKit tokens), Authorization headers or provider bodies.
    """
    from db.db_client import get_db
    from hushh_mcp.services.direct_calls_service import release_available

    if not release_available():
        return {"accepted": 0, "rejected": 0, "retry": 0, "discarded": 0}
    from mcp_modules.log_redaction import install_sensitive_log_filter

    install_sensitive_log_filter()
    config = APNSConfig.load()
    db = db or get_db()
    counts = {"accepted": 0, "rejected": 0, "retry": 0, "discarded": 0}
    with db.engine.connect() as conn:
        candidates = (
            conn.execute(
                text("""SELECT o.call_id,o.device_id,c.callee_user_id FROM direct_call_voip_outbox o
            JOIN direct_calls c ON c.id=o.call_id WHERE o.attempts<3 AND o.next_attempt_at<=clock_timestamp()
            AND c.state='ringing' AND c.expires_at>clock_timestamp() ORDER BY o.next_attempt_at LIMIT 20""")
            )
            .mappings()
            .all()
        )
    if client is not None:
        for candidate in candidates:
            counts[_deliver(db, dict(candidate), config, client)] += 1
    else:
        # A fresh transport per batch; no ambient HTTP logging/instrumentation of tokens.
        with httpx.Client(http2=True, timeout=5, follow_redirects=False) as transport:
            for candidate in candidates:
                counts[_deliver(db, dict(candidate), config, transport)] += 1
    return counts


def deliver_after_offer() -> None:
    # Run in BackgroundTasks' threadpool. --watch recovers task-loss on restart.
    for attempt in range(3):
        counts = drain()
        if not counts["retry"] or attempt == 2:
            return
        time.sleep(3)


if __name__ == "__main__":
    import argparse
    import json

    parser = argparse.ArgumentParser(
        description="Dispatch opaque incoming-call hints; aggregate output only."
    )
    parser.add_argument("--watch", action="store_true")
    args = parser.parse_args()
    while True:
        try:
            print(json.dumps(drain()), flush=True)
        except Exception:
            print('{"unavailable":1}', flush=True)
        if not args.watch:
            break
        time.sleep(3)
