"""Real PostgreSQL serialization of binding publication and device revocation."""

from __future__ import annotations

import asyncio
import json
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from sqlalchemy import create_engine, event, text

from db.db_client import DatabaseClient
from hushh_mcp.services.personal_agent_direct_admission import record_binding
from hushh_mcp.services.trusted_device_service import PostgresTrustedDeviceStore
from tests.pkm_conformance import postgres_harness

pytestmark = pytest.mark.skipif(
    postgres_harness.find_pg_bin() is None, reason="PostgreSQL unavailable"
)


@pytest.fixture(scope="module")
def pg():
    old = postgres_harness.MIGRATIONS
    postgres_harness.MIGRATIONS = []
    server = postgres_harness.TempPostgres()
    try:
        server.start()
        base = Path(__file__).resolve().parents[1] / "db/migrations"
        for name in (
            "parked/900_personal_agent_registry.sql",
            "parked/906_personal_agent_user_cloud.sql",
            "121_trusted_devices.sql",
        ):
            server.apply_file(base / name)
        yield server
    finally:
        postgres_harness.MIGRATIONS = old
        server.stop()


@pytest.fixture
def db(pg):
    engine = create_engine(f"postgresql+psycopg2://hushh@/postgres?host={pg.dir}&port={pg.port}")
    with engine.begin() as conn:
        conn.execute(text("DELETE FROM trusted_devices"))
        conn.execute(text("DELETE FROM personal_agent_registry"))
        conn.execute(
            text(
                "INSERT INTO personal_agent_registry (user_id,hushh_id,status,deployment_target,user_cloud_project,pod_key_id,pod_pubkey,backend_metadata) VALUES ('u','ha1_test','provisioned','user_gcp','synthetic-project','podk_test','public',CAST(:meta AS jsonb))"
            ),
            {
                "meta": json.dumps(
                    {
                        "url": "https://pod.example",
                        "serviceUid": "uid-1",
                        "bindings": {"other": {"version": 9}},
                        "retained": "keep",
                    }
                )
            },
        )
        conn.execute(
            text(
                "INSERT INTO trusted_devices (device_id,user_id,device_public_key,device_name,platform,created_at) VALUES ('tdv_test','u','device-public','Synthetic','web',1)"
            )
        )
    yield DatabaseClient(engine)
    engine.dispose()


def record(version=1):
    return {
        "version": version,
        "serviceUid": "uid-1",
        "envelope": {
            "binding": {
                "user_id": "u",
                "subject_id": "tdv_test",
                "subject_public_key": "device-public",
                "platform": "web",
                "hushh_id": "ha1_test",
                "deployment_target": "user_gcp",
                "pod_key_id": "podk_test",
                "pod_public_key": "public",
                "url": "https://pod.example",
                "version": version,
            }
        },
    }


def issue(db, version=1):
    return asyncio.run(
        record_binding(db, user_id="u", device_id="tdv_test", record=record(version))
    )


def revoke(db):
    store = PostgresTrustedDeviceStore.__new__(PostgresTrustedDeviceStore)
    store._db = db
    return store.revoke_device(user_id="u", device_id="tdv_test", now_ms=2)


def test_competing_issuers_publish_one_version_and_preserve_other_metadata(db):
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(lambda _: issue(db), range(2))) == [False, True]
    assert issue(db, 2)
    with db.engine.connect() as conn:
        meta = conn.execute(
            text("SELECT backend_metadata FROM personal_agent_registry WHERE user_id='u'")
        ).scalar_one()
    assert meta["bindings"]["tdv_test"]["version"] == 2
    assert meta["bindings"]["other"] == {"version": 9}
    assert meta["retained"] == "keep"


def test_revocation_commit_while_issuer_waits_prevents_publication(db):
    reached_device = threading.Event()

    def observe(_conn, _cursor, statement, _params, _context, _many):
        if statement.startswith("SELECT device_public_key"):
            reached_device.set()

    event.listen(db.engine, "before_cursor_execute", observe)
    try:
        with db.engine.connect() as conn, ThreadPoolExecutor(max_workers=1) as pool:
            tx = conn.begin()
            conn.execute(
                text("UPDATE trusted_devices SET status='revoked' WHERE device_id='tdv_test'")
            )
            result = pool.submit(issue, db)
            assert reached_device.wait(5)
            tx.commit()
            assert result.result(timeout=5) is False
    finally:
        event.remove(db.engine, "before_cursor_execute", observe)


