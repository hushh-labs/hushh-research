"""Buying a PKM packet: the buyer pays hussh, the owner still decides.

hussh is the broker. A buyer pays hussh's Stripe account through Checkout for
one packet on a verified White Pages listing. The signed webhook marks the order
paid and files a marketplace access request; the owner approves or denies it
like any other. A denied or expired request, or an account deletion before
delivery, is refunded in full. Migration 266.

platform_fee_cents is hussh's share, PKM_PACKET_PLATFORM_FEE_BPS basis points of
the price, 0 by default. The owner's earning (amount - fee) is paid out in a
later step; nothing here moves money to an owner.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import quote, urlsplit
from uuid import uuid4

import stripe

from db.db_client import get_db
from hushh_mcp.services.directory_claim_service import DirectoryClaimService, normalize_listing_id
from hushh_mcp.services.marketplace_request_service import MarketplaceRequestService

logger = logging.getLogger(__name__)

TABLE = "pkm_packet_orders"
PAYMENT_KIND = "pkm_packet_order"
CHECKOUT_TTL = timedelta(hours=24)
MAX_FEE_BPS = 3000
REFUNDABLE_REQUEST_STATUSES = {"denied", "expired"}
ORPHAN_PAID_GRACE = timedelta(hours=1)
SITE_ORIGIN_BY_ENV = {"production": "https://www.hushh.ai", "uat": "https://uat.hushh.ai"}


class PacketOrderError(ValueError):
    """Stable code + a message safe to show the buyer."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _now() -> datetime:
    return datetime.now(UTC)


def _str(value: Any) -> str | None:
    return None if value is None else str(value)


def _stripe_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else value.to_dict()


def platform_fee_cents(amount_cents: int) -> int:
    try:
        bps = int(os.getenv("PKM_PACKET_PLATFORM_FEE_BPS") or 0)
    except ValueError:
        bps = 0
    bps = max(0, min(bps, MAX_FEE_BPS))
    return amount_cents * bps // 10_000


