"""Money and activation contracts against an explicit isolated PostgreSQL DB.

Never use environment application credentials or db.connection.get_pool here.
Each test owns a disposable schema in the parent-authorized local test database.
"""

from __future__ import annotations

import asyncio
from dataclasses import replace
from uuid import UUID, uuid4

import asyncpg
import pytest

from hushh_mcp.services.scope_commerce import CommerceError, ScopeCommerceService
from hushh_mcp.services.scope_commerce.provider_sandbox import SandboxPolicy

from .test_scope_commerce_core_support import KEY_FINGERPRINT, fund, purchase, staged
from .test_scope_commerce_core_support import commerce_db as commerce_db


async def test_work_lease_starts_retry_clock_only_when_submission_becomes_possible(commerce_db):
    service, pool = commerce_db
    funding_id, _ = await fund(service, 50)
    refund_id = str(uuid4())
    await service.reserve_funding_refund(
        user_id="payer", funding_id=funding_id, refund_id=refund_id, amount_cents=50
    )
    claim = (await service.claim_obligations())[0]
    assert claim["first_dispatch_at"] is None and claim["create_allowed"] is True
    async with pool.acquire() as c, c.transaction():
        await service.mark_obligation_dispatch_started(obligation_id=refund_id, conn=c)
        assert await c.fetchval(
            "SELECT first_dispatch_at IS NOT NULL FROM scope_commerce_obligations WHERE obligation_id=$1",
            UUID(refund_id),
        )
        await c.execute(
            "UPDATE scope_commerce_obligations SET first_dispatch_at=clock_timestamp()-interval '21 hours',lease_expires_at=NULL WHERE obligation_id=$1",
            UUID(refund_id),
        )
    # This repeat claim exercised the timestamp-vs-interval inference failure.
    old_claim = (await service.claim_obligations())[0]
    assert old_claim["create_allowed"] is False


async def test_exact_scopes_share_handle_without_tariff_collision_and_quote_reprice(commerce_db):
    service, pool = commerce_db
    q, _ = await purchase(service, 19)
    await service.set_tariff(
        owner_user_id="owner",
        scope_handle="scope_abcdefgh",
        machine_scope="information.other",
        price_cents=71,
        base_duration_seconds=60,
        idempotency_key="other",
    )
    await service.set_tariff(
        owner_user_id="owner",
        scope_handle="scope_abcdefgh",
        machine_scope="information.test",
        price_cents=23,
        base_duration_seconds=60,
        idempotency_key="new-price",
    )
    assert (
        await service.get_tariff(
            owner_user_id="owner", scope_handle="scope_abcdefgh", machine_scope="information.other"
        )
    )["priceCents"] == 71
    assert (
        await service.get_tariff(
            owner_user_id="owner", scope_handle="scope_abcdefgh", machine_scope="information.test"
        )
    )["priceCents"] == 23
    assert (await service.get_quote_by_request(q["requestId"]))["priceCents"] == 19
    with pytest.raises(CommerceError, match="exact_machine_scope_required"):
        await service.get_tariff(owner_user_id="owner", scope_handle="scope_abcdefgh")
    async with pool.acquire() as c:
        with pytest.raises(asyncpg.CheckViolationError):
            await c.execute(
                "UPDATE scope_commerce_quotes SET price_cents=1 WHERE quote_id=$1",
                UUID(q["quoteId"]),
            )


async def test_environment_pin_rejects_flag_account_mode_and_country_switch(commerce_db):
    service, pool = commerce_db
    await fund(service, 50)
    switched = ScopeCommerceService(
        pool,
        enabled=True,
        provider_config=replace(service.provider_config, platform_account_id="acct_other"),
    )
    with pytest.raises(CommerceError, match="commerce_environment_mismatch"):
        await switched.bind_environment(platform_account_id="acct_other", livemode=False)
    with pytest.raises(CommerceError, match="commerce_environment_mismatch"):
        await switched.reserve_funding(
            payer_user_id="payer", funding_id=str(uuid4()), amount_cents=50
        )
    with pytest.raises(CommerceError, match="commerce_environment_mismatch"):
        await service.bind_environment(platform_account_id="acct_platform_test", livemode=True)
    async with pool.acquire() as c:
        with pytest.raises(asyncpg.CheckViolationError):
            await c.execute("UPDATE scope_commerce_environment SET livemode=true")
        await c.execute("UPDATE scope_commerce_seller_accounts SET livemode=true")
    with pytest.raises(CommerceError, match="seller_onboarding_required"):
        await purchase(service, 1)


