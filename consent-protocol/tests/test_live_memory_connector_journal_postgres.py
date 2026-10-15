"""Real Postgres evidence for commit ordering, retention and owner deletion."""

# ruff: noqa: F811 -- imported pytest fixture has the test argument's name

from __future__ import annotations

import asyncio
import hashlib
import json
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine, text

from hushh_mcp.services.source_journal_service import SourceJournalService
from tests.services.test_external_connector_lifecycle_postgres import (
    connector_postgres_url,  # noqa: F401
)

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "db/migrations/342_live_memory_connector_journal.sql"
ROLLBACK = ROOT / "db/migrations/rollback/342_live_memory_connector_journal.rollback.sql"


def _apply(engine, path: Path) -> None:
    with engine.begin() as connection:
        connection.exec_driver_sql(path.read_text(), execution_options={"no_parameters": True})


def _rows(engine, owner: str) -> list[dict]:
    owner_hash = "sha256:" + hashlib.sha256(owner.encode("utf-8")).hexdigest()
    with engine.connect() as connection:
        return [
            dict(row)
            for row in connection.execute(
                text("""SELECT sequence, source_id, operation FROM live_memory_connector_events
                        WHERE owner_hash=:owner_hash ORDER BY sequence"""),
                {"owner_hash": owner_hash},
            ).mappings()
        ]


def _read(engine, owner: str, after: int = 0, limit: int = 100) -> dict:
    return asyncio.run(
        SourceJournalService(SimpleNamespace(engine=engine)).connector_events(
            user_id=owner, after=after, limit=limit
        )
    )


