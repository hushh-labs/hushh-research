"""Owner payouts through Stripe Connect: hussh pays owners after delivery.

Money boundaries: nothing is owed until the packet is delivered; nothing is
sent until Stripe enables payouts; each earning is transferred once, for the
price minus hussh's fee, against the buyer's own charge; and a delivered order
is never refunded.
"""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
import stripe

import api.routes.one.payouts as payouts_routes
from api.middleware import require_vault_owner_token
from hushh_mcp.services import payout_account_status_cache, pkm_payout_service
from hushh_mcp.services.payout_account_status_cache import PayoutAccountStatusCache
from hushh_mcp.services.pkm_packet_order_service import PacketOrderError, PkmPacketOrderService
from hushh_mcp.services.pkm_payout_service import PkmPayoutService
from tests.fixtures.payout_provider import _provider_response, _Stripe, payout_tables
from tests.test_pkm_credits import _DB


@pytest.fixture
def payout_client():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()
    app.include_router(payouts_routes.router)
    return TestClient(app)


@pytest.fixture(autouse=True)
def stripe_env(monkeypatch):
    cache = PayoutAccountStatusCache()
    monkeypatch.setattr(payout_account_status_cache, "account_status_cache", cache)
    monkeypatch.setattr(pkm_payout_service, "account_status_cache", cache)
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_" + "x" * 30)
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_" + "x" * 30)
    monkeypatch.setenv("HUSSH_SITE_ORIGIN", "https://uat.hushh.ai")
    for name in ("ENVIRONMENT", "HUSSH_DEPLOY_ENV"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(pkm_payout_service, "_app_origin", lambda: "https://uat.one.hushh.ai")


@pytest.fixture
def world():
    db, fake = _DB(), _Stripe()
    db.tables.update(payout_tables())
    svc = PkmPayoutService(stripe_api=fake)
    svc._db = db
    return svc, db, fake


async def test_onboarding_creates_one_express_account(world):
    svc, db, fake = world
    first = await svc.onboarding_link(user_id="owner")
    assert fake.retrieves == ["acct_1", "acct_1"]  # replay receipts cannot prove current identity
    await svc.onboarding_link(user_id="owner")
    assert fake.retrieves == ["acct_1", "acct_1", "acct_1"]  # existing mapping is still re-read
    assert first["url"].startswith("https://connect.stripe.com/")
    assert len(fake.accounts) == 1 and fake.accounts[0]["type"] == "express"
    assert len(fake.preparations) == 1
    assert fake.preparations[0]["business_type"] == "individual"
    assert fake.preparations[0]["account"] == "acct_1"
    assert "consumer-profile:acct_1" in fake.preparations[0]["idempotency_key"]
    assert fake.links[0]["return_url"] == "https://uat.one.hushh.ai/one/marketplace?payouts=done"
    assert db.tables["stripe_owner_payout_accounts"][0]["stripe_account_id"] == "acct_1"
    fake.country = "CA"
    with pytest.raises(PacketOrderError, match="needs support"):
        await svc.onboarding_link(user_id="other")


@pytest.mark.parametrize(
    "historical",
    [
        {"business_type": "company"},
        {"details_submitted": True},
        {"business_profile": {"product_description": "Existing activity"}},
        {"business_profile": {"url": "https://example.invalid", "mcc": "5734"}},
    ],
)
async def test_consumer_defaults_preserve_existing_account_information(world, historical):
    svc, db, fake = world
    fake.account_extra = historical
    monkeypatch_create = fake.Account.create
    fake.Account.create = lambda **kwargs: {
        **monkeypatch_create(**kwargs),
        "business_type": None,
        "details_submitted": False,
        "business_profile": None,
    }
    await svc.onboarding_link(user_id="owner", surface="documents")
    assert fake.preparations == []
    assert db.tables["stripe_owner_payout_accounts"][0]["stripe_account_id"] == "acct_1"


@pytest.mark.parametrize("refusal", ["modify_id", "current_id", "deleted", "company"])
async def test_consumer_profile_mismatch_cannot_bind_or_open_onboarding(
    world, monkeypatch, refusal
):
    svc, db, fake = world
    retrieve = fake.Account.retrieve
    if refusal == "modify_id":
        monkeypatch.setattr(
            fake.Account,
            "modify",
            lambda *args, **kwargs: {
                "id": "acct_other",
                "country": "US",
                "business_type": "individual",
            },
        )
    else:

        def current(account, **kwargs):
            facts = retrieve(account, **kwargs)
            if fake.preparations:
                facts.update(
                    {
                        "current_id": {"id": "acct_other"},
                        "deleted": {"deleted": True},
                        "company": {"business_type": "company"},
                    }[refusal]
                )
            return facts

        monkeypatch.setattr(fake.Account, "retrieve", current)
    with pytest.raises(PacketOrderError, match="Could not start payout setup"):
        await svc.onboarding_link(user_id="owner", surface="documents")
    assert not db.tables.get("stripe_owner_payout_accounts")
    assert fake.links == []


async def test_document_onboarding_reuses_packet_account_with_separate_return_path(world):
    svc, db, fake = world
    await svc.onboarding_link(user_id="owner")
    document = await svc.onboarding_link(user_id="owner", surface="documents")
    assert document == {"url": "https://connect.stripe.com/setup/x"}
    assert len(fake.accounts) == 1
    assert (
        fake.links[1]["account"]
        == db.tables["stripe_owner_payout_accounts"][0]["stripe_account_id"]
    )
    assert fake.links[1]["refresh_url"] == (
        "https://uat.one.hushh.ai/one/profile/payouts?documentPayouts=refresh"
    )
    assert fake.links[1]["return_url"] == (
        "https://uat.one.hushh.ai/one/profile/payouts?documentPayouts=done"
    )


async def test_document_onboarding_first_is_reused_for_packet_payouts(world):
    svc, _db, fake = world
    await svc.onboarding_link(user_id="owner", surface="documents")
    await svc.onboarding_link(user_id="owner")
    assert len(fake.accounts) == 1
    assert {link["account"] for link in fake.links} == {"acct_1"}


async def test_document_status_requires_live_transfer_and_payout_readiness(world):
    svc, _db, fake = world
    assert await svc.account_status(user_id="owner", force_refresh=True) == {
        "account": None,
        "stripeMode": "test",
    }
    await svc.onboarding_link(user_id="owner", surface="documents")
    initial = (await svc.account_status(user_id="owner", force_refresh=True))["account"]
    assert initial == {
        "detailsSubmitted": True,
        "transfersEnabled": False,
        "payoutsEnabled": False,
        "ready": False,
        "status": "onboarding_required",
        "canManageBank": True,
        "bankStatus": "linked",
        "bank": {"name": "Example Bank", "last4": "6789", "status": "new"},
        "verification": {
            "state": "none",
            "deadline": None,
            "items": [],
            "eventuallyDue": False,
            "hasErrors": False,
            "disabledReason": None,
        },
        "payoutSchedule": None,
    }

    fake.payouts_enabled = True
    fake.transfers_capability = "active"
    ready = (await svc.account_status(user_id="owner", force_refresh=True))["account"]
    assert ready["ready"] is True and ready["status"] == "ready"
    assert "stripe_account_id" not in ready

    fake.disabled_reason = "requirements.past_due"
    restricted = (await svc.account_status(user_id="owner", force_refresh=True))["account"]
    assert restricted["ready"] is False and restricted["status"] == "restricted"


async def test_deleted_or_non_us_mapped_account_is_never_replaced(world):
    svc, _db, fake = world
    await svc.onboarding_link(user_id="owner", surface="documents")
    fake.deleted = True
    assert (await svc.account_status(user_id="owner", force_refresh=True))["account"][
        "status"
    ] == "restricted"
    with pytest.raises(PacketOrderError, match="needs support"):
        await svc.onboarding_link(user_id="owner", surface="documents")
    fake.deleted = False
    fake.country = "CA"
    assert (await svc.account_status(user_id="owner", force_refresh=True))["account"][
        "ready"
    ] is False
    with pytest.raises(PacketOrderError, match="needs support"):
        await svc.onboarding_link(user_id="owner", surface="documents")
    assert len(fake.accounts) == 1


async def test_concurrent_mapping_insert_reuses_existing_stripe_account(world, monkeypatch):
    svc, db, fake = world
    original_rows = svc._rows

    async def concurrent_insert(query):
        if query.op == "insert" and query.store is db.tables["stripe_owner_payout_accounts"]:
            query.store.append(
                {"user_id": "owner", "stripe_mode": "test", "stripe_account_id": "acct_1"}
            )
            raise RuntimeError("unique constraint")
        return await original_rows(query)

    monkeypatch.setattr(svc, "_rows", concurrent_insert)
    await svc.onboarding_link(user_id="owner", surface="documents")
    assert len(fake.accounts) == 1
    assert len(db.tables["stripe_owner_payout_accounts"]) == 1
    assert fake.links[0]["account"] == "acct_1"
    assert fake.retrieves == [
        "acct_1",
        "acct_1",
        "acct_1",
    ]  # current creation and the winner are verified


async def test_stripe_failure_is_sanitized_and_does_not_create_second_account(world):
    svc, db, fake = world
    await svc.onboarding_link(user_id="owner", surface="documents")

    def fail_retrieve(*_args, **_kwargs):
        raise RuntimeError("sk_test_fake_secret from Stripe")

    fake.Account.retrieve = fail_retrieve
    with pytest.raises(PacketOrderError) as exc:
        await svc.account_status(user_id="owner", force_refresh=True)
    assert exc.value.code == "PAYOUT_UNAVAILABLE"
    assert "sk_test" not in str(exc.value)
    assert len(fake.accounts) == 1
    assert len(db.tables["stripe_owner_payout_accounts"]) == 1


def test_document_account_routes_are_owner_scoped_and_exclude_packet_sales(
    world, monkeypatch, payout_client
):
    svc, _db, fake = world
    monkeypatch.setattr(payouts_routes, "_service", lambda: svc)
    client = payout_client
    app = client.app
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "owner"}

    setup = client.post("/api/one/payouts/account/onboard")
    assert setup.status_code == 200
    assert setup.headers["Cache-Control"] == "private, no-store"
    assert setup.json() == {"url": "https://connect.stripe.com/setup/x"}
    assert fake.links[0]["return_url"].endswith("?documentPayouts=done")

    status = client.get("/api/one/payouts/account")
    assert status.status_code == 200
    assert status.headers["Cache-Control"] == "private, no-store"
    assert set(status.json()) == {"account", "stripeMode"}
    assert "earningsCents" not in status.text
    assert "acct_" not in status.text

    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "other"}
    assert client.get("/api/one/payouts/account").json() == {"account": None, "stripeMode": "test"}


