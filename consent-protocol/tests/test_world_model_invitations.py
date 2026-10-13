"""Contact-bound claims and reset share one serialized database authority."""

import os
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import UUID

import pytest

from hushh_mcp.services import world_model_invitations as invites
from tests.test_data_model_audit_postgres import isolated_postgres as isolated_postgres

ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.asyncio
async def test_locked_authority_reuses_connection(monkeypatch):
    conn = object()
    identity = AsyncMock(return_value={"email": "owner@example.test"})
    setup = AsyncMock(return_value=True)
    token = AsyncMock(return_value=object())
    monkeypatch.setattr(invites, "owner_identity", identity)
    monkeypatch.setattr(invites, "owner_setup_resolved", setup)
    monkeypatch.setattr(invites, "validate_first_party_owner_token", token)
    await invites.verified_owner("owner", "fixture", conn=conn)
    identity.assert_awaited_once_with("owner", "fixture", conn=conn)
    setup.assert_awaited_once_with("owner", conn=conn)
    token.assert_awaited_once_with("owner", "fixture", conn=conn)
    setup.return_value = False
    with pytest.raises(PermissionError):
        await invites.verified_owner("owner", "fixture", conn=conn)


@pytest.mark.asyncio
async def test_phone_claim_retains_current_binding_until_commit(request, monkeypatch):
    if sys.platform == "win32" or os.name != "posix":
        pytest.skip("Disposable PostgreSQL needs Unix sockets")
    dsn = request.getfixturevalue("isolated_postgres")
    import asyncpg
    from psycopg2.extensions import parse_dsn

    from hushh_mcp.services import actor_identity_service
    from hushh_mcp.services.profile_research_service import resolve_profile_research_identity

    settings = parse_dsn(dsn)
    pool = await asyncpg.create_pool(
        host=settings["host"],
        port=int(settings["port"]),
        database=settings["dbname"],
        user=settings["user"],
        ssl=False,
        min_size=2,
        max_size=2,
    )
    monkeypatch.setattr(actor_identity_service, "get_pool", AsyncMock(return_value=pool))
    record = SimpleNamespace(
        display_name="Example Owner", email_verified=False, phone_number="+15555550999"
    )
    try:
        await pool.execute("""CREATE TABLE actor_identity_cache (
            user_id text PRIMARY KEY, display_name text, email text, phone_number text,
            photo_url text, custom_photo_url text, email_verified bool, phone_verified bool,
            source text, last_synced_at timestamptz, created_at timestamptz, updated_at timestamptz);
            INSERT INTO actor_identity_cache(user_id) VALUES ('recipient'), ('new-owner');""")
        for retain_authority in (True, False):
            await pool.execute("""UPDATE actor_identity_cache
                SET phone_number='+15555550123', phone_verified=true WHERE user_id='recipient'""")
            async with pool.acquire() as reader, reader.transaction():
                identity = await resolve_profile_research_identity(
                    "recipient", record, **({"conn": reader} if retain_authority else {})
                )
                assert identity["phone_number"] == "+15555550123"
                async with pool.acquire() as writer:

                    async def transfer():
                        async with writer.transaction():
                            await writer.execute("SET LOCAL lock_timeout='100ms'")
                            await actor_identity_service.ActorIdentityService._lock_and_clear_verified_phone_binding(
                                writer, user_id="new-owner", phone_number="+15555550123"
                            )

                    if retain_authority:
                        with pytest.raises(asyncpg.LockNotAvailableError):
                            await transfer()
                    else:
                        # Negative control: an ordinary read cannot protect a claim.
                        await transfer()
            async with pool.acquire() as writer, writer.transaction():
                await actor_identity_service.ActorIdentityService._lock_and_clear_verified_phone_binding(
                    writer, user_id="new-owner", phone_number="+15555550123"
                )
            identity = await resolve_profile_research_identity("recipient", record)
            assert identity["phone_number"] is None
    finally:
        await pool.close()


