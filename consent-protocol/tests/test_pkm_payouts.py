"""Owner payouts through Stripe Connect: hussh pays owners after delivery.

Money boundaries: nothing is owed until the packet is delivered; nothing is
sent until Stripe enables payouts; each earning is transferred once, for the
price minus hussh's fee, against the buyer's own charge; and a delivered order
is never refunded.
"""

from __future__ import annotations

import pytest

from hushh_mcp.services import pkm_payout_service
from hushh_mcp.services.pkm_packet_order_service import PkmPacketOrderService
from hushh_mcp.services.pkm_payout_service import PkmPayoutService
from tests.test_pkm_credits import _DB


class _Stripe:
    def __init__(self):
        self.accounts, self.links, self.transfers, self.refunds = [], [], [], []
        self.payouts_enabled = False
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
                    "details_submitted": True,
                    "payouts_enabled": outer.payouts_enabled,
                }

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
