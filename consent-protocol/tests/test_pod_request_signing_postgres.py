"""Migration 947 and the signed-request store, on a real PostgreSQL.

The verifier's guarantees are only as good as four conditional statements: the
nonce insert, the latch, the per-row pull claim and the signing-key binding. Fakes
cannot prove a WHERE clause; this file runs the statements themselves, plus the
MCP transaction fence that compares a signed principal by key id under FOR UPDATE.
"""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text

from db.db_client import DatabaseClient
from hushh_mcp.services import pod_request_identity_store as store_module
from hushh_mcp.services.pod_request_identity_store import PodRequestIdentityStore
from hushh_mcp.services.pod_request_signing import VerifiedPod
from tests.pkm_conformance import postgres_harness

pytestmark = pytest.mark.skipif(
    postgres_harness.find_pg_bin() is None, reason="PostgreSQL unavailable"
)

MIGRATIONS = Path(__file__).resolve().parents[1] / "db/migrations"
KID = "pods_" + "a" * 32
OTHER_KID = "pods_" + "b" * 32
SIGNING_KEY = "A" * 43 + "="
OTHER_SIGNING_KEY = "B" * 43 + "="


@pytest.fixture(scope="module")
def pg():
    old = postgres_harness.MIGRATIONS
    postgres_harness.MIGRATIONS = []
    server = postgres_harness.TempPostgres()
    try:
        server.start()
        for name in (
            "parked/900_personal_agent_registry.sql",
            "parked/906_personal_agent_user_cloud.sql",
            "parked/947_pod_request_signing.sql",
            "parked/947_pod_request_signing.sql",  # idempotent by construction
        ):
            server.apply_file(MIGRATIONS / name)
        server.execute("CREATE TABLE agent_chat_conversations (id UUID PRIMARY KEY)")
        server.execute(
            "CREATE TABLE one_adk_sessions (app_name TEXT, user_id TEXT, session_id TEXT, "
            "PRIMARY KEY(app_name,user_id,session_id))"
        )
        for name in (
            "114_one_action_directive_ledger.sql",
            "248_adk_chat_action_authority.sql",
            "parked/945_pod_mcp_action_authority.sql",
        ):
            server.apply_file(MIGRATIONS / name)
        yield server
    finally:
        postgres_harness.MIGRATIONS = old
        server.stop()


@pytest.fixture
def db(pg):
    engine = create_engine(f"postgresql+psycopg2://hushh@/postgres?host={pg.dir}&port={pg.port}")
    with engine.begin() as conn:
        conn.execute(text("DELETE FROM one_action_directive_ledger"))
        conn.execute(text("DELETE FROM pod_request_nonces"))
        conn.execute(text("DELETE FROM personal_agent_registry"))
        conn.execute(
            text(
                "INSERT INTO personal_agent_registry (user_id,hushh_id,status,deployment_target,"
                "user_cloud_project,pod_key_id,pod_pubkey,backend_metadata) VALUES ('u','ha1_test',"
                "'provisioned','user_gcp','synthetic-project','podk_test','public',"
                "CAST(:meta AS jsonb))"
            ),
            {
                "meta": json.dumps(
                    {
                        "url": "https://pod.example",
                        "serviceUid": "uid-1",
                        "runtime_service_account": "pod@synthetic.iam.gserviceaccount.com",
                        "ingress": "direct",
                        "directReadiness": {
                            "verified": True,
                            "serviceUid": "uid-1",
                            "podKeyId": "podk_test",
                            "url": "https://pod.example",
                        },
                    }
                )
            },
        )
    yield DatabaseClient(engine)
    engine.dispose()


def _store(db) -> PodRequestIdentityStore:
    return PodRequestIdentityStore(client=db)


def _row(db) -> dict:
    with db.engine.begin() as conn:
        return dict(
            conn.execute(text("SELECT * FROM personal_agent_registry WHERE user_id='u'"))
            .mappings()
            .one()
        )


def _execute(db, sql: str, params: dict | None = None) -> None:
    with db.engine.begin() as conn:
        conn.execute(text(sql), params or {})


