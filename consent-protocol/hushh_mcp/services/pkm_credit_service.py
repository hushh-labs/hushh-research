"""Credits plans: buyers subscribe monthly and spend credits on packets.

Three plans, billed monthly through Stripe Checkout (subscription mode) on
hussh's account. Each paid invoice grants the plan's credits once and expires
whatever was left (pkm_grant_credits, migration 267). Spending and refunds go
through the ledger; the balance is the sum of its rows.

The owner of a packet bought with credits still earns the packet's dollar
price; hussh funds it from subscription revenue (payout is a later step).
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime
from typing import Any

import stripe

from db.db_client import get_db
from hushh_mcp.services.pkm_packet_order_service import (
    PacketOrderError,
    _stripe_config,
    _stripe_dict,
)

logger = logging.getLogger(__name__)

PAYMENT_KIND = "pkm_credits"
PLANS: dict[str, dict[str, Any]] = {
    "starter": {"label": "Starter", "price_cents": 999, "credits": 10},
    "professional": {"label": "Professional", "price_cents": 4900, "credits": 60},
    "enterprise": {"label": "Enterprise", "price_cents": 9900, "credits": 150},
}
GRANTING_BILLING_REASONS = {"subscription_create", "subscription_cycle", "subscription_update"}
LIVE_STATUSES = {"active", "past_due"}


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _iso(ts: Any) -> str | None:
    try:
        return datetime.fromtimestamp(int(ts), UTC).isoformat()
    except (TypeError, ValueError):
        return None


def credits_metadata(obj: dict[str, Any]) -> dict[str, Any]:
    """Our metadata on a Checkout session, subscription or invoice (both API shapes)."""
    for candidate in (
        obj.get("metadata"),
        ((obj.get("parent") or {}).get("subscription_details") or {}).get("metadata"),
        (obj.get("subscription_details") or {}).get("metadata"),
    ):
        if isinstance(candidate, dict) and candidate.get("payment_kind") == PAYMENT_KIND:
            return candidate
    return {}


def _plan_list() -> list[dict[str, Any]]:
    return [
        {"id": key, "label": p["label"], "priceCents": p["price_cents"], "credits": p["credits"]}
        for key, p in PLANS.items()
    ]


class PkmCreditService:
    def __init__(self, *, stripe_api: Any = None) -> None:
        self._db = None
        self.stripe_api = stripe_api or stripe

    @property
    def db(self):
        if self._db is None:
            self._db = get_db()
        return self._db

    async def _rows(self, query) -> list[dict[str, Any]]:
        result = await asyncio.to_thread(query.execute)
        return getattr(result, "data", None) or []

    async def _rpc(self, fn: str, params: dict[str, Any]) -> Any:
        result = await asyncio.to_thread(self.db.rpc, fn, params)
        rows = getattr(result, "data", None) or []
        return rows[0].get(fn) if rows else None

    # --- balance + plan ----------------------------------------------------

    async def balance(self, user_id: str) -> int:
        rows = await self._rows(
            self.db.table("pkm_credit_ledger").select("delta").eq("user_id", user_id)
        )
        return sum(int(r.get("delta") or 0) for r in rows)

    async def summary(self, user_id: str) -> dict[str, Any]:
        subs = await self._rows(
            self.db.table("pkm_credit_subscriptions").select("*").eq("user_id", user_id).limit(1)
        )
        sub = subs[0] if subs else None
        return {
            "balance": await self.balance(user_id),
            "subscription": None
            if sub is None
            else {
                "plan": sub.get("plan"),
                "status": sub.get("status"),
                "cancelAtPeriodEnd": bool(sub.get("cancel_at_period_end")),
                "currentPeriodEnd": None
                if sub.get("current_period_end") is None
                else str(sub.get("current_period_end")),
            },
            "plans": _plan_list(),
        }

    async def spend(self, *, user_id: str, cost: int, ref: str) -> bool:
        return bool(
            await self._rpc(
                "pkm_spend_credits", {"p_user": user_id, "p_cost": int(cost), "p_ref": ref}
            )
        )

    async def refund(self, *, user_id: str, credits: int, ref: str) -> None:
        """Give credits back for a refunded order. Unique (user, 'refund', ref) makes it once-only."""
        existing = await self._rows(
            self.db.table("pkm_credit_ledger")
            .select("id")
            .eq("user_id", user_id)
            .eq("reason", "refund")
            .eq("ref", ref)
            .limit(1)
        )
        if not existing:
            await self._rows(
                self.db.table("pkm_credit_ledger").insert(
                    {"user_id": user_id, "delta": int(credits), "reason": "refund", "ref": ref}
                )
            )

    # --- subscribe / cancel --------------------------------------------------

    async def create_subscription_checkout(self, *, user_id: str, plan: str) -> dict[str, Any]:
        key, _, origin = _stripe_config()
        chosen = PLANS.get(plan)
        if chosen is None:
            raise PacketOrderError("UNKNOWN_PLAN", "Pick Starter, Professional or Enterprise.")
        subs = await self._rows(
            self.db.table("pkm_credit_subscriptions")
            .select("status")
            .eq("user_id", user_id)
            .limit(1)
        )
        if subs and subs[0].get("status") in LIVE_STATUSES:
            raise PacketOrderError("ALREADY_SUBSCRIBED", "You already have a credits plan.")
        metadata = {"payment_kind": PAYMENT_KIND, "user_id": user_id, "plan": plan}
        back = f"{origin}/marketplace/white-pages/credits"
        session = _stripe_dict(
            await asyncio.to_thread(
                self.stripe_api.checkout.Session.create,
                api_key=key,
                mode="subscription",
                client_reference_id=user_id,
                line_items=[
                    {
                        "quantity": 1,
                        "price_data": {
                            "currency": "usd",
                            "unit_amount": chosen["price_cents"],
                            "recurring": {"interval": "month"},
                            "product_data": {"name": f"hussh credits · {chosen['label']}"},
                        },
                    }
                ],
                metadata=metadata,
                subscription_data={"metadata": metadata},
                success_url=f"{back}?checkout=success",
                cancel_url=f"{back}?checkout=cancel",
            )
        )
        return {"checkoutUrl": session["url"]}

    async def cancel_at_period_end(self, *, user_id: str) -> bool:
        key, _, _ = _stripe_config()
        subs = await self._rows(
            self.db.table("pkm_credit_subscriptions").select("*").eq("user_id", user_id).limit(1)
        )
        if (
            not subs
            or subs[0].get("status") not in LIVE_STATUSES
            or not subs[0].get("stripe_subscription_id")
        ):
            return False
        await asyncio.to_thread(
            self.stripe_api.Subscription.modify,
            subs[0]["stripe_subscription_id"],
            api_key=key,
            cancel_at_period_end=True,
        )
        await self._rows(
            self.db.table("pkm_credit_subscriptions")
            .update({"cancel_at_period_end": True, "updated_at": _now()})
            .eq("user_id", user_id)
        )
        return True

    # --- Stripe events (signature already verified by the caller) ----------

    async def _upsert_subscription(self, user_id: str, patch: dict[str, Any]) -> None:
        existing = await self._rows(
            self.db.table("pkm_credit_subscriptions")
            .select("user_id")
            .eq("user_id", user_id)
            .limit(1)
        )
        if existing:
            await self._rows(
                self.db.table("pkm_credit_subscriptions")
                .update({**patch, "updated_at": _now()})
                .eq("user_id", user_id)
            )
        else:
            await self._rows(
                self.db.table("pkm_credit_subscriptions").insert({"user_id": user_id, **patch})
            )

    async def _metadata(self, obj: dict[str, Any]) -> dict[str, Any]:
        """Our metadata for an event object. Older Stripe API versions (the UAT
        endpoint is pinned to 2022-08-01) send invoices without the subscription's
        metadata, so fall back to reading it from the subscription itself."""
        meta = credits_metadata(obj)
        if meta or obj.get("object") != "invoice":
            return meta
        sub_id = obj.get("subscription") or (
            ((obj.get("parent") or {}).get("subscription_details") or {}).get("subscription")
        )
        if not sub_id:
            return {}
        key, _, _ = _stripe_config()
        sub = _stripe_dict(
            await asyncio.to_thread(self.stripe_api.Subscription.retrieve, str(sub_id), api_key=key)
        )
        return credits_metadata(sub)

    async def handle_event(self, event: dict[str, Any]) -> None:
        kind = str(event.get("type") or "")
        obj = event.get("data", {}).get("object", {}) or {}
        meta = await self._metadata(obj)
        user_id, plan = str(meta.get("user_id") or ""), str(meta.get("plan") or "")
        if not user_id or plan not in PLANS:
            return

        if kind == "checkout.session.completed" and obj.get("mode") == "subscription":
            await self._upsert_subscription(
                user_id,
                {
                    "plan": plan,
                    "status": "active",
                    "stripe_customer_id": obj.get("customer"),
                    "stripe_subscription_id": obj.get("subscription"),
                },
            )
        elif kind == "invoice.paid":
            if (
                obj.get("billing_reason") not in GRANTING_BILLING_REASONS
                or int(obj.get("amount_paid") or 0) <= 0
            ):
                return
            granted = await self._rpc(
                "pkm_grant_credits",
                {
                    "p_user": user_id,
                    "p_credits": PLANS[plan]["credits"],
                    "p_ref": str(obj.get("id")),
                },
            )
            period_end = None
            lines = (obj.get("lines") or {}).get("data") or []
            if lines:
                period_end = _iso(((lines[0] or {}).get("period") or {}).get("end"))
            await self._upsert_subscription(
                user_id,
                {
                    "plan": plan,
                    "status": "active",
                    **({"current_period_end": period_end} if period_end else {}),
                },
            )
            logger.info("pkm_credits.invoice_paid granted=%s", bool(granted))
        elif kind in {"customer.subscription.updated", "customer.subscription.deleted"}:
            status = "canceled" if kind.endswith("deleted") else str(obj.get("status") or "")
            if status not in {"incomplete", "active", "past_due", "canceled"}:
                status = "canceled" if status in {"unpaid", "incomplete_expired"} else "active"
            await self._upsert_subscription(
                user_id,
                {
                    "plan": plan,
                    "status": status,
                    "stripe_subscription_id": obj.get("id"),
                    "cancel_at_period_end": bool(obj.get("cancel_at_period_end")),
                },
            )

    # --- account deletion --------------------------------------------------

    async def cancel_deleted_subscriptions(self, *, max_jobs: int = 20) -> int:
        """Cancel at Stripe every subscription whose owner deleted their account."""
        rows = await self._rows(
            self.db.table("pkm_credit_subscription_cancellations").select("*").limit(max_jobs)
        )
        if not rows:
            return 0
        key, _, _ = _stripe_config()
        done = 0
        for row in rows:
            sub_id = str(row["stripe_subscription_id"])
            try:
                await asyncio.to_thread(self.stripe_api.Subscription.cancel, sub_id, api_key=key)
            except stripe.error.InvalidRequestError:
                pass  # already cancelled or gone at Stripe
            except Exception:
                logger.exception("pkm_credits.cancel_failed")
                continue
            await self._rows(
                self.db.table("pkm_credit_subscription_cancellations")
                .delete()
                .eq("stripe_subscription_id", sub_id)
            )
            done += 1
        return done
