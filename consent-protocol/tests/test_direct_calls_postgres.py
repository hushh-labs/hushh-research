"""Real call CAS, revocation and migration tests in an agent-owned database.

Uses the canonical CI PostgreSQL fixture; never points at an application DB.
"""

import base64
import os
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

from hushh_mcp.services.direct_call_policy import CallError
from hushh_mcp.services.direct_call_retention import purge_batch
from hushh_mcp.services.direct_calls_service import DirectCallsService, proof_bytes

pytestmark = pytest.mark.db
ROOT = Path(__file__).resolve().parents[1]
CONVERSATION = "00000000-0000-4000-8000-000000000001"


def prepare_call_schema(engine):
    with engine.begin() as conn:
        conn.exec_driver_sql("""
          CREATE TABLE actor_profiles(user_id TEXT PRIMARY KEY,public_person_ref UUID);
          CREATE TABLE actor_identity_cache(user_id TEXT PRIMARY KEY,display_name TEXT);
          CREATE TABLE trusted_devices(device_id TEXT PRIMARY KEY,user_id TEXT,
            device_public_key TEXT,status TEXT DEFAULT 'active',platform TEXT DEFAULT 'ios',UNIQUE(user_id,device_id));
          CREATE TABLE connections(user_a_id TEXT,user_b_id TEXT,status TEXT,PRIMARY KEY(user_a_id,user_b_id));
          CREATE TABLE conversations(id UUID PRIMARY KEY,participant_a_user_id TEXT,participant_b_user_id TEXT,
            UNIQUE(participant_a_user_id,participant_b_user_id));
          CREATE TABLE direct_message_blocks(blocker_user_id TEXT,blocked_user_id TEXT);
          INSERT INTO actor_profiles VALUES('alice','00000000-0000-4000-8000-000000000010'),('bob','00000000-0000-4000-8000-000000000020');
          INSERT INTO actor_identity_cache VALUES('alice','Synthetic Alice'),('bob','Synthetic Bob');
          INSERT INTO connections VALUES('alice','bob','active');
          INSERT INTO conversations VALUES('00000000-0000-4000-8000-000000000001','alice','bob');
        """)
        source = (ROOT / "db/migrations/264_direct_messages.sql").read_text(encoding="utf-8")
        start = source.index(
            "CREATE OR REPLACE FUNCTION public.require_active_direct_message_connection("
        )
        conn.exec_driver_sql(source[start : source.index("$$;", start) + 3])
    migration = (ROOT / "db/migrations/407_direct_calls.sql").read_text(encoding="utf-8")
    with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
        conn.exec_driver_sql(migration, execution_options={"no_parameters": True})
        conn.exec_driver_sql(migration, execution_options={"no_parameters": True})


