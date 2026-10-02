"""Buying a PKM packet: hussh is the broker, the owner still decides.

Covers the money boundaries: only a verified listing's for-sale packet can be
bought, never your own; a forged or mismatched Stripe event pays nothing; a
replayed event files one request, not two; a denied request is refunded once.
"""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime, timedelta

import pytest
import stripe

from db.db_client import JsonParam
from hushh_mcp.services.pkm_packet_order_service import (
    PacketOrderError,
    PkmPacketOrderService,
    platform_fee_cents,
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
            lambda r, k=k, v=v: str(r.get(k)) == str(v) if v is not True else r.get(k) is True
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
    def __init__(self):
        self.tables: dict[str, list] = {}

    def table(self, name):
        return _Query(self.tables.setdefault(name, []))


class _Stripe:
    """Records Checkout and Refund calls; verifies 'signatures' as a fixed token."""

    def __init__(self):
        self.sessions: list[dict] = []
        self.refunds: list[dict] = []
        outer = self

        class _Session:
            @staticmethod
            def create(**kw):
                s = {
                    "id": f"cs_test_{len(outer.sessions)}",
                    "url": "https://checkout.stripe.com/x",
                    **kw,
                }
                outer.sessions.append(s)
                return s

            @staticmethod
            def retrieve(sid, **_kw):
                return {"id": sid, "status": "open", "url": "https://checkout.stripe.com/x"}

        class _Checkout:
            Session = _Session

        class _Refund:
            @staticmethod
            def create(**kw):
                outer.refunds.append(kw)
                return {"id": f"re_{len(outer.refunds)}"}

        class _Webhook:
            @staticmethod
            def construct_event(payload, signature, secret):
                if signature != "good":
                    raise stripe.error.SignatureVerificationError("bad", signature)
                return json.loads(payload)

        self.checkout = _Checkout
        self.Refund = _Refund
        self.Webhook = _Webhook


@pytest.fixture(autouse=True)
def stripe_env(monkeypatch):
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_" + "x" * 30)
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_" + "x" * 30)
    monkeypatch.setenv("HUSSH_SITE_ORIGIN", "https://uat.hushh.ai")
    monkeypatch.delenv("PKM_PACKET_PLATFORM_FEE_BPS", raising=False)
    monkeypatch.delenv("ENVIRONMENT", raising=False)
    monkeypatch.delenv("HUSSH_DEPLOY_ENV", raising=False)


@pytest.fixture
def world():
    db = _DB()
    db.tables["directory_listing_claims"] = [
        {"id": "c1", "user_id": "owner", "listing_id": "npi1-42", "status": "verified"},
        {"id": "c2", "user_id": "other", "listing_id": "npi1-77", "status": "pending"},
    ]
    db.tables["pkm_packets"] = [
        {
            "id": "p1",
            "owner_user_id": "owner",
            "title": "Bank statements",
            "price_cents": 300,
            "for_sale": True,
        },
        {
            "id": "p2",
            "owner_user_id": "owner",
            "title": "Tax documents",
            "price_cents": 400,
            "for_sale": False,
        },
    ]
    fake = _Stripe()
    svc = PkmPacketOrderService(stripe_api=fake)
    svc._bind(db)
    return svc, db, fake


def _event(order, session, kind="checkout.session.completed", **overrides):
    obj = {
        "object": "checkout.session",
        "id": session["id"],
        "client_reference_id": order["id"],
        "payment_status": "paid",
        "amount_total": order["amount_cents"],
        "currency": "usd",
        "payment_intent": "pi_1",
        "metadata": {"payment_kind": "pkm_packet_order", "order_id": order["id"]},
        **overrides,
    }
    return json.dumps({"type": kind, "data": {"object": obj}}).encode()


async def test_checkout_only_for_verified_for_sale_packets_and_not_your_own(world):
    svc, db, fake = world
    out = await svc.create_checkout(buyer_user_id="buyer", listing_id="npi1-42", packet_id="p1")
    assert out["checkoutUrl"].startswith("https://checkout.stripe.com/")
    s = fake.sessions[0]
    assert s["line_items"][0]["price_data"]["unit_amount"] == 300
    assert s["metadata"] == {"payment_kind": "pkm_packet_order", "order_id": out["orderId"]}
    assert s["success_url"].startswith(
        "https://uat.hushh.ai/marketplace/white-pages/purchase?order="
    )

    for listing, packet in [("npi1-42", "p2"), ("npi1-77", "p1"), ("npi1-42", "nope")]:
        with pytest.raises(PacketOrderError):
            await svc.create_checkout(buyer_user_id="buyer", listing_id=listing, packet_id=packet)
    with pytest.raises(PacketOrderError) as exc:
        await svc.create_checkout(buyer_user_id="owner", listing_id="npi1-42", packet_id="p1")
    assert exc.value.code == "OWN_PACKET"


async def test_open_checkout_is_reused(world):
    svc, _, fake = world
    a = await svc.create_checkout(buyer_user_id="buyer", listing_id="npi1-42", packet_id="p1")
    b = await svc.create_checkout(buyer_user_id="buyer", listing_id="npi1-42", packet_id="p1")
    assert a["orderId"] == b["orderId"] and len(fake.sessions) == 1


async def test_paid_webhook_files_one_request_even_when_replayed(world):
    svc, db, fake = world
    out = await svc.create_checkout(buyer_user_id="buyer", listing_id="npi1-42", packet_id="p1")
    order = db.tables["pkm_packet_orders"][0]
    payload = _event(order, fake.sessions[0])
    await svc.process_webhook(payload=payload, signature="good")
    await svc.process_webhook(payload=payload, signature="good")
    assert order["status"] == "paid"
    requests = db.tables["marketplace_access_requests"]
    assert len(requests) == 1
    assert requests[0]["owner_user_id"] == "owner" and requests[0]["buyer_user_id"] == "buyer"
    assert str(order["access_request_id"]) == str(requests[0]["id"])
    assert (await svc.get_order(buyer_user_id="buyer", order_id=out["orderId"]))["status"] == "paid"
    assert await svc.get_order(buyer_user_id="someone-else", order_id=out["orderId"]) is None


async def test_forged_or_mismatched_events_pay_nothing(world):
    svc, db, fake = world
    await svc.create_checkout(buyer_user_id="buyer", listing_id="npi1-42", packet_id="p1")
    order = db.tables["pkm_packet_orders"][0]
    with pytest.raises(PacketOrderError):
        await svc.process_webhook(payload=_event(order, fake.sessions[0]), signature="forged")
    with pytest.raises(PacketOrderError):
        await svc.process_webhook(
            payload=_event(order, fake.sessions[0], amount_total=1), signature="good"
        )
    with pytest.raises(PacketOrderError):
        await svc.process_webhook(payload=_event(order, {"id": "cs_other"}), signature="good")
    assert order["status"] == "awaiting_payment"
    assert "marketplace_access_requests" not in db.tables


async def test_denied_request_is_refunded_once(world):
    svc, db, fake = world
    await svc.create_checkout(buyer_user_id="buyer", listing_id="npi1-42", packet_id="p1")
    order = db.tables["pkm_packet_orders"][0]
    await svc.process_webhook(payload=_event(order, fake.sessions[0]), signature="good")

    assert await svc.reconcile() == {"markedRefundable": 0, "refunded": 0}  # still pending

    db.tables["marketplace_access_requests"][0]["status"] = "denied"
    assert await svc.reconcile() == {"markedRefundable": 1, "refunded": 1}
    assert order["status"] == "refunded"
    assert fake.refunds[0]["payment_intent"] == "pi_1"
    assert fake.refunds[0]["idempotency_key"] == f"pkm-packet-refund:{order['id']}"
    assert await svc.reconcile() == {"markedRefundable": 0, "refunded": 0}
    assert len(fake.refunds) == 1


async def test_request_deleted_with_account_is_refunded_and_row_removed(world):
    svc, db, fake = world
    await svc.create_checkout(buyer_user_id="buyer", listing_id="npi1-42", packet_id="p1")
    order = db.tables["pkm_packet_orders"][0]
    await svc.process_webhook(payload=_event(order, fake.sessions[0]), signature="good")
    db.tables["marketplace_access_requests"].clear()
    assert (await svc.reconcile())["refunded"] == 1
    assert db.tables["pkm_packet_orders"] == []


async def test_orphan_paid_order_is_refunded_after_grace(world):
    svc, db, fake = world
    db.tables["pkm_packet_orders"] = [
        {
            "id": "o1",
            "status": "paid",
            "access_request_id": None,
            "stripe_payment_intent_id": "pi_9",
            "paid_at": (datetime.now(UTC) - timedelta(hours=2)).isoformat(),
        },
        {
            "id": "o2",
            "status": "paid",
            "access_request_id": None,
            "stripe_payment_intent_id": "pi_8",
            "paid_at": datetime.now(UTC).isoformat(),
        },
    ]
    assert await svc.reconcile() == {"markedRefundable": 1, "refunded": 1}
    assert [o["status"] for o in db.tables["pkm_packet_orders"]] == ["refunded", "paid"]


def test_fee_defaults_to_zero_and_is_capped(monkeypatch):
    assert platform_fee_cents(1000) == 0
    monkeypatch.setenv("PKM_PACKET_PLATFORM_FEE_BPS", "1000")
    assert platform_fee_cents(1000) == 100
    monkeypatch.setenv("PKM_PACKET_PLATFORM_FEE_BPS", "99999")
    assert platform_fee_cents(1000) == 300


def test_live_key_required_in_production(monkeypatch, world):
    monkeypatch.setenv("ENVIRONMENT", "production")
    svc, _, _ = world
    with pytest.raises(PacketOrderError):
        import asyncio

        asyncio.run(svc.create_checkout(buyer_user_id="b", listing_id="npi1-42", packet_id="p1"))


def test_webhook_routing_peek():
    assert (
        webhook_payment_kind(
            b'{"data":{"object":{"metadata":{"payment_kind":"pkm_packet_order"}}}}'
        )
        == "pkm_packet_order"
    )
    assert webhook_payment_kind(b"not json") is None


def test_site_origin_defaults_per_environment(monkeypatch):
    from hushh_mcp.services.pkm_packet_order_service import _stripe_config

    monkeypatch.delenv("HUSSH_SITE_ORIGIN")
    monkeypatch.setenv("ENVIRONMENT", "uat")
    assert _stripe_config()[2] == "https://uat.hushh.ai"
    monkeypatch.setenv("ENVIRONMENT", "development")
    with pytest.raises(PacketOrderError):
        _stripe_config()  # no default outside deployed environments
