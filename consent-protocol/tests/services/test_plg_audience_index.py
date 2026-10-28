"""Bounded indexed searches do not stop at unrelated registry pages."""

import os
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest

from hushh_mcp.services import plg_audience as audience
from hushh_mcp.services import plg_audience_identity as identity
from hushh_mcp.services import plg_audience_index as index
from tests.services.test_plg_evidence import (
    reporting_roster,  # noqa: F401 -- shared policy fixture.
)

NOW = datetime(2026, 10, 29, tzinfo=timezone.utc)


def test_captured_replacement_reads_firebase_identity_but_keeps_attempt_owner(monkeypatch):
    owner = "acct_" + "a" * 32

    def resolver(ids):
        return {owner: "firebase-person"}

    monkeypatch.setattr(
        identity.AccountGenerationService, "firebase_identities_for_owners", resolver
    )
    calls = []

    def lookup(ids):
        calls.append(ids)
        return [
            SimpleNamespace(
                uid="firebase-person", email="person@example.test", **{"password_hash": "PRIVATE"}
            )
        ]

    result = identity.captured_records([owner, "retired-owner"], lookup)
    assert calls == [["firebase-person"]]
    assert [row.uid for row in result] == [owner]
    assert result[0].email == "person@example.test" and not hasattr(result[0], "password_hash")


@pytest.mark.parametrize(
    "mapping,returned",
    [
        ({"foreign": "firebase-person"}, []),
        ({"one": "firebase-person", "two": "firebase-person"}, []),
        ({"one": "firebase-person"}, ["foreign"]),
        ({"one": "firebase-person"}, ["firebase-person", "firebase-person"]),
    ],
)
def test_captured_identity_rejects_substitution_and_ambiguous_mapping(
    monkeypatch, mapping, returned
):
    monkeypatch.setattr(
        identity.AccountGenerationService, "firebase_identities_for_owners", lambda _: mapping
    )
    with pytest.raises(ValueError):
        identity.captured_records(
            ["one", "two"], lambda _: [SimpleNamespace(uid=uid) for uid in returned]
        )


def test_current_directory_projection_excludes_retirement_and_preserves_owner(monkeypatch):
    owner = "acct_" + "b" * 32

    class Connection:
        def __enter__(self):
            return self

        def __exit__(self, *_):
            pass

        def execute(self, query, params=None):
            if params:
                assert params == {"identities": ["replacement", "retired", "legacy"]}
            return SimpleNamespace(
                mappings=lambda: [
                    {"uid": "replacement", "owner": owner},
                    {"uid": "legacy", "owner": "legacy"},
                ]
            )

    monkeypatch.setattr(identity, "get_db_connection", Connection)
    records = [
        SimpleNamespace(uid=uid, **{"password_hash": "PRIVATE"})
        for uid in ["replacement", "retired", "legacy"]
    ]
    result = identity.current_records(records)
    assert [row.uid for row in result] == [owner, "legacy"]
    assert all(not hasattr(row, "password_hash") for row in result)


@pytest.mark.asyncio
async def test_index_search_loads_only_matching_identities_and_retains_excluded_continuation(
    monkeypatch,
):
    ids = [f"matching-owner-{n:03}" for n in range(26)]
    conn = SimpleNamespace(
        execute=AsyncMock(), fetch=AsyncMock(return_value=[{"user_id": uid} for uid in ids])
    )

    @asynccontextmanager
    async def context(value=None, **_):
        yield value

    conn.transaction = lambda **kwargs: context(**kwargs)
    monkeypatch.setattr(
        index,
        "get_pool",
        AsyncMock(return_value=SimpleNamespace(acquire=lambda **_: context(conn))),
    )
    identity_calls = []

    def lookup(selected):
        identity_calls.append(selected)
        return []  # All selected identities were deleted; continuation must survive.

    monkeypatch.setattr(index, "registered_records", lookup)
    monkeypatch.setattr(
        index,
        "activity_catalog",
        lambda: {
            "actions": [
                {
                    "id": "one.task",
                    "agentId": "agent_one",
                    "kind": "feature",
                    "proof": "client_reported",
                }
            ]
        },
    )
    result = await index.source_page(audience.AudienceRequest(segment="failed"), None, NOW, 25)
    assert identity_calls == [ids[:25]]
    assert result.users == [] and result.next_page_token == "attempts:" + ids[24]
    args = conn.fetch.call_args.args
    assert args[4] == "" and args[6:9] == (["one.task"], ["client_reported"], "failed")


@pytest.mark.asyncio
async def test_index_rejects_identity_substitution_and_old_registry_cursor(monkeypatch):
    request = audience.AudienceRequest(segment="failed")
    with pytest.raises(ValueError, match="refresh"):
        await index.source_page(request, "old-firebase-page", NOW, 25)
    conn = SimpleNamespace(
        execute=AsyncMock(), fetch=AsyncMock(return_value=[{"user_id": "owner"}])
    )

    @asynccontextmanager
    async def context(value=None, **_):
        yield value

    conn.transaction = lambda **kwargs: context(**kwargs)
    monkeypatch.setattr(
        index,
        "get_pool",
        AsyncMock(return_value=SimpleNamespace(acquire=lambda **_: context(conn))),
    )
    monkeypatch.setattr(index, "registered_records", lambda _: [SimpleNamespace(uid="other-owner")])
    with pytest.raises(ValueError, match="identity"):
        await index.source_page(request, None, NOW, 25)


