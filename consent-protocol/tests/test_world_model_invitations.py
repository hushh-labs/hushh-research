"""Contact-bound claims and reset share one serialized database authority."""

import json
import os
import sys
from hashlib import sha256
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import UUID, uuid4

import pytest

from hushh_mcp.services import world_model_invitations as invites
from tests.test_data_model_audit_postgres import isolated_postgres as isolated_postgres

ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.asyncio
async def test_public_preview_accepts_previewless_link_without_private_metadata(monkeypatch):
    previewless_token, previewed_token = "a" * 43, "b" * 43
    previewed_id = uuid4()
    selected_preview = {
        "report": {"sections": [{"kind": "profile", "facts": []}]},
        "introduction": "Synthetic introduction",
        "prepared_by": "inviter",
    }
    rows = {
        sha256(previewless_token.encode()).hexdigest(): {
            "id": uuid4(),
            "preview_envelope": None,
            "inviter_user_id": "private-inviter",
            "contact_commitment": "private-contact-commitment",
        },
        sha256(previewed_token.encode()).hexdigest(): {
            "id": previewed_id,
            "preview_envelope": invites.seal_preview(
                previewed_token, previewed_id, selected_preview
            ),
        },
    }

    async def fetchrow(query, token_hash, *, timeout):
        assert "state='pending'" in query and "expires_at>NOW()" in query
        assert timeout == 5
        return rows.get(token_hash)

    monkeypatch.setattr(
        invites, "get_pool", AsyncMock(return_value=SimpleNamespace(fetchrow=fetchrow))
    )
    assert await invites.preview(previewless_token) == {"has_preview": False}
    assert await invites.preview(previewed_token) == selected_preview
    with pytest.raises(ValueError, match="Preview unavailable"):
        await invites.preview("c" * 43)


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
@pytest.mark.parametrize(
    ("status", "report", "expected_outcome", "expected_email"),
    [
        ("unavailable", {}, "attention", "suppressed"),
        ("insufficient_identity", {}, "attention", "suppressed"),
        ("offered", {"match_status": "matched", "sections": []}, "attention", "suppressed"),
        (
            "offered",
            {"match_status": "matched", "sections": [{"facts": [{"statement": "Fact"}]}]},
            "ready",
            "pending",
        ),
        (
            "offered",
            {
                "match_status": "candidate_for_review",
                "sections": [{"facts": [{"statement": "Fact"}]}],
            },
            "partial",
            "pending",
        ),
    ],
)
async def test_pwm_completion_keeps_failed_outbox_without_feed_action(
    status, report, expected_outcome, expected_email
):
    from hushh_mcp.services.world_model_preferences import checkpoint_committed

    generation, draft_id = uuid4(), uuid4()
    calls = []

    class Conn:
        async def fetchrow(self, _sql, _user_id, *, timeout):
            assert timeout == 5
            return {"enabled": True, "generation": generation}

        async def execute(self, sql, *args, timeout):
            assert timeout == 5
            calls.append((sql, args))

    await checkpoint_committed(
        Conn(),
        "recipient",
        {
            "job_id": str(draft_id),
            "consent_generation": str(generation),
            "status": status,
            "result": {"report": report},
        },
    )
    completion = next(
        (sql, args) for sql, args in calls if "INSERT INTO pwm_completion_events" in sql
    )
    assert completion[1][3:] == (expected_outcome, expected_email)
    delete_index = next(
        index for index, (sql, _) in enumerate(calls) if "DELETE FROM feed_events" in sql
    )
    insert_index = calls.index(completion)
    assert (delete_index > insert_index) == (expected_outcome == "attention")
    delete_sql, delete_args = calls[delete_index]
    assert "source_domain='pwm'" in delete_sql
    assert "metadata->>'pwm_outcome'='attention'" in delete_sql
    assert delete_args == ("recipient", str(draft_id))


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
        await pool.execute("""CREATE TABLE feed_events(id bigserial PRIMARY KEY,user_id text,source_domain text,event_type text,source_row_id text,metadata jsonb,read_at timestamptz,dismissed_at timestamptz,dismissal_token text);
            CREATE UNIQUE INDEX uq_feed_events_source_projection ON feed_events(user_id,source_domain,event_type,source_row_id) WHERE source_row_id IS NOT NULL;""")
        lifecycle = (ROOT / "db/migrations/341_pwm_research_lifecycle.sql").read_text()
        await pool.execute(lifecycle)
        await pool.execute(lifecycle)
        secondary_contact = (
            ROOT / "db/migrations/352_pwm_invitation_secondary_contact.sql"
        ).read_text()
        await pool.execute(secondary_contact)
        await pool.execute(secondary_contact)
        import asyncio

        invitation = await asyncio.wait_for(
            invites.create("inviter", "fixture", "recipient@example.test"), 2
        )
        assert await invites.preview(invitation["token"]) == {"has_preview": False}
        with pytest.raises(ValueError, match="Preview unavailable"):
            await invites.preview("x" * 43)
        invites.owner_identity.return_value = {"email": "wrong@example.test"}
        with pytest.raises(ValueError):
            await invites.claim("wrong", "fixture", invitation["token"])
        invites.owner_identity.return_value = {"email": "recipient@example.test"}
        result = await asyncio.wait_for(
            invites.claim("recipient", "fixture", invitation["token"]), 2
        )
        assert result == {
            "claimed": True,
            "sharing_granted": False,
            "research_started": False,
            "draft_id": None,
        }
        assert await invites.claim("recipient", "fixture", invitation["token"]) == result
        with pytest.raises(ValueError, match="Preview unavailable"):
            await invites.preview(invitation["token"])
        dual = await invites.create(
            "inviter",
            "fixture",
            "recipient@example.test",
            secondary_contact="+15550001111",
            subject_name="Recipient Example",
        )
        assert await invites.preview(dual["token"]) == {
            "has_preview": False,
            "subject_name": "Recipient Example",
        }
        invites.owner_identity.return_value = {"phone_number": "+15550001111"}
        assert (await invites.claim("recipient", "fixture", dual["token"]))["draft_id"] is None
        invites.owner_identity.return_value = {"email": "recipient@example.test"}
        second = await invites.create("inviter", "fixture", "recipient@example.test")
        selected_preview = {
            "report": {"sections": [{"kind": "profile", "facts": []}]},
            "introduction": "Synthetic introduction",
            "prepared_by": "inviter",
        }
        await pool.execute(
            "UPDATE pwm_claim_invitations SET preview_envelope=$1,preview_version=1 WHERE id=$2",
            invites.seal_preview(second["token"], UUID(second["id"]), selected_preview),
            UUID(second["id"]),
        )
        assert await invites.preview(second["token"]) == selected_preview
        await invites.revoke("inviter", "fixture", UUID(second["id"]))
        with pytest.raises(ValueError, match="Preview unavailable"):
            await invites.preview(second["token"])
        with pytest.raises(ValueError):
            await invites.claim("recipient", "fixture", second["token"])
        third = await invites.create("inviter", "fixture", "recipient@example.test")
        await pool.execute(
            "UPDATE pwm_claim_invitations SET expires_at=NOW()-INTERVAL '1 day' WHERE state='pending'"
        )
        with pytest.raises(ValueError, match="Preview unavailable"):
            await invites.preview(third["token"])
        with pytest.raises(ValueError):
            await invites.claim("recipient", "fixture", third["token"])
        await pool.execute("UPDATE vault_keys SET setup_completed=false WHERE user_id='inviter'")
        with pytest.raises(PermissionError):
            await invites.create("inviter", "fixture", "recipient@example.test")
        from uuid import uuid4

        from hushh_mcp.services.world_model_preferences import checkpoint_committed

        generation, draft_id = uuid4(), uuid4()
        await pool.execute(
            "INSERT INTO pwm_research_preferences(user_id,enabled,email_enabled,generation) VALUES ('recipient',true,true,$1)",
            generation,
        )
        state = {
            "job_id": str(draft_id),
            "consent_generation": str(generation),
            "status": "unavailable",
            "result": {},
        }
        async with pool.acquire() as conn, conn.transaction():
            await checkpoint_committed(conn, "recipient", state)
        assert (
            await pool.fetchval("SELECT count(*) FROM feed_events WHERE source_domain='pwm'") == 0
        )
        assert await pool.fetchval("SELECT outcome FROM pwm_completion_events") == "attention"
        assert await pool.fetchval("SELECT email_state FROM pwm_completion_events") == "suppressed"
        # Simulate a dismissed attention row left by an older backend. A real
        # offered draft must become visible even when that failure was dismissed.
        await pool.execute(
            """INSERT INTO feed_events(user_id,source_domain,event_type,source_row_id,metadata,
            read_at,dismissed_at,dismissal_token)
            VALUES ('recipient','pwm','pwm_research',$1,$2,NOW(),NOW(),'synthetic-dismissal')""",
            str(draft_id),
            json.dumps({"draft_id": str(draft_id), "pwm_outcome": "attention"}),
        )
        state.update(
            status="offered",
            result={
                "report": {
                    "match_status": "matched",
                    "sections": [{"facts": [{"statement": "Synthetic reviewed finding"}]}],
                }
            },
        )
        async with pool.acquire() as conn, conn.transaction():
            await checkpoint_committed(conn, "recipient", state)
            await checkpoint_committed(conn, "recipient", state)
        assert (
            await pool.fetchval("SELECT count(*) FROM feed_events WHERE source_domain='pwm'") == 1
        )
        row = await pool.fetchrow(
            "SELECT source_row_id,read_at,dismissed_at,dismissal_token,metadata->>'pwm_outcome' AS outcome FROM feed_events WHERE source_domain='pwm'"
        )
        assert (
            row["source_row_id"] == str(draft_id)
            and row["read_at"] is None
            and row["dismissed_at"] is None
            and row["dismissal_token"] is None
            and row["outcome"] == "ready"
        )
        assert await pool.fetchval("SELECT email_state FROM pwm_completion_events") == "pending"
        await pool.execute("UPDATE pwm_completion_events SET email_state='accepted'")
        async with pool.acquire() as conn, conn.transaction():
            await checkpoint_committed(conn, "recipient", state)
        assert await pool.fetchval("SELECT email_state FROM pwm_completion_events") == "accepted"
        # Only a newly active draft restarts the re-preparation interval.
        stale = "SELECT auto_started_at<NOW()-INTERVAL '29 days' FROM pwm_research_preferences WHERE user_id='recipient'"
        await pool.execute(
            "UPDATE pwm_research_preferences SET auto_started_at=NOW()-INTERVAL '30 days' WHERE user_id='recipient'"
        )
        async with pool.acquire() as conn, conn.transaction():
            await checkpoint_committed(conn, "recipient", state)
        assert await pool.fetchval(stale) is True
        async with pool.acquire() as conn, conn.transaction():
            await checkpoint_committed(
                conn, "recipient", {**state, "job_id": str(uuid4()), "status": "pending"}
            )
        assert await pool.fetchval(stale) is False
        # Default research enrolls once and never rewrites an existing choice.
        from hushh_mcp.services import world_model_preferences as research_preferences

        monkeypatch.setattr(research_preferences, "get_pool", AsyncMock(return_value=pool))
        monkeypatch.setattr(
            research_preferences,
            "validate_first_party_owner_token",
            AsyncMock(return_value=object()),
        )
        enrolled = "SELECT * FROM pwm_research_preferences WHERE user_id='wrong'"
        await research_preferences.enroll_default("wrong", "fixture")
        row = dict(await pool.fetchrow(enrolled))
        assert (row["enabled"], row["email_enabled"], row["consent_version"]) == (
            True,
            True,
            "pwm-default-v1",
        )
        # A previously default-enrolled owner has not opted into Azure/Bing.
        with monkeypatch.context() as patch:
            patch.setattr(
                research_preferences,
                "load_pwm_policy",
                lambda: {"provider": "azure_openai_web_search"},
            )
            assert research_preferences.public_preferences(row)["enabled"] is False
            await research_preferences.update_preferences(
                "wrong",
                "fixture",
                enabled=True,
                email_enabled=True,
                consent_version=research_preferences.AZURE_BING_CONSENT_VERSION,
            )
            opted_in = dict(await pool.fetchrow(enrolled))
            assert opted_in["consent_version"] == "pwm-azure-bing-v1"
            assert opted_in["generation"] != row["generation"]
            assert research_preferences.public_preferences(opted_in)["enabled"] is True
        await pool.execute(
            "UPDATE pwm_research_preferences SET enabled=false,email_enabled=false WHERE user_id='wrong'"
        )
        opted_out = dict(await pool.fetchrow(enrolled))
        await research_preferences.enroll_default("wrong", "fixture")
        assert dict(await pool.fetchrow(enrolled)) == opted_out
        await pool.execute("DELETE FROM pwm_research_preferences WHERE user_id='recipient'")
        async with pool.acquire() as conn, conn.transaction():
            with pytest.raises(PermissionError):
                await checkpoint_committed(conn, "recipient", state)
        assert await pool.fetchval("SELECT count(*) FROM pwm_completion_events") == 0
        await pool.execute(
            (ROOT / "db/migrations/rollback/341_pwm_research_lifecycle.rollback.sql").read_text()
        )
        await pool.execute(
            (ROOT / "db/migrations/rollback/336_pwm_claim_invitations.rollback.sql").read_text()
        )
        legacy_budget = (ROOT / "db/migrations/340_pwm_provider_budget.sql").read_text()
        await pool.execute(legacy_budget)
        await pool.execute(legacy_budget)
        assert (
            await pool.fetchval("SELECT to_regclass('pwm_provider_budget')::text")
            == "pwm_provider_budget"
        )
        await pool.execute(
            (ROOT / "db/migrations/rollback/340_pwm_provider_budget.rollback.sql").read_text()
        )
    finally:
        await pool.close()
