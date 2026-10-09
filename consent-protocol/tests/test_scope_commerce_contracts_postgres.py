"""Consumer consent, human purchase and immutable financial-history contracts."""

from __future__ import annotations

import importlib
import json
from dataclasses import replace
from uuid import uuid4

import pytest

from hushh_mcp.consent import paid_admission
from hushh_mcp.consent.export_envelope import scope_handle_for_machine_scope
from hushh_mcp.services.scope_commerce.provider_sandbox import SandboxPolicy
from tests import scope_commerce_contract_fixtures as fixtures
from tests.scope_commerce_contract_harness import (
    HANDLE,
    SCOPE,
    PaidContract,
    approved_quote,
    encrypted_package,
    funded_reservation,
    staged_purchase,
)

connector_postgres_url = fixtures.connector_postgres_url
paid_contract_dsn = fixtures.paid_contract_dsn
paid_contract = fixtures.paid_contract


def test_paid_scope_schema_readiness_projections_match_registered_migration(monkeypatch):
    monkeypatch.syspath_prepend(str(fixtures.MIGRATIONS.parents[1] / "scripts"))
    generator = importlib.import_module("generate_scope_commerce_schema_contracts")
    projections = generator.expected_contracts()
    assert {path.name for path in projections} == {
        "prod_core_schema.json",
        "dev_minimum_schema.json",
        "uat_integrated_schema.json",
    }
    for path, expected in projections.items():
        assert path.read_text() == json.dumps(expected, indent=2) + "\n", path.name
        assert "scope_commerce_purchases" in expected["required_tables"]
        assert "scope_commerce_balanced" in expected["required_functions"]


async def test_exact_registry_owner_approval_creates_no_usable_export(paid_contract: PaidContract):
    ctx = paid_contract
    assert HANDLE != scope_handle_for_machine_scope("owner", SCOPE)
    tariff = await ctx.tariff()
    assert tariff.status_code == 200, tariff.text
    premature = await ctx.quote(ctx.request_id)
    assert premature.status_code == 409
    assert premature.json()["detail"]["code"] == "owner_approval_required"
    assert (await ctx.approve(ctx.request_id, "stranger")).status_code == 404
    approval = await ctx.approve(ctx.request_id)
    assert approval.status_code == 200, approval.text
    assert approval.json()["status"] == "approved_awaiting_payment"
    assert "consent_token" not in approval.text and "token_id" not in approval.text
    async with ctx.pool.acquire() as conn:
        assert (
            await conn.fetchval(
                "SELECT COUNT(*) FROM consent_exports WHERE grant_id=$1", ctx.request_id
            )
            == 0
        )
        assert (
            await conn.fetchval("SELECT action FROM consent_audit ORDER BY id DESC LIMIT 1")
            == "CONSENT_PAID_APPROVED"
        )
    quote = await ctx.quote(ctx.request_id)
    assert quote.status_code == 200, quote.text
    assert quote.json()["scope_handle"] == HANDLE
    assert quote.json()["machine_scope"] == SCOPE
    assert quote.json()["amount_cents"] == 1


async def test_funded_reservation_requires_human_confirmation_and_bound_payer(
    paid_contract: PaidContract,
):
    ctx = paid_contract
    assert (await ctx.tariff()).status_code == 200
    quote = await approved_quote(ctx)
    body = {"quote_id": quote["id"], "confirmed": True, "idempotency_key": str(uuid4())}
    assert (await ctx.post("/purchases", {**body, "confirmed": False})).status_code == 422
    assert (await ctx.post("/purchases", body, "stranger")).status_code == 404
    assert (await ctx.post("/purchases", body)).status_code == 409
    await ctx.fund()
    reservation = await ctx.post("/purchases", body)
    assert reservation.status_code == 200, reservation.text
    assert reservation.json()["status"] == "reserved"
    assert (await ctx.service.balance(payer_user_id="payer"))["reservedCents"] == 1
    assert (await ctx.service.earnings(owner_user_id="owner"))["pendingCents"] == 0
    from hushh_mcp.services.marketplace_information_service import MarketplaceInformationService

    metadata = MarketplaceInformationService()
    page = await metadata.scope_commerce_activity(user_id="payer", view="purchases", cursor=None)
    assert [item["request_id"] for item in page["items"]] == [ctx.request_id]
    assert "consent_token" not in json.dumps(page) and "ciphertext" not in json.dumps(page)
    assert (
        await metadata.scope_commerce_activity(user_id="stranger", view="purchases", cursor=None)
    )["items"] == []
    summary = await metadata.scope_commerce_summary(user_id="owner")
    assert summary["earnings"]["pendingCents"] == 0
    assert summary["readiness"]["seller"]["status"] == "eligible"


