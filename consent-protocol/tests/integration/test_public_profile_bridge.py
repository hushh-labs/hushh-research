"""Opt-in real PostgreSQL + real local HusshOne A2A proof, synthetic identity input.

This tests the service bridge; route tests separately exercise authorization.
It is not a replacement for authenticated browser/vault acceptance.
"""

import asyncio
import os
from unittest.mock import AsyncMock
from uuid import UUID, uuid4

import asyncpg
import pytest

import hushh_mcp.services.public_profile_discovery_service as module
from hushh_mcp.services.profile_claim_receipts import claim_operations

DSN = os.getenv("PROFILE_BRIDGE_TEST_DSN")
BASE = os.getenv("PROFILE_BRIDGE_TEST_BASE")
pytestmark = pytest.mark.skipif(
    not DSN or not BASE, reason="Explicit isolated bridge services required"
)


@pytest.mark.asyncio
async def test_saved_new_ambiguous_resume_and_receipt_bound_claim(monkeypatch):
    pool = await asyncpg.create_pool(DSN, min_size=1, max_size=4)
    assert (await pool.fetchval("SELECT current_database()")).startswith("hushh_profile_fixture_")
    monkeypatch.setattr(module, "get_pool", AsyncMock(return_value=pool))
    monkeypatch.setenv("ONE_PUBLIC_PROFILE_DISCOVERY_ENABLED", "true")
    monkeypatch.setenv("ONE_PUBLIC_PROFILE_PROTOCOL", "a2a")
    monkeypatch.setenv("INTELLIGENCE_API_BASE_URL", BASE)
    monkeypatch.setenv("INTELLIGENCE_API_KEY", "local-fixture-service-key")
    suffix = uuid4().hex
    owner = "fixture-" + suffix
    name = "Fixture Researcher " + suffix
    identity = AsyncMock()
    identity.ensure_many.side_effect = lambda ids: {
        uid: {"display_name": name, "email": "fixture@example.org", "phone_verified": True}
        for uid in ids
    }
    service = module.PublicProfileDiscoveryService(identity_service=identity)
    url = "https://example.org/fixture/" + suffix
    try:
        job = await service.start(
            user_id=owner, consent=True, consent_version=module.CONSENT_VERSION, profile_url=url
        )
        again = await service.start(
            user_id=owner, consent=True, consent_version=module.CONSENT_VERSION, profile_url=url
        )
        assert again["job_id"] == job["job_id"]
        assert job["status"] == "queued"

        async def finish(uid):
            for _ in range(20):
                await pool.execute(
                    "UPDATE one_profile_discovery_jobs SET next_attempt_at=now() WHERE user_id=$1",
                    uid,
                )
                await service.drain()
                current = await service.status(user_id=uid)
                if current["status"] in {"ready", "needs_details", "failed"}:
                    return current
                await asyncio.sleep(0.3)
            raise AssertionError("Fixture worker did not complete")

        ready = await finish(owner)
        assert ready["status"] == "ready", ready
        assert ready["profile"]["provenance"]["mode"] == "fixture"
        await service.drain_feed_outbox()
        assert (
            await pool.fetchval(
                "SELECT count(*) FROM feed_events WHERE user_id=$1 AND source_domain='profile_discovery'",
                owner,
            )
            == 1
        )
        # Another owner reuses typed evidence, but identity is still assessed by H1.
        second = owner + "-second"
        await service.start(
            user_id=second, consent=True, consent_version=module.CONSENT_VERSION, profile_url=url
        )
        assert (await finish(second))["status"] == "ready"
        key = uuid4()
        cards = [{"card_id": "a", "domain": "professional"}]
        prepared = await service.prepare_claim(
            user_id=owner, revision=ready["profile_revision"], operation_key=key, cards=cards
        )
        assert prepared["committed_card_ids"] == []
        with pytest.raises(module.ProfileDiscoveryError, match="not all committed"):
            await service.complete_claim(
                user_id=owner,
                revision=ready["profile_revision"],
                idempotency_key=key,
                reject_all=False,
                accepted_count=1,
            )
        receipt = claim_operations(owner, key, cards)[0]
        # A synthetic ledger receipt tests completion binding; the actual PKM writer
        # is exercised by its existing coordinator/atomic-write suites.
        await pool.execute(
            """INSERT INTO pkm_domain_commits(commit_id,user_id,domain,commit_kind,expected_content_revision,expected_manifest_revision,result_content_revision,result_manifest_revision)
           VALUES($1,$2,$3,'mutation',0,0,1,1)""",
            UUID(receipt["commit_id"]),
            owner,
            receipt["domain"],
        )
        resumed = await service.prepare_claim(
            user_id=owner, revision=ready["profile_revision"], operation_key=key, cards=cards
        )
        assert resumed["committed_card_ids"] == ["a"]
        claimed = await service.complete_claim(
            user_id=owner,
            revision=ready["profile_revision"],
            idempotency_key=key,
            reject_all=False,
            accepted_count=1,
        )
        assert claimed["status"] == "claimed"
        assert (
            await service.start(user_id=owner, consent=True, consent_version=module.CONSENT_VERSION)
        )["status"] == "claimed"
        await service.complete_claim(
            user_id=second,
            revision=ready["profile_revision"],
            idempotency_key=uuid4(),
            reject_all=True,
            accepted_count=0,
        )
        ambiguous = owner + "-ambiguous"
        await service.start(
            user_id=ambiguous,
            consent=True,
            consent_version=module.CONSENT_VERSION,
            name="Fixture same name",
        )
        assert (await finish(ambiguous))["status"] == "needs_details"
    finally:
        await pool.close()
