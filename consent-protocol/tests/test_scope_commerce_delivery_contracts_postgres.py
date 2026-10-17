"""Encrypted paid export admission and source-refresh boundaries on PostgreSQL."""

from __future__ import annotations

import base64
import copy
from datetime import UTC, datetime
from uuid import uuid4

import pytest

from hushh_mcp.consent import paid_admission
from hushh_mcp.consent.export_envelope import canonical_aad_bytes, digest_bytes
from hushh_mcp.services.consent_db import ConsentDBService
from hushh_mcp.services.personal_knowledge_model_service import (
    DomainManifest,
    PersonalKnowledgeModelService,
)
from tests import scope_commerce_contract_fixtures as fixtures
from tests.scope_commerce_contract_harness import (
    PUBLIC_KEY,
    SCOPE,
    PaidContract,
    PaidGrant,
    active_token_ids,
    additional_purchase,
    encrypted_package,
    existing_free_grant,
    funded_reservation,
    staged_purchase,
)

connector_postgres_url = fixtures.connector_postgres_url
paid_contract_dsn = fixtures.paid_contract_dsn
paid_contract = fixtures.paid_contract


async def test_exact_scope_stage_rejects_broadening_and_pre_activation_reads(
    paid_contract: PaidContract, monkeypatch: pytest.MonkeyPatch
):
    ctx = paid_contract
    reservation = await funded_reservation(ctx)
    context = await ctx.prepare(reservation)
    assert context["expires_at_ms"] - context["starts_at_ms"] == 3_600_000
    package = encrypted_package(context)
    wrong_scope = copy.deepcopy(package)
    wrong_scope["exportEnvelope"]["aad"]["machine_scope"] = "attr.travel.*"
    wrong_scope["exportEnvelope"]["aad_sha256"] = digest_bytes(
        canonical_aad_bytes(wrong_scope["exportEnvelope"]["aad"])
    )
    failed = await ctx.post(
        f"/purchases/{reservation.purchase_id}/stage",
        {"preparation_id": context["preparation_id"], "envelope": wrong_scope},
        "owner",
    )
    assert failed.status_code != 200
    async with ctx.pool.acquire() as conn:
        assert (
            await conn.fetchval(
                "SELECT COUNT(*) FROM consent_exports WHERE grant_id=$1", reservation.request_id
            )
            == 0
        )
    assert (await ctx.service.balance(payer_user_id="payer"))["reservedCents"] == 1
    paid = await ctx.stage(reservation, context)
    assert await paid_admission.paid_grant_is_admitted(paid.grant.token, paid.metadata) is False
    assert await paid.grant.exports() == [None] * 4
    status = await ConsentDBService().get_request_status_for_agent(
        reservation.request_id, agent_id="developer:app"
    )
    assert status["action"] == "CONSENT_PAID_APPROVED" and status["token_id"] is None
    for path in (f"/requests/{reservation.request_id}", f"/purchases/{reservation.purchase_id}"):
        projection = await ctx.get(path)
        assert projection.status_code == 200, projection.text
        assert not any(
            field in projection.text
            for field in (
                "consent_token",
                "token_hash",
                "ciphertext",
                "staged_export",
                "wrapped_export_key",
            )
        )

    async def bypass_paid_guard(*_args, **_kwargs):
        return True

    # Negative control: the same committed ciphertext becomes visible if the
    # shared paid admission check is bypassed. No other authority is mocked.
    with monkeypatch.context() as bypass:
        bypass.setattr(paid_admission, "paid_grant_is_admitted", bypass_paid_guard)
        assert all(await paid.grant.exports())
    assert await paid.grant.exports() == [None] * 4