def _bind(db, *, key=SIGNING_KEY, kid=KID, pod_pubkey="public", rotate=False) -> bool:
    return asyncio.run(
        _store(db).bind_signing_key(
            user_id="u",
            hushh_id="ha1_test",
            pod_pubkey=pod_pubkey,
            signing_pubkey=key,
            signing_key_id=kid,
            allow_rotation=rotate,
        )
    )


# -- the schema ------------------------------------------------------------------------


@pytest.mark.parametrize(
    "statement",
    [
        "UPDATE personal_agent_registry SET pod_signing_pubkey='A' || repeat('A',42) || '=', "
        "pod_signing_key_id='podk_wrong'",
        "UPDATE personal_agent_registry SET pod_signing_pubkey='not-base64', "
        "pod_signing_key_id='pods_' || repeat('a',32)",
        "UPDATE personal_agent_registry SET pod_signing_key_id='pods_' || repeat('a',32)",
        "UPDATE personal_agent_registry SET identity_mode='google'",
        "UPDATE personal_agent_registry SET pod_pubkey=NULL, "
        "pod_signing_pubkey='A' || repeat('A',42) || '=', "
        "pod_signing_key_id='pods_' || repeat('a',32)",
    ],
)
def test_the_schema_refuses_malformed_signing_state(db, statement):
    with pytest.raises(Exception, match="check"):
        _execute(db, statement)


def test_the_schema_accepts_a_well_formed_signing_key(db):
    _execute(
        db,
        "UPDATE personal_agent_registry SET pod_signing_pubkey='A' || repeat('A',42) || '=', "
        "pod_signing_key_id='pods_' || repeat('a',32), identity_mode='signed'",
    )
    assert _row(db)["identity_mode"] == "signed"


def test_the_rollback_removes_everything_and_947_reapplies(pg, db):
    pg.apply_file(MIGRATIONS / "rollback/947_pod_request_signing.rollback.sql")
    try:
        assert "pod_signing_key_id" not in _row(db)
        assert pg.execute("SELECT to_regclass('public.pod_request_nonces')") == [(None,)]
    finally:
        pg.apply_file(MIGRATIONS / "parked/947_pod_request_signing.sql")
    assert {"pod_signing_pubkey", "pod_signing_key_id", "identity_mode"} <= set(_row(db))


# -- the store -------------------------------------------------------------------------


def test_a_nonce_is_single_use_per_kid(db):
    store = _store(db)
    expires = int(time.time() * 1000) + 120_000
    nonce = "AAECAwQFBgcICQoLDA0ODw"
    assert asyncio.run(store.consume_nonce(kid=KID, nonce=nonce, expires_at_ms=expires))
    assert not asyncio.run(store.consume_nonce(kid=KID, nonce=nonce, expires_at_ms=expires))
    assert asyncio.run(store.consume_nonce(kid=OTHER_KID, nonce=nonce, expires_at_ms=expires))


def test_expired_nonces_are_pruned(db, monkeypatch):
    _execute(
        db,
        "INSERT INTO pod_request_nonces VALUES (:kid,'ZZZZZZZZZZZZZZZZZZZZZZ',now()-interval '1 minute')",
        {"kid": KID},
    )
    monkeypatch.setattr(store_module, "_LAST_PRUNE", [0.0])
    asyncio.run(
        _store(db).consume_nonce(
            kid=KID, nonce="AAECAwQFBgcICQoLDA0ODw", expires_at_ms=int(time.time() * 1000) + 60_000
        )
    )
    assert db.execute_raw("SELECT nonce FROM pod_request_nonces").data == [
        {"nonce": "AAECAwQFBgcICQoLDA0ODw"}
    ]