async def test_only_delivered_orders_become_due_and_pay_once_payouts_enabled(world):
    svc, db, fake = world
    assert await svc.mark_delivered_earnings_due() == 1
    statuses = {o["id"]: o["owner_earning_status"] for o in db.tables["pkm_packet_orders"]}
    assert statuses == {"o1": "due", "o2": "none"}

    await svc.onboarding_link(user_id="owner")
    assert await svc.transfer_due() == 0  # payouts not enabled yet
    assert fake.transfers == []

    fake.payouts_enabled = True
    fake.transfers_capability = "active"
    await svc.refresh_account("owner")
    assert await svc.transfer_due() == 1
    assert await svc.transfer_due() == 0
    t = fake.transfers[0]
    assert t["amount"] == 450 and t["destination"] == "acct_1"
    assert t["source_transaction"] == "ch_1"
    assert t["idempotency_key"] == "pkm-packet-transfer:o1"
    summary = await svc.summary(user_id="owner")
    assert summary["earningsCents"] == {"awaitingDelivery": 300, "due": 0, "paidOut": 450}


async def test_delivered_order_is_never_refunded(world):
    _, db, fake = world
    orders = PkmPacketOrderService(stripe_api=fake)
    orders._bind(db)
    db.tables["marketplace_access_requests"].clear()  # e.g. removed with a deleted account
    db.tables["pkm_packet_orders"][0]["owner_earning_status"] = "due"
    result = await orders.reconcile()
    statuses = {o["id"]: o["status"] for o in db.tables["pkm_packet_orders"] if "id" in o}
    assert statuses.get("o1") == "paid"  # delivered: kept, owner still owed
    assert result["refunded"] == 1  # o2 was never delivered, so it is refunded


