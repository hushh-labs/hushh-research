"""A free grant and independent purchased terms never replace each other."""

from __future__ import annotations

from unittest.mock import AsyncMock
from uuid import uuid4

import pytest

from hushh_mcp.consent import paid_admission
from hushh_mcp.services.consent_db import ConsentDBService
from tests import scope_commerce_contract_fixtures as fixtures
from tests.scope_commerce_contract_harness import (
    SCOPE,
    Grant,
    PaidContract,
    PaidGrant,
    active_token_ids,
    additional_purchase,
    approved_quote,
    existing_free_grant,
    reserve_quote,
    staged_purchase,
)

connector_postgres_url = fixtures.connector_postgres_url
paid_contract_dsn = fixtures.paid_contract_dsn
paid_contract = fixtures.paid_contract


async def assert_admitted(paid: PaidGrant, expected: bool) -> None:
    assert await paid_admission.paid_grant_is_admitted(paid.grant.token, paid.metadata) is expected
    if expected:
        assert all(await paid.grant.exports())
    else:
        assert await paid.grant.exports() == [None] * 4


async def assert_free_expiry_unchanged(ctx: PaidContract, free: Grant) -> None:
    async with ctx.pool.acquire() as conn:
        expiry = await conn.fetchval(
            "SELECT expires_at FROM consent_exports WHERE grant_id=$1", free.request_id
        )
        assert int(expiry.timestamp() * 1000) == free.expires_at_ms
        assert (
            await conn.fetchval(
                "SELECT expires_at FROM consent_audit WHERE token_id=$1 AND action='CONSENT_GRANTED'",
                free.token,
            )
            == free.expires_at_ms
        )


