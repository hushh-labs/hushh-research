"""Real PostgreSQL ordering for renewable private-agent consent authority."""

from __future__ import annotations

# ruff: noqa: S106, S107 -- synthetic ledger labels, never usable credentials.
import json
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event
from types import SimpleNamespace
from unittest.mock import AsyncMock

import psycopg2
import pytest

from tests.pkm_conformance import postgres_harness
from tests.pkm_conformance.postgres_harness import TempPostgres, find_pg_bin

pytestmark = pytest.mark.skipif(find_pg_bin() is None, reason="PostgreSQL binaries unavailable")
ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "db/migrations/parked/915_personal_agent_renewal_authority.sql"


@pytest.fixture
def pg(monkeypatch):
    monkeypatch.setattr(postgres_harness, "MIGRATIONS", [])
    server = TempPostgres()
    try:
        server.start()
        schema = (ROOT / "db/legacy/init_legacy_schema.sql").read_text()
        table = schema.split("CREATE TABLE IF NOT EXISTS consent_audit (", 1)[1].split(";", 1)[0]
        server.execute("CREATE TABLE IF NOT EXISTS consent_audit (" + table)
        server.execute("CREATE TABLE IF NOT EXISTS actor_profiles (user_id TEXT PRIMARY KEY)")
        server.apply_file(ROOT / "db/migrations/201_account_deletion_tombstones.sql")
        server.apply_file(MIGRATION)
        yield server
    finally:
        server.stop()


def event(
    action="CONSENT_GRANTED", *, automatic=True, owner="synthetic-owner", token="grant", **extra
):
    return {
        "user_id": owner,
        "agent_id": "personal_agent",
        "scope": "pkm.read",
        "action": action,
        "token_id": token,
        "issued_at": 100,
        "metadata": json.dumps({"automatic_renewal": automatic}),
        **extra,
    }


def insert(conn, item, *, renewal=False):
    with conn.cursor() as cursor:
        if renewal:
            cursor.execute(
                "SELECT id FROM insert_personal_agent_renewal(%s::jsonb)", (json.dumps(item),)
            )
        else:
            cursor.execute(
                """INSERT INTO consent_audit
                   (user_id,agent_id,scope,action,token_id,issued_at,expires_at,metadata)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s::jsonb) RETURNING id""",
                tuple(
                    item.get(k)
                    for k in (
                        "user_id",
                        "agent_id",
                        "scope",
                        "action",
                        "token_id",
                        "issued_at",
                        "expires_at",
                        "metadata",
                    )
                ),
            )
        return cursor.fetchone()[0]


def connect(pg, **kwargs):
    return psycopg2.connect(
        host=str(pg.dir), port=pg.port, user="hushh", dbname="postgres", **kwargs
    )


@pytest.mark.parametrize("denial", ["REVOKED", "CONSENT_DENIED"])
def test_revocation_blocks_renewal_until_explicit_reapproval(pg, denial):
    with connect(pg) as conn:
        insert(conn, event(), renewal=True)
        insert(conn, event(denial, token="denial"))
    with connect(pg) as conn, pytest.raises(psycopg2.errors.InsufficientPrivilege):
        insert(conn, event(token="replacement"), renewal=True)
    with connect(pg) as conn:
        insert(conn, event(automatic=False, token="owner-approved"))
        insert(conn, event(token="renewed"), renewal=True)
    assert pg.execute("SELECT token_id FROM consent_audit ORDER BY issued_at DESC LIMIT 1") == [
        ("renewed",)
    ]


def test_expiry_is_renewable_but_stale_expiry_cannot_override_revoke(pg):
    expiry = json.dumps({"reason": "expired", "source": "consent_revocation_worker"})
    with connect(pg) as conn:
        insert(conn, event(expires_at=1), renewal=True)
        insert(conn, event("REVOKED", expires_at=1, metadata=expiry))
        insert(conn, event(token="renewed", expires_at=1), renewal=True)
        insert(conn, event("REVOKED", token="owner-revoke"))
    with connect(pg) as conn, pytest.raises(psycopg2.errors.SerializationFailure):
        insert(conn, event("REVOKED", token="renewed", expires_at=1, metadata=expiry))
    with connect(pg) as conn, pytest.raises(psycopg2.errors.InsufficientPrivilege):
        insert(conn, event(token="resurrected"), renewal=True)