def _stripe_config() -> tuple[str, str, str]:
    """Secret key, webhook secret and the hussh.ai origin buyers return to.

    Live keys only in production, test keys everywhere else; the return origin
    must be https except for a local dev server.
    """
    key = (os.getenv("STRIPE_SECRET_KEY") or "").strip()
    webhook_secret = (os.getenv("STRIPE_WEBHOOK_SECRET") or "").strip()
    env = {
        (os.getenv("ENVIRONMENT") or "").strip().lower(),
        (os.getenv("HUSSH_DEPLOY_ENV") or "").strip().lower(),
    }
    # hussh.ai origin buyers return to; defaults per deployed environment so
    # no extra deploy variable is needed.
    default_origin = (
        SITE_ORIGIN_BY_ENV["production"]
        if "production" in env
        else SITE_ORIGIN_BY_ENV["uat"]
        if "uat" in env
        else ""
    )
    origin = (os.getenv("HUSSH_SITE_ORIGIN") or default_origin).strip().rstrip("/")
    expected = "sk_live_" if "production" in env else "sk_test_"
    parsed = urlsplit(origin)
    local = parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1"}
    if (
        not key.startswith(expected)
        or len(key) < 24
        or not webhook_secret.startswith("whsec_")
        or not parsed.hostname
        or (parsed.scheme != "https" and not (local and "production" not in env))
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise PacketOrderError("PAYMENT_UNAVAILABLE", "Payments are not available right now.")
    return key, webhook_secret, origin


def _row_to_order(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": _str(row.get("id")),
        "listingId": row.get("listing_id"),
        "packetTitle": row.get("packet_title"),
        "amountCents": row.get("amount_cents"),
        "currency": row.get("currency") or "USD",
        "status": row.get("status"),
        "accessRequestId": _str(row.get("access_request_id")),
        "createdAt": _str(row.get("created_at")),
        "paidAt": _str(row.get("paid_at")),
        "refundedAt": _str(row.get("refunded_at")),
    }


class PkmPacketOrderService:
    def __init__(self, *, stripe_api: Any = None) -> None:
        self._db = None
        self.stripe_api = stripe_api or stripe
        self._requests = MarketplaceRequestService()
        self._claims = DirectoryClaimService()

    @property
    def db(self):
        if self._db is None:
            self._db = get_db()
        return self._db

    def _bind(self, db: Any) -> None:
        """Share one DB handle across the services this flow writes through."""
        self._db = db
        self._requests._db = db
        self._claims._db = db

    async def _rows(self, query) -> list[dict[str, Any]]:
        result = await asyncio.to_thread(query.execute)
        return getattr(result, "data", None) or []

    async def _order(self, order_id: str) -> dict[str, Any] | None:
        rows = await self._rows(self.db.table(TABLE).select("*").eq("id", order_id).limit(1))
        return rows[0] if rows else None

    async def _transition(self, order_id: str, from_status: str, patch: dict[str, Any]) -> bool:
        """Conditional update: only one concurrent caller wins a transition."""
        rows = await self._rows(
            self.db.table(TABLE)
            .update({**patch, "updated_at": _now().isoformat()})
            .eq("id", order_id)
            .eq("status", from_status)
        )
        return bool(rows)

    # --- buyer ------------------------------------------------------------

    async def _purchasable(
        self, *, buyer_user_id: str, listing_id: Any, packet_id: Any
    ) -> tuple[str, str, str, dict[str, Any]]:
        """(listing, packet_ref, owner, packet) for a for-sale packet on a verified
        listing the buyer does not own; otherwise PacketOrderError."""
        listing = normalize_listing_id(listing_id)
        packet_ref = str(packet_id or "").strip()
        if not packet_ref or len(packet_ref) > 64:
            raise PacketOrderError("PACKET_UNAVAILABLE", "This packet is not for sale.")

        owner = (await self._claims.verified_owners([listing])).get(listing)
        if not owner:
            raise PacketOrderError("PACKET_UNAVAILABLE", "This packet is not for sale.")
        if owner == buyer_user_id:
            raise PacketOrderError("OWN_PACKET", "You can't buy your own packet.")
        packets = await self._rows(
            self.db.table("pkm_packets")
            .select("*")
            .eq("id", packet_ref)
            .eq("owner_user_id", owner)
            .eq("for_sale", True)
            .limit(1)
        )
        if not packets or packets[0].get("price_cents") is None:
            raise PacketOrderError("PACKET_UNAVAILABLE", "This packet is not for sale.")
        return listing, packet_ref, owner, packets[0]

    async def create_checkout(
        self, *, buyer_user_id: str, listing_id: Any, packet_id: Any
    ) -> dict[str, Any]:
        key, _, origin = _stripe_config()
        listing, packet_ref, owner, packet = await self._purchasable(
            buyer_user_id=buyer_user_id, listing_id=listing_id, packet_id=packet_id
        )

        open_rows = await self._rows(
            self.db.table(TABLE)
            .select("*")
            .eq("buyer_user_id", buyer_user_id)
            .eq("packet_id", packet_ref)
            .eq("status", "awaiting_payment")
        )
        for row in open_rows:
            # A checkout from the last 24 hours is reused; an older one is closed
            # so the partial unique index lets a fresh one through.
            created = datetime.fromisoformat(str(row.get("created_at")))
            if created.tzinfo is None:
                created = created.replace(tzinfo=UTC)
            session_id = row.get("stripe_checkout_session_id")
            if _now() - created < CHECKOUT_TTL and session_id:
                session = _stripe_dict(
                    await asyncio.to_thread(
                        self.stripe_api.checkout.Session.retrieve, session_id, api_key=key
                    )
                )
                if session.get("status") == "open" and session.get("url"):
                    return {"orderId": _str(row["id"]), "checkoutUrl": session["url"]}
            await self._transition(str(row["id"]), "awaiting_payment", {"status": "expired"})

        amount = int(packet["price_cents"])
        inserted = await self._rows(
            self.db.table(TABLE).insert(
                {
                    "buyer_user_id": buyer_user_id,
                    "owner_user_id": owner,
                    "packet_id": packet_ref,
                    "listing_id": listing,
                    "packet_title": packet["title"],
                    "amount_cents": amount,
                    "platform_fee_cents": platform_fee_cents(amount),
                    "status": "awaiting_payment",
                }
            )
        )
        if not inserted:
            raise PacketOrderError("PAYMENT_UNAVAILABLE", "Payments are not available right now.")
        order_id = str(inserted[0]["id"])
        back = f"{origin}/marketplace/white-pages/purchase?order={quote(order_id)}"
        session = _stripe_dict(
            await asyncio.to_thread(
                self.stripe_api.checkout.Session.create,
                api_key=key,
                idempotency_key=f"pkm-packet-order:{order_id}",
                mode="payment",
                client_reference_id=order_id,
                line_items=[
                    {
                        "quantity": 1,
                        "price_data": {
                            "currency": "usd",
                            "unit_amount": amount,
                            "product_data": {"name": f"{packet['title']} · hussh packet"},
                        },
                    }
                ],
                metadata={"payment_kind": PAYMENT_KIND, "order_id": order_id},
                payment_intent_data={
                    "metadata": {"payment_kind": PAYMENT_KIND, "order_id": order_id}
                },
                success_url=f"{back}&checkout=success",
                cancel_url=f"{back}&checkout=cancel",
                expires_at=int((_now() + CHECKOUT_TTL - timedelta(minutes=5)).timestamp()),
            )
        )
        await self._rows(
            self.db.table(TABLE)
            .update({"stripe_checkout_session_id": session["id"], "updated_at": _now().isoformat()})
            .eq("id", order_id)
        )
        logger.info("pkm_packet_order.checkout_created order=%s", order_id)
        return {"orderId": order_id, "checkoutUrl": session["url"]}

    async def buy_with_credits(
        self, *, buyer_user_id: str, listing_id: Any, packet_id: Any
    ) -> dict[str, Any]:
        """Spend credits first under a fresh order id, then record the order as
        paid. If recording fails the credits are given back. Never touches an
        open card checkout for the same packet."""
        from hushh_mcp.services.pkm_credit_service import PkmCreditService

        listing, packet_ref, owner, packet = await self._purchasable(
            buyer_user_id=buyer_user_id, listing_id=listing_id, packet_id=packet_id
        )
        cost = packet.get("credit_cost")
        if not cost:
            raise PacketOrderError("NO_CREDIT_PRICE", "This packet can't be bought with credits.")
        credits = PkmCreditService()
        credits._db = self.db
        order_id = str(uuid4())
        if not await credits.spend(user_id=buyer_user_id, cost=int(cost), ref=order_id):
            raise PacketOrderError(
                "NOT_ENOUGH_CREDITS", "You don't have enough credits for this packet."
            )
        amount = int(packet["price_cents"])
        try:
            inserted = await self._rows(
                self.db.table(TABLE).insert(
                    {
                        "id": order_id,
                        "buyer_user_id": buyer_user_id,
                        "owner_user_id": owner,
                        "packet_id": packet_ref,
                        "listing_id": listing,
                        "packet_title": packet["title"],
                        "amount_cents": amount,
                        "platform_fee_cents": platform_fee_cents(amount),
                        "status": "paid",
                        "paid_at": _now().isoformat(),
                        "payment_method": "credits",
                        "credits_spent": int(cost),
                    }
                )
            )
            if not inserted:
                raise RuntimeError("order not recorded")
            await self._file_request(inserted[0])
        except Exception:
            await credits.refund(user_id=buyer_user_id, credits=int(cost), ref=order_id)
            logger.exception("pkm_packet_order.credits_order_failed")
            raise PacketOrderError(
                "PAYMENT_UNAVAILABLE", "Couldn't complete the purchase. Your credits were returned."
            ) from None
        logger.info("pkm_packet_order.paid_with_credits order=%s", order_id)
        return {"orderId": order_id, "status": "paid"}

    async def _file_request(self, order: dict[str, Any]) -> None:
        request = await self._requests.create_request(
            owner_user_id=str(order["owner_user_id"]),
            buyer_user_id=str(order["buyer_user_id"]),
            buyer_label="Paid packet buyer",
            slice_label=str(order["packet_title"]),
            domain="pkm_packet",
            scope_handle=f"packet:{order['packet_id']}",
            price_cents=int(order["amount_cents"]),
        )
        await self._rows(
            self.db.table(TABLE)
            .update({"access_request_id": request.get("id"), "updated_at": _now().isoformat()})
            .eq("id", str(order["id"]))
        )

    async def get_order(self, *, buyer_user_id: str, order_id: str) -> dict[str, Any] | None:
        rows = await self._rows(
            self.db.table(TABLE)
            .select("*")
            .eq("id", order_id)
            .eq("buyer_user_id", buyer_user_id)
            .limit(1)
        )
        return _row_to_order(rows[0]) if rows else None

    # --- Stripe ------------------------------------------------------------

    async def process_webhook(self, *, payload: bytes, signature: str | None) -> None:
        _, webhook_secret, _ = _stripe_config()
        try:
            event = _stripe_dict(
                self.stripe_api.Webhook.construct_event(payload, signature, webhook_secret)
            )
        except (ValueError, stripe.error.SignatureVerificationError):
            raise PacketOrderError("INVALID_SIGNATURE", "Invalid payment signature.") from None
        session = event.get("data", {}).get("object", {}) or {}
        from hushh_mcp.services.pkm_credit_service import PkmCreditService, credits_metadata

        if credits_metadata(session) or is_subscription_event(str(event.get("type") or "")):
            credit_service = PkmCreditService(stripe_api=self.stripe_api)
            credit_service._db = self.db
            await credit_service.handle_event(event)
            return
        metadata = session.get("metadata") or {}
        if (
            metadata.get("payment_kind") != PAYMENT_KIND
            or session.get("object") != "checkout.session"
        ):
            return
        order_id = str(metadata.get("order_id") or "")
        order = await self._order(order_id) if order_id else None
        if order is None or session.get("id") != order.get("stripe_checkout_session_id"):
            raise PacketOrderError("UNMATCHED_EVENT", "Payment event could not be matched.")

        kind = event.get("type")
        if kind == "checkout.session.expired":
            await self._transition(order_id, "awaiting_payment", {"status": "expired"})
            return
        if kind not in {"checkout.session.completed", "checkout.session.async_payment_succeeded"}:
            return
        if (
            session.get("payment_status") != "paid"
            or session.get("client_reference_id") != order_id
            or int(session.get("amount_total") or -1) != int(order["amount_cents"])
            or str(session.get("currency") or "").lower() != "usd"
        ):
            raise PacketOrderError("UNMATCHED_EVENT", "Payment event could not be matched.")

        won = await self._transition(
            order_id,
            "awaiting_payment",
            {
                "status": "paid",
                "paid_at": _now().isoformat(),
                "stripe_payment_intent_id": _str(session.get("payment_intent")),
            },
        )
        if not won:
            return  # already settled by an earlier delivery of this event
        await self._file_request(order)
        logger.info("pkm_packet_order.paid order=%s", order_id)

    # --- refunds -------------------------------------------------------------

    async def mark_refundable(self, *, max_orders: int = 50) -> int:
        """Paid orders whose request the owner denied or let expire, or whose
        request no longer exists (an account was deleted), become refund_pending."""
        paid = await self._rows(
            self.db.table(TABLE).select("*").eq("status", "paid").limit(max_orders)
        )
        request_ids = [str(r["access_request_id"]) for r in paid if r.get("access_request_id")]
        statuses: dict[str, str] = {}
        if request_ids:
            for row in await self._rows(
                self.db.table("marketplace_access_requests")
                .select("id,status")
                .in_("id", request_ids)
            ):
                statuses[str(row["id"])] = str(row.get("status"))
        marked = 0
        for order in paid:
            request_id = _str(order.get("access_request_id"))
            if request_id is None:
                # Paid but no request filed. Give the webhook an hour, then refund
                # rather than hold a buyer's money for a request that never came.
                paid_at = datetime.fromisoformat(str(order.get("paid_at") or _now().isoformat()))
                if paid_at.tzinfo is None:
                    paid_at = paid_at.replace(tzinfo=UTC)
                if _now() - paid_at > ORPHAN_PAID_GRACE:
                    marked += await self._transition(
                        str(order["id"]), "paid", {"status": "refund_pending"}
                    )
                continue
            status = statuses.get(request_id)
            if status is None or status in REFUNDABLE_REQUEST_STATUSES:
                marked += await self._transition(
                    str(order["id"]), "paid", {"status": "refund_pending"}
                )
        return marked

    async def refund_pending(self, *, max_orders: int = 20) -> int:
        key, _, _ = _stripe_config()
        pending = await self._rows(
            self.db.table(TABLE).select("*").eq("status", "refund_pending").limit(max_orders)
        )
        refunded = 0
        for order in pending:
            order_id = str(order["id"])
            if order.get("payment_method") == "credits":
                # Paid in credits, refunded in credits (once, by ledger uniqueness).
                from hushh_mcp.services.pkm_credit_service import PkmCreditService

                credit_service = PkmCreditService()
                credit_service._db = self.db
                await credit_service.refund(
                    user_id=str(order["buyer_user_id"]),
                    credits=int(order["credits_spent"]),
                    ref=order_id,
                )
                refunded += await self._transition(
                    order_id,
                    "refund_pending",
                    {"status": "refunded", "refunded_at": _now().isoformat()},
                )
                continue
            intent = order.get("stripe_payment_intent_id")
            if not intent:
                logger.warning("pkm_packet_order.refund_without_intent order=%s", order_id)
                continue
            try:
                refund = _stripe_dict(
                    await asyncio.to_thread(
                        self.stripe_api.Refund.create,
                        api_key=key,
                        payment_intent=intent,
                        idempotency_key=f"pkm-packet-refund:{order_id}",
                        metadata={"payment_kind": PAYMENT_KIND, "order_id": order_id},
                    )
                )
            except Exception:
                logger.exception("pkm_packet_order.refund_failed order=%s", order_id)
                continue
            done = await self._transition(
                order_id,
                "refund_pending",
                {
                    "status": "refunded",
                    "refunded_at": _now().isoformat(),
                    "stripe_refund_id": refund.get("id"),
                },
            )
            refunded += done
            if done and order.get("access_request_id"):
                still_there = await self._rows(
                    self.db.table("marketplace_access_requests")
                    .select("id")
                    .eq("id", str(order["access_request_id"]))
                    .limit(1)
                )
                if not still_there:
                    # The request went with a deleted account; drop the settled record too.
                    await self._rows(self.db.table(TABLE).delete().eq("id", order_id))
        return refunded

    async def reconcile(self) -> dict[str, int]:
        marked = await self.mark_refundable()
        refunded = await self.refund_pending()
        return {"markedRefundable": marked, "refunded": refunded}


def webhook_payment_kind(payload: bytes) -> str | None:
    """Peek at an (as yet unverified) event's payment_kind to route it. Looks at
    Checkout sessions and at invoices/subscriptions (both API shapes). The chosen
    handler still verifies the signature before acting on anything."""
    try:
        obj = (json.loads(payload).get("data") or {}).get("object") or {}
        for meta in (
            obj.get("metadata"),
            ((obj.get("parent") or {}).get("subscription_details") or {}).get("metadata"),
            (obj.get("subscription_details") or {}).get("metadata"),
        ):
            if isinstance(meta, dict) and meta.get("payment_kind"):
                return str(meta["payment_kind"])
        return None
    except (ValueError, AttributeError):
        return None


def is_subscription_event(event_type: str) -> bool:
    """Invoice and subscription events belong to credits plans; Drive never uses them."""
    return event_type.startswith(("invoice.", "customer.subscription."))


def webhook_event_type(payload: bytes) -> str:
    try:
        return str(json.loads(payload).get("type") or "")
    except (ValueError, AttributeError):
        return ""