async def assert_latest_scope_regression_negative_control(
    ctx: PaidContract, free: Grant, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def latest_scope_only(_self, user_id, scope, agent_id=None, *, token_id=None):
        # Characterize the actual earlier regression: the latest same-scope
        # paid grant erased a valid free grant's independent lineage.
        async with ctx.pool.acquire() as conn:
            latest = await conn.fetchrow(
                """SELECT action,token_id FROM consent_audit WHERE user_id=$1
                   AND agent_id=$2 AND scope=$3 AND action IN ('CONSENT_GRANTED','REVOKED')
                   ORDER BY issued_at DESC,id DESC LIMIT 1""",
                user_id,
                agent_id,
                scope,
            )
        return bool(
            latest and latest["action"] == "CONSENT_GRANTED" and latest["token_id"] == token_id
        )

    with monkeypatch.context() as broken:
        broken.setattr(ConsentDBService, "is_token_active", latest_scope_only)
        assert await free.exports() == [None] * 4
    assert all(await free.exports())


@pytest.mark.parametrize("revoke_surface", ["commerce", "consent"])
async def test_prior_free_grant_and_two_paid_terms_preserve_independent_lineage(
    paid_contract: PaidContract, monkeypatch: pytest.MonkeyPatch, revoke_surface: str
):
    ctx = paid_contract

    async def revoke(paid: PaidGrant) -> None:
        if revoke_surface == "commerce":
            response = await ctx.post(
                f"/purchases/{paid.reservation.purchase_id}/revoke",
                {"idempotency_key": str(uuid4())},
                "owner",
            )
            assert response.status_code == 200, response.text
            return
        from hushh_mcp.services.consent_lifecycle_service import ConsentLifecycleService

        async def identifiers(user_id):
            return [user_id]

        response = await ConsentLifecycleService(
            identifiers_resolver=identifiers
        ).revoke_active_grant("owner", request_id=paid.reservation.request_id)
        assert response["status"] == "revoked" and response["lockVault"] is False
        assert response["scope"] == SCOPE

    free = await existing_free_grant(ctx)
    assert all(await free.exports())
    first = await staged_purchase(ctx)
    second = await additional_purchase(ctx)
    assert first.grant.token != second.grant.token
    assert first.context["starts_at_ms"] < second.context["starts_at_ms"]
    assert await active_token_ids() == {free.token}
    assert all(await free.exports())
    await assert_admitted(first, False)
    await assert_admitted(second, False)

    # Only the database clock advances; process wall time still precedes T.
    # This guards paid token enumeration against premature wall-clock filtering.
    await ctx.activate(first, monkeypatch)
    await assert_admitted(first, True)
    await assert_admitted(second, False)
    assert all(await free.exports())
    assert await active_token_ids() == {free.token, first.grant.token}
    await ctx.activate(second, monkeypatch)
    await assert_admitted(first, True)
    await assert_admitted(second, True)
    assert await active_token_ids() == {free.token, first.grant.token, second.grant.token}
    await assert_latest_scope_regression_negative_control(ctx, free, monkeypatch)

    await revoke(first)
    await assert_admitted(first, False)
    await assert_admitted(second, True)
    assert all(await free.exports())
    assert await active_token_ids() == {free.token, second.grant.token}
    assert (await ctx.service.balance(payer_user_id="payer"))["balanceCents"] == 49

    await revoke(second)
    await assert_admitted(second, False)
    assert all(await free.exports())
    assert await active_token_ids() == {free.token}
    await assert_free_expiry_unchanged(ctx, free)
    assert (await ctx.service.balance(payer_user_id="payer"))["balanceCents"] == 50


@pytest.mark.parametrize("activated", [False, True])
async def test_bulk_owner_revocation_ends_unusable_paid_terms_and_preserves_money(
    paid_contract: PaidContract, monkeypatch: pytest.MonkeyPatch, activated: bool
):
    from hushh_mcp.services.consent_lifecycle_service import ConsentLifecycleService

    ctx = paid_contract
    armed = await staged_purchase(ctx)
    unpaid_id = await ctx.additional_request()
    await approved_quote(ctx, unpaid_id)
    reserved_id = await ctx.additional_request()
    reserved = await reserve_quote(ctx, await approved_quote(ctx, reserved_id), reserved_id)
    preparing_id = await ctx.additional_request()
    preparing = await reserve_quote(ctx, await approved_quote(ctx, preparing_id), preparing_id)
    await ctx.prepare(preparing)
    if activated:
        await ctx.activate(armed, monkeypatch)
        await assert_admitted(armed, True)
    # A payer is not the seller; bulk owner revocation must not refund their buys.
    assert await paid_admission.end_owner_paid_purchases("payer") == 0
    monkeypatch.setenv("SCOPE_COMMERCE_ENABLED", "false")

    async def identifiers(user_id):
        return [user_id]

    # This isolated authority fixture has no internal vault-grant table.
    monkeypatch.setattr(ConsentDBService, "get_active_internal_tokens", AsyncMock(return_value=[]))
    lifecycle = ConsentLifecycleService(identifiers_resolver=identifiers)
    if not activated:
        # Original active-token-only selection misses every future-T/unfinished term.
        with monkeypatch.context() as broken:
            broken.setattr(paid_admission, "end_owner_paid_purchases", AsyncMock(return_value=0))
            assert await lifecycle.revoke_all_active_grants("owner") == 0
            with pytest.raises(AssertionError):
                assert (await ctx.service.lookup_by_request(armed.reservation.request_id))[
                    "status"
                ] == "revoked"

    assert await lifecycle.revoke_all_active_grants("owner") == 4
    for request_id in (
        armed.reservation.request_id,
        unpaid_id,
        reserved.request_id,
        preparing.request_id,
    ):
        assert (await ctx.service.lookup_by_request(request_id))["status"] == "revoked"
    await assert_admitted(armed, False)
    assert (await ctx.service.balance(payer_user_id="payer"))["balanceCents"] == 50
    async with ctx.pool.acquire() as conn:
        assert not await conn.fetchval(
            "SELECT EXISTS(SELECT 1 FROM scope_commerce_purchases WHERE owner_user_id IS NULL OR payer_user_id IS NULL OR erased_at IS NOT NULL)"
        )
        assert not await conn.fetchval(
            "SELECT EXISTS(SELECT entry_id FROM scope_commerce_postings GROUP BY entry_id HAVING sum(micro_usd) <> 0)"
        )
        assert await conn.fetchval("SELECT count(*) FROM consent_audit WHERE action='REVOKED'") == 4
    assert await lifecycle.revoke_all_active_grants("owner") == 0
    assert (await ctx.service.balance(payer_user_id="payer"))["balanceCents"] == 50