def test_connector_journal_atomic_owner_only_replay_and_erasure(
    connector_postgres_url, monkeypatch
):
    # The fixture creates a disposable database with its own public schema;
    # This migration intentionally targets public, as production does.
    engine = create_engine(connector_postgres_url)
    with engine.begin() as connection:
        connection.exec_driver_sql(
            "CREATE TABLE external_mcp_connectors ("
            "connector_id TEXT PRIMARY KEY, user_id TEXT, auth_style TEXT NOT NULL)"
        )
        connection.exec_driver_sql(
            "CREATE TABLE user_external_connector_connections ("
            "user_id TEXT NOT NULL, connector_id TEXT NOT NULL, status TEXT NOT NULL, "
            "connected_at TIMESTAMPTZ, credential_ciphertext TEXT, connected_account_label TEXT, "
            "PRIMARY KEY (user_id, connector_id))"
        )
        connection.exec_driver_sql(
            "CREATE TABLE account_deletion_tombstones (user_id_hash TEXT PRIMARY KEY)"
        )
        connection.exec_driver_sql("CREATE TABLE actor_profiles (user_id TEXT PRIMARY KEY)")
        connection.exec_driver_sql("CREATE TABLE vault_keys (user_id TEXT PRIMARY KEY)")
        connection.execute(
            text("""INSERT INTO external_mcp_connectors VALUES
                 ('google_drive',NULL,'oauth'),('private','owner-1','oauth'),
                 ('api_key',NULL,'api_key')""")
        )
    _apply(engine, MIGRATION)
    _apply(engine, MIGRATION)  # release replay is mandatory
    with engine.connect() as connection:
        function = connection.execute(
            text("""SELECT p.prosecdef, p.proconfig,
                 n.nspname, r.rolname
            FROM pg_proc p
            JOIN pg_namespace n ON n.oid=p.pronamespace
            JOIN pg_roles r ON r.oid=p.proowner
            WHERE p.oid='public.append_live_memory_connector_event()'::regprocedure""")
        ).one()
        assert function.prosecdef is True
        assert any(
            setting.replace(" ", "") == "search_path=pg_catalog,public"
            for setting in function.proconfig
        )
        assert function.nspname == "public"
        assert function.rolname == connection.execute(text("SELECT current_user")).scalar_one()
        assert (
            connection.execute(
                text("""SELECT bool_and(relrowsecurity)
            FROM pg_class WHERE oid IN (
                'public.live_memory_connector_streams'::regclass,
                'public.live_memory_connector_events'::regclass
            )""")
            ).scalar_one()
            is True
        )

    with engine.begin() as connection:
        connection.execute(
            text("""INSERT INTO user_external_connector_connections
                (user_id,connector_id,status,credential_ciphertext,connected_account_label)
                VALUES ('owner-1','google_drive','connected','secret-token','private@example.com'),
                       ('owner-1','private','connected','private-secret','private@example.com'),
                       ('owner-1','api_key','connected','api-secret','private@example.com')""")
        )
    assert _rows(engine, "owner-1") == [
        {"sequence": 1, "source_id": "google_drive", "operation": "changed"}
    ]
    assert _read(engine, "someone-else")["events"] == []
    page = _read(engine, "owner-1")
    assert page["events"][0]["sourceId"] == "google_drive"
    assert page["events"][0]["sequence"] == "1"
    assert page["headCursor"] == "1"
    assert "secret-token" not in json.dumps(page)
    assert "private@example.com" not in json.dumps(page)

    with engine.begin() as connection:
        connection.execute(
            text("""UPDATE user_external_connector_connections
            SET credential_ciphertext='new-secret',connected_account_label='new-label'
            WHERE user_id='owner-1' AND connector_id='google_drive'""")
        )
        connection.execute(
            text("""UPDATE user_external_connector_connections
            SET status='connected' WHERE user_id='owner-1' AND connector_id='google_drive'""")
        )
    assert len(_rows(engine, "owner-1")) == 1

    # Source and outbox roll back together, including sequence allocation.
    with pytest.raises(RuntimeError, match="rollback"):
        with engine.begin() as connection:
            connection.execute(
                text("""UPDATE user_external_connector_connections
                SET status='verifying' WHERE user_id='owner-1' AND connector_id='google_drive'""")
            )
            raise RuntimeError("rollback")
    assert len(_rows(engine, "owner-1")) == 1
    with engine.begin() as connection:
        connection.execute(
            text("""UPDATE user_external_connector_connections
            SET status='revoked' WHERE user_id='owner-1' AND connector_id='google_drive'""")
        )
        connection.execute(
            text("""DELETE FROM user_external_connector_connections
            WHERE user_id='owner-1' AND connector_id='google_drive'""")
        )
    assert [row["sequence"] for row in _rows(engine, "owner-1")] == [1, 2, 3]
    assert _rows(engine, "owner-1")[-1]["operation"] == "deleted"

    # Two transactions on different source rows cannot commit 2 before 1.
    with engine.begin() as connection:
        connection.execute(
            text("""INSERT INTO external_mcp_connectors
            VALUES ('oauth-two',NULL,'oauth')""")
        )
        connection.execute(
            text("""INSERT INTO user_external_connector_connections
            (user_id,connector_id,status) VALUES
            ('owner-1','google_drive','revoked'),('owner-1','oauth-two','revoked')""")
        )
    ready = Event()
    release = Event()
    second_attempt = Event()
    second_pid: int | None = None

    def first_transaction() -> None:
        with engine.begin() as connection:
            connection.execute(
                text("""UPDATE user_external_connector_connections
                SET status='connected' WHERE user_id='owner-1' AND connector_id='google_drive'""")
            )
            ready.set()
            assert release.wait(5)

    def second_transaction() -> None:
        nonlocal second_pid
        assert ready.wait(5)
        with engine.begin() as connection:
            second_pid = connection.execute(text("SELECT pg_backend_pid()")).scalar_one()
            second_attempt.set()
            connection.execute(
                text("""UPDATE user_external_connector_connections
                SET status='connected' WHERE user_id='owner-1' AND connector_id='oauth-two'""")
            )

    with ThreadPoolExecutor(max_workers=2) as executor:
        first = executor.submit(first_transaction)
        second = executor.submit(second_transaction)
        try:
            assert second_attempt.wait(5)
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                with engine.connect() as connection:
                    waiting = connection.execute(
                        text("""SELECT wait_event_type='Lock'
                        FROM pg_stat_activity WHERE pid=:pid"""),
                        {"pid": second_pid},
                    ).scalar_one()
                if waiting:
                    break
                time.sleep(0.01)
            else:
                pytest.fail("second owner transaction never waited on the journal stream lock")
            assert not second.done()
        finally:
            release.set()
        first.result(timeout=5)
        second.result(timeout=5)
    sequences = [row["sequence"] for row in _rows(engine, "owner-1")]
    assert sequences == list(range(1, len(sequences) + 1))
    assert _read(engine, "owner-1", after=3)["resetRequired"] is False

    # Bounded retention preserves a durable floor and explicitly resets laggards.
    with engine.begin() as connection:
        for index in range(2050):
            connection.execute(
                text("""UPDATE user_external_connector_connections SET status=:status
                        WHERE user_id='owner-1' AND connector_id='oauth-two'"""),
                {"status": "verifying" if index % 2 else "connected"},
            )
    retained = _rows(engine, "owner-1")
    assert len(retained) == 2048
    assert retained[-1]["sequence"] - retained[0]["sequence"] == 2047
    reset = _read(engine, "owner-1", after=0)
    assert reset["resetRequired"] is True
    assert reset["events"] == []
    assert reset["earliestCursor"] == str(retained[0]["sequence"] - 1)
    resumed = _read(engine, "owner-1", after=retained[0]["sequence"] - 1, limit=1)
    assert resumed["resetRequired"] is False
    assert resumed["hasMore"] is True
    with engine.begin() as connection:
        connection.execute(
            text("""DELETE FROM public.live_memory_connector_events
                WHERE owner_hash='sha256:' || encode(digest('owner-1','sha256'),'hex')
                  AND sequence=:sequence"""),
            {"sequence": retained[0]["sequence"] + 1},
        )
    assert _read(engine, "owner-1", after=retained[0]["sequence"] - 1)["resetRequired"] is True

    # Erasure's tombstone suppresses a late source deletion append; account
    # cleanup then removes both the retained rows and cursor head.
    with engine.begin() as connection:
        connection.execute(
            text("""INSERT INTO account_deletion_tombstones
            SELECT 'sha256:' || encode(digest('owner-1','sha256'),'hex')""")
        )
        before = connection.execute(
            text("""SELECT last_sequence
            FROM live_memory_connector_streams
            WHERE owner_hash='sha256:' || encode(digest('owner-1','sha256'),'hex')""")
        ).scalar_one()
        connection.execute(
            text("""DELETE FROM user_external_connector_connections
            WHERE user_id='owner-1'""")
        )
        after = connection.execute(
            text("""SELECT last_sequence
            FROM live_memory_connector_streams
            WHERE owner_hash='sha256:' || encode(digest('owner-1','sha256'),'hex')""")
        ).scalar_one()
        assert after == before

    import hushh_mcp.services.account_service as account_module
    import hushh_mcp.services.drive_sharing_retention as retention_module

    monkeypatch.setattr(account_module, "lock_connection_graph_users", lambda *a, **k: None)
    monkeypatch.setattr(
        retention_module, "erase_drive_account_in_transaction", lambda *a, **k: None
    )
    results: dict[str, bool] = {}
    with engine.begin() as connection:
        account_module.AccountService._clear_external_connector_data(
            connection, "owner-1", results, permanent=True
        )
    assert results["live_memory_connector_journal"] is True
    assert _rows(engine, "owner-1") == []
    assert _read(engine, "owner-1")["headCursor"] == "0"

    # A rolling old runtime does not know the journal tables. Deleting either
    # full-account root still purges its committed hints in the database.
    with engine.begin() as connection:
        connection.execute(text("""INSERT INTO actor_profiles VALUES ('owner-2')"""))
        connection.execute(
            text("""INSERT INTO user_external_connector_connections
            (user_id,connector_id,status) VALUES ('owner-2','google_drive','connected')""")
        )
    assert _read(engine, "owner-2")["headCursor"] == "1"
    with engine.begin() as connection:
        connection.execute(
            text("""INSERT INTO account_deletion_tombstones
            SELECT 'sha256:' || encode(digest('owner-2','sha256'),'hex')""")
        )
        connection.execute(text("DELETE FROM actor_profiles WHERE user_id='owner-2'"))
        connection.execute(
            text("""DELETE FROM user_external_connector_connections
            WHERE user_id='owner-2'""")
        )
    assert _rows(engine, "owner-2") == []
    assert _read(engine, "owner-2")["headCursor"] == "0"

    # Legacy accounts can have a vault root without an actor profile.
    with engine.begin() as connection:
        connection.execute(text("INSERT INTO vault_keys VALUES ('owner-3')"))
        connection.execute(
            text("""INSERT INTO user_external_connector_connections
                (user_id,connector_id,status)
                VALUES ('owner-3','google_drive','connected')""")
        )
    assert _read(engine, "owner-3")["headCursor"] == "1"
    with engine.begin() as connection:
        connection.execute(
            text("""INSERT INTO account_deletion_tombstones
                SELECT 'sha256:' || encode(digest('owner-3','sha256'),'hex')""")
        )
        connection.execute(text("DELETE FROM vault_keys WHERE user_id='owner-3'"))
        connection.execute(
            text("""DELETE FROM user_external_connector_connections
                WHERE user_id='owner-3'""")
        )
    assert _rows(engine, "owner-3") == []
    assert _read(engine, "owner-3")["headCursor"] == "0"

    # Reset erases content but never reuses an old cursor. The source cleanup
    # emits a deleted hint first, which the reset removes in the same txn.
    with engine.begin() as connection:
        connection.execute(
            text("""INSERT INTO user_external_connector_connections
                (user_id,connector_id,status)
                VALUES ('owner-4','google_drive','connected')""")
        )
        connection.execute(
            text("""UPDATE user_external_connector_connections SET status='revoked'
                WHERE user_id='owner-4' AND connector_id='google_drive'""")
        )
    old_cursor = int(_read(engine, "owner-4")["headCursor"])
    assert old_cursor == 2

    def erase_owner_sources(connection, *, user_id, permanent):
        connection.execute(
            text("DELETE FROM user_external_connector_connections WHERE user_id=:user_id"),
            {"user_id": user_id},
        )

    monkeypatch.setattr(retention_module, "erase_drive_account_in_transaction", erase_owner_sources)
    with engine.begin() as connection:
        account_module.AccountService._clear_external_connector_data(
            connection, "owner-4", {}, permanent=False
        )
    assert _rows(engine, "owner-4") == []
    after_reset = _read(engine, "owner-4", after=old_cursor)
    assert after_reset["resetRequired"] is True
    assert after_reset["events"] == []
    watermark = int(after_reset["headCursor"])
    assert int(after_reset["earliestCursor"]) == watermark
    assert _read(engine, "owner-4", after=watermark)["resetRequired"] is False

    with engine.begin() as connection:
        connection.execute(
            text("""INSERT INTO user_external_connector_connections
                (user_id,connector_id,status)
                VALUES ('owner-4','google_drive','connected')""")
        )
        connection.execute(
            text("""UPDATE user_external_connector_connections SET status='revoked'
                WHERE user_id='owner-4' AND connector_id='google_drive'""")
        )
    assert _read(engine, "owner-4", after=old_cursor)["resetRequired"] is True
    fresh = _read(engine, "owner-4", after=watermark)
    assert fresh["resetRequired"] is False
    assert [int(event["sequence"]) for event in fresh["events"]] == [
        watermark + 1,
        watermark + 2,
    ]

    with engine.begin() as connection:
        for index in range(2050):
            connection.execute(
                text("""UPDATE user_external_connector_connections SET status=:status
                    WHERE user_id='owner-4' AND connector_id='google_drive'"""),
                {"status": "connected" if index % 2 == 0 else "revoked"},
            )
    retained_after_reset = _rows(engine, "owner-4")
    assert len(retained_after_reset) == 2048
    assert retained_after_reset[-1]["sequence"] - retained_after_reset[0]["sequence"] == 2047
    assert _read(engine, "owner-4", after=old_cursor)["resetRequired"] is True
    assert (
        _read(engine, "owner-4", after=retained_after_reset[0]["sequence"] - 1)["resetRequired"]
        is False
    )

    # A reset still establishes a barrier for a pre-migration owner whose
    # encrypted client memory exists but no connector journal row does yet.
    assert _read(engine, "owner-5")["headCursor"] == "0"
    with engine.begin() as connection:
        account_module.AccountService._clear_external_connector_data(
            connection, "owner-5", {}, permanent=False
        )
    reset_without_prior_stream = _read(engine, "owner-5", after=0)
    assert reset_without_prior_stream["resetRequired"] is True
    assert reset_without_prior_stream["headCursor"] == "1"
    assert reset_without_prior_stream["earliestCursor"] == "1"
    with engine.begin() as connection:
        connection.execute(
            text("""INSERT INTO user_external_connector_connections
                (user_id,connector_id,status)
                VALUES ('owner-5','google_drive','connected')""")
        )
    assert _read(engine, "owner-5", after=0)["resetRequired"] is True
    assert _read(engine, "owner-5", after=1)["events"][0]["sequence"] == "2"

    _apply(engine, ROLLBACK)
    engine.dispose()