@pytest.fixture
def calls(monkeypatch):
    value = os.getenv("ONE_COMMAND_TEST_DATABASE_URL")
    if not value:
        pytest.skip("requires canonical CI's disposable PostgreSQL")
    url = make_url(value)
    assert url.host in {"localhost", "127.0.0.1"} and url.database == "command_test"
    name = "calling_test_" + uuid4().hex
    admin = create_engine(url, isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.exec_driver_sql(f'CREATE DATABASE "{name}"')
    engine = create_engine(url.set(database=name), pool_size=3, max_overflow=0)
    try:
        prepare_call_schema(engine)
        keys = {}
        for owner, device in [
            ("alice", "tdv_alice"),
            ("bob", "tdv_bob_one"),
            ("bob", "tdv_bob_two"),
        ]:
            key = ec.generate_private_key(ec.SECP256R1())
            public = base64.b64encode(
                key.public_key().public_bytes(
                    serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
                )
            ).decode()
            keys[device] = (owner, key)
            with engine.begin() as conn:
                conn.execute(
                    text(
                        "INSERT INTO trusted_devices(device_id,user_id,device_public_key,status) VALUES(:device,:owner,:public,'active')"
                    ),
                    {"device": device, "owner": owner, "public": public},
                )
        for env in (
            "DIRECT_CALLS_ENABLED",
            "DIRECT_MESSAGES_E2EE_QUALIFIED",
            "DIRECT_CALLS_NATIVE_QUALIFIED",
        ):
            monkeypatch.setenv(env, "1")
        monkeypatch.setenv("DIRECT_CALLS_TURN_HOST", "turn.synthetic.example.test")
        monkeypatch.setenv(
            "DIRECT_CALLS_TURN_SECRET", "synthetic-relay-secret-used-only-by-tests-32chars"
        )
        service = DirectCallsService(db=SimpleNamespace(engine=engine))

        def invoke(device, operation, payload, *, proof=None):
            owner, key = keys[device]
            if proof is None:
                proof = {
                    "deviceId": device,
                    "nonce": str(uuid4()),
                    "expiresAt": int(time.time()) + 90,
                }
                proof["signature"] = base64.b64encode(
                    key.sign(
                        proof_bytes(owner, operation, payload, proof), ec.ECDSA(hashes.SHA256())
                    )
                ).decode()
            method = operation.replace("-", "_")
            return getattr(service, method)(owner, payload, proof)

        for device, (_owner, key) in keys.items():
            public = base64.b64encode(
                key.public_key().public_bytes(
                    serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
                )
            ).decode()
            invoke(device, "register-key", {"keyId": str(uuid4()), "publicKey": public})
        yield service, engine, invoke
    finally:
        engine.dispose()
        with admin.connect() as conn:
            conn.exec_driver_sql(f'DROP DATABASE "{name}" WITH (FORCE)')
        admin.dispose()


def ring(invoke):
    created = invoke(
        "tdv_alice", "create", {"callId": str(uuid4()), "conversationId": CONVERSATION}
    )
    directory = invoke("tdv_alice", "directory", {"conversationId": CONVERSATION})
    offers = [
        {
            "deviceId": item["deviceId"],
            "keyId": item["keyId"],
            "algorithm": "HPKE-P256-SHA256-AES256GCM-v1",
            "enc": "A" * 88,
            "ciphertext": "A" * 24,
        }
        for item in directory["items"]
        if item["userId"] == "bob"
    ]
    return invoke("tdv_alice", "offer", {"callId": created["id"], "offers": offers})


def test_answer_race_revocation_cleanup_and_retention(calls):
    service, engine, invoke = calls
    call = ring(invoke)

    def accept(device):
        try:
            return invoke(
                device,
                "action",
                {"callId": call["id"], "action": "accept", "revision": call["revision"]},
            )
        except CallError as exc:
            return exc

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(accept, ["tdv_bob_one", "tdv_bob_two"]))
    winners = [result for result in results if isinstance(result, dict)]
    assert (
        len(winners) == 1
        and len([result for result in results if isinstance(result, CallError)]) == 1
    )
    winner = winners[0]
    current = invoke(
        "tdv_alice",
        "action",
        {"callId": call["id"], "action": "connected", "revision": winner["revision"]},
    )
    assert current["state"] == "connecting"
    current = invoke(
        winner["calleeDeviceId"],
        "action",
        {"callId": call["id"], "action": "connected", "revision": current["revision"]},
    )
    assert current["state"] == "active"
    assert (
        invoke("tdv_alice", "credentials", {"callId": call["id"]})["iceTransportPolicy"] == "relay"
    )
    with engine.begin() as conn:
        conn.execute(
            text("UPDATE trusted_devices SET status='revoked' WHERE device_id=:device"),
            {"device": winner["calleeDeviceId"]},
        )
    with pytest.raises(CallError, match="no longer authorized"):
        invoke("tdv_alice", "credentials", {"callId": call["id"]})
    ended = invoke(
        "tdv_alice",
        "action",
        {"callId": call["id"], "action": "end", "revision": current["revision"]},
    )
    assert ended["state"] == "ended"
    with engine.begin() as conn:
        assert conn.execute(text("SELECT count(*) FROM direct_call_slots")).scalar_one() == 0
        assert conn.execute(text("SELECT offers FROM direct_calls")).scalar_one() == []
        conn.execute(
            text("UPDATE direct_calls SET created_at=clock_timestamp()-interval '25 hours'")
        )
    assert purge_batch(db=service.db)["compacted"] == 1


def test_busy_and_block_boundaries_preserve_existing_history(calls):
    _service, engine, invoke = calls
    call = ring(invoke)
    with pytest.raises(CallError, match="already in a call"):
        invoke("tdv_alice", "create", {"callId": str(uuid4()), "conversationId": CONVERSATION})
    with engine.begin() as conn:
        conn.execute(text("INSERT INTO direct_message_blocks VALUES('bob','alice')"))
    with pytest.raises(CallError):
        invoke(
            "tdv_bob_one",
            "action",
            {"callId": call["id"], "action": "accept", "revision": call["revision"]},
        )
    # Cleanup remains available after blocks/disconnection and uses graph-first locks.
    assert (
        invoke(
            "tdv_alice",
            "action",
            {"callId": call["id"], "action": "end", "revision": call["revision"]},
        )["state"]
        == "ended"
    )
    with engine.begin() as conn:
        assert conn.execute(text("SELECT count(*) FROM conversations")).scalar_one() == 1


def test_first_call_materializes_pair_without_manufacturing_a_message(calls):
    _service, engine, invoke = calls
    with engine.begin() as conn:
        conn.execute(text("DELETE FROM conversations"))
    call = invoke(
        "tdv_alice",
        "create",
        {"callId": str(uuid4()), "recipientPersonRef": "00000000-0000-4000-8000-000000000020"},
    )
    assert call["conversationId"] and call["state"] == "preparing"
    with engine.begin() as conn:
        assert conn.execute(text("SELECT count(*) FROM conversations")).scalar_one() == 1
        assert conn.execute(text("SELECT to_regclass('public.messages')")).scalar_one() is None