@pytest.mark.asyncio
async def test_claim_contract_on_single_connection_postgres(request, monkeypatch):
    if sys.platform == "win32" or os.name != "posix":
        pytest.skip("Disposable PostgreSQL needs Unix sockets")
    dsn = request.getfixturevalue("isolated_postgres")
    import asyncpg
    from psycopg2.extensions import parse_dsn

    settings = parse_dsn(dsn)
    pool = await asyncpg.create_pool(
        host=settings["host"],
        port=int(settings["port"]),
        database=settings["dbname"],
        user=settings["user"],
        ssl=False,
        min_size=1,
        max_size=1,
    )
    monkeypatch.setattr(invites, "get_pool", AsyncMock(return_value=pool))
    monkeypatch.setattr(
        invites,
        "get_core_security_settings",
        lambda: SimpleNamespace(app_signing_key="synthetic-test-signing-material"),
    )
    monkeypatch.setattr(
        invites, "validate_first_party_owner_token", AsyncMock(return_value=object())
    )
    monkeypatch.setattr(
        invites, "owner_identity", AsyncMock(return_value={"email": "recipient@example.test"})
    )
    from hushh_mcp.services import one_owner_admission

    monkeypatch.setattr(one_owner_admission, "get_pool", AsyncMock(return_value=pool))
    try:
        await pool.execute("""CREATE TABLE actor_profiles(user_id text PRIMARY KEY);
            INSERT INTO actor_profiles VALUES ('inviter'),('recipient'),('wrong');
            CREATE TABLE vault_keys(user_id text PRIMARY KEY, setup_completed bool, vault_status text);
            INSERT INTO vault_keys SELECT user_id,true,'active' FROM actor_profiles;""")
        migration = (ROOT / "db/migrations/336_pwm_claim_invitations.sql").read_text()
        await pool.execute(migration)
        await pool.execute(migration)
        import asyncio

        invitation = await asyncio.wait_for(
            invites.create("inviter", "fixture", "recipient@example.test"), 2
        )
        invites.owner_identity.return_value = {"email": "wrong@example.test"}
        with pytest.raises(ValueError):
            await invites.claim("wrong", "fixture", invitation["token"])
        invites.owner_identity.return_value = {"email": "recipient@example.test"}
        result = await asyncio.wait_for(
            invites.claim("recipient", "fixture", invitation["token"]), 2
        )
        assert result == {"claimed": True, "sharing_granted": False, "research_started": False}
        with pytest.raises(ValueError):
            await invites.claim("recipient", "fixture", invitation["token"])
        second = await invites.create("inviter", "fixture", "recipient@example.test")
        await invites.revoke("inviter", "fixture", UUID(second["id"]))
        with pytest.raises(ValueError):
            await invites.claim("recipient", "fixture", second["token"])
        third = await invites.create("inviter", "fixture", "recipient@example.test")
        await pool.execute(
            "UPDATE pwm_claim_invitations SET expires_at=NOW()-INTERVAL '1 day' WHERE state='pending'"
        )
        with pytest.raises(ValueError):
            await invites.claim("recipient", "fixture", third["token"])
        await pool.execute("UPDATE vault_keys SET setup_completed=false WHERE user_id='inviter'")
        with pytest.raises(PermissionError):
            await invites.create("inviter", "fixture", "recipient@example.test")
        await pool.execute(
            (ROOT / "db/migrations/rollback/336_pwm_claim_invitations.rollback.sql").read_text()
        )
        await pool.execute((ROOT / "db/migrations/335_pwm_provider_budget.sql").read_text())
        from hushh_mcp.one_adk import world_model

        monkeypatch.setattr("db.connection.get_pool", AsyncMock(return_value=pool))
        assert await world_model.charge_search_credit() is True
        await pool.execute("UPDATE pwm_provider_budget SET credits=900")
        assert await world_model.charge_search_credit() is False
        await pool.execute(
            (ROOT / "db/migrations/rollback/335_pwm_provider_budget.rollback.sql").read_text()
        )
    finally:
        await pool.close()