async def test_bank_management_uses_only_authenticated_owners_mapping(world):
    svc, db, fake = world
    with pytest.raises(PacketOrderError, match="Link a bank"):
        await svc.management_link(user_id="other")
    await svc.onboarding_link(user_id="owner", surface="documents")
    link = await svc.management_link(user_id="owner")
    assert link["url"] == "https://connect.stripe.com/express/test"
    assert fake.links[-1]["account"] == "acct_1"
    assert len(fake.accounts) == 1


async def test_bank_changes_disable_readiness_and_keep_masked_owner_details(world):
    svc, _db, fake = world
    await svc.onboarding_link(user_id="owner", surface="documents")
    fake.payouts_enabled = True
    fake.transfers_capability = "active"
    fake.external_accounts_visible = True
    bank = {
        "object": "bank_account",
        "country": "US",
        "currency": "usd",
        "default_for_currency": True,
        "bank_name": "Example Bank",
        "last4": "6789",
        "status": "new",
        "routing_number": "private-routing",
        "id": "ba_private",
    }
    fake.external_accounts["data"] = [bank]
    account = (await svc.account_status(user_id="owner", force_refresh=True))["account"]
    assert account["ready"] is True
    assert account["bank"] == {"name": "Example Bank", "last4": "6789", "status": "new"}
    assert "private" not in str(account)

    bank["status"] = "errored"
    account = (await svc.account_status(user_id="owner", force_refresh=True))["account"]
    assert account["ready"] is False and account["bankStatus"] == "needs_attention"
    # A failed bank still needs an owner-accessible repair link.
    assert (await svc.management_link(user_id="owner"))["url"].startswith(
        "https://connect.stripe.com/"
    )

    fake.external_accounts["data"] = []
    account = (await svc.account_status(user_id="owner", force_refresh=True))["account"]
    assert account["ready"] is False and account["bankStatus"] == "missing"
    fake.external_accounts["has_more"] = True
    account = (await svc.account_status(user_id="owner", force_refresh=True))["account"]
    assert account["bankStatus"] == "unavailable"  # partial preview cannot prove removal
    assert account["ready"] is False
    fake.external_accounts_visible = False
    account = (await svc.account_status(user_id="owner", force_refresh=True))["account"]
    assert account["bankStatus"] == "unavailable" and account["ready"] is False


async def test_disabled_bank_management_never_issues_login_link(world):
    svc, _db, fake = world
    await svc.onboarding_link(user_id="owner", surface="documents")
    prior_links = len(fake.links)
    fake.deleted = True
    with pytest.raises(PacketOrderError, match="needs support"):
        await svc.management_link(user_id="owner")
    assert len(fake.links) == prior_links


async def test_authoritative_refresh_persists_transfer_and_unrestricted_us_readiness(world):
    svc, db, fake = world
    await svc.onboarding_link(user_id="owner", surface="documents")
    fake.payouts_enabled = True
    await svc.refresh_account("owner")
    assert db.tables["stripe_owner_payout_accounts"][0]["account_ready"] is False
    fake.transfers_capability = "active"
    await svc.refresh_account("owner")
    assert db.tables["stripe_owner_payout_accounts"][0]["account_ready"] is True
    fake.disabled_reason = "requirements.past_due"
    await svc.refresh_account("owner")
    assert db.tables["stripe_owner_payout_accounts"][0]["account_ready"] is False


def test_document_money_routes_require_owner_and_sanitize_history_failure(
    monkeypatch, payout_client
):
    from hushh_mcp.services.drive_request_owner_payout_service import DriveRequestOwnerPayoutService

    calls = []

    async def history(self, *, user_id, cursor=None, modes=None):
        calls.append((user_id, cursor, modes))
        if cursor:
            raise RuntimeError("private_provider_or_database_detail")
        return {"currency": "USD", "transactions": [], "nextCursor": None}

    monkeypatch.setattr(DriveRequestOwnerPayoutService, "owner_history", history)
    client = payout_client
    app = client.app
    for unauthenticated in (
        client.get("/api/one/payouts/account/earnings"),
        client.post("/api/one/payouts/account/manage"),
    ):
        assert unauthenticated.status_code == 401
        assert unauthenticated.headers["Cache-Control"] == "private, no-store"
    assert calls == []
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "owner"}
    response = client.get("/api/one/payouts/account/earnings?user_id=other")
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "private, no-store"
    # No mode means the configured one (test here), which keeps legacy rows.
    assert response.json()["mode"] == "test"
    assert calls == [("owner", None, ("test", "legacy"))]
    live = client.get("/api/one/payouts/account/earnings?mode=live")
    assert live.json()["mode"] == "live" and calls[-1] == ("owner", None, ("live",))
    for mode in ("legacy", "bogus", ""):
        rejected = client.get("/api/one/payouts/account/earnings", params={"mode": mode})
        assert rejected.status_code == 422
        assert rejected.json() == {
            "detail": {"code": "INVALID_MODE", "message": "Choose live or test."}
        }
        assert rejected.headers["Cache-Control"] == "private, no-store"
    # An older parameter keeps FastAPI's error body and is private too.
    malformed = client.get("/api/one/payouts/account/earnings?cursor=invalid")
    assert malformed.status_code == 422
    assert malformed.json()["detail"][0]["loc"] == ["query", "cursor"]
    assert malformed.headers["Cache-Control"] == "private, no-store"
    assert len(calls) == 2
    failed = client.get(
        "/api/one/payouts/account/earnings?cursor=00000000-0000-4000-8000-000000000001"
    )
    assert failed.status_code == 503
    assert failed.json() == {"detail": "Transactions are unavailable."}
    assert failed.headers["Cache-Control"] == "private, no-store"


