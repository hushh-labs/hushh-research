"""Bounded read projections of canonical financial records; no bootstrap or I/O."""

from datetime import datetime
from typing import Any
from urllib.parse import urlencode

from .activity_cursor import decode_cursor, encode_cursor
from .cost_review import read_negative_net_review
from .domain import MICRO_PER_CENT, CommerceError, account, integer


def scope_label(machine_scope: str) -> str:
    return " / ".join(
        part.replace("_", " ")
        for part in machine_scope.removeprefix("attr.").split(".")
        if part != "*"
    )


def iso(value: datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


class CommerceActivity:
    async def _counterpart_metadata(self, c, user_id, fallback):
        if user_id and await c.fetchval("SELECT to_regclass('marketplace_public_profiles')"):
            label = await c.fetchval(
                "SELECT display_name FROM marketplace_public_profiles WHERE user_id=$1 AND is_discoverable",
                user_id,
            )
            if label:
                return {"label": " ".join(str(label).split())[:160]}
        return {"label": fallback}

    async def activity(
        self,
        *,
        viewer_user_id: str,
        view: str = "transactions",
        cursor: str | None = None,
        limit: int = 25,
        conn: Any = None,
    ) -> dict[str, Any]:
        if view not in {"purchases", "sales", "transactions"}:
            raise CommerceError("invalid_activity_view")
        integer(limit, 1, 100, "invalid_activity_limit")
        boundary = decode_cursor(cursor, viewer_user_id, view)

        async def operation(c):
            rows = await c.fetch(
                """WITH entries AS (
                 SELECT 'purchase'::text AS kind,purchase_id AS id,created_at
                 FROM scope_commerce_purchases WHERE erased_at IS NULL AND
                 (($2='purchases' AND payer_user_id=$1) OR ($2='sales' AND owner_user_id=$1)
                  OR ($2='transactions' AND (payer_user_id=$1 OR owner_user_id=$1)))
                 UNION ALL SELECT 'funding',f.funding_id,f.created_at FROM scope_commerce_fundings f
                 JOIN scope_commerce_wallets w USING(wallet_id) WHERE $2='transactions' AND w.payer_user_id=$1 AND w.erased_at IS NULL
                 UNION ALL SELECT 'refund',o.obligation_id,o.created_at FROM scope_commerce_obligations o
                 JOIN scope_commerce_wallets w USING(wallet_id) WHERE $2='transactions' AND o.kind='source_refund' AND w.payer_user_id=$1 AND w.erased_at IS NULL
                 UNION ALL SELECT 'withdrawal',withdrawal_id,created_at FROM scope_commerce_withdrawals
                 WHERE $2='transactions' AND user_id=$1)
                SELECT * FROM entries WHERE $3::timestamptz IS NULL OR (created_at,kind,id)<($3::timestamptz,$4::text,$5::uuid)
                ORDER BY created_at DESC,kind DESC,id DESC LIMIT $6""",
                viewer_user_id,
                view,
                *(boundary or (None, None, None)),
                limit + 1,
            )
            items = [
                await self._activity_item(c, row, viewer_user_id, view) for row in rows[:limit]
            ]
            return {
                "items": items,
                "next_cursor": encode_cursor(rows[limit - 1], viewer_user_id, view)
                if len(rows) > limit
                else None,
            }

        return await self._transaction(operation, conn)

    async def _activity_item(self, c, reference, viewer, view):
        item = {
            "id": str(reference["id"]),
            "kind": reference["kind"],
            "created_at": iso(reference["created_at"]),
            "request_id": None,
            "purchase_id": None,
            "counterpart": None,
            "scope_label": None,
            "machine_scope": None,
            "scope_handle": None,
            "activation_at": None,
            "expires_at": None,
            "matures_at": None,
            "fulfillment_deadline": None,
            "processing_fee_micro_usd": None,
            "net_earnings_micro_usd": None,
            "refunded_cents": None,
            "currency": "USD",
            "next_action": {"label": "Review payments", "href": "/one/profile/account"},
        }
        if reference["kind"] == "purchase":
            return await self._purchase_activity(c, reference, viewer, view, item)
        return await self._payment_activity(c, reference, item)

    async def _purchase_activity(self, c, reference, viewer, view, item):
        p = await self._row(
            c, "SELECT * FROM scope_commerce_purchases WHERE purchase_id=$1", reference["id"]
        )
        state = await self.access_state(
            purchase_id=p["purchase_id"], buyer_app_id=p["buyer_app_id"], conn=c
        )
        seller = view == "sales" or (view == "transactions" and p["owner_user_id"] == viewer)
        counterpart = await self._counterpart_metadata(
            c,
            p["payer_user_id"] if seller else p["owner_user_id"],
            "Requester" if seller else "Information owner",
        )
        item.update(
            {
                "kind": "sale" if seller else "purchase",
                "direction": "incoming" if seller else "outgoing",
                "status": state["status"],
                "request_id": p["request_id"],
                "purchase_id": str(p["purchase_id"]),
                "counterpart": counterpart,
                "scope_label": scope_label(p["machine_scope"]),
                "machine_scope": p["machine_scope"],
                "scope_handle": p["scope_handle"],
                "gross_cents": p["price_cents"],
                "amount_cents": p["price_cents"],
                "processing_fee_micro_usd": state["processingFeeMicroUsd"],
                "net_earnings_micro_usd": state["netEarningsMicroUsd"],
                "refunded_cents": p["refunded_cents"],
                "activation_at": iso(p["activation_at"]),
                "expires_at": iso(p["expires_at"]),
                "matures_at": iso(p["earnings_settled_at"] or p["expires_at"]),
                "fulfillment_deadline": iso(p["fulfillment_deadline"]),
                "next_action": {
                    "label": "Prepare encrypted information"
                    if seller and p["status"] in {"reserved", "preparing"}
                    else "Review sharing",
                    "href": "/one/consent?" + urlencode({"commerceRequestId": p["request_id"]}),
                },
            }
        )
        return item

    async def _payment_activity(self, c, reference, item):
        if reference["kind"] == "funding":
            row = await self._row(
                c, "SELECT * FROM scope_commerce_fundings WHERE funding_id=$1", reference["id"]
            )
            amount, direction = row["amount_cents"], "incoming"
        elif reference["kind"] == "refund":
            row = await self._row(
                c,
                "SELECT * FROM scope_commerce_obligations WHERE obligation_id=$1",
                reference["id"],
            )
            amount, direction = row["amount_micro_usd"] // MICRO_PER_CENT, "incoming"
        else:
            row = await self._row(
                c,
                "SELECT * FROM scope_commerce_withdrawals WHERE withdrawal_id=$1",
                reference["id"],
            )
            amount, direction = row["net_cents"], "outgoing"
            fee = (
                row["fee_micro_usd"]
                if row["settled_micro_usd"] is None
                else row["settled_micro_usd"]
                - (amount * MICRO_PER_CENT if row["status"] == "succeeded" else 0)
            )
            item.update(
                {"processing_fee_micro_usd": fee, "net_earnings_micro_usd": amount * MICRO_PER_CENT}
            )
        item.update(
            {
                "status": row["status"],
                "gross_cents": row.get("gross_micro_usd", amount * MICRO_PER_CENT)
                // MICRO_PER_CENT,
                "amount_cents": amount,
                "direction": direction,
            }
        )
        return item

    async def request_review(
        self, *, request_id: str, viewer_user_id: str, conn: Any = None
    ) -> dict[str, Any]:
        async def operation(c):
            purchase = await self._row(
                c,
                "SELECT * FROM scope_commerce_purchases WHERE request_id=$1 AND (owner_user_id=$2 OR payer_user_id=$2)",
                request_id,
                viewer_user_id,
            )
            wallet = await c.fetchrow(
                "SELECT wallet_id FROM scope_commerce_wallets WHERE payer_user_id=$1 AND erased_at IS NULL",
                viewer_user_id,
            )
            available = (
                await self._amount(c, account("wallet_available", wallet["wallet_id"]))
                if wallet
                else 0
            )
            if not purchase:
                return {
                    "available_balance_cents": available // MICRO_PER_CENT,
                    "shortfall_cents": 0,
                    "negative_net_acknowledgement": None,
                }
            deadline = await c.fetchval(
                "SELECT request_deadline FROM scope_commerce_quotes WHERE quote_id=$1",
                purchase["quote_id"],
            )
            owner = purchase["owner_user_id"] == viewer_user_id
            counterpart = await self._counterpart_metadata(
                c,
                purchase["payer_user_id"] if owner else purchase["owner_user_id"],
                "Requester" if owner else "Information owner",
            )
            return {
                "scope_label": scope_label(purchase["machine_scope"]),
                "counterpart_label": counterpart["label"],
                "recipient_label": "Requester’s private agent"
                if purchase["buyer_app_id"] == "agent_one"
                else "Registered application " + purchase["buyer_app_id"],
                "available_balance_cents": available // MICRO_PER_CENT,
                "shortfall_cents": max(0, purchase["price_cents"] - available // MICRO_PER_CENT)
                if purchase["status"] == "awaiting_payment" and not owner
                else 0,
                "request_deadline": iso(deadline),
                "negative_net_acknowledgement": await read_negative_net_review(c, purchase)
                if owner
                and purchase["status"] in {"reserved", "preparing", "staged"}
                and purchase["earnings_settled_at"] is None
                else None,
            }

        return await self._transaction(operation, conn)