async def assert_internal_refresh_candidate(paid: PaidGrant) -> None:
    candidates = await ConsentDBService().get_continuous_refresh_candidates_for_domain(
        "owner", "travel"
    )
    candidate = next(row for row in candidates if row["token_id"] == paid.grant.token)
    metadata = candidate["_refresh_metadata"]
    assert metadata["refresh_policy"] == "continuous_until_expiry"
    assert metadata["scope_handle"] == paid.context["scope_handle"]
    assert metadata["envelope_version"] == 2
    assert metadata["is_strict_zero_knowledge"] is True
    assert candidate["expires_at"] == paid.grant.expires_at_ms
    manifest = DomainManifest(
        user_id="owner", domain="travel", top_level_scope_paths=["preferences"]
    )
    tokens = await PersonalKnowledgeModelService()._continuous_refresh_tokens_for_domain_write(
        user_id="owner", domain="travel", manifest=manifest
    )
    assert tokens == [paid.grant.token]


async def test_pre_activation_source_write_queues_continuous_owner_refresh_only(
    paid_contract: PaidContract,
):
    ctx = paid_contract
    free = await existing_free_grant(ctx)
    snapshot = await staged_purchase(ctx)
    continuous = await additional_purchase(ctx, "continuous_until_expiry")
    assert continuous.grant.token != snapshot.grant.token
    assert continuous.context["starts_at_ms"] > snapshot.context["starts_at_ms"]
    assert await active_token_ids() == {free.token}
    await assert_internal_refresh_candidate(continuous)
    async with ctx.pool.acquire() as conn:
        # This committed PKM write executes the actual deferred migration269
        # refresh trigger, rather than a Python approximation of the queue.
        await conn.execute("UPDATE pkm_blobs SET content_revision=2 WHERE user_id='owner'")
        jobs = await conn.fetch(
            "SELECT consent_token,granted_scope,status,trigger_domain,claim_id,expected_export_revision FROM consent_export_refresh_jobs"
        )
        assert len(jobs) == 1
        assert jobs[0]["consent_token"] == continuous.grant.token
        assert jobs[0]["status"] == "pending"
        assert jobs[0]["granted_scope"] == SCOPE
        assert jobs[0]["trigger_domain"] == "travel"
        assert jobs[0]["claim_id"] is None
        assert jobs[0]["expected_export_revision"] == 1
        assert (
            await conn.fetchval(
                "SELECT COUNT(*) FROM consent_export_refresh_jobs WHERE consent_token=ANY($1::text[])",
                [snapshot.grant.token, free.token],
            )
            == 0
        )
        stored = await conn.fetchrow(
            "SELECT expires_at,refresh_status,envelope_aad_sha256 FROM consent_exports WHERE grant_id=$1",
            continuous.grant.request_id,
        )
        assert stored["refresh_status"] == "refresh_pending"
        assert int(stored["expires_at"].timestamp() * 1000) == continuous.grant.expires_at_ms
        assert (
            stored["envelope_aad_sha256"]
            == encrypted_package(continuous.context)["exportEnvelope"]["aad_sha256"]
        )
    await assert_internal_refresh_candidate(continuous)
    assert await active_token_ids() == {free.token}
    assert (
        await paid_admission.paid_grant_is_admitted(continuous.grant.token, continuous.metadata)
        is False
    )
    assert await continuous.grant.exports() == [None] * 4