def test_missing_guard_refuses_instead_of_using_plain_insert(pg):
    pg.execute("ALTER TABLE consent_audit DISABLE TRIGGER zz_personal_agent_renewal_authority")
    with connect(pg) as conn, pytest.raises(psycopg2.errors.InsufficientPrivilege):
        insert(conn, event(), renewal=True)
    assert pg.execute("SELECT count(*) FROM consent_audit") == [(0,)]


@pytest.mark.parametrize("account_deletion", [False, True])
def test_inflight_revocation_serializes_renewal_without_affecting_another_owner(
    pg, account_deletion
):
    pg.execute("INSERT INTO actor_profiles(user_id) VALUES ('synthetic-owner')")
    with connect(pg) as conn:
        insert(conn, event(), renewal=True)
    revoker = connect(pg)
    started = Event()
    pool = ThreadPoolExecutor(max_workers=1)
    try:
        if account_deletion:
            with revoker.cursor() as cursor:
                cursor.execute("DELETE FROM actor_profiles WHERE user_id='synthetic-owner'")
        else:
            insert(revoker, event("REVOKED", token="owner-revoke"))

        def renew():
            with connect(pg, application_name="private-renewal-race") as conn:
                started.set()
                error = (
                    psycopg2.errors.CheckViolation
                    if account_deletion
                    else psycopg2.errors.InsufficientPrivilege
                )
                with pytest.raises(error):
                    insert(conn, event(token="racing-renewal"), renewal=True)

        result = pool.submit(renew)
        assert started.wait(5)
        deadline = time.monotonic() + 5
        while not pg.execute(
            "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='private-renewal-race' AND wait_event_type='Lock')"
        )[0][0]:
            assert time.monotonic() < deadline, "renewal never reached the lock"
            time.sleep(0.01)
        with connect(pg) as conn:
            insert(conn, event(owner="other-owner"), renewal=True)
        revoker.commit()
        result.result(timeout=5)
    finally:
        revoker.rollback()
        revoker.close()
        pool.shutdown(wait=True)
    assert pg.execute("SELECT count(*) FROM consent_audit WHERE token_id='racing-renewal'") == [
        (0,)
    ]


@pytest.mark.asyncio
async def test_existing_ledger_adapter_uses_guard_and_receipts_persisted_order(pg, monkeypatch):
    from sqlalchemy import create_engine, text

    from hushh_mcp.services import consent_audit_chain_service
    from hushh_mcp.services.consent_db import ConsentDBService

    engine = create_engine(f"postgresql+psycopg2://hushh@/postgres?host={pg.dir}&port={pg.port}")

    class Database:
        def execute_raw(self, sql, params):
            with engine.begin() as conn:
                return SimpleNamespace(
                    data=[dict(row) for row in conn.execute(text(sql), params).mappings()]
                )

        def table(self, _name):
            raise AssertionError("automatic issuance must not fall back to ordinary INSERT")

    receipt = AsyncMock()
    monkeypatch.setattr(consent_audit_chain_service, "append_consent_receipt_safe", receipt)
    ledger = ConsentDBService()
    monkeypatch.setattr(ledger, "_get_db", lambda: Database())
    args = dict(
        user_id="synthetic-owner",
        agent_id="personal_agent",
        scope="pkm.read",
        action="CONSENT_GRANTED",
        token_id="synthetic-token",
        metadata={"automatic_renewal": True},
    )
    try:
        await ledger.insert_event(**args)
        saved = pg.execute("SELECT issued_at FROM consent_audit WHERE token_id='synthetic-token'")[
            0
        ][0]
        assert receipt.call_args.kwargs["issued_at_ms"] == saved
        with connect(pg) as conn:
            insert(conn, event("REVOKED", token="owner-revoke"))
        receipt.reset_mock()
        with pytest.raises(PermissionError, match="renewal authority unavailable"):
            await ledger.insert_event(**args)
        receipt.assert_not_awaited()
        assert pg.execute(
            "SELECT count(*) FROM consent_audit WHERE token_id='synthetic-token'"
        ) == [(1,)]
    finally:
        engine.dispose()