async def test_reservation_deadline_and_missed_encryption_window_have_bounded_recovery(commerce_db):
    service, pool = commerce_db
    await fund(service, 50)
    async with pool.acquire() as c:
        earlier = await c.fetchval("SELECT clock_timestamp()+interval '1 hour'")
    q, p = await purchase(service, 10, request_deadline=earlier)
    await service.reserve_purchase(
        payer_user_id="payer", quote_id=q["quoteId"], idempotency_key="confirm"
    )
    async with pool.acquire() as c:
        assert (
            await c.fetchval(
                "SELECT fulfillment_deadline FROM scope_commerce_purchases WHERE purchase_id=$1",
                UUID(p["purchaseId"]),
            )
            == earlier
        )
    ctx = await service.preparation_context(
        owner_user_id="owner", purchase_id=p["purchaseId"], source_revisions={"contentRevision": 1}
    )
    async with pool.acquire() as c:
        await c.execute(
            "WITH t AS(SELECT clock_timestamp()-interval '1 second' AS v) UPDATE scope_commerce_purchases SET activation_at=t.v,expires_at=t.v+duration_seconds*interval '1 second' FROM t WHERE purchase_id=$1",
            UUID(p["purchaseId"]),
        )
    retry = await service.preparation_context(
        owner_user_id="owner", purchase_id=p["purchaseId"], source_revisions={"contentRevision": 2}
    )
    assert retry["preparationId"] != ctx["preparationId"] and retry["exportId"] != ctx["exportId"]
    assert retry["startsAtMs"] > ctx["startsAtMs"]
    q2, p2 = await purchase(service, 10)
    async with pool.acquire() as c:
        # Approval happened earlier; reservation starts its own <=24h window.
        await c.execute(
            "UPDATE scope_commerce_purchases SET fulfillment_deadline=clock_timestamp()+interval '1 hour' WHERE purchase_id=$1",
            UUID(p2["purchaseId"]),
        )
    await service.reserve_purchase(
        payer_user_id="payer", quote_id=q2["quoteId"], idempotency_key="confirm2"
    )
    async with pool.acquire() as c:
        seconds = await c.fetchval(
            "SELECT extract(epoch FROM fulfillment_deadline-clock_timestamp()) FROM scope_commerce_purchases WHERE purchase_id=$1",
            UUID(p2["purchaseId"]),
        )
        assert 86390 < seconds <= 86400
        await c.execute(
            "UPDATE scope_commerce_purchases SET fulfillment_deadline=clock_timestamp()-interval '1 second' WHERE purchase_id=$1",
            UUID(p2["purchaseId"]),
        )
    with pytest.raises(CommerceError, match="reserved_purchase_required"):
        await service.preparation_context(owner_user_id="owner", purchase_id=p2["purchaseId"])
    await service.settle_expired_earnings()
    assert (await service.lookup_by_request(p2["requestId"]))["status"] == "expired"


