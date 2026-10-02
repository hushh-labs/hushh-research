"""Credits plans: monthly grants, spending on packets, refunds in credits.

Money boundaries: a paid invoice grants credits once (a replay grants nothing)
and expires the unused balance; you cannot spend credits you don't have; a
credit-paid order the owner declines is refunded in credits, once, with no card
refund; a deleted account's subscription is cancelled at Stripe.
"""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime

import pytest
import stripe

from db.db_client import JsonParam
from hushh_mcp.services.pkm_credit_service import PLANS
from hushh_mcp.services.pkm_packet_order_service import (
    PacketOrderError,
    PkmPacketOrderService,
    webhook_payment_kind,
)


class _Result:
    def __init__(self, data):
        self.data = data


class _Query:
    def __init__(self, store):
        self.store, self.op, self.payload, self.filters, self.n = store, "select", None, [], None

    def select(self, *_a):
        return self

    def insert(self, p):
        self.op, self.payload = "insert", p
        return self

    def update(self, p):
        self.op, self.payload = "update", p
        return self

    def delete(self):
        self.op = "delete"
        return self

    def eq(self, k, v):
        self.filters.append(
            lambda r, k=k, v=v: r.get(k) is True if v is True else str(r.get(k)) == str(v)
        )
        return self

    def in_(self, k, vs):
        self.filters.append(lambda r, k=k, vs=tuple(str(x) for x in vs): str(r.get(k)) in vs)
        return self

    def limit(self, n):
        self.n = n
        return self

    def execute(self):
        if self.op == "insert":
            row = {k: (v.value if isinstance(v, JsonParam) else v) for k, v in self.payload.items()}
            row = {"id": str(uuid.uuid4()), "created_at": datetime.now(UTC).isoformat(), **row}
            self.store.append(row)
            return _Result([row])
        rows = [r for r in self.store if all(f(r) for f in self.filters)]
        if self.op == "update":
            for r in rows:
                r.update(self.payload)
        if self.op == "delete":
            for r in rows:
                self.store.remove(r)
        return _Result(rows[: self.n] if self.n else rows)


class _DB:
    """In-memory tables plus the two credits functions from migration 267."""

    def __init__(self):
        self.tables: dict[str, list] = {}

    def table(self, name):
        return _Query(self.tables.setdefault(name, []))

    def _ledger(self, user):
        return [r for r in self.tables.setdefault("pkm_credit_ledger", []) if r["user_id"] == user]

    def rpc(self, fn, params):
        user, ref = params["p_user"], params["p_ref"]
        ledger = self.tables.setdefault("pkm_credit_ledger", [])
        balance = sum(r["delta"] for r in self._ledger(user))
        if fn == "pkm_grant_credits":
            if any(r["reason"] == "grant" and r["ref"] == ref for r in self._ledger(user)):
                return _Result([{fn: False}])
            if balance > 0:
                ledger.append({"user_id": user, "delta": -balance, "reason": "expire", "ref": ref})
            ledger.append(
                {"user_id": user, "delta": params["p_credits"], "reason": "grant", "ref": ref}
            )
            return _Result([{fn: True}])
        if fn == "pkm_spend_credits":
            if any(r["reason"] == "spend" and r["ref"] == ref for r in self._ledger(user)):
                return _Result([{fn: True}])
            if balance < params["p_cost"]:
                return _Result([{fn: False}])
            ledger.append(
                {"user_id": user, "delta": -params["p_cost"], "reason": "spend", "ref": ref}
            )
            return _Result([{fn: True}])
        raise AssertionError(fn)