async def test_cancel_before_activation_is_payer_bound_and_releases_once(
    paid_contract: PaidContract, monkeypatch: pytest.MonkeyPatch
):
    ctx = paid_contract
    reservation = await funded_reservation(ctx)
    path = f"/purchases/{reservation.purchase_id}/cancel"
    operation = {"idempotency_key": str(uuid4())}
    assert (await ctx.post(path, operation, "stranger")).status_code == 404
    assert (await ctx.post(path, operation, "owner")).status_code == 404
    assert (await ctx.post(path, {"idempotency_key": "invalid"})).status_code == 422
    assert (await ctx.service.balance(payer_user_id="payer"))["reservedCents"] == 1
    monkeypatch.setenv("SCOPE_COMMERCE_ENABLED", "false")
    cancelled = await ctx.post(path, operation)
    assert cancelled.status_code == 200, cancelled.text
    assert cancelled.json()["status"] == "revoked"
    assert (await ctx.post(path, operation)).status_code == 200
    balance = await ctx.service.balance(payer_user_id="payer")
    assert balance["reservedCents"] == 0 and balance["balanceCents"] == 50


async def test_active_buyer_nonuse_cannot_cancel_and_owner_revocation_is_immediate(
    paid_contract: PaidContract, monkeypatch: pytest.MonkeyPatch
):
    ctx = paid_contract
    paid = await staged_purchase(ctx)
    await ctx.activate(paid, monkeypatch)
    buyer_cancel = await ctx.post(
        f"/purchases/{paid.reservation.purchase_id}/cancel", {"idempotency_key": str(uuid4())}
    )
    assert buyer_cancel.status_code == 409
    assert buyer_cancel.json()["detail"]["code"] == "buyer_cancellation_after_activation_denied"
    path = f"/purchases/{paid.reservation.purchase_id}/revoke"
    operation = {"idempotency_key": str(uuid4())}
    assert (await ctx.post(path, operation, "stranger")).status_code == 404
    assert (await ctx.post(path, operation, "payer")).status_code == 404
    monkeypatch.setenv("SCOPE_COMMERCE_ENABLED", "false")
    revoked = await ctx.post(path, operation, "owner")
    assert revoked.status_code == 200, revoked.text
    assert revoked.json()["status"] == "revoked"
    assert (await ctx.post(path, operation, "owner")).status_code == 200
    assert await paid_admission.paid_grant_is_admitted(paid.grant.token, paid.metadata) is False
    assert await paid.grant.exports() == [None] * 4
    async with ctx.pool.acquire() as conn:
        stored = await conn.fetchrow(
            "SELECT encrypted_data,expires_at FROM consent_exports WHERE grant_id=$1",
            paid.grant.request_id,
        )
    assert stored["encrypted_data"] == encrypted_package(paid.context)["ciphertext"]
    assert int(stored["expires_at"].timestamp() * 1000) == paid.grant.expires_at_ms
    assert (await ctx.service.balance(payer_user_id="payer"))["balanceCents"] == 50

    account = (await ctx.get("/account")).json()
    assert account["balance"]["available_cents"] == 50
    assert len(account["funding_lots"]) == 1
    source = account["funding_lots"][0]
    assert source["refundable_cents"] == 50
    assert (await ctx.get("/account", "stranger")).json()["funding_lots"] == []
    refund_id = str(uuid4())
    await ctx.service.reserve_funding_refund(
        user_id="payer", funding_id=source["id"], refund_id=refund_id, amount_cents=10
    )
    assert (await ctx.get("/account")).json()["funding_lots"][0]["refundable_cents"] == 40
    await ctx.service.settle_funding_refund(
        refund_id=refund_id, provider_refund_id="re_contract", status="failed"
    )
    assert (await ctx.get("/account")).json()["funding_lots"][0]["refundable_cents"] == 50
    await ctx.service.freeze_funding_dispute(
        charge_id="ch_contract", dispute_id="dp_contract", amount_cents=50
    )
    assert (await ctx.get("/account")).json()["funding_lots"][0]["refundable_cents"] == 0


