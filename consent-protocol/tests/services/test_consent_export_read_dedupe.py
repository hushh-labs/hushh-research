"""Export audit dedupe uses a database transaction across independent workers."""

import asyncio
import json
from contextlib import contextmanager
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine, text

from db.db_client import DatabaseClient
from hushh_mcp.services import consent_db
from hushh_mcp.services.consent_db import ConsentDBService


@pytest.fixture
def ledger(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{tmp_path / 'audit.db'}")
    with engine.begin() as connection:
        connection.execute(
            text("""CREATE TABLE consent_audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT, token_id TEXT, user_id TEXT,
            agent_id TEXT, scope TEXT, action TEXT, request_id TEXT,
            issued_at BIGINT, metadata TEXT)""")
        )
    clock = {"now": 1_800_000_000.0}
    monkeypatch.setattr(consent_db.time, "time", lambda: clock["now"])

    def service():
        instance = ConsentDBService()
        monkeypatch.setattr(instance, "_get_db", lambda: DatabaseClient(engine=engine))
        return instance

    yield service, engine, clock
    engine.dispose()


def read_args(**overrides):
    return {
        "user_id": "owner",
        "agent_id": "one_person:requester",
        "scope": "attr.identity.legal_name",
        "request_id": "request",
        "metadata": {"requester_label": "Requester", "bundle_id": "bundle", "export_revision": 3},
        **overrides,
    }


@pytest.mark.asyncio
async def test_concurrent_workers_insert_one_row_with_identity_metadata(ledger):
    service, engine, _ = ledger
    results = await asyncio.gather(
        *(service().record_export_read_once(**read_args()) for _ in range(16))
    )
    assert sum(result is not None for result in results) == 1
    with engine.connect() as connection:
        row = connection.execute(text("SELECT * FROM consent_audit")).mappings().one()
    assert row["action"] == "EXPORT_READ"
    assert row["agent_id"] == "one_person:requester"
    assert json.loads(row["metadata"]) == read_args()["metadata"]


@pytest.mark.asyncio
async def test_window_is_rolling_and_includes_exact_hour_boundary(ledger):
    service, _, clock = ledger
    writer = service()
    assert await writer.record_export_read_once(**read_args()) is not None
    clock["now"] += 3599.999
    assert await writer.record_export_read_once(**read_args()) is None
    clock["now"] += 0.001
    assert await writer.record_export_read_once(**read_args()) is not None
    # Suppressed reads do not move the window; new committed reads do.
    clock["now"] += 1
    assert await writer.record_export_read_once(**read_args()) is None


@pytest.mark.asyncio
async def test_dedupe_separates_owners_and_requests(ledger):
    service, _, _ = ledger
    writer = service()
    for overrides in ({}, {"user_id": "other"}, {"request_id": "other"}):
        assert await writer.record_export_read_once(**read_args(**overrides)) is not None
        assert await writer.record_export_read_once(**read_args(**overrides)) is None


@pytest.mark.asyncio
async def test_failed_insert_rolls_back_and_does_not_suppress_retry(ledger):
    service, engine, _ = ledger
    with engine.begin() as connection:
        connection.execute(
            text("""CREATE TRIGGER reject_read BEFORE INSERT ON consent_audit
            BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END""")
        )
    with pytest.raises(Exception, match="synthetic audit failure"):
        await service().record_export_read_once(**read_args())
    with engine.begin() as connection:
        connection.execute(text("DROP TRIGGER reject_read"))
    assert await service().record_export_read_once(**read_args()) is not None


@pytest.mark.asyncio
async def test_postgres_locks_before_lookup_and_insert_in_same_transaction(monkeypatch):
    calls = []

    class Connection:
        dialect = SimpleNamespace(name="postgresql")

        def execute(self, statement, params):
            calls.append((str(statement), params))
            return SimpleNamespace(scalar_one_or_none=lambda: None, scalar_one=lambda: 7)

    @contextmanager
    def begin():
        yield Connection()
        calls.append(("COMMIT", {}))

    service = ConsentDBService()
    monkeypatch.setattr(
        service, "_get_db", lambda: SimpleNamespace(engine=SimpleNamespace(begin=begin))
    )
    assert await service.record_export_read_once(**read_args()) == 7
    assert "pg_advisory_xact_lock" in calls[0][0]
    assert json.loads(calls[0][1]["key"].removeprefix("export-read:")) == ["owner", "request"]
    assert "SELECT issued_at" in calls[1][0]
    assert "INSERT INTO consent_audit" in calls[2][0]
    assert calls[3][0] == "COMMIT"