async def test_switch_to_live_does_not_reuse_test_bank_or_transfer_test_earnings(
    world, monkeypatch
):
    svc, db, fake = world
    await svc.onboarding_link(user_id="owner", surface="documents")
    db.tables["stripe_owner_payout_accounts"][0].update(payouts_enabled=True, account_ready=True)
    db.tables["pkm_packet_orders"][0]["owner_earning_status"] = "due"
    monkeypatch.setenv("STRIPE_MODE", "live")
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_live_" + "x" * 30)
    assert await svc.account_status(user_id="owner", force_refresh=True) == {
        "account": None,
        "stripeMode": "live",
    }
    assert await svc.transfer_due() == 0
    assert fake.transfers == []
    await svc.onboarding_link(user_id="owner", surface="documents")
    assert len(fake.accounts) == 2
    assert {a["stripe_mode"] for a in db.tables["stripe_owner_payout_accounts"]} == {"test", "live"}
    assert fake.accounts[0]["idempotency_key"] != fake.accounts[1]["idempotency_key"]


async def test_legacy_bank_adoption_requires_active_mode_provider_proof(world, monkeypatch):
    svc, db, fake = world
    db.tables["pkm_owner_payout_accounts"] = [
        {"user_id": "owner", "stripe_account_id": "acct_old", "account_ready": True}
    ]

    class MissingAccount(Exception):
        code = "resource_missing"

    def missing(*args, **kwargs):
        raise MissingAccount()

    monkeypatch.setattr(fake.Account, "retrieve", missing)
    assert await svc.account_status(user_id="owner", force_refresh=True) == {
        "account": None,
        "stripeMode": "test",
    }
    assert not db.tables["stripe_owner_payout_accounts"]
    assert db.tables["pkm_owner_payout_accounts"][0]["account_ready"] is True

    def unavailable(*args, **kwargs):
        raise RuntimeError("provider temporarily unavailable")

    monkeypatch.setattr(fake.Account, "retrieve", unavailable)
    with pytest.raises(PacketOrderError):
        await svc.onboarding_link(user_id="owner", surface="documents")
    assert fake.accounts == []


async def test_production_preserves_legacy_credit_earnings_and_adopts_bank_in_worker(
    world, monkeypatch
):
    svc, db, fake = world
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "production")
    monkeypatch.setenv("STRIPE_MODE", "live")
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_live_" + "x" * 30)
    db.tables["pkm_packet_orders"][0].update(stripe_mode="legacy", payment_method="credits")
    db.tables["pkm_owner_payout_accounts"] = [{"user_id": "owner", "stripe_account_id": "acct_old"}]
    fake.payouts_enabled = True
    fake.transfers_capability = "active"
    assert await svc.mark_delivered_earnings_due() == 1
    assert await svc.transfer_due() == 1
    assert len(fake.accounts) == 0
    assert fake.transfers[0]["destination"] == "acct_old"
    assert "source_transaction" not in fake.transfers[0]
    assert db.tables["stripe_owner_payout_accounts"][0]["stripe_mode"] == "live"
    assert (await svc.summary(user_id="owner"))["earningsCents"]["paidOut"] == 450


async def test_uat_live_never_adopts_legacy_credit_earnings_for_cash(world, monkeypatch):
    svc, db, fake = world
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "uat")
    monkeypatch.setenv("STRIPE_MODE", "live")
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_live_" + "x" * 30)
    db.tables["pkm_packet_orders"][0].update(
        stripe_mode="legacy", payment_method="credits", owner_earning_status="due"
    )
    assert await svc.transfer_due() == 0
    assert fake.transfers == []


async def test_live_setup_accepts_stripes_exact_test_account_verdict_only(world, monkeypatch):
    from hushh_mcp.services.pkm_payout_service import _legacy_account_absent

    svc, db, fake = world
    monkeypatch.setenv("STRIPE_MODE", "live")
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_live_" + "x" * 30)
    db.tables["pkm_owner_payout_accounts"] = [{"user_id": "owner", "stripe_account_id": "acct_old"}]
    message = "The account acct_old was a test account created with a testmode key, and therefore can only be used with testmode keys."
    _provider_response(
        monkeypatch, payload={"error": {"type": "api_error", "message": message}}, status=400
    )
    with pytest.raises(stripe.InvalidRequestError) as provider_error:
        stripe.Account.retrieve("acct_old", api_key="sk_live_" + "x" * 30)
    verdict = provider_error.value
    assert _legacy_account_absent(verdict, account_id="acct_old", mode="live")
    assert not _legacy_account_absent(verdict, account_id="acct_different", mode="live")
    assert not _legacy_account_absent(verdict, account_id="acct_old", mode="test")
    for error in (
        stripe.APIError(
            "Unavailable",
            http_status=400,
            json_body={"error": {"type": "api_error", "message": "Unavailable"}},
        ),
        stripe.APIError(
            message, http_status=500, json_body={"error": {"type": "api_error", "message": message}}
        ),
        stripe.AuthenticationError(message, http_status=401),
    ):
        assert not _legacy_account_absent(error, account_id="acct_old", mode="live")
    original_retrieve = fake.Account.retrieve

    def retrieve(account_id, **kwargs):
        if account_id == "acct_old":
            raise verdict
        return original_retrieve(account_id, **kwargs)

    monkeypatch.setattr(fake.Account, "retrieve", retrieve)
    assert await svc.account_status(user_id="owner", force_refresh=True) == {
        "account": None,
        "stripeMode": "live",
    }
    await svc.onboarding_link(user_id="owner", surface="documents")
    assert len(fake.accounts) == 1
    assert db.tables["stripe_owner_payout_accounts"][0]["stripe_mode"] == "live"
    assert db.tables["pkm_owner_payout_accounts"][0]["stripe_account_id"] == "acct_old"