@pytest.mark.parametrize("activated", [False, True], ids=["cancelled", "revoked"])
async def test_terminal_history_preserves_accepted_quote_after_tariff_edit(
    paid_contract: PaidContract, monkeypatch: pytest.MonkeyPatch, activated: bool
):
    ctx = paid_contract
    reservation = await funded_reservation(ctx)
    if activated:
        paid = await ctx.stage(reservation, await ctx.prepare(reservation))
        await ctx.activate(paid, monkeypatch)
    changed = await ctx.tariff(99, 7200)
    assert changed.status_code == 200, changed.text
    suffix, identity = ("revoke", "owner") if activated else ("cancel", "payer")
    ended = await ctx.post(
        f"/purchases/{reservation.purchase_id}/{suffix}",
        {"idempotency_key": str(uuid4())},
        identity,
    )
    assert ended.status_code == 200, ended.text
    for identity in ("owner", "payer"):
        history = await ctx.get(f"/requests/{reservation.request_id}", identity)
        assert history.status_code == 200, history.text
        receipt = history.json()
        assert receipt["purchase"]["status"] == "revoked"
        assert receipt["purchase"]["access_allowed"] is False
        assert receipt["purchase"]["quote_id"] == reservation.quote["id"]
        assert receipt["purchase"]["amount_cents"] == 1
        assert receipt["duration_seconds"] == 3600
        assert receipt["tariff"]["price_cents"] == 1
        assert receipt["tariff"]["base_duration_seconds"] == 3600
    for path in (f"/requests/{reservation.request_id}", f"/purchases/{reservation.purchase_id}"):
        assert (await ctx.get(path, "stranger")).status_code == 404


async def test_activity_is_owner_bound_keyset_and_read_only(paid_contract: PaidContract):
    from tests.scope_commerce_contract_harness import reserve_quote

    ctx = paid_contract
    first = await funded_reservation(ctx)
    second_request = await ctx.additional_request()
    second = await reserve_quote(ctx, await approved_quote(ctx, second_request), second_request)
    page = await ctx.get("/activity?view=purchases&limit=1")
    assert page.status_code == 200, page.text
    assert page.headers["cache-control"] == "private, no-store"
    data = page.json()
    assert len(data["items"]) == 1 and data["next_cursor"]
    from urllib.parse import urlencode

    next_page = await ctx.get(
        "/activity?" + urlencode({"view": "purchases", "limit": 1, "cursor": data["next_cursor"]})
    )
    assert next_page.status_code == 200, next_page.text
    assert next_page.json()["next_cursor"] is None
    assert {data["items"][0]["purchase_id"], next_page.json()["items"][0]["purchase_id"]} == {
        first.purchase_id,
        second.purchase_id,
    }
    sales = await ctx.get("/activity?view=sales", "owner")
    assert len(sales.json()["items"]) == 2
    assert all(item["kind"] == "sale" for item in sales.json()["items"])
    wrong_subject = await ctx.get(
        "/activity?" + urlencode({"view": "purchases", "cursor": data["next_cursor"]}), "stranger"
    )
    wrong_view = await ctx.get(
        "/activity?" + urlencode({"view": "sales", "cursor": data["next_cursor"]})
    )
    assert wrong_subject.status_code == wrong_view.status_code == 422
    async with ctx.pool.acquire() as c:
        before = await c.fetchval("SELECT count(*) FROM scope_commerce_wallets")
    empty = await ctx.get("/activity", "stranger")
    assert empty.json() == {"items": [], "next_cursor": None}
    async with ctx.pool.acquire() as c:
        assert await c.fetchval("SELECT count(*) FROM scope_commerce_wallets") == before
    transactions = await ctx.get("/activity")
    assert {item["kind"] for item in transactions.json()["items"]} == {"purchase", "funding"}
    for forbidden in (
        "consent_token",
        "ciphertext",
        "wrapped_export_key",
        "payment_intent",
        "charge_id",
        "payer_user_id",
        "owner_user_id",
    ):
        assert forbidden not in transactions.text
    assert (await ctx.get("/activity?limit=101")).status_code == 422
    assert (await ctx.get("/requests/" + ctx.request_id, "stranger")).status_code == 404
    paid = await ctx.stage(first, await ctx.prepare(first))
    async with ctx.pool.acquire() as c:
        from datetime import UTC, datetime, timedelta

        await c.execute(
            "UPDATE contract_clock SET observed_at=$1",
            datetime.fromtimestamp(paid.context["starts_at_ms"] / 1000, UTC) + timedelta(seconds=1),
        )
        await c.execute(
            "UPDATE developer_connector_keys SET connector_public_key='cnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnI='"
        )
    rotated = await ctx.get("/activity?view=purchases")
    assert (
        next(item for item in rotated.json()["items"] if item["purchase_id"] == first.purchase_id)[
            "status"
        ]
        == "access_blocked"
    )


