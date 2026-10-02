"""Owner payouts: hussh pays packet owners their earnings through Stripe Connect.

hussh is the broker. Buyers pay hussh; once a packet is delivered the owner's
earning (amount_cents - platform_fee_cents) becomes 'due', and when the owner's
Stripe Express account can receive payouts hussh transfers it (idempotent per
order). Card orders transfer against the buyer's own charge so the funds are
always there; credit orders are paid from hussh's balance. Migration 268.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlsplit

from db.db_client import get_db
from hushh_mcp.runtime_settings import get_app_runtime_settings
from hushh_mcp.services.pkm_packet_order_service import (
    TABLE as ORDERS,
)
from hushh_mcp.services.pkm_packet_order_service import (
    PacketOrderError,
    _stripe_config,
    _stripe_dict,
)

logger = logging.getLogger(__name__)

ACCOUNTS = "pkm_owner_payout_accounts"


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _earning(order: dict[str, Any]) -> int:
    return max(0, int(order.get("amount_cents") or 0) - int(order.get("platform_fee_cents") or 0))


def _app_origin() -> str:
    origin = get_app_runtime_settings().app_frontend_origin.rstrip("/")
    parsed = urlsplit(origin)
    if parsed.scheme not in {"https", "http"} or not parsed.hostname:
        raise PacketOrderError("PAYMENT_UNAVAILABLE", "Payouts are not available right now.")
    return origin


class PkmPayoutService:
    def __init__(self, *, stripe_api: Any = None) -> None:
        import stripe

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

    async def _account(self, user_id: str) -> dict[str, Any] | None:
        rows = await self._rows(self.db.table(ACCOUNTS).select("*").eq("user_id", user_id).limit(1))
        return rows[0] if rows else None

    # --- owner -------------------------------------------------------------

    async def onboarding_link(self, *, user_id: str) -> dict[str, Any]:
        """Create (once) the owner's Express account and a fresh onboarding link."""
        key, _, _ = _stripe_config()
        origin = _app_origin()
        account = await self._account(user_id)
        if account is None:
            created = _stripe_dict(
                await asyncio.to_thread(
                    self.stripe_api.Account.create,
                    api_key=key,
                    idempotency_key=f"pkm-payout-account:{user_id}",
                    type="express",
                    country="US",
                    capabilities={"transfers": {"requested": True}},
                    metadata={"hussh_user_ref": "pkm_owner"},
                )
            )
            await self._rows(
                self.db.table(ACCOUNTS).insert(
                    {"user_id": user_id, "stripe_account_id": created["id"]}
                )
            )
            account_id = created["id"]
        else:
            account_id = account["stripe_account_id"]
        link = _stripe_dict(
            await asyncio.to_thread(
                self.stripe_api.AccountLink.create,
                api_key=key,
                account=account_id,
                type="account_onboarding",
                refresh_url=f"{origin}/one/marketplace?payouts=refresh",
                return_url=f"{origin}/one/marketplace?payouts=done",
            )
        )
        return {"url": link["url"]}

    async def refresh_account(self, user_id: str) -> dict[str, Any] | None:
        account = await self._account(user_id)
        if account is None:
            return None
        key, _, _ = _stripe_config()
        remote = _stripe_dict(
            await asyncio.to_thread(
                self.stripe_api.Account.retrieve, account["stripe_account_id"], api_key=key
            )
        )
        patch = {
            "details_submitted": bool(remote.get("details_submitted")),
            "payouts_enabled": bool(remote.get("payouts_enabled")),
            "updated_at": _now(),
        }
        await self._rows(self.db.table(ACCOUNTS).update(patch).eq("user_id", user_id))
        return {**account, **patch}

    async def summary(self, *, user_id: str) -> dict[str, Any]:
        account = await self.refresh_account(user_id)
        orders = await self._rows(
            self.db.table(ORDERS).select("*").eq("owner_user_id", user_id).eq("status", "paid")
        )
        totals = {"awaitingDelivery": 0, "due": 0, "paidOut": 0}
        for order in orders:
            state = order.get("owner_earning_status") or "none"
            bucket = {"none": "awaitingDelivery", "due": "due", "transferred": "paidOut"}.get(state)
            if bucket:
                totals[bucket] += _earning(order)
        return {
            "account": None
            if account is None
            else {
                "detailsSubmitted": bool(account.get("details_submitted")),
                "payoutsEnabled": bool(account.get("payouts_enabled")),
            },
            "earningsCents": totals,
            "currency": "USD",
        }

    # --- scheduled ---------------------------------------------------------

    async def mark_delivered_earnings_due(self, *, max_orders: int = 50) -> int:
        """Paid orders whose packet has been delivered become 'due' to the owner."""
        paid = await self._rows(
            self.db.table(ORDERS)
            .select("*")
            .eq("status", "paid")
            .eq("owner_earning_status", "none")
            .limit(max_orders)
        )
        request_ids = [str(o["access_request_id"]) for o in paid if o.get("access_request_id")]
        if not request_ids:
            return 0
        delivered = {
            str(r["id"])
            for r in await self._rows(
                self.db.table("marketplace_access_requests")
                .select("id,latest_envelope_id")
                .in_("id", request_ids)
            )
            if r.get("latest_envelope_id")
        }
        marked = 0
        for order in paid:
            if str(order.get("access_request_id")) in delivered:
                marked += bool(
                    await self._rows(
                        self.db.table(ORDERS)
                        .update({"owner_earning_status": "due", "updated_at": _now()})
                        .eq("id", str(order["id"]))
                        .eq("owner_earning_status", "none")
                    )
                )
        return marked

    async def transfer_due(self, *, max_orders: int = 20) -> int:
        due = await self._rows(
            self.db.table(ORDERS).select("*").eq("owner_earning_status", "due").limit(max_orders)
        )
        if not due:
            return 0
        key, _, _ = _stripe_config()
        accounts = {
            str(a["user_id"]): a
            for a in await self._rows(
                self.db.table(ACCOUNTS)
                .select("*")
                .in_("user_id", list({str(o["owner_user_id"]) for o in due}))
            )
        }
        sent = 0
        for order in due:
            account = accounts.get(str(order["owner_user_id"]))
            if not account or not account.get("payouts_enabled"):
                continue  # stays due until the owner finishes onboarding
            amount = _earning(order)
            order_id = str(order["id"])
            if amount <= 0:
                await self._rows(
                    self.db.table(ORDERS)
                    .update({"owner_earning_status": "void", "updated_at": _now()})
                    .eq("id", order_id)
                )
                continue
            params: dict[str, Any] = {
                "api_key": key,
                "idempotency_key": f"pkm-packet-transfer:{order_id}",
                "amount": amount,
                "currency": "usd",
                "destination": account["stripe_account_id"],
                "transfer_group": f"pkm-order-{order_id}",
                "metadata": {"payment_kind": "pkm_packet_payout", "order_id": order_id},
            }
            try:
                if order.get("payment_method") != "credits" and order.get(
                    "stripe_payment_intent_id"
                ):
                    intent = _stripe_dict(
                        await asyncio.to_thread(
                            self.stripe_api.PaymentIntent.retrieve,
                            order["stripe_payment_intent_id"],
                            api_key=key,
                        )
                    )
                    if intent.get("latest_charge"):
                        params["source_transaction"] = intent["latest_charge"]
                transfer = _stripe_dict(
                    await asyncio.to_thread(self.stripe_api.Transfer.create, **params)
                )
            except Exception:
                logger.exception("pkm_payout.transfer_failed order=%s", order_id)
                continue  # stays due; retried next run
            sent += bool(
                await self._rows(
                    self.db.table(ORDERS)
                    .update(
                        {
                            "owner_earning_status": "transferred",
                            "stripe_transfer_id": transfer.get("id"),
                            "transferred_at": _now(),
                            "updated_at": _now(),
                        }
                    )
                    .eq("id", order_id)
                    .eq("owner_earning_status", "due")
                )
            )
        return sent