async def test_live_onboarding_platform_setup_failure_is_actionable_and_sanitized(
    world, monkeypatch, caplog
):
    svc, db, _fake = world
    monkeypatch.setenv("STRIPE_MODE", "live")
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_live_" + "x" * 30)
    message = (
        "You must complete your platform profile to use Connect and create live connected "
        "accounts. Visit your dashboard at https://dashboard.stripe.com/connect/accounts/overview "
        "to answer the questionnaire."
    )
    _provider_response(
        monkeypatch,
        payload={"error": {"type": "invalid_request_error", "message": message}},
        status=400,
    )
    svc.stripe_api = stripe
    with pytest.raises(PacketOrderError) as failed:
        await svc.onboarding_link(user_id="owner", surface="documents")
    assert failed.value.code == "PAYOUT_PLATFORM_SETUP_REQUIRED"
    assert "Hushh" in str(failed.value)
    assert not db.tables["stripe_owner_payout_accounts"]
    assert "request_id=req_synthetic" in caplog.text
    assert "dashboard.stripe.com" not in caplog.text
    assert "sk_live" not in caplog.text


@pytest.mark.parametrize(
    ("url", "allowed"),
    [
        ("https://stripe.com/express/Ln7FfnNpUcCU", True),
        ("https://connect.stripe.com/express/acct_example/login", True),
        ("https://stripe.com/express/", False),
        ("https://stripe.com/setup/example", False),
        ("https://stripe.com.evil.example/express/example", False),
        ("https://stripe.com@evil.example/express/example", False),
        ("https://stripe.com:444/express/example", False),
        ("http://stripe.com/express/example", False),
    ],
)
async def test_bank_management_accepts_both_official_stripe_login_hosts_only(
    world, monkeypatch, url, allowed
):
    svc, _db, fake = world
    await svc.onboarding_link(user_id="owner", surface="documents")
    _provider_response(monkeypatch, payload={"object": "login_link", "url": url})
    # Account retrieval is already characterized; exercise actual LoginLink decoding.
    monkeypatch.setattr(fake.Account, "create_login_link", stripe.Account.create_login_link)
    if allowed:
        assert await svc.management_link(user_id="owner") == {"url": url}
    else:
        with pytest.raises(PacketOrderError, match="Couldn't open bank settings"):
            await svc.management_link(user_id="owner")


async def test_explicit_sandbox_bank_keeps_live_marketplace_settlement_isolated(world, monkeypatch):
    legacy, db, fake = world
    monkeypatch.setenv("STRIPE_MODE", "live")
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_live_" + "l" * 30)
    sandbox = PkmPayoutService(stripe_api=fake, mode="test", api_key="sk_test_" + "t" * 30)
    sandbox._db = db
    await sandbox.onboarding_link(user_id="owner", surface="documents")
    assert fake.accounts[-1]["api_key"].startswith("sk_test_")
    assert db.tables["stripe_owner_payout_accounts"][-1]["stripe_mode"] == "test"
    assert (await legacy.account_status(user_id="owner"))["stripeMode"] == "live"
    assert (await legacy.account_status(user_id="owner"))["account"] is None
    with pytest.raises(PacketOrderError, match="mode does not match"):
        await sandbox.transfer_due()
    assert fake.transfers == []


async def test_account_verification_projects_closed_categories_never_provider_text(world):
    svc, _db, fake = world
    await svc.onboarding_link(user_id="owner", surface="documents")
    fake.payouts_enabled = True
    fake.transfers_capability = "active"
    fake.requirements = {
        "currently_due": [
            "individual.verification.document",
            "individual.address.city",
            "external_account",
        ],
        "eventually_due": [
            "individual.verification.document",
            "individual.address.city",
            "external_account",
            "individual.id_number",
        ],
        "current_deadline": 1793318400,
        "errors": [
            {
                "code": "verification_document_failed_copy",
                "reason": "Private provider text 123-45-6789",
                "requirement": "individual.verification.document",
            }
        ],
    }
    fake.account_extra = {
        "settings": {"payouts": {"schedule": {"interval": "daily", "delay_days": 2}}}
    }
    account = (await svc.account_status(user_id="owner"))["account"]
    # Stripe still pays out until the deadline; readiness is unchanged.
    assert account["ready"] is True
    assert account["verification"] == {
        "state": "due",
        "deadline": "2026-10-30T00:00:00+00:00",
        "items": ["identity", "address", "bank_account"],
        "eventuallyDue": True,
        "hasErrors": True,
        "disabledReason": None,
    }
    assert account["payoutSchedule"] == {"interval": "daily", "delayDays": 2}
    serialized = json.dumps(account)
    assert "Private provider text" not in serialized
    assert "individual." not in serialized and "external_account" not in serialized


@pytest.mark.parametrize(
    ("requirements", "extra", "expected"),
    [
        (
            {
                "past_due": ["tos_acceptance.date"],
                "currently_due": ["tos_acceptance.date"],
                "disabled_reason": "requirements.past_due",
            },
            {},
            ("past_due", ["terms"], "requirements_past_due", None),
        ),
        (
            {"pending_verification": ["individual.verification.document"]},
            {},
            ("in_review", [], None, None),
        ),
        ({"disabled_reason": "under_review"}, {}, ("in_review", [], "under_review", None)),
        (
            {"disabled_reason": "rejected.fraud", "currently_due": ["company.tax_id"]},
            {},
            ("disabled", ["tax_id"], "rejected", None),
        ),
        ({"disabled_reason": "a.newer_reason"}, {}, ("disabled", [], "other", None)),
        (
            {"eventually_due": ["individual.id_number"]},
            {"future_requirements": {"currently_due": [], "current_deadline": 1793318400}},
            ("none", [], None, None),
        ),
        (
            {},
            {
                "future_requirements": {
                    "currently_due": ["individual.id_number", "business_profile.url"],
                    "current_deadline": 1793318400,
                },
                "settings": {"payouts": {"schedule": {"interval": "hourly", "delay_days": 2}}},
            },
            ("upcoming", ["tax_id", "business"], None, "2026-10-30T00:00:00+00:00"),
        ),
    ],
)
async def test_account_verification_state_follows_stripe_requirements(
    world, requirements, extra, expected
):
    svc, _db, fake = world
    await svc.onboarding_link(user_id="owner", surface="documents")
    fake.requirements, fake.account_extra = requirements, extra
    account = (await svc.account_status(user_id="owner"))["account"]
    verification = account["verification"]
    assert (
        verification["state"],
        verification["items"],
        verification["disabledReason"],
        verification["deadline"],
    ) == expected
    # An unknown payout interval is omitted, never guessed.
    assert account["payoutSchedule"] is None