async def test_negative_net_requires_exact_owner_review_at_prepare_and_stage(
    paid_contract: PaidContract,
):
    from tests.scope_commerce_contract_harness import reserve_quote
    from tests.services.test_scope_commerce_core_support import fund

    ctx = paid_contract
    assert (await ctx.tariff()).status_code == 200
    quote = await approved_quote(ctx)
    await fund(ctx.service, 50, 1_000_000)
    reservation = await reserve_quote(ctx, quote, ctx.request_id)
    request = await ctx.get("/requests/" + ctx.request_id, "owner")
    assert request.status_code == 200, request.text
    review = request.json()["negative_net_acknowledgement"]
    assert review["gross_cents"] == 1 and review["net_earnings_micro_usd"] == -10_000
    assert request.json()["purchase"]["net_earnings_micro_usd"] == review["net_earnings_micro_usd"]
    assert (await ctx.get("/requests/" + ctx.request_id)).json()[
        "negative_net_acknowledgement"
    ] is None
    path = "/purchases/" + reservation.purchase_id
    body = {"source_revisions": {"content_revision": 1, "manifest_revision": 1}}
    assert (await ctx.post(path + "/prepare", body, "payer")).status_code == 404
    assert (await ctx.post(path + "/prepare", body, "owner")).status_code == 409
    ack = {"version": 1, "binding": review["binding"], "acknowledged": True}
    for invalid in ({**ack, "binding": "0" * 64}, {**ack, "acknowledged": False}):
        assert (
            await ctx.post(
                path + "/prepare", {**body, "negative_net_acknowledgement": invalid}, "owner"
            )
        ).status_code == 409
    async with ctx.pool.acquire() as c:
        assert (
            await c.fetchval(
                "SELECT status FROM scope_commerce_purchases WHERE request_id=$1", ctx.request_id
            )
            == "reserved"
        )
        assert await c.fetchval("SELECT count(*) FROM consent_exports") == 0
    prepared = await ctx.post(
        path + "/prepare", {**body, "negative_net_acknowledgement": ack}, "owner"
    )
    assert prepared.status_code == 200, prepared.text
    stage = {
        "preparation_id": prepared.json()["preparation_id"],
        "envelope": encrypted_package(prepared.json()),
    }
    assert (await ctx.post(path + "/stage", stage, "owner")).status_code == 409
    completed = await ctx.post(
        path + "/stage", {**stage, "negative_net_acknowledgement": ack}, "owner"
    )
    assert completed.status_code == 200, completed.text
    replay = await ctx.post(
        path + "/stage", {**stage, "negative_net_acknowledgement": ack}, "owner"
    )
    assert replay.status_code == 200, replay.text
    async with ctx.pool.acquire() as c:
        rows = await c.fetch(
            "SELECT action,metadata FROM consent_audit WHERE request_id=$1 AND action='CONSENT_PAID_COST_ACKNOWLEDGED'",
            ctx.request_id,
        )
        assert len(rows) == 2
        assert {json.loads(row["metadata"])["phase"] for row in rows} == {"prepare", "stage"}
        assert all(json.loads(row["metadata"])["binding"] == review["binding"] for row in rows)
        assert (
            await c.fetchval(
                "SELECT action FROM consent_audit WHERE request_id=$1 ORDER BY issued_at DESC,id DESC LIMIT 1",
                ctx.request_id,
            )
            == "CONSENT_GRANTED"
        )
    ended = await ctx.post(path + "/revoke", {"idempotency_key": str(uuid4())}, "owner")
    assert ended.status_code == 200, ended.text
    terminal = await ctx.get("/requests/" + ctx.request_id, "owner")
    assert terminal.status_code == 200, terminal.text
    assert terminal.json()["negative_net_acknowledgement"] is None
    assert terminal.json()["purchase"]["net_earnings_micro_usd"] == 0


