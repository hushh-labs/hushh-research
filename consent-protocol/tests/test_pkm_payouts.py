"""Owner payouts through Stripe Connect: hussh pays owners after delivery.

Money boundaries: nothing is owed until the packet is delivered; nothing is
sent until Stripe enables payouts; each earning is transferred once, for the
price minus hussh's fee, against the buyer's own charge; and a delivered order
is never refunded.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import api.routes.one.payouts as payouts_routes
from api.middleware import require_vault_owner_token
from hushh_mcp.services import pkm_payout_service
from hushh_mcp.services.pkm_packet_order_service import PacketOrderError, PkmPacketOrderService
from hushh_mcp.services.pkm_payout_service import PkmPayoutService
from tests.test_pkm_credits import _DB


class _Stripe:
    def __init__(self):
        self.accounts, self.links, self.transfers, self.refunds = [], [], [], []
        self.payouts_enabled = False
        self.transfers_capability = "inactive"
        self.disabled_reason = None
        self.country = "US"
        self.deleted = False
        outer = self

        class _Account:
            @staticmethod
            def create(**kw):
                outer.accounts.append(kw)
                return {"id": f"acct_{len(outer.accounts)}"}

            @staticmethod
            def retrieve(acct, **_kw):
                return {
                    "id": acct,
                    "country": outer.country,
                    "deleted": outer.deleted,
                    "details_submitted": True,
                    "payouts_enabled": outer.payouts_enabled,
                    "capabilities": {"transfers": outer.transfers_capability},
                    "requirements": {"disabled_reason": outer.disabled_reason},
                }

            @staticmethod
            def create_login_link(account, **kw):
                outer.links.append({"account": account, **kw})
                return {"url": "https://connect.stripe.com/express/test"}

        class _AccountLink:
            @staticmethod
            def create(**kw):
                outer.links.append(kw)
                return {"url": "https://connect.stripe.com/setup/x"}

        class _PaymentIntent:
            @staticmethod
            def retrieve(pi, **_kw):
                return {"id": pi, "latest_charge": "ch_1"}

        class _Transfer:
            @staticmethod
            def create(**kw):
                outer.transfers.append(kw)
                return {"id": f"tr_{len(outer.transfers)}"}

        class _Refund:
            @staticmethod
            def create(**kw):
                outer.refunds.append(kw)
                return {"id": "re_1"}

        self.Account, self.AccountLink, self.PaymentIntent = _Account, _AccountLink, _PaymentIntent
        self.Transfer, self.Refund = _Transfer, _Refund


@pytest.fixture(autouse=True)
def stripe_env(monkeypatch):
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_" + "x" * 30)
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_" + "x" * 30)
    monkeypatch.setenv("HUSSH_SITE_ORIGIN", "https://uat.hushh.ai")
    for name in ("ENVIRONMENT", "HUSSH_DEPLOY_ENV"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(pkm_payout_service, "_app_origin", lambda: "https://uat.one.hushh.ai")


@pytest.fixture
def world():
    db, fake = _DB(), _Stripe()
    db.tables["marketplace_access_requests"] = [
        {"id": "r1", "status": "approved", "latest_envelope_id": "env1"},
        {"id": "r2", "status": "pending", "latest_envelope_id": None},
    ]
    db.tables["pkm_packet_orders"] = [
        {
            "id": "o1",
            "owner_user_id": "owner",
            "buyer_user_id": "b",
            "status": "paid",
            "access_request_id": "r1",
            "amount_cents": 500,
            "platform_fee_cents": 50,
            "payment_method": "card",
            "stripe_payment_intent_id": "pi_1",
            "owner_earning_status": "none",
        },
        {
            "id": "o2",
            "owner_user_id": "owner",
            "buyer_user_id": "b",
            "status": "paid",
            "access_request_id": "r2",
            "amount_cents": 300,
            "platform_fee_cents": 0,
            "payment_method": "card",
            "stripe_payment_intent_id": "pi_2",
            "owner_earning_status": "none",
        },
    ]
    svc = PkmPayoutService(stripe_api=fake)
    svc._db = db
    return svc, db, fake


async def test_onboarding_creates_one_express_account(world):
    svc, db, fake = world
    first = await svc.onboarding_link(user_id="owner")
    await svc.onboarding_link(user_id="owner")
    assert first["url"].startswith("https://connect.stripe.com/")
    assert len(fake.accounts) == 1 and fake.accounts[0]["type"] == "express"
    assert fake.links[0]["return_url"] == "https://uat.one.hushh.ai/one/marketplace?payouts=done"
    assert db.tables["pkm_owner_payout_accounts"][0]["stripe_account_id"] == "acct_1"


async def test_document_onboarding_reuses_packet_account_with_separate_return_path(world):
    svc, db, fake = world
    await svc.onboarding_link(user_id="owner")
    document = await svc.onboarding_link(user_id="owner", surface="documents")
    assert document == {"url": "https://connect.stripe.com/setup/x"}
    assert len(fake.accounts) == 1
    assert (
        fake.links[1]["account"] == db.tables["pkm_owner_payout_accounts"][0]["stripe_account_id"]
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
    assert await svc.account_status(user_id="owner") == {"account": None}
    await svc.onboarding_link(user_id="owner", surface="documents")
    initial = (await svc.account_status(user_id="owner"))["account"]
    assert initial == {
        "detailsSubmitted": True,
        "transfersEnabled": False,
        "payoutsEnabled": False,
        "ready": False,
        "status": "onboarding_required",
    }

    fake.payouts_enabled = True
    fake.transfers_capability = "active"
    ready = (await svc.account_status(user_id="owner"))["account"]
    assert ready["ready"] is True and ready["status"] == "ready"
    assert "stripe_account_id" not in ready

    fake.disabled_reason = "requirements.past_due"
    restricted = (await svc.account_status(user_id="owner"))["account"]
    assert restricted["ready"] is False and restricted["status"] == "restricted"


async def test_deleted_or_non_us_mapped_account_is_never_replaced(world):
    svc, _db, fake = world
    await svc.onboarding_link(user_id="owner", surface="documents")
    fake.deleted = True
    assert (await svc.account_status(user_id="owner"))["account"]["status"] == "restricted"
    with pytest.raises(PacketOrderError, match="needs support"):
        await svc.onboarding_link(user_id="owner", surface="documents")
    fake.deleted = False
    fake.country = "CA"
    assert (await svc.account_status(user_id="owner"))["account"]["ready"] is False
    with pytest.raises(PacketOrderError, match="needs support"):
        await svc.onboarding_link(user_id="owner", surface="documents")
    assert len(fake.accounts) == 1


async def test_concurrent_mapping_insert_reuses_existing_stripe_account(world, monkeypatch):
    svc, db, fake = world
    original_rows = svc._rows

    async def concurrent_insert(query):
        if query.op == "insert" and query.store is db.tables["pkm_owner_payout_accounts"]:
            query.store.append({"user_id": "owner", "stripe_account_id": "acct_1"})
            raise RuntimeError("unique constraint")
        return await original_rows(query)

    monkeypatch.setattr(svc, "_rows", concurrent_insert)
    await svc.onboarding_link(user_id="owner", surface="documents")
    assert len(fake.accounts) == 1
    assert len(db.tables["pkm_owner_payout_accounts"]) == 1
    assert fake.links[0]["account"] == "acct_1"


async def test_stripe_failure_is_sanitized_and_does_not_create_second_account(world):
    svc, db, fake = world
    await svc.onboarding_link(user_id="owner", surface="documents")

    def fail_retrieve(*_args, **_kwargs):
        raise RuntimeError("sk_test_fake_secret from Stripe")

    fake.Account.retrieve = fail_retrieve
    with pytest.raises(PacketOrderError) as exc:
        await svc.account_status(user_id="owner")
    assert exc.value.code == "PAYOUT_UNAVAILABLE"
    assert "sk_test" not in str(exc.value)
    assert len(fake.accounts) == 1
    assert len(db.tables["pkm_owner_payout_accounts"]) == 1


def test_document_account_routes_are_owner_scoped_and_exclude_packet_sales(world, monkeypatch):
    svc, _db, fake = world
    monkeypatch.setattr(payouts_routes, "_service", lambda: svc)
    app = FastAPI()
    app.include_router(payouts_routes.router)
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "owner"}
    client = TestClient(app)

    setup = client.post("/api/one/payouts/account/onboard")
    assert setup.status_code == 200
    assert setup.headers["Cache-Control"] == "private, no-store"
    assert setup.json() == {"url": "https://connect.stripe.com/setup/x"}
    assert fake.links[0]["return_url"].endswith("?documentPayouts=done")

    status = client.get("/api/one/payouts/account")
    assert status.status_code == 200
    assert status.headers["Cache-Control"] == "private, no-store"
    assert set(status.json()) == {"account"}
    assert "earningsCents" not in status.text
    assert "acct_" not in status.text

    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "other"}
    assert client.get("/api/one/payouts/account").json() == {"account": None}


async def test_only_delivered_orders_become_due_and_pay_once_payouts_enabled(world):
    svc, db, fake = world
    assert await svc.mark_delivered_earnings_due() == 1
    statuses = {o["id"]: o["owner_earning_status"] for o in db.tables["pkm_packet_orders"]}
    assert statuses == {"o1": "due", "o2": "none"}

    await svc.onboarding_link(user_id="owner")
    assert await svc.transfer_due() == 0  # payouts not enabled yet
    assert fake.transfers == []

    fake.payouts_enabled = True
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


async def test_payout_readiness_cache_requires_transfers_and_unrestricted_us_account(world):
    svc, db, fake = world
    await svc.onboarding_link(user_id="owner", surface="documents")
    fake.payouts_enabled = True
    await svc.account_status(user_id="owner")
    assert db.tables["pkm_owner_payout_accounts"][0]["account_ready"] is False
    fake.transfers_capability = "active"
    await svc.account_status(user_id="owner")
    assert db.tables["pkm_owner_payout_accounts"][0]["account_ready"] is True
    fake.disabled_reason = "requirements.past_due"
    await svc.account_status(user_id="owner")
    assert db.tables["pkm_owner_payout_accounts"][0]["account_ready"] is False


def test_document_money_routes_require_owner_and_sanitize_history_failure(monkeypatch):
    from hushh_mcp.services.drive_request_owner_payout_service import DriveRequestOwnerPayoutService

    calls = []

    async def history(self, *, user_id, cursor=None):
        calls.append((user_id, cursor))
        if cursor:
            raise RuntimeError("private_provider_or_database_detail")
        return {"currency": "USD", "transactions": [], "nextCursor": None}

    monkeypatch.setattr(DriveRequestOwnerPayoutService, "owner_history", history)
    app = FastAPI()
    app.include_router(payouts_routes.router)
    client = TestClient(app)
    assert client.get("/api/one/payouts/account/earnings").status_code == 401
    assert client.post("/api/one/payouts/account/manage").status_code == 401
    assert calls == []
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "owner"}
    response = client.get("/api/one/payouts/account/earnings?user_id=other")
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "private, no-store"
    assert calls == [("owner", None)]
    assert client.get("/api/one/payouts/account/earnings?cursor=invalid").status_code == 422
    failed = client.get(
        "/api/one/payouts/account/earnings?cursor=00000000-0000-4000-8000-000000000001"
    )
    assert failed.status_code == 503
    assert failed.json() == {"detail": "Transactions are unavailable."}
