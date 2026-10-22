"""Personal completion requires confirmed owner receipts, never client saved state."""

import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock
from uuid import UUID

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from api.middleware import require_vault_owner_token
from api.middlewares.chat_key import require_vault_owner_chat_key
from api.routes.one import profile_research as routes
from hushh_mcp.services import magic_intelligence_completion as completion
from hushh_mcp.services.pkm_mutation_contracts import derive_pkm_mutation_commit_id
from tests.test_data_model_audit_postgres import isolated_postgres as isolated_postgres

ROOT = Path(__file__).resolve().parents[1]
COMMITS = [("professional", "pkm_plan_one_123456"), ("personal", "pkm_plan_two_123456")]
BODY = {"commits": [{"domain": domain, "plan_id": plan} for domain, plan in COMMITS]}
ENDPOINT = "/api/one/profile-research/complete"


def install_pool(monkeypatch, *, acknowledged=2, saved=False, owner_exists=True):
    conn = SimpleNamespace(
        fetchrow=AsyncMock(
            return_value={"one_magic_intelligence_saved": saved} if owner_exists else None
        ),
        fetchval=AsyncMock(return_value=acknowledged),
        execute=AsyncMock(),
    )
    transaction = MagicMock()
    transaction.__aenter__ = AsyncMock()
    transaction.__aexit__ = AsyncMock(return_value=False)
    conn.transaction = lambda: transaction
    lease = MagicMock()
    lease.__aenter__ = AsyncMock(return_value=conn)
    lease.__aexit__ = AsyncMock(return_value=False)
    monkeypatch.setattr(
        completion, "get_pool", AsyncMock(return_value=SimpleNamespace(acquire=lambda: lease))
    )
    return conn


@pytest.mark.asyncio
@pytest.mark.parametrize("acknowledged", [0, 1, 2])
async def test_every_selected_receipt_must_be_acknowledged(monkeypatch, acknowledged):
    conn = install_pool(monkeypatch, acknowledged=acknowledged)
    if acknowledged == len(COMMITS):
        await completion.complete_magic_intelligence("owner", COMMITS)
        conn.execute.assert_awaited_once_with(
            "UPDATE vault_keys SET one_magic_intelligence_saved = TRUE WHERE user_id = $1",
            "owner",
        )
    else:
        with pytest.raises(completion.MagicReviewNotCommitted):
            await completion.complete_magic_intelligence("owner", COMMITS)
        conn.execute.assert_not_awaited()
    assert conn.fetchval.await_args.args[1:] == (
        "owner",
        [domain for domain, _ in COMMITS],
        [plan for _, plan in COMMITS],
        [
            derive_pkm_mutation_commit_id(user_id="owner", domain=domain, plan_id=plan)
            for domain, plan in COMMITS
        ],
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("commits", [[], COMMITS * 33, [COMMITS[0]] * 2, [("professional", "bad")]])
async def test_invalid_or_duplicate_receipts_never_access_storage(monkeypatch, commits):
    pool = AsyncMock()
    monkeypatch.setattr(completion, "get_pool", pool)
    with pytest.raises(completion.MagicReviewNotCommitted):
        await completion.complete_magic_intelligence("owner", commits)
    pool.assert_not_awaited()


@pytest.mark.asyncio
async def test_missing_owner_cannot_complete_and_saved_retry_needs_no_new_writes(monkeypatch):
    conn = install_pool(monkeypatch, owner_exists=False)
    with pytest.raises(completion.MagicReviewNotCommitted):
        await completion.complete_magic_intelligence("owner", COMMITS)
    conn.fetchval.assert_not_awaited()
    conn.execute.assert_not_awaited()
    conn = install_pool(monkeypatch, saved=True)
    await completion.complete_magic_intelligence("owner", COMMITS)
    conn.fetchval.assert_not_awaited()
    conn.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_saved_state_is_owner_scoped_and_read_failure_is_not_unsaved(monkeypatch):
    conn = install_pool(monkeypatch, acknowledged=True)
    assert await completion.magic_intelligence_saved("owner") is True
    conn.fetchval.assert_awaited_once_with(
        "SELECT one_magic_intelligence_saved FROM vault_keys WHERE user_id = $1", "owner"
    )
    conn.fetchval.side_effect = RuntimeError("storage unavailable")
    with pytest.raises(RuntimeError, match="storage unavailable"):
        await completion.magic_intelligence_saved("owner")


def app_for_owner():
    app = FastAPI()
    app.include_router(routes.router)
    app.dependency_overrides[require_vault_owner_chat_key] = lambda: {"user_id": "owner"}
    return app


def test_route_uses_authenticated_owner_and_rejects_extra_or_unbounded_fields(monkeypatch):
    mark = AsyncMock()
    monkeypatch.setattr(routes, "complete_magic_intelligence", mark)
    client = TestClient(app_for_owner())
    response = client.post(f"{ENDPOINT}?user_id=other", json=BODY)
    assert response.status_code == 200 and response.json() == {"saved": True}
    assert response.headers["cache-control"] == "private, no-store"
    mark.assert_awaited_once_with("owner", COMMITS)
    for invalid in [
        {**BODY, "user_id": "other"},
        {"commits": []},
        {"commits": BODY["commits"] * 33},
        {"commits": [{**BODY["commits"][0], "saved": True}]},
    ]:
        response = client.post(ENDPOINT, json=invalid)
        assert response.status_code == 422
        assert response.headers["cache-control"] == "private, no-store"
    assert mark.await_count == 1


@pytest.mark.parametrize("boundary", ["token", "chat_key"])
def test_denied_owner_or_missing_chat_key_never_calls_completion(monkeypatch, boundary):
    mark = AsyncMock()
    monkeypatch.setattr(routes, "complete_magic_intelligence", mark)
    app = FastAPI()
    app.include_router(routes.router)
    if boundary == "token":

        def denied():
            raise HTTPException(status_code=401, detail="Invalid owner session")

        app.dependency_overrides[require_vault_owner_token] = denied
    else:
        app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "owner"}
    response = TestClient(app).post(ENDPOINT, json=BODY)
    assert response.status_code == (401 if boundary == "token" else 403)
    assert response.headers["cache-control"] == "private, no-store"
    mark.assert_not_awaited()