async def test_verify_link_collects_upcoming_requirements_for_existing_accounts_only(world):
    svc, _db, fake = world
    with pytest.raises(PacketOrderError) as missing:
        await svc.onboarding_link(user_id="owner", surface="documents", purpose="verify")
    assert missing.value.code == "PAYOUT_ACCOUNT_REQUIRED"
    assert fake.accounts == [] and fake.links == []
    await svc.onboarding_link(user_id="owner", surface="documents")
    assert "collection_options" not in fake.links[-1]
    await svc.onboarding_link(user_id="owner", surface="documents", purpose="verify")
    assert fake.links[-1]["type"] == "account_onboarding"
    assert fake.links[-1]["collection_options"] == {
        "fields": "eventually_due",
        "future_requirements": "include",
    }
    assert len(fake.accounts) == 1


def test_onboard_route_accepts_only_an_optional_verify_purpose(world, monkeypatch, payout_client):
    svc, _db, fake = world
    monkeypatch.setattr(payouts_routes, "_service", lambda: svc)
    client = payout_client
    app = client.app
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "owner"}
    onboard = "/api/one/payouts/account/onboard"
    missing = client.post(onboard, json={"purpose": "verify"})
    assert missing.status_code == 503
    assert missing.json()["detail"]["code"] == "PAYOUT_ACCOUNT_REQUIRED"
    assert missing.headers["Cache-Control"] == "private, no-store"
    for body in (None, {}):
        assert client.post(onboard, json=body).status_code == 200
        assert "collection_options" not in fake.links[-1]
    assert client.post(onboard, json={"purpose": "verify"}).status_code == 200
    assert fake.links[-1]["collection_options"]["fields"] == "eventually_due"
    for body in (
        {"purpose": "update"},
        {"purpose": "verify", "account": "acct_other"},
        {"attempt_id": "invalid"},
        {"attempt_id": "63c06d5a-0c5f-4a85-a43a-4a63417c9be0", "user_id": "other"},
    ):
        assert client.post(onboard, json=body).status_code == 422
    assert len(fake.links) == 3 and len(fake.accounts) == 1


def test_bank_payout_route_pages_by_cursor_for_the_token_owner_only(monkeypatch, payout_client):
    from hushh_mcp.services.stripe_connect_bank_payouts import ConnectBankPayoutError

    calls = []

    async def owner_summary(*, user_id, cursor=None):
        calls.append((user_id, cursor))
        if cursor == "stale":
            raise ConnectBankPayoutError("invalid_cursor")
        return {"currency": "USD", "stripeMode": "test", "payouts": [], "nextCursor": None}

    monkeypatch.setattr(
        payouts_routes,
        "StripeConnectBankPayouts",
        lambda **_: SimpleNamespace(owner_summary=owner_summary),
    )
    client = payout_client
    app = client.app
    deposits = "/api/one/payouts/account/bank-payouts"
    unauthenticated = client.get(f"{deposits}?cursor=")
    assert unauthenticated.status_code == 401
    assert unauthenticated.headers["Cache-Control"] == "private, no-store"
    assert calls == []
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "owner"}
    assert client.get(f"{deposits}?user_id=other").json()["nextCursor"] is None
    assert client.get(f"{deposits}?cursor=page_2").status_code == 200
    assert client.get(deposits, params={"cursor": "x" * 256}).status_code == 200
    assert calls == [("owner", None), ("owner", "page_2"), ("owner", "x" * 256)]
    invalid = {"code": "INVALID_CURSOR", "message": "Bank payout page is unavailable."}
    # Malformed cursors never reach the service; a stale one is refused by it.
    for cursor in ("", "x" * 257, "stale"):
        rejected = client.get(deposits, params={"cursor": cursor})
        assert rejected.status_code == 422
        assert rejected.json() == {"detail": invalid}
        assert rejected.headers["Cache-Control"] == "private, no-store"
    assert calls[-1] == ("owner", "stale") and len(calls) == 4


@pytest.mark.parametrize(
    ("route", "path"), [("live", "/connect/webhook"), ("sandbox", "/connect/sandbox-webhook")]
)
def test_connect_webhook_rejections_log_closed_codes_only(
    monkeypatch, caplog, route, path, payout_client
):
    from hushh_mcp.services.external_connector_lifecycle_store import ConnectorLifecycleError
    from hushh_mcp.services.stripe_connect_bank_payouts import ConnectBankPayoutError

    failures = iter(
        [
            ConnectBankPayoutError("provider_mismatch"),
            ConnectBankPayoutError("Provider said acct_private failed"),
            ConnectorLifecycleError("private storage detail"),
        ]
    )

    async def process_webhook(**_):
        raise next(failures)

    monkeypatch.setattr(
        payouts_routes,
        "StripeConnectBankPayouts",
        lambda **_: SimpleNamespace(process_webhook=process_webhook),
    )
    client = payout_client
    caplog.set_level("WARNING", logger=payouts_routes.logger.name)
    statuses = [
        client.post(
            f"/api/one/payouts{path}", content=b"{}", headers={"Stripe-Signature": "t=1,v1=x"}
        ).status_code
        for _ in range(3)
    ]
    assert statuses == [409, 503, 503]
    assert [record.getMessage() for record in caplog.records] == [
        f"connect_webhook.rejected route={route} status=409 code=provider_mismatch",
        f"connect_webhook.rejected route={route} status=503 code=other",
        f"connect_webhook.rejected route={route} status=503 code=storage_unavailable",
    ]
    assert "acct_private" not in caplog.text and "private storage" not in caplog.text