@pytest.mark.asyncio
async def test_denial_cannot_reuse_an_older_unexpired_grant(pg, monkeypatch):
    from sqlalchemy import create_engine

    from db.db_client import DatabaseClient
    from hushh_mcp.services import personal_agent_grant_service as grants
    from hushh_mcp.services.consent_db import ConsentDBService

    expiry = int(time.time() * 1000) + 86400000
    with connect(pg) as conn:
        insert(conn, event(token="old", expires_at=expiry), renewal=True)
        insert(conn, event("CONSENT_DENIED", token="denial"))
    engine = create_engine(f"postgresql+psycopg2://hushh@/postgres?host={pg.dir}&port={pg.port}")
    ledger = ConsentDBService()
    monkeypatch.setattr(ledger, "_get_db", lambda: DatabaseClient(engine))
    monkeypatch.setattr(grants, "personal_agent_enabled", lambda: True)
    monkeypatch.setattr(
        grants, "issue_token", lambda **_: SimpleNamespace(token="candidate", expires_at=expiry)
    )
    validator = AsyncMock(return_value=(True, None, object()))
    try:
        assert (
            await ledger.get_active_tokens(
                "synthetic-owner", agent_id="personal_agent", scope="pkm.read"
            )
            == []
        )
        assert not await ledger.is_token_active(
            "synthetic-owner", "pkm.read", "personal_agent", token_id="old"
        )
        with pytest.raises(PermissionError, match="renewal authority unavailable"):
            await grants.PersonalAgentGrantService().issue_or_reuse_standing_pkm_read(
                "synthetic-owner",
                ledger=ledger,
                lookup=ledger.get_active_tokens,
                validator=validator,
            )
        validator.assert_not_awaited()
        assert pg.execute("SELECT count(*) FROM consent_audit WHERE token_id='candidate'") == [(0,)]
    finally:
        engine.dispose()


@pytest.mark.asyncio
@pytest.mark.parametrize("later_insert_issued_at", [100, 200])
async def test_historical_event_order_uses_timestamp_then_id(
    pg, monkeypatch, later_insert_issued_at
):
    from sqlalchemy import create_engine

    from db.db_client import DatabaseClient
    from hushh_mcp.services.consent_db import ConsentDBService

    # Legacy/imported rows need not have timestamps increasing with insertion id.
    # Updating fixtures bypasses the new INSERT guard's monotonic timestamp rule.
    with connect(pg) as conn:
        insert(conn, event(token="grant", expires_at=int(time.time() * 1000) + 86400000))
        insert(conn, event("CONSENT_DENIED", token="denial"))
        with conn.cursor() as cursor:
            cursor.execute("UPDATE consent_audit SET issued_at=200 WHERE token_id='grant'")
            cursor.execute(
                "UPDATE consent_audit SET issued_at=%s WHERE token_id='denial'",
                (later_insert_issued_at,),
            )
    engine = create_engine(f"postgresql+psycopg2://hushh@/postgres?host={pg.dir}&port={pg.port}")
    ledger = ConsentDBService()
    monkeypatch.setattr(ledger, "_get_db", lambda: DatabaseClient(engine))
    try:
        active = await ledger.get_active_tokens(
            "synthetic-owner", agent_id="personal_agent", scope="pkm.read"
        )
        assert bool(active) is (later_insert_issued_at < 200)
        assert await ledger.is_token_active(
            "synthetic-owner", "pkm.read", "personal_agent", token_id="grant"
        ) is (later_insert_issued_at < 200)
    finally:
        engine.dispose()