def test_the_pull_claim_is_one_per_row_per_interval(db):
    store = _store(db)
    now = 1_000_000_000_000
    assert asyncio.run(store.claim_key_pull(hushh_id="ha1_test", interval_ms=30_000, now_ms=now))
    assert not asyncio.run(
        store.claim_key_pull(hushh_id="ha1_test", interval_ms=30_000, now_ms=now + 29_999)
    )
    assert asyncio.run(
        store.claim_key_pull(hushh_id="ha1_test", interval_ms=30_000, now_ms=now + 30_000)
    )
    assert _row(db)["backend_metadata"]["signingKeyPull"] == now + 30_000
    assert _row(db)["backend_metadata"]["runtime_service_account"]  # nothing else touched


@pytest.mark.parametrize(
    "setup",
    [
        "UPDATE personal_agent_registry SET status='pending'",
        "UPDATE personal_agent_registry SET backend_metadata="
        "jsonb_set(backend_metadata,'{url}','\"http://pod.example\"')",
        "UPDATE personal_agent_registry SET backend_metadata="
        'backend_metadata || \'{"erasure":{"phase":"reserved"}}\'::jsonb',
    ],
)
def test_the_pull_claim_never_stamps_a_row_with_nothing_to_pull(db, setup):
    _execute(db, setup)
    assert not asyncio.run(
        _store(db).claim_key_pull(hushh_id="ha1_test", interval_ms=30_000, now_ms=1)
    )
    assert "signingKeyPull" not in _row(db)["backend_metadata"]


def test_the_signing_key_binds_only_to_the_recorded_pod_key(db):
    assert not _bind(db, pod_pubkey="another-pod-key")
    assert _bind(db)
    assert _bind(db)  # the same key again is a no-op success
    assert not _bind(db, key=OTHER_SIGNING_KEY, kid=OTHER_KID)
    assert _row(db)["pod_signing_key_id"] == KID
    assert _bind(db, key=OTHER_SIGNING_KEY, kid=OTHER_KID, rotate=True)
    assert _row(db)["pod_signing_key_id"] == OTHER_KID


def test_the_latch_needs_the_recorded_kid_and_sets_once(db):
    store = _store(db)
    assert _bind(db)
    assert not asyncio.run(store.latch_signed(hushh_id="ha1_test", kid=OTHER_KID))
    assert asyncio.run(store.latch_signed(hushh_id="ha1_test", kid=KID))
    assert not asyncio.run(store.latch_signed(hushh_id="ha1_test", kid=KID))
    assert _row(db)["identity_mode"] == "signed"


# -- the MCP transaction fence ---------------------------------------------------------


def test_the_mcp_fence_compares_the_signed_key_under_the_row_lock(db, monkeypatch):
    from hushh_mcp.services import pod_binding_service, pod_mcp_approval
    from hushh_mcp.services.action_directive_ledger import (
        ActionDirectiveAuthorityError,
        ActionDirectiveStore,
    )

    monkeypatch.setattr(pod_binding_service, "hub_environment", lambda: "dev")
    monkeypatch.setattr(
        ActionDirectiveStore, "hmac_key", property(lambda _: b"synthetic-ledger-key")
    )
    assert _bind(db)
    review = pod_mcp_approval.PodMcpTerms(
        ownerId="u",
        hushhId="ha1_test",
        podKeyId="podk_test",
        environment="dev",
        epoch=1,
        conversationId="private-thread",
        connectorId="custom_test",
        toolName="mcp_" + "a" * 40,
        callId="call",
        catalogRevision="rev1",
        commitment="b" * 64,
    )

    def issue(principal):
        return asyncio.run(
            pod_mcp_approval.mutate_review(
                "issue", pod_mcp_approval.PodMcpMutation(review=review), principal=principal, db=db
            )
        )

    assert issue(VerifiedPod("ha1_test", key_id=KID))["podReview"]["serviceUid"] == "uid-1"
    _bind(db, key=OTHER_SIGNING_KEY, kid=OTHER_KID, rotate=True)  # the pod key moved
    with pytest.raises(ActionDirectiveAuthorityError, match="runtime identity"):
        issue(VerifiedPod("ha1_test", key_id=KID))
    with pytest.raises(ActionDirectiveAuthorityError, match="runtime identity"):
        issue(VerifiedPod("ha1_test"))  # the managed fleet account never owner-binds