async def test_stage_atomicity_early_gate_revoke_fee_debt_and_replay(commerce_db):
    service, pool = commerce_db
    await fund(service, 100, 333333)
    q, p = await purchase(service, 100)
    await service.reserve_purchase(
        payer_user_id="payer", quote_id=q["quoteId"], idempotency_key="confirm"
    )

    async def fail(c, row):
        await c.execute(
            "INSERT INTO scope_commerce_financial_events VALUES('failed-callback','test','test','test',clock_timestamp())"
        )
        raise CommerceError("authority_changed")

    with pytest.raises(CommerceError, match="authority_changed"):
        await staged(service, p, fail)
    async with pool.acquire() as c:
        assert not await c.fetchval(
            "SELECT EXISTS(SELECT 1 FROM scope_commerce_financial_events WHERE event_id='failed-callback')"
        )
        assert not await c.fetchval(
            "SELECT EXISTS(SELECT 1 FROM scope_commerce_journal WHERE kind='staged_activation')"
        )
    active = await staged(service, p)
    assert active["status"] == "armed"
    assert not (await service.access_state(purchase_id=p["purchaseId"], buyer_app_id="app"))[
        "accessAllowed"
    ]
    refund = await service.revoke_purchase(owner_user_id="owner", purchase_id=p["purchaseId"])
    assert refund["refundedCents"] == 100
    assert refund["processingFeeMicroUsd"] == refund["netEarningsMicroUsd"] == 0
    assert (await service.earnings(owner_user_id="owner"))["debtCents"] == 0
    async with pool.acquire() as c:
        original = await c.fetchrow(
            "SELECT available_micro_usd,fee_remaining_micro_usd,fee_basis_remaining_micro_usd FROM scope_commerce_funding_lots"
        )
        assert tuple(original) == (1000000, 333333, 1000000)
    assert (await service.balance(payer_user_id="payer"))["balanceCents"] == 100
    assert (
        await service.revoke_purchase(owner_user_id="owner", purchase_id=p["purchaseId"]) == refund
    )
    # Pre-T cancellation restores the original source fee for a later term.
    q2, p2 = await purchase(service, 100)
    await service.reserve_purchase(
        payer_user_id="payer", quote_id=q2["quoteId"], idempotency_key="confirm2"
    )
    async with pool.acquire() as c:
        assert (
            await c.fetchval(
                "SELECT fee_micro_usd FROM scope_commerce_purchases WHERE purchase_id=$1",
                UUID(p2["purchaseId"]),
            )
            == 333333
        )
        assert (
            await c.fetchval(
                "SELECT COALESCE(sum(micro_usd),0)::bigint FROM scope_commerce_postings"
            )
            == 0
        )


async def test_stage_revoke_serialization_releases_or_refunds_once_and_funded_event_once(
    commerce_db,
):
    service, pool = commerce_db
    await fund(service, 50)
    q, p = await purchase(service, 50)

    async def notify(c, row):
        await c.execute(
            "INSERT INTO scope_commerce_financial_events VALUES('funded_notice','notice',$1,'notice',clock_timestamp())",
            row["request_id"],
        )

    for _ in range(2):
        await service.reserve_purchase(
            payer_user_id="payer",
            quote_id=q["quoteId"],
            idempotency_key="human-confirm",
            on_reserved=notify,
        )
    results = await asyncio.gather(
        staged(service, p),
        service.revoke_purchase(owner_user_id="owner", purchase_id=p["purchaseId"]),
        return_exceptions=True,
    )
    assert isinstance(results[1], dict)
    assert (await service.lookup_by_request(p["requestId"]))["status"] == "revoked"
    assert (await service.balance(payer_user_id="payer"))["balanceCents"] == 50
    async with pool.acquire() as c:
        assert (
            await c.fetchval(
                "SELECT count(*) FROM scope_commerce_financial_events WHERE event_id='funded_notice'"
            )
            == 1
        )
        assert (
            await c.fetchval(
                "SELECT count(*) FROM scope_commerce_journal WHERE kind IN ('reservation_release','earnings_settlement')"
            )
            == 1
        )


async def test_feature_rollback_keeps_tariff_and_known_paid_admission(commerce_db):
    service, pool = commerce_db
    await fund(service, 50)
    q, p = await purchase(service, 10)
    await service.reserve_purchase(
        payer_user_id="payer", quote_id=q["quoteId"], idempotency_key="reserve"
    )
    await staged(service, p)
    disabled = ScopeCommerceService(pool, enabled=False)
    assert await disabled.get_tariff(owner_user_id="owner", scope_handle="scope_abcdefgh")
    raw = await disabled.lookup_by_consent_token("synthetic-token-" + p["requestId"])
    assert raw["status"] == "staged" and raw["owner_user_id"] == "owner"
    with pytest.raises(CommerceError, match="commerce_unavailable"):
        await disabled.reserve_funding(
            payer_user_id="payer", funding_id=str(uuid4()), amount_cents=50
        )
    assert (await disabled.revoke_purchase(owner_user_id="owner", purchase_id=p["purchaseId"]))[
        "status"
    ] == "revoked"