class _Stripe:
    def __init__(self):
        self.sessions, self.refunds, self.cancelled = [], [], []
        outer = self

        class _Session:
            @staticmethod
            def create(**kw):
                s = {
                    "id": f"cs_{len(outer.sessions)}",
                    "url": "https://checkout.stripe.com/s",
                    **kw,
                }
                outer.sessions.append(s)
                return s

        class _Checkout:
            Session = _Session

        class _Refund:
            @staticmethod
            def create(**kw):
                outer.refunds.append(kw)
                return {"id": "re_1"}

        class _Subscription:
            @staticmethod
            def cancel(sub_id, **_kw):
                outer.cancelled.append(sub_id)

        class _Webhook:
            @staticmethod
            def construct_event(payload, signature, secret):
                if signature != "good":
                    raise stripe.error.SignatureVerificationError("bad", signature)
                return json.loads(payload)

        self.checkout, self.Refund, self.Subscription, self.Webhook = (
            _Checkout,
            _Refund,
            _Subscription,
            _Webhook,
        )


@pytest.fixture(autouse=True)
def stripe_env(monkeypatch):
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_" + "x" * 30)
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_" + "x" * 30)
    monkeypatch.setenv("HUSSH_SITE_ORIGIN", "https://uat.hushh.ai")
    for name in ("ENVIRONMENT", "HUSSH_DEPLOY_ENV", "PKM_PACKET_PLATFORM_FEE_BPS"):
        monkeypatch.delenv(name, raising=False)


@pytest.fixture
def world(monkeypatch):
    db, fake = _DB(), _Stripe()
    db.tables["directory_listing_claims"] = [
        {"user_id": "owner", "listing_id": "npi1-42", "status": "verified"}
    ]
    db.tables["pkm_packets"] = [
        {
            "id": "p1",
            "owner_user_id": "owner",
            "title": "Lifestyle packet",
            "price_cents": 200,
            "credit_cost": 2,
            "for_sale": True,
        },
        {
            "id": "p2",
            "owner_user_id": "owner",
            "title": "No credits",
            "price_cents": 200,
            "credit_cost": None,
            "for_sale": True,
        },
    ]

    def credit_service(*_a, **kw):
        svc = _RealCredits(stripe_api=kw.get("stripe_api") or fake)
        svc._db = db
        return svc

    import hushh_mcp.services.pkm_credit_service as credits_module

    _RealCredits = credits_module.PkmCreditService
    monkeypatch.setattr(credits_module, "PkmCreditService", credit_service)
    orders = PkmPacketOrderService(stripe_api=fake)
    orders._bind(db)
    return orders, credit_service(), db, fake


def _invoice(invoice_id, user="buyer", plan="starter", reason="subscription_cycle"):
    meta = {"payment_kind": "pkm_credits", "user_id": user, "plan": plan}
    obj = {
        "object": "invoice",
        "id": invoice_id,
        "billing_reason": reason,
        "amount_paid": 999,
        "parent": {"subscription_details": {"metadata": meta}},
        "lines": {"data": [{"period": {"end": 1767225600}}]},
    }
    return json.dumps({"type": "invoice.paid", "data": {"object": obj}}).encode()


async def test_invoice_grants_once_and_expires_unused(world):
    orders, credits, db, _ = world
    assert webhook_payment_kind(_invoice("in_1")) == "pkm_credits"
    await orders.process_webhook(payload=_invoice("in_1"), signature="good")
    await orders.process_webhook(payload=_invoice("in_1"), signature="good")  # replay
    assert await credits.balance("buyer") == PLANS["starter"]["credits"]
    await orders.process_webhook(payload=_invoice("in_2"), signature="good")
    assert (
        await credits.balance("buyer") == PLANS["starter"]["credits"]
    )  # leftover expired, refilled
    reasons = [r["reason"] for r in db.tables["pkm_credit_ledger"]]
    assert reasons == ["grant", "expire", "grant"]
    with pytest.raises(PacketOrderError):
        await orders.process_webhook(payload=_invoice("in_3"), signature="forged")