async def test_display_account_reads_single_flight_across_service_instances(world, monkeypatch):
    svc, db, fake = world
    svc._resume_documents = False
    await svc.onboarding_link(user_id="owner")
    fake.retrieves.clear()
    other = PkmPayoutService(stripe_api=fake, resume_documents=False)
    other._db = db
    started, release = asyncio.Event(), asyncio.Event()
    retrieve = svc._retrieve_account
    all_joined = asyncio.Event()
    binding = other._account
    joined = 0

    async def observed_binding(user_id):
        nonlocal joined
        account = await binding(user_id)
        joined += 1
        if joined == 8:
            all_joined.set()
        return account

    monkeypatch.setattr(other, "_account", observed_binding)

    async def blocked(account_id, *, key):
        started.set()
        await release.wait()
        return await retrieve(account_id, key=key)

    monkeypatch.setattr(svc, "_retrieve_account", blocked)
    first = asyncio.create_task(svc.account_status(user_id="owner"))
    await started.wait()
    reads = [asyncio.create_task(other.account_status(user_id="owner")) for _ in range(8)]
    await all_joined.wait()
    release.set()
    statuses = await asyncio.gather(first, *reads)
    assert all(result == statuses[0] for result in statuses)
    statuses[0]["account"]["bank"]["last4"] = "0000"
    assert (await other.account_status(user_id="owner"))["account"]["bank"]["last4"] == "6789"
    assert fake.retrieves == ["acct_1"]


async def test_display_status_isolates_owner_mode_provider_and_account_binding(world):
    svc, db, fake = world
    svc._resume_documents = False
    await svc.onboarding_link(user_id="owner")
    fake.retrieves.clear()
    await svc.account_status(user_id="owner")
    assert (await svc.account_status(user_id="other"))["account"] is None
    live = PkmPayoutService(
        stripe_api=fake, mode="live", api_key="sk_live_" + "y" * 30, resume_documents=False
    )
    live._db = db
    assert (await live.account_status(user_id="owner"))["account"] is None
    rotated = PkmPayoutService(
        stripe_api=fake, mode="test", api_key="sk_test_" + "y" * 30, resume_documents=False
    )
    rotated._db = db
    fake.payouts_enabled = True
    fake.transfers_capability = "active"
    db.tables[pkm_payout_service.ACCOUNTS].extend(
        [
            {"user_id": "other", "stripe_mode": "test", "stripe_account_id": "acct_other"},
            {"user_id": "owner", "stripe_mode": "live", "stripe_account_id": "acct_1"},
        ]
    )
    assert (await svc.account_status(user_id="other"))["account"]["ready"] is True
    assert (await live.account_status(user_id="owner"))["account"]["ready"] is True
    assert (await rotated.account_status(user_id="owner"))["account"]["ready"] is True
    assert (await svc.account_status(user_id="owner"))["account"]["ready"] is False
    db.tables[pkm_payout_service.ACCOUNTS][0]["stripe_account_id"] = "acct_rebound"
    assert (await svc.account_status(user_id="owner"))["account"]["ready"] is True
    assert fake.retrieves == ["acct_1", "acct_other", "acct_1", "acct_1", "acct_rebound"]
    db.tables[pkm_payout_service.ACCOUNTS].clear()
    assert (await svc.account_status(user_id="owner"))["account"] is None


async def test_verified_invalidation_fences_inflight_display_result(world, monkeypatch):
    svc, _db, fake = world
    svc._resume_documents = False
    await svc.onboarding_link(user_id="owner")
    started, release = asyncio.Event(), asyncio.Event()
    retrieve = svc._retrieve_account
    calls = 0

    async def blocked(account_id, *, key):
        nonlocal calls
        calls += 1
        snapshot = await retrieve(account_id, key=key)
        if calls == 1:
            started.set()
            await release.wait()
        return snapshot

    monkeypatch.setattr(svc, "_retrieve_account", blocked)
    reading = asyncio.create_task(svc.account_status(user_id="owner"))
    await started.wait()
    fake.payouts_enabled = True
    fake.transfers_capability = "active"
    payout_account_status_cache.invalidate_payout_account_status(user_id="owner", mode="test")
    release.set()
    assert (await reading)["account"]["ready"] is True
    assert (await svc.account_status(user_id="owner"))["account"]["ready"] is True
    assert calls == 2


async def test_display_provider_failure_is_not_cached(world, monkeypatch):
    svc, _db, fake = world
    await svc.onboarding_link(user_id="owner")
    fake.retrieves.clear()
    retrieve = svc._retrieve_account
    failing = AsyncMock(side_effect=PacketOrderError("PAYOUT_UNAVAILABLE", "Retry."))
    monkeypatch.setattr(svc, "_retrieve_account", failing)
    with pytest.raises(PacketOrderError):
        await svc.account_status(user_id="owner")
    monkeypatch.setattr(svc, "_retrieve_account", retrieve)
    assert (await svc.account_status(user_id="owner"))["account"] is not None
    assert fake.retrieves == ["acct_1"]


async def test_cached_ready_display_never_authorizes_hashcoin_redemption(world):
    from hushh_mcp.services.hashcoin_redemption_service import (
        HashcoinRedemptionError,
        HashcoinRedemptionService,
    )

    svc, _db, fake = world
    svc._resume_documents = False
    await svc.onboarding_link(user_id="owner")
    fake.retrieves.clear()
    fake.payouts_enabled = True
    fake.transfers_capability = "active"
    assert (await svc.account_status(user_id="owner"))["account"]["ready"] is True
    fake.deleted = True
    wallet = SimpleNamespace(
        get_redemption=AsyncMock(return_value=None), reserve_redemption=AsyncMock()
    )
    redemption = HashcoinRedemptionService(wallet=wallet, stripe_api=fake, accounts=svc)
    with pytest.raises(HashcoinRedemptionError) as failure:
        await redemption.redeem(
            user_id="owner",
            amount_coins=100,
            client_request_id="00000000-0000-4000-8000-000000000001",
            mode="test",
        )
    assert failure.value.code == "PAYOUT_ACCOUNT_REQUIRED"
    assert fake.retrieves == ["acct_1", "acct_1"]
    wallet.reserve_redemption.assert_not_awaited()
    assert fake.transfers == []


async def test_bank_management_and_onboarding_fence_display_cache(world):
    svc, _db, fake = world
    svc._resume_documents = False
    await svc.onboarding_link(user_id="owner")
    fake.retrieves.clear()
    await svc.account_status(user_id="owner")
    await svc.management_link(user_id="owner")
    await svc.account_status(user_id="owner")
    assert len(fake.retrieves) == 3
    await svc.onboarding_link(user_id="owner")
    await svc.account_status(user_id="owner")
    assert len(fake.retrieves) == 5