@pytest.mark.parametrize(
    "failure,status",
    [(completion.MagicReviewNotCommitted(), 409), (RuntimeError("private-storage-detail"), 503)],
)
def test_completion_errors_are_private_and_storage_failure_is_retryable(
    monkeypatch, failure, status
):
    monkeypatch.setattr(routes, "complete_magic_intelligence", AsyncMock(side_effect=failure))
    response = TestClient(app_for_owner()).post(ENDPOINT, json=BODY)
    assert response.status_code == status
    assert response.headers["cache-control"] == "private, no-store"
    assert "private-storage-detail" not in response.text
    if status == 503:
        assert response.headers["retry-after"] == "5"


@pytest.mark.asyncio
async def test_isolated_postgres_receipt_authority_and_forward_rollback(request, monkeypatch):
    # The canonical fixture calls geteuid and creates a Unix-socket-only cluster.
    # Guard before dynamic fixture acquisition, so Windows never enters it.
    if sys.platform == "win32" or os.name != "posix" or not hasattr(os, "geteuid"):
        pytest.skip("Isolated PostgreSQL rehearsal requires the Unix socket fixture")
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
        max_size=2,
    )
    monkeypatch.setattr(completion, "get_pool", AsyncMock(return_value=pool))
    try:
        async with pool.acquire() as conn:
            await conn.execute("""
                CREATE TABLE vault_keys (
                  user_id text PRIMARY KEY, one_business_profile_saved boolean NOT NULL DEFAULT false
                );
                CREATE TABLE pkm_domain_commits (
                  user_id text, domain text, commit_id uuid, commit_kind text,
                  result_content_revision bigint
                );
                CREATE TABLE pkm_events (
                  user_id text, domain text, operation_type text, source_agent text, metadata jsonb
                );
                INSERT INTO vault_keys VALUES ('owner', true), ('other', false);
            """)
            migration = (ROOT / "db/migrations/314_one_magic_intelligence_saved.sql").read_text()
            await conn.execute(migration)
            await conn.execute(migration)  # Additive migration replay preserves existing state.
            assert (
                await conn.fetchval(
                    "SELECT one_magic_intelligence_saved FROM vault_keys WHERE user_id='owner'"
                )
                is False
            )

        async def seed(domain, plan, *, change=None):
            metadata = {
                "data_version": 7,
                "provenance": {
                    "writer_id": "profile_research_review",
                    "mutation_plan_id": plan,
                    "confirmation_receipt_id": "synthetic-confirmation",
                },
            }
            if change == "writer":
                metadata["provenance"]["writer_id"] = "business_profile_review"
            elif change == "plan":
                metadata["provenance"]["mutation_plan_id"] = "pkm_plan_unrelated_123456"
            elif change == "revision":
                metadata["data_version"] = 8
            elif change == "confirmation":
                metadata["provenance"]["confirmation_receipt_id"] = ""
            elif change == "missing_confirmation":
                del metadata["provenance"]["confirmation_receipt_id"]
            commit_id = UUID(
                derive_pkm_mutation_commit_id(user_id="owner", domain=domain, plan_id=plan)
            )
            async with pool.acquire() as conn:
                if change != "missing_commit":
                    await conn.execute(
                        "INSERT INTO pkm_domain_commits VALUES ($1,$2,$3,$4,$5)",
                        "other" if change == "owner" else "owner",
                        domain,
                        commit_id,
                        "upgrade" if change == "kind" else "mutation",
                        None if change == "missing_revision" else 7,
                    )
                if change != "missing_event":
                    await conn.execute(
                        "INSERT INTO pkm_events VALUES ($1,$2,$3,$4,$5::jsonb)",
                        "other" if change == "event_owner" else "owner",
                        domain,
                        "index_update" if change == "operation" else "content_write",
                        "business_profile_review"
                        if change == "source"
                        else "profile_research_review",
                        json.dumps(metadata),
                    )

        for change in [
            "owner",
            "event_owner",
            "writer",
            "source",
            "plan",
            "revision",
            "confirmation",
            "missing_confirmation",
            "operation",
            "kind",
            "missing_revision",
            "missing_commit",
            "missing_event",
        ]:
            async with pool.acquire() as conn:
                await conn.execute("TRUNCATE pkm_domain_commits, pkm_events")
            await seed(*COMMITS[0], change=change)
            with pytest.raises(completion.MagicReviewNotCommitted):
                await completion.complete_magic_intelligence("owner", [COMMITS[0]])
            assert await completion.magic_intelligence_saved("owner") is False
        async with pool.acquire() as conn:
            await conn.execute("TRUNCATE pkm_domain_commits, pkm_events")
        await seed(*COMMITS[0])
        with pytest.raises(completion.MagicReviewNotCommitted):
            await completion.complete_magic_intelligence("owner", COMMITS)
        await seed(*COMMITS[1])
        with pytest.raises(completion.MagicReviewNotCommitted):
            await completion.complete_magic_intelligence("owner", [COMMITS[0]] * 2)
        await completion.complete_magic_intelligence("owner", COMMITS)
        assert await completion.magic_intelligence_saved("owner") is True
        assert await completion.magic_intelligence_saved("other") is False
        async with pool.acquire() as conn:
            await conn.execute("DELETE FROM pkm_events")
        await completion.complete_magic_intelligence("owner", COMMITS)  # Lost response recovery.
        async with pool.acquire() as conn:
            await conn.execute(
                (
                    ROOT / "db/migrations/rollback/314_one_magic_intelligence_saved.rollback.sql"
                ).read_text()
            )
            assert await conn.fetchval("SELECT COUNT(*) FROM pkm_domain_commits") == 2
            assert (
                await conn.fetchval(
                    "SELECT one_business_profile_saved FROM vault_keys WHERE user_id='owner'"
                )
                is True
            )
            assert not await conn.fetchval("""
                SELECT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name='vault_keys' AND column_name='one_magic_intelligence_saved')
            """)
    finally:
        await pool.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("acknowledged", [0, 2])