async def test_buy_with_credits_spends_files_request_and_needs_balance(world):
    orders, credits, db, _ = world
    with pytest.raises(PacketOrderError) as exc:
        await orders.buy_with_credits(buyer_user_id="buyer", listing_id="npi1-42", packet_id="p1")
    assert exc.value.code == "NOT_ENOUGH_CREDITS"
    assert "pkm_packet_orders" not in db.tables

    await orders.process_webhook(payload=_invoice("in_1"), signature="good")
    out = await orders.buy_with_credits(buyer_user_id="buyer", listing_id="npi1-42", packet_id="p1")
    assert out["status"] == "paid"
    assert await credits.balance("buyer") == PLANS["starter"]["credits"] - 2
    order = db.tables["pkm_packet_orders"][0]
    assert order["payment_method"] == "credits" and order["credits_spent"] == 2
    assert order["amount_cents"] == 200  # the owner still earns the dollar price
    assert db.tables["marketplace_access_requests"][0]["owner_user_id"] == "owner"

    with pytest.raises(PacketOrderError) as exc:
        await orders.buy_with_credits(buyer_user_id="buyer", listing_id="npi1-42", packet_id="p2")
    assert exc.value.code == "NO_CREDIT_PRICE"


async def test_declined_credit_order_is_refunded_in_credits_once(world):
    orders, credits, db, fake = world
    await orders.process_webhook(payload=_invoice("in_1"), signature="good")
    await orders.buy_with_credits(buyer_user_id="buyer", listing_id="npi1-42", packet_id="p1")
    db.tables["marketplace_access_requests"][0]["status"] = "denied"
    assert (await orders.reconcile())["refunded"] == 1
    assert await orders.reconcile() == {"markedRefundable": 0, "refunded": 0}
    assert await credits.balance("buyer") == PLANS["starter"]["credits"]
    assert fake.refunds == []  # no card refund for a credits order
    assert db.tables["pkm_packet_orders"][0]["status"] == "refunded"


async def test_subscription_checkout_and_single_live_plan(world):
    _, credits, db, fake = world
    out = await credits.create_subscription_checkout(user_id="buyer", plan="professional")
    s = fake.sessions[0]
    assert out["checkoutUrl"].startswith("https://checkout.stripe.com/")
    assert s["mode"] == "subscription"
    assert s["line_items"][0]["price_data"]["recurring"] == {"interval": "month"}
    assert s["line_items"][0]["price_data"]["unit_amount"] == 4900
    assert s["subscription_data"]["metadata"]["plan"] == "professional"
    with pytest.raises(PacketOrderError):
        await credits.create_subscription_checkout(user_id="buyer", plan="platinum")
    db.tables["pkm_credit_subscriptions"] = [{"user_id": "buyer", "status": "active"}]
    with pytest.raises(PacketOrderError) as exc:
        await credits.create_subscription_checkout(user_id="buyer", plan="starter")
    assert exc.value.code == "ALREADY_SUBSCRIBED"


async def test_deleted_accounts_subscription_is_cancelled_at_stripe(world):
    _, credits, db, fake = world
    db.tables["pkm_credit_subscription_cancellations"] = [{"stripe_subscription_id": "sub_9"}]
    assert await credits.cancel_deleted_subscriptions() == 1
    assert fake.cancelled == ["sub_9"]
    assert db.tables["pkm_credit_subscription_cancellations"] == []


async def test_old_api_invoice_without_inline_metadata_reads_the_subscription(world, monkeypatch):
    orders, credits, db, fake = world
    meta = {"payment_kind": "pkm_credits", "user_id": "buyer", "plan": "professional"}

    class _Sub:
        @staticmethod
        def retrieve(sub_id, **_kw):
            assert sub_id == "sub_1"
            return {"object": "subscription", "id": sub_id, "metadata": meta}

    fake.Subscription.retrieve = _Sub.retrieve
    invoice = {
        "object": "invoice",
        "id": "in_old",
        "billing_reason": "subscription_create",
        "amount_paid": 4900,
        "subscription": "sub_1",
        "lines": {"data": []},
    }
    payload = json.dumps({"type": "invoice.paid", "data": {"object": invoice}}).encode()
    await orders.process_webhook(payload=payload, signature="good")
    assert await credits.balance("buyer") == PLANS["professional"]["credits"]