@pytest.mark.asyncio
@pytest.mark.usefixtures("reporting_roster")
async def test_filtered_reader_uses_index_before_live_identity_and_binds_its_cursor(
    monkeypatch,
):
    def forbidden(_):
        raise AssertionError("A task-status search must not walk unrelated Firebase pages")

    monkeypatch.setattr(audience, "_firebase_page", forbidden)
    indexed = AsyncMock(
        return_value=SimpleNamespace(users=[], next_page_token=index.PREFIX + "later-owner")
    )
    monkeypatch.setattr(index, "source_page", indexed)
    request = audience.AudienceRequest(segment="failed")
    result = await audience.audience_page(request, "s" * 40, NOW)
    assert result["rows"] == [] and result["campaignEnrollmentChanged"] is False
    next_request = request.model_copy(update={"cursor": result["nextCursor"]})
    assert audience._cursor(next_request, "s" * 40, NOW) == ("attempts:later-owner", NOW)
    changed = next_request.model_copy(update={"segment": "returned"})
    with pytest.raises(audience.AudienceCursorError):
        audience._cursor(changed, "s" * 40, NOW)


@pytest.mark.db
@pytest.mark.asyncio
async def test_real_index_sql_fences_epochs_and_matches_correlated_terminal_status():
    configured = os.getenv("ONE_COMMAND_TEST_DATABASE_URL")
    if not configured:
        pytest.skip("Canonical disposable PostgreSQL URL is required")
    import asyncpg
    from sqlalchemy.engine import make_url

    url = make_url(configured).set(drivername="postgresql").render_as_string(hide_password=False)
    conn = await asyncpg.connect(url, command_timeout=10)
    try:
        await conn.execute("""
          CREATE TEMP TABLE one_product_activity_epochs(user_id text PRIMARY KEY,generation uuid);
          CREATE TEMP TABLE one_product_activity_observations(
            user_id text,generation uuid,agent_id text,action_id text,source text,
            operation_key text,phase text,observed_at timestamptz,expires_at timestamptz);
        """)
        generation = uuid4()
        cases = {
            "complete": [(120, "started"), (60, "returned")],
            "incomplete": [(120, "started")],
            "recent": [(10, "started")],
            "failed": [(120, "started"), (60, "failed")],
            "blocked": [(120, "started"), (60, "blocked")],
            "cancelled": [(120, "started"), (60, "cancelled")],
            "out-of-order": [(10, "started"), (20, "returned")],
            "reset": [(120, "started")],
            "expired": [(120, "started")],
        }
        for uid, phases in cases.items():
            await conn.execute(
                "INSERT INTO one_product_activity_epochs VALUES($1,$2)", uid, generation
            )
            for minutes, phase in phases:
                await conn.execute(
                    """INSERT INTO one_product_activity_observations
                  VALUES($1,$2,'agent_one','one.task','client_reported','operation',$3,$4,$5)""",
                    uid,
                    uuid4() if uid == "reset" else generation,
                    phase,
                    NOW - timedelta(minutes=minutes),
                    NOW - timedelta(seconds=1) if uid == "expired" else NOW + timedelta(days=7),
                )
        expected = {
            "possible_incomplete": {"incomplete"},
            "in_progress": {"recent"},
            "failed": {"failed"},
            "blocked": {"blocked"},
            "cancelled": {"cancelled"},
            "returned": {"complete", "out-of-order"},
        }
        for segment, owners in expected.items():
            result = await conn.fetch(
                index.CANDIDATES_SQL,
                "agent_one",
                NOW - timedelta(days=7),
                NOW,
                "",
                NOW - timedelta(hours=1),
                ["one.task"],
                ["client_reported"],
                segment,
                26,
            )
            assert {row["user_id"] for row in result} == owners
    finally:
        await conn.close()  # Temporary tables disappear without touching shared schema.


@pytest.mark.db
@pytest.mark.asyncio
async def test_real_current_owner_sql_excludes_retired_and_missing_replacements():
    configured = os.getenv("ONE_COMMAND_TEST_DATABASE_URL")
    if not configured:
        pytest.skip("Canonical disposable PostgreSQL URL is required")
    import asyncpg
    from sqlalchemy.engine import make_url

    url = make_url(configured).set(drivername="postgresql").render_as_string(hide_password=False)
    conn = await asyncpg.connect(url, command_timeout=10)
    try:
        await conn.execute("""CREATE TEMP TABLE account_generations(
          identity_hash text, identity_uid text,owner_id text,generation integer,retired_at timestamptz)
        """)
        owner = "acct_" + "a" * 32
        for uid, account, generation, retired in [
            ("replacement", "replacement", 0, NOW),
            ("replacement", owner, 1, None),
            ("retired", "retired", 0, NOW),
        ]:
            await conn.execute(
                """INSERT INTO account_generations
              VALUES('sha256:'||encode(sha256(convert_to($1,'UTF8')),'hex'),$1,$2,$3,$4)
              """,
                uid,
                account,
                generation,
                retired,
            )
        query = identity.CURRENT_OWNERS_SQL.replace("CAST(:identities AS text[])", "$1::text[]")
        mapped = await conn.fetch(query, ["replacement", "retired", "legacy", "acct_" + "f" * 32])
        assert {row["uid"]: row["owner"] for row in mapped} == {
            "replacement": owner,
            "legacy": "legacy",
        }
    finally:
        await conn.close()
