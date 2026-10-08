"""Prepared public profiles cannot publish fixture or contact information."""

from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services.public_profile_assessment_client import validate_prepared_profile
from hushh_mcp.services.public_profile_projection import bind_anchor, store_prepared


def profile():
    return {
        "schema_version": "public_profile_review.v1",
        "entity_id": "dca42cd0-88af-4fcb-b276-9dbcec505f83",
        "revision": 1,
        "display_name": "Synthetic Researcher",
        "summary": "Public research",
        "collected_at": "2026-09-24T12:00:00Z",
        "identity": {"verdict": "matched", "reason": "Public source matches"},
        "facts": [
            {
                "category": "Professional",
                "claim": "Published research",
                "confidence": "high",
                "support": "Company page",
                "source_urls": ["https://example.org/research"],
                "observed_at": None,
                "collected_at": "2026-09-24T12:00:00Z",
            }
        ],
        "sources": ["https://example.org/research"],
        "conflicts": [],
        "warnings": [],
        "provenance": {
            "model": "synthetic-model",
            "prompt_version": "public-profile.v1",
            "mode": "vertex",
            "acquisition_refs": [],
        },
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "field",
    [
        "summary",
        "display_name",
        "claim",
        "support",
        "reason",
        "source",
        "warnings",
        "acquisition_refs",
    ],
)
async def test_contact_information_is_refused_before_any_pool_write(field):
    value = profile()
    contact = "synthetic@example.org"
    if field in {"claim", "support"}:
        value["facts"][0][field] = contact
    elif field == "reason":
        value["identity"][field] = contact
    elif field == "source":
        url = "https://example.org/synthetic%40example.org"
        value["sources"] = [url]
        value["facts"][0]["source_urls"] = [url]
    elif field == "acquisition_refs":
        value["provenance"][field] = [contact]
    elif field == "warnings":
        value[field] = [contact]
    else:
        value[field] = contact
    conn = AsyncMock()
    with pytest.raises(ValueError, match="contact information"):
        await store_prepared(conn, value)
    conn.fetchrow.assert_not_awaited()
    conn.execute.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "enabled,database,allowed",
    [
        (False, "hushh_profile_fixture_test", False),
        (True, "postgres", False),
        (True, "hushh_profile_fixture_test", True),
    ],
)
async def test_fixture_profiles_require_both_opt_in_and_isolated_database(
    monkeypatch, enabled, database, allowed
):
    monkeypatch.setenv("ONE_PUBLIC_PROFILE_FIXTURE_MODE", str(enabled).lower())
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("DB_HOST", "127.0.0.1")
    monkeypatch.delenv("K_SERVICE", raising=False)
    monkeypatch.delenv("DB_UNIX_SOCKET", raising=False)
    value = profile()
    value["provenance"]["mode"] = "fixture"
    conn = AsyncMock()
    conn.fetchval.return_value = database
    conn.fetchrow.return_value = {"entity_id": value["entity_id"]}
    if allowed:
        await store_prepared(conn, value)
        conn.fetchrow.assert_awaited_once()
    else:
        with pytest.raises(ValueError, match="isolated storage"):
            await store_prepared(conn, value)
        conn.fetchrow.assert_not_awaited()


@pytest.mark.asyncio
async def test_contact_bearing_owner_anchor_is_not_added_to_public_pool():
    conn = AsyncMock()
    with pytest.raises(ValueError, match="contact information"):
        await bind_anchor(
            conn, profile()["entity_id"], "https://example.org/synthetic%2540example.org"
        )
    conn.fetchval.assert_not_awaited()


def test_valid_dated_profile_retains_its_meaning():
    value = profile()
    value["summary"] = "Published research on 2026-09-24"
    assert validate_prepared_profile(value)["summary"] == value["summary"]


@pytest.mark.parametrize("protocol", ["legacy", "", "a2", "typo"])
def test_unknown_protocol_cannot_fall_back_to_legacy_writer(monkeypatch, protocol):
    from hushh_mcp.services.public_profile_discovery_service import _assessment_protocol

    monkeypatch.setenv("ONE_PUBLIC_PROFILE_PROTOCOL", protocol)
    with pytest.raises(ValueError, match="assessment is unavailable"):
        _assessment_protocol()


def test_legacy_source_parser_refuses_encoded_contacts():
    from hushh_mcp.services.public_profile_discovery_service import _source_url

    assert _source_url("https://example.org/person%40example.org") == ""
    assert _source_url("https://example.org/research") == "https://example.org/research"


@pytest.mark.asyncio
async def test_hosted_fixture_mode_is_refused_even_for_fixture_named_database(monkeypatch):
    monkeypatch.setenv("ONE_PUBLIC_PROFILE_FIXTURE_MODE", "true")
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("DB_HOST", "127.0.0.1")
    monkeypatch.setenv("K_SERVICE", "synthetic-hub")
    value = profile()
    value["provenance"]["mode"] = "fixture"
    conn = AsyncMock()
    conn.fetchval.return_value = "hushh_profile_fixture_test"
    with pytest.raises(ValueError, match="isolated storage"):
        await store_prepared(conn, value)
    conn.fetchrow.assert_not_awaited()


@pytest.mark.parametrize("protocol", ["a2a", "scan"])
def test_declared_protocols_preserve_their_explicit_paths(monkeypatch, protocol):
    from hushh_mcp.services.public_profile_discovery_service import _assessment_protocol

    monkeypatch.setenv("ONE_PUBLIC_PROFILE_PROTOCOL", protocol)
    assert _assessment_protocol() == protocol


@pytest.mark.asyncio
async def test_existing_entity_update_requires_frozen_candidate_membership():
    import os
    from uuid import UUID

    import asyncpg

    dsn = os.getenv("PROFILE_PROJECTION_TEST_DSN")
    if not dsn:
        pytest.skip("Explicit disposable PostgreSQL projection rehearsal required")
    conn = await asyncpg.connect(dsn)
    try:
        assert (await conn.fetchval("SELECT current_database()")).startswith("hushh_rehearsal")
        await conn.execute("""
            CREATE TABLE one_public_profile_entities (
                entity_id uuid PRIMARY KEY, display_name text, revision integer,
                prepared_payload jsonb, updated_at timestamptz DEFAULT now());
            CREATE TABLE one_public_profile_sources (
                entity_id uuid, source_url text, source_domain text, acquired_at timestamptz,
                UNIQUE(entity_id, source_url));
            CREATE TABLE one_public_profile_findings (
                entity_id uuid, revision integer, category text, claim text, confidence text,
                support text, source_urls text[], observed_at timestamptz, model_name text,
                model_version text, created_at timestamptz, UNIQUE(entity_id, revision, claim));
        """)
        value = profile()
        await store_prepared(conn, value)
        newer = {**value, "revision": 2, "summary": "New public research"}
        with pytest.raises(ValueError, match="Conflicting public profile revision"):
            await store_prepared(conn, newer)
        assert await conn.fetchval("SELECT revision FROM one_public_profile_entities") == 1
        await store_prepared(conn, newer, candidate_entity_ids=[UUID(value["entity_id"])])
        assert await conn.fetchval("SELECT revision FROM one_public_profile_entities") == 2
        await store_prepared(conn, newer, candidate_entity_ids=[UUID(value["entity_id"])])
        changed_same_revision = {**newer, "summary": "Conflicting public research"}
        with pytest.raises(ValueError, match="Conflicting public profile revision"):
            await store_prepared(
                conn, changed_same_revision, candidate_entity_ids=[UUID(value["entity_id"])]
            )
    finally:
        await conn.close()
