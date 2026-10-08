"""A free grant and independent purchased terms never replace each other."""

from __future__ import annotations

from uuid import uuid4

import pytest

from hushh_mcp.consent import paid_admission
from hushh_mcp.services.consent_db import ConsentDBService
from tests import scope_commerce_contract_fixtures as fixtures
from tests.scope_commerce_contract_harness import (
    Grant,
    PaidContract,
    PaidGrant,
    active_token_ids,
    additional_purchase,
    existing_free_grant,
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


async def test_prior_free_grant_and_two_paid_terms_preserve_independent_lineage(
    paid_contract: PaidContract, monkeypatch: pytest.MonkeyPatch
):
    ctx = paid_contract
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

    first_revoked = await ctx.post(
        f"/purchases/{first.reservation.purchase_id}/revoke",
        {"idempotency_key": str(uuid4())},
        "owner",
    )
    assert first_revoked.status_code == 200, first_revoked.text
    await assert_admitted(first, False)
    await assert_admitted(second, True)
    assert all(await free.exports())
    assert await active_token_ids() == {free.token, second.grant.token}
    assert (await ctx.service.balance(payer_user_id="payer"))["balanceCents"] == 49

    second_revoked = await ctx.post(
        f"/purchases/{second.reservation.purchase_id}/revoke",
        {"idempotency_key": str(uuid4())},
        "owner",
    )
    assert second_revoked.status_code == 200, second_revoked.text
    await assert_admitted(second, False)
    assert all(await free.exports())
    assert await active_token_ids() == {free.token}
    await assert_free_expiry_unchanged(ctx, free)
    assert (await ctx.service.balance(payer_user_id="payer"))["balanceCents"] == 50