async def test_pwm_revalidates_receipts_even_after_legacy_save(monkeypatch, acknowledged):
    conn = install_pool(monkeypatch, acknowledged=acknowledged, saved=True)
    if acknowledged == 0:
        with pytest.raises(completion.MagicReviewNotCommitted):
            await completion.complete_magic_intelligence("owner", COMMITS, verify_only=True)
    else:
        await completion.complete_magic_intelligence("owner", COMMITS, verify_only=True)
    conn.fetchval.assert_awaited_once()
    conn.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_pwm_full_report_receipts_complete_and_overflow_fails(monkeypatch):
    from uuid import uuid4

    from pydantic import ValidationError

    from api.routes.one.world_model import WorldModelCompletion

    rows = [{"domain": "personal", "plan_id": f"pkm_plan_{uuid4().hex}"} for _ in range(160)]
    body = WorldModelCompletion(draft_id=uuid4(), commits=rows)
    commits = [(row.domain, row.plan_id) for row in body.commits]
    conn = install_pool(monkeypatch, acknowledged=160, saved=True)
    await completion.complete_magic_intelligence(
        "owner", commits, verify_only=True, max_commits=160
    )
    conn.fetchval.assert_awaited_once()
    conn.execute.assert_not_awaited()
    with pytest.raises(ValidationError):
        WorldModelCompletion(draft_id=uuid4(), commits=rows + [rows[0]])
    with pytest.raises(completion.MagicReviewNotCommitted):
        await completion.complete_magic_intelligence(
            "owner", commits + [("profile", "extra")], verify_only=True, max_commits=160
        )