async def test_commerce_readiness_account_are_read_only_and_free_survives_setup_loss(
    paid_contract: PaidContract, monkeypatch: pytest.MonkeyPatch
):
    ctx = paid_contract
    ctx.service.provider_config = replace(
        ctx.service.provider_config,
        sandbox_policy=SandboxPolicy(
            ctx.service.provider_config.platform_account_id, ("owner", "payer")
        ),
    )
    response = await ctx.get("/readiness", "owner")
    assert response.status_code == 200 and response.headers["cache-control"] == "private, no-store"
    assert response.json()["platform"]["status"] == "ready"
    assert response.json()["seller"]["status"] == "eligible"
    unknown = (await ctx.get("/readiness", "stranger")).json()
    assert unknown["seller"]["status"] == "not_onboarded"
    assert unknown["platform"]["status"] == "ready"
    assert unknown["capabilities"] == {
        "set_free_tariff": True,
        "set_paid_tariff": False,
        "approve_paid_request": False,
        "reserve_paid_purchase": False,
        "start_funding": False,
        "start_onboarding": False,
    }
    account = await ctx.get("/account", "stranger")
    assert account.json()["readiness"] == unknown
    assert account.json()["balance"]["available_cents"] == 0
    assert "acct_" not in response.text
    async with ctx.pool.acquire() as c:
        assert await c.fetchval("SELECT count(*) FROM scope_commerce_wallets") == 0
        assert await c.fetchval("SELECT count(*) FROM scope_commerce_sellers") == 0
    assert (await ctx.tariff()).status_code == 200
    ctx.service.provider_config = None
    monkeypatch.delenv("SCOPE_COMMERCE_STRIPE_SECRET_KEY", raising=False)
    missing = (await ctx.get("/readiness", "owner")).json()
    assert missing["platform"]["reason_code"] == "provider_credentials_required"
    assert missing["capabilities"]["set_free_tariff"]
    assert not missing["capabilities"]["approve_paid_request"]
    assert (await ctx.approve(ctx.request_id)).json()["detail"][
        "code"
    ] == "provider_credentials_required"
    lookup = await ctx.get(f"/tariffs?scope_handle={HANDLE}&machine_scope={SCOPE}", "owner")
    assert lookup.json()["tariff"]["price_cents"] == 1
    monkeypatch.setenv("SCOPE_COMMERCE_ENABLED", "false")
    monkeypatch.setenv("SCOPE_COMMERCE_COUNTRY_POLICIES_JSON", "invalid-configuration")
    assert (await ctx.tariff(0)).status_code == 200
    paused = (await ctx.get("/readiness", "owner")).json()
    assert paused["platform"]["reason_code"] == "commerce_disabled"
    assert paused["free"] == {
        "requires_payment_provider": False,
        "requires_owner_approval": True,
        "tariff_controls_available": True,
    }
    # The original commercial request cannot become free when pricing is cleared.
    assert (await ctx.approve(ctx.request_id)).status_code == 503


async def test_readiness_reports_unverified_pin_and_ineligible_seller(paid_contract: PaidContract):
    ctx = paid_contract
    async with ctx.pool.acquire() as c:
        await c.execute(
            "UPDATE scope_commerce_seller_accounts SET eligible=false WHERE user_id='owner'"
        )
    data = (await ctx.get("/readiness", "owner")).json()
    assert data["seller"]["reason_code"] == "seller_not_eligible"
    assert not data["capabilities"]["set_paid_tariff"]
    async with ctx.pool.acquire() as c:
        await c.execute("TRUNCATE scope_commerce_environment")
    data = (await ctx.get("/readiness", "owner")).json()
    assert data["platform"]["status"] == "unverified"
    assert data["platform"]["reason_code"] == "platform_account_unverified"
    assert not data["capabilities"]["start_funding"]


async def test_legacy_free_request_read_requires_binding_and_never_downgrades_paid(
    paid_contract: PaidContract,
):
    ctx = paid_contract
    async with ctx.pool.acquire() as c:
        await c.execute("DROP TABLE scope_commerce_purchases CASCADE")
    assert (await ctx.get("/requests/" + ctx.request_id, "owner")).status_code == 503
    async with ctx.pool.acquire() as c:
        await c.execute("UPDATE consent_audit SET metadata=metadata-'commercial_required'")
        await c.execute(
            'UPDATE consent_audit SET metadata=metadata || \'{"commerce_quote_id":"known-paid"}\'::jsonb'
        )
    assert (await ctx.get("/requests/" + ctx.request_id, "owner")).status_code == 503
    async with ctx.pool.acquire() as c:
        await c.execute("UPDATE consent_audit SET metadata=metadata-'commerce_quote_id'")
    free = await ctx.get("/requests/" + ctx.request_id, "owner")
    assert free.status_code == 200, free.text
    assert free.json()["tariff"] is None and free.json()["purchase"] is None
    assert free.json()["machine_scope"] == SCOPE
    assert "available_balance_cents" not in free.json()
    assert (await ctx.get("/requests/" + ctx.request_id, "stranger")).status_code == 404
    assert (await ctx.tariff()).status_code == 200
    assert (await ctx.get("/requests/" + ctx.request_id, "owner")).status_code == 503