async def test_free_tariff_and_balance_need_no_provider_admission_or_bootstrap(commerce_db):
    service, pool = commerce_db
    free = ScopeCommerceService(pool, enabled=False)
    payload = {
        "owner_user_id": "new-owner",
        "scope_handle": "scope_free",
        "machine_scope": "attr.travel.preferences.*",
        "price_cents": 0,
        "base_duration_seconds": 3600,
        "idempotency_key": "free-revision",
    }
    revision = await free.set_tariff(**payload)
    assert revision == await free.set_tariff(**payload)
    assert revision["priceCents"] == 0 and revision["tariffRevision"] == 1
    with pytest.raises(CommerceError, match="idempotency_conflict"):
        await free.set_tariff(**{**payload, "base_duration_seconds": 7200})
    with pytest.raises(CommerceError, match="commerce_unavailable"):
        await free.set_tariff(**{**payload, "price_cents": 1})
    assert (await free.balance(payer_user_id="new-payer"))["balanceCents"] == 0
    async with pool.acquire() as c:
        assert await c.fetchval("SELECT count(*) FROM scope_commerce_wallets") == 0
        assert await c.fetchval("SELECT count(*) FROM scope_commerce_sellers") == 0
        assert await c.fetchval("SELECT count(*) FROM scope_commerce_journal") == 0


@pytest.mark.parametrize("excluded", ["owner", "payer"])
async def test_sandbox_actor_admission_bounds_new_paid_work_but_preserves_existing_release(
    commerce_db, excluded
):
    service, pool = commerce_db
    await fund(service, 50)
    reserved_quote, reserved = await purchase(service, 1)
    quote, _ = await purchase(service, 1)
    await service.reserve_purchase(
        payer_user_id="payer", quote_id=reserved_quote["quoteId"], idempotency_key="confirmed"
    )
    service.provider_config = replace(
        service.provider_config,
        sandbox_policy=SandboxPolicy(
            service.provider_config.platform_account_id, ("owner", "payer")
        ),
    )
    assert (await service.readiness(viewer_user_id="owner"))["capabilities"]["set_paid_tariff"]
    permitted = ("payer", "other") if excluded == "owner" else ("owner", "other")
    service.provider_config = replace(
        service.provider_config,
        sandbox_policy=SandboxPolicy(service.provider_config.platform_account_id, permitted),
    )
    async with pool.acquire() as c:
        before = await c.fetchrow(
            "SELECT (SELECT count(*) FROM scope_commerce_quotes) AS quotes, (SELECT count(*) FROM scope_commerce_purchases) AS purchases, (SELECT count(*) FROM scope_commerce_reservations) AS reservations, (SELECT count(*) FROM scope_commerce_journal) AS journals"
        )
    terms = dict(
        owner_user_id="owner",
        buyer_app_id="app",
        payer_user_id="payer",
        scope_handle="scope_abcdefgh",
        machine_scope="information.test",
        duration_seconds=60,
        recipient_key_fingerprint=KEY_FINGERPRINT,
        idempotency_key=str(uuid4()),
        purpose="contract test",
        refresh_policy="snapshot",
        scope_manifest_revision="1",
    )
    for request_id in (quote["requestId"], "req_" + uuid4().hex):
        with pytest.raises(CommerceError, match="provider_sandbox_reviewer_required"):
            await service.quote(**terms, request_id=request_id)
    with pytest.raises(CommerceError, match="provider_sandbox_reviewer_required"):
        await service.approve_quote(
            owner_user_id="owner", quote_id=quote["quoteId"], request_id=quote["requestId"]
        )
    with pytest.raises(CommerceError, match="provider_sandbox_reviewer_required"):
        await service.reserve_purchase(
            payer_user_id="payer", quote_id=quote["quoteId"], idempotency_key="new-confirmation"
        )
    if excluded == "owner":
        with pytest.raises(CommerceError, match="provider_sandbox_reviewer_required"):
            await service.set_tariff(
                owner_user_id="owner",
                scope_handle="scope_abcdefgh",
                machine_scope="information.test",
                price_cents=2,
                base_duration_seconds=60,
                idempotency_key="changed-price",
            )
    async with pool.acquire() as c:
        after = await c.fetchrow(
            "SELECT (SELECT count(*) FROM scope_commerce_quotes) AS quotes, (SELECT count(*) FROM scope_commerce_purchases) AS purchases, (SELECT count(*) FROM scope_commerce_reservations) AS reservations, (SELECT count(*) FROM scope_commerce_journal) AS journals"
        )
    assert dict(after) == dict(before)
    await service.set_tariff(
        owner_user_id="owner",
        scope_handle="scope_abcdefgh",
        machine_scope="information.test",
        price_cents=0,
        base_duration_seconds=60,
        idempotency_key="free",
    )
    await service.revoke_purchase(owner_user_id="owner", purchase_id=reserved["purchaseId"])
    assert (await service.balance(payer_user_id="payer"))["balanceCents"] == 50