def native_tokens(monkeypatch, invoke):
    key = ec.generate_private_key(ec.SECP256R1())
    pem = key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    ).decode()
    for name, value in {
        "TEAM_ID": "SYNTHETIC1",
        "KEY_ID": "SYNTHETIC2",
        "PRIVATE_KEY": pem,
        "BUNDLE_ID": "test.synthetic.calling",
        "ENVIRONMENT": "sandbox",
    }.items():
        monkeypatch.setenv("DIRECT_CALLS_APNS_" + name, value)
    for device, token in [("tdv_bob_one", "ab" * 32), ("tdv_bob_two", "cd" * 32)]:
        invoke(device, "register-voip", {"token": token, "environment": "sandbox"})


class SyntheticAPNS:
    def __init__(self, status=200):
        self.requests = []
        self.status = status

    def post(self, url, *, headers, json):
        self.requests.append((url, headers, json))
        return SimpleNamespace(status_code=self.status)


def test_native_outbox_is_atomic_opaque_once_and_fenced_to_registration(calls, monkeypatch):
    from hushh_mcp.services.direct_call_voip import drain

    service, engine, invoke = calls
    native_tokens(monkeypatch, invoke)
    call = ring(invoke)
    client = SyntheticAPNS()
    assert drain(service.db, client=client)["accepted"] == 2
    assert len(client.requests) == 2
    for _url, headers, payload in client.requests:
        assert set(payload) == {"aps", "callId", "deviceId", "keyId", "expiresAt"}
        assert payload["callId"] == call["id"]
        assert headers["apns-push-type"] == "voip" and headers["apns-expiration"] == "0"
    assert client.requests[0][1]["authorization"] == client.requests[1][1]["authorization"]
    assert drain(service.db, client=client)["accepted"] == 0
    assert len(client.requests) == 2
    # Token ownership transfers even if old-owner logout was offline.
    invoke("tdv_alice", "register-voip", {"token": "ab" * 32, "environment": "sandbox"})
    with engine.connect() as conn:
        rows = conn.execute(
            text("SELECT user_id FROM direct_call_voip_tokens WHERE token=:token"),
            {"token": "ab" * 32},
        ).all()
        assert rows == [("alice",)]


@pytest.mark.parametrize("boundary", ["block", "revoke", "rotate", "expired"])
def test_native_pending_delivery_rechecks_authority_and_token_generation(
    calls, monkeypatch, boundary
):
    from hushh_mcp.services.direct_call_voip import drain

    service, engine, invoke = calls
    native_tokens(monkeypatch, invoke)
    ring(invoke)
    if boundary == "rotate":
        for device, token in [("tdv_bob_one", "ef" * 32), ("tdv_bob_two", "01" * 32)]:
            invoke(device, "register-voip", {"token": token, "environment": "sandbox"})
    else:
        with engine.begin() as conn:
            sql = {
                "block": "INSERT INTO direct_message_blocks VALUES('bob','alice')",
                "revoke": "UPDATE trusted_devices SET status='revoked' WHERE user_id='bob'",
                "expired": "UPDATE direct_calls SET expires_at=clock_timestamp()-interval '1 second'",
            }[boundary]
            conn.execute(text(sql))
    client = SyntheticAPNS()
    drain(service.db, client=client)
    assert client.requests == []
    if boundary == "expired":
        purge_batch(db=service.db)
    with engine.connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM direct_call_voip_outbox")).scalar_one() == 0


def test_native_retry_and_invalid_token_cleanup(calls, monkeypatch):
    from hushh_mcp.services.direct_call_voip import drain

    service, engine, invoke = calls
    native_tokens(monkeypatch, invoke)
    ring(invoke)
    client = SyntheticAPNS(status=503)
    assert drain(service.db, client=client)["retry"] == 2
    assert drain(service.db, client=client)["retry"] == 0  # scheduled backoff
    with engine.begin() as conn:
        conn.execute(text("UPDATE direct_call_voip_outbox SET next_attempt_at=clock_timestamp()"))
    client.status = 410
    assert drain(service.db, client=client)["rejected"] == 2
    with engine.connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM direct_call_voip_tokens")).scalar_one() == 0


def test_native_registration_rejects_other_platform_and_wrong_environment(calls, monkeypatch):
    _service, engine, invoke = calls
    native_tokens(monkeypatch, invoke)
    with pytest.raises(CallError, match="environment"):
        invoke("tdv_alice", "register-voip", {"token": "23" * 32, "environment": "production"})
    with engine.begin() as conn:
        conn.execute(text("UPDATE trusted_devices SET platform='web' WHERE device_id='tdv_alice'"))
    with pytest.raises(CallError, match="iOS"):
        invoke("tdv_alice", "register-voip", {"token": "23" * 32, "environment": "sandbox"})