@pytest.mark.parametrize("ending", ["revocation", "expiry"])
async def test_rollback_retains_account_obligations_and_paid_activation_enforcement(
    paid_contract: PaidContract, monkeypatch: pytest.MonkeyPatch, ending: str
):
    ctx = paid_contract
    paid = await staged_purchase(ctx)
    monkeypatch.setenv("SCOPE_COMMERCE_ENABLED", "false")
    account = await ctx.get("/account")
    assert account.status_code == 200, account.text
    assert account.json()["enabled"] is False
    assert account.json()["balance"]["available_cents"] == 49
    assert "earnings" in account.json()
    assert await paid_admission.paid_grant_is_admitted(paid.grant.token, paid.metadata) is False
    assert await paid.grant.exports() == [None] * 4
    await ctx.activate(paid, monkeypatch)
    assert await paid_admission.paid_grant_is_admitted(paid.grant.token, paid.metadata) is True
    assert all(await paid.grant.exports())
    active = await ctx.service.access_state(
        purchase_id=paid.reservation.purchase_id, buyer_app_id="app"
    )
    assert active["accessAllowed"] is True
    if ending == "expiry":
        expiry = datetime.fromtimestamp(paid.grant.expires_at_ms / 1000, UTC)
        async with ctx.pool.acquire() as conn:
            await conn.execute("UPDATE contract_clock SET observed_at=$1", expiry)
            assert await conn.fetchval(
                "SELECT earnings_settled_at IS NULL FROM scope_commerce_purchases WHERE purchase_id=$1",
                paid.reservation.purchase_id,
            )
        monkeypatch.setattr("hushh_mcp.services.scope_commerce.domain.utcnow", lambda: expiry)
        assert await paid_admission.paid_grant_is_admitted(paid.grant.token, paid.metadata) is False
        assert await paid.grant.exports() == [None] * 4
        return
    revoke = await ctx.post(
        f"/purchases/{paid.reservation.purchase_id}/revoke",
        {"idempotency_key": str(uuid4())},
        "owner",
    )
    assert revoke.status_code == 200, revoke.text
    assert await paid.grant.exports() == [None] * 4


async def test_registered_recipient_key_rotation_invalidates_paid_retrieval(
    paid_contract: PaidContract, monkeypatch: pytest.MonkeyPatch
):
    ctx = paid_contract
    paid = await staged_purchase(ctx)
    await ctx.activate(paid, monkeypatch)
    assert await paid_admission.paid_grant_is_admitted(paid.grant.token, paid.metadata) is True
    async with ctx.pool.acquire() as conn:
        await conn.execute(
            "UPDATE developer_connector_keys SET connector_public_key=$1",
            base64.b64encode(b"r" * 32).decode(),
        )
    assert await paid_admission.paid_grant_is_admitted(paid.grant.token, paid.metadata) is False
    assert await paid.grant.exports() == [None] * 4
    rotated = await ctx.get(f"/purchases/{paid.reservation.purchase_id}")
    assert rotated.status_code == 200, rotated.text
    assert rotated.json()["access_allowed"] is False
    async with ctx.pool.acquire() as conn:
        await conn.execute(
            "UPDATE developer_connector_keys SET connector_public_key=$1", PUBLIC_KEY
        )
    assert await paid_admission.paid_grant_is_admitted(paid.grant.token, paid.metadata) is True


async def test_paid_reads_require_original_provider_environment_pin_without_admission_flags(
    paid_contract: PaidContract, monkeypatch: pytest.MonkeyPatch
):
    ctx = paid_contract
    free = await existing_free_grant(ctx)
    paid = await staged_purchase(ctx)
    await ctx.activate(paid, monkeypatch)
    assert await paid_admission.paid_grant_is_admitted(paid.grant.token, paid.metadata) is True
    assert all(await paid.grant.exports())

    for setting, value in (
        ("SCOPE_COMMERCE_STRIPE_LIVEMODE", "true"),
        ("SCOPE_COMMERCE_STRIPE_ACCOUNT_ID", "acct_other_platform"),
    ):
        with monkeypatch.context() as repointed:
            repointed.setenv(setting, value)
            assert (
                await paid_admission.paid_grant_is_admitted(paid.grant.token, paid.metadata)
                is False
            )
            assert await paid.grant.exports() == [None] * 4
            assert all(await free.exports())

    # Disabling new admission/payment operations preserves a historical paid
    # grant only while the durable original provider account and mode match.
    monkeypatch.setenv("SCOPE_COMMERCE_ENABLED", "false")
    monkeypatch.setenv("SCOPE_COMMERCE_PROVIDER_ENABLED", "false")
    assert await paid_admission.paid_grant_is_admitted(paid.grant.token, paid.metadata) is True
    assert all(await paid.grant.exports())