async def test_cached_verification_is_copied_owner_scoped_and_fenced_by_verify_link(world):
    svc, db, fake = world
    svc._resume_documents = False
    await svc.onboarding_link(user_id="owner", surface="documents")
    fake.retrieves.clear()
    fake.requirements = {"currently_due": ["individual.verification.document"]}
    fake.account_extra = {
        "settings": {"payouts": {"schedule": {"interval": "weekly", "delay_days": 3}}}
    }
    shown = (await svc.account_status(user_id="owner"))["account"]
    shown["verification"]["items"].append("tax_id")
    shown["payoutSchedule"]["interval"] = "manual"
    fake.requirements = {}
    cached = (await svc.account_status(user_id="owner"))["account"]
    # One provider read serves both; one reader's edit never reaches the next.
    assert fake.retrieves == ["acct_1"]
    assert cached["verification"]["state"] == "due"
    assert cached["verification"]["items"] == ["identity"]
    assert cached["payoutSchedule"] == {"interval": "weekly", "delayDays": 3}
    db.tables[pkm_payout_service.ACCOUNTS].append(
        {"user_id": "other", "stripe_mode": "test", "stripe_account_id": "acct_other"}
    )
    other = (await svc.account_status(user_id="other"))["account"]
    assert other["verification"]["state"] == "none"
    # Opening a verify link fences the display, so Stripe's new state shows.
    await svc.onboarding_link(user_id="owner", surface="documents", purpose="verify")
    assert (await svc.account_status(user_id="owner"))["account"]["verification"]["items"] == []
    # Coming back from Stripe asks for a fresh read even while one is cached.
    fake.requirements = {"past_due": ["tos_acceptance.date"]}
    returned = (await svc.account_status(user_id="owner", force_refresh=True))["account"]
    assert returned["verification"]["state"] == "past_due"
    assert returned["verification"]["items"] == ["terms"]


async def test_display_cache_expiry_capacity_and_cancelled_reader(monkeypatch):
    now = 100.0
    monkeypatch.setattr(payout_account_status_cache, "monotonic", lambda: now)
    cache = PayoutAccountStatusCache(ttl=30, max_entries=2)
    load = AsyncMock(return_value={"ready": True})
    owner = ("owner", "test", "provider", "acct_1")
    await cache.get(owner, load)
    now += 29
    await cache.get(owner, load)
    assert load.await_count == 1
    now += 1
    await cache.get(owner, load)
    assert load.await_count == 2
    await cache.get(("second", "test", "provider", "acct_2"), load)
    await cache.get(("third", "test", "provider", "acct_3"), load)
    await cache.get(owner, load)
    assert load.await_count == 5  # the least-recently-read entry was evicted
    assert len(cache._entries) == 2

    started, release = asyncio.Event(), asyncio.Event()
    calls = 0

    async def slow():
        nonlocal calls
        calls += 1
        started.set()
        await release.wait()
        return {"ready": False}

    cache.invalidate(user_id="owner", mode="test")
    disconnected = asyncio.create_task(cache.get(owner, slow))
    await started.wait()
    disconnected.cancel()
    with pytest.raises(asyncio.CancelledError):
        await disconnected
    release.set()
    assert await cache.get(owner, slow) == {"ready": False}
    assert calls == 1


@pytest.mark.parametrize("deleted", [False, True])
async def test_account_rebinding_during_refresh_cannot_publish_old_readiness(
    world, monkeypatch, deleted
):
    svc, db, fake = world
    svc._resume_documents = False
    await svc.onboarding_link(user_id="owner")
    fake.payouts_enabled = True
    fake.transfers_capability = "active"
    started, release = asyncio.Event(), asyncio.Event()
    retrieve = svc._retrieve_account

    async def blocked(account_id, *, key):
        snapshot = await retrieve(account_id, key=key)
        started.set()
        await release.wait()
        return snapshot

    monkeypatch.setattr(svc, "_retrieve_account", blocked)
    reading = asyncio.create_task(svc.refresh_account("owner"))
    await started.wait()
    db.tables[pkm_payout_service.ACCOUNTS] = (
        []
        if deleted
        else [{"user_id": "owner", "stripe_mode": "test", "stripe_account_id": "acct_rebound"}]
    )
    release.set()
    with pytest.raises(PacketOrderError) as failure:
        await reading
    assert failure.value.code == "PAYOUT_UNAVAILABLE"
    assert all("account_ready" not in row for row in db.tables[pkm_payout_service.ACCOUNTS])


async def test_invalidated_display_cannot_overwrite_new_authority_when_retry_fails(
    world, monkeypatch
):
    svc, db, fake = world
    await svc.onboarding_link(user_id="owner")
    db.tables[pkm_payout_service.ACCOUNTS][0]["account_ready"] = False
    fake.payouts_enabled = True
    fake.transfers_capability = "active"
    started, release = asyncio.Event(), asyncio.Event()
    retrieve = svc._retrieve_account
    resume = AsyncMock()
    monkeypatch.setattr(pkm_payout_service, "resume_document_owner_setup", resume)
    calls = 0

    async def delayed_display(account_id, *, key):
        nonlocal calls
        calls += 1
        if calls == 3:
            raise PacketOrderError("PAYOUT_UNAVAILABLE", "Retry failed.")
        snapshot = await retrieve(account_id, key=key)
        if calls == 1:
            started.set()
            await release.wait()
        return snapshot

    monkeypatch.setattr(svc, "_retrieve_account", delayed_display)
    reading = asyncio.create_task(svc.account_status(user_id="owner"))
    await started.wait()
    fake.deleted = True
    refreshed = await svc.refresh_account("owner")
    assert refreshed["readiness"]["ready"] is False
    authoritative_row = dict(db.tables[pkm_payout_service.ACCOUNTS][0])
    release.set()
    with pytest.raises(PacketOrderError, match="Retry failed"):
        await reading
    assert calls == 3
    assert db.tables[pkm_payout_service.ACCOUNTS][0] == authoritative_row
    assert authoritative_row["account_ready"] is False
    resume.assert_not_awaited()