def test_issuer_commit_precedes_waiting_revoke_and_ceiling_is_retained(db):
    publishing = threading.Event()
    release = threading.Event()
    revoking = threading.Event()

    def hold(_conn, _cursor, statement, _params, _context, _many):
        if statement.startswith("UPDATE personal_agent_registry"):
            publishing.set()
            assert release.wait(5)
        elif statement.startswith("UPDATE trusted_devices"):
            revoking.set()

    event.listen(db.engine, "before_cursor_execute", hold)
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            issued = pool.submit(issue, db)
            assert publishing.wait(5)
            revoked = pool.submit(revoke, db)
            assert revoking.wait(5)
            release.set()
            assert issued.result(timeout=5) is True
            assert revoked.result(timeout=5) is True
        assert issue(db, 2) is False
        with db.engine.connect() as conn:
            assert (
                conn.execute(
                    text(
                        "SELECT backend_metadata->'bindings'->'tdv_test'->>'version' FROM personal_agent_registry WHERE user_id='u'"
                    )
                ).scalar_one()
                == "1"
            )
    finally:
        release.set()
        event.remove(db.engine, "before_cursor_execute", hold)


@pytest.mark.parametrize("changed", ["key", "pod", "erasure"])
def test_changed_authority_refuses_signed_candidate(db, changed):
    with db.engine.begin() as conn:
        if changed == "key":
            conn.execute(text("UPDATE trusted_devices SET device_public_key='replaced'"))
        elif changed == "pod":
            conn.execute(text("UPDATE personal_agent_registry SET pod_key_id='replaced'"))
        else:
            conn.execute(
                text(
                    "UPDATE personal_agent_registry SET backend_metadata=backend_metadata || '{\"erasure\":{}}'::jsonb"
                )
            )
    assert issue(db) is False


def test_canonical_trailing_slash_url_is_accepted(db):
    with db.engine.begin() as conn:
        conn.execute(
            text(
                "UPDATE personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,'{url}','\" https://pod.example/ \"'::jsonb)"
            )
        )
    assert issue(db)


def test_database_failure_is_sanitized():
    from contextlib import contextmanager
    from types import SimpleNamespace

    from sqlalchemy.exc import OperationalError

    from db.db_client import DatabaseExecutionError

    @contextmanager
    def unavailable():
        raise OperationalError(
            "synthetic SQL", {"sensitive": "must-not-leak"}, Exception("driver details")
        )
        yield

    broken = SimpleNamespace(engine=SimpleNamespace(begin=unavailable))
    with pytest.raises(DatabaseExecutionError) as caught:
        issue(broken)
    assert caught.value.code == "POD_BINDING_STORAGE_UNAVAILABLE"
    assert "must-not-leak" not in str(caught.value)
    assert caught.value.__suppress_context__ is True


def test_courier_acknowledgment_preserves_concurrent_append_and_unknown_entries(db):
    from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo

    repo = PersonalAgentRegistryRepo()
    repo._db = lambda: db
    a = {"intent": {"intentId": "a"}}
    b = {"intent": {"intentId": "b"}}
    asyncio.run(repo.append_pending_tombstone(user_id="u", entry=a))
    clearing = threading.Event()

    def observe(conn, cursor, statement, parameters, context, executemany):
        if "jsonb_agg(item ORDER BY ordinal)" in statement:
            clearing.set()

    event.listen(db.engine, "before_cursor_execute", observe)
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            with db.engine.begin() as conn:
                # Hold the row with an append that has not committed when clear
                # starts. Its UPDATE must filter the row after our commit.
                conn.execute(
                    text(
                        "UPDATE personal_agent_registry SET backend_metadata = "
                        "jsonb_set(backend_metadata, '{pendingTombstones}', "
                        "backend_metadata->'pendingTombstones' || CAST(:entries AS jsonb)) "
                        "WHERE user_id='u'"
                    ),
                    {"entries": json.dumps([b, {"unknown": True}])},
                )
                future = pool.submit(
                    lambda: asyncio.run(
                        repo.clear_pending_tombstones(hushh_id="ha1_test", intent_ids=["a"])
                    )
                )
                assert clearing.wait(5)
            future.result(timeout=5)
        row = asyncio.run(repo.get("u"))
        assert row["backend_metadata"]["pendingTombstones"] == [b, {"unknown": True}]
        assert row["backend_metadata"]["retained"] == "keep"
        asyncio.run(repo.clear_pending_tombstones(hushh_id="ha1_test", intent_ids=["a"]))
        assert asyncio.run(repo.get("u"))["backend_metadata"] == row["backend_metadata"]
    finally:
        event.remove(db.engine, "before_cursor_execute", observe)
