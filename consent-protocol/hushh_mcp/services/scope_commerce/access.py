"""Access capability; composed by the canonical commerce transaction host."""

from __future__ import annotations

import hashlib
import json
from uuid import UUID

from .domain import (
    MICRO_PER_CENT,
    CommerceError,
    account,
    public,
)


class CommercialAccess:
    async def lookup_by_request(self, request_id, conn=None):
        async def operation(c):
            row = await self._row(
                c, "SELECT * FROM scope_commerce_purchases WHERE request_id=$1", request_id
            )
            return public(row) if row else None

        return await self._transaction(operation, conn)

    async def lookup_by_consent_token(self, token, conn=None):
        digest = hashlib.sha256(token.encode()).hexdigest()

        async def operation(c):
            row = await self._row(
                c,
                "SELECT *,clock_timestamp() AS admission_now FROM scope_commerce_purchases WHERE consent_token_hash=$1",
                digest,
            )
            if row and await c.fetchval(
                "SELECT EXISTS(SELECT 1 FROM scope_commerce_allocations a JOIN scope_commerce_funding_lots f USING(lot_id) WHERE a.purchase_id=$1 AND f.frozen)",
                row["purchase_id"],
            ):
                result = {k: v for k, v in row.items() if k != "staged_export"}
                result["status"] = "payment_disputed"
                return result
            return {k: v for k, v in row.items() if k != "staged_export"} if row else None

        return await self._transaction(operation, conn)

    async def request_status(self, request_id, buyer_app_id):
        purchase = await self.lookup_by_request(request_id)
        if purchase:
            if purchase["buyerAppId"] != buyer_app_id:
                raise CommerceError("request_unavailable")
            return await self.access_state(
                purchase_id=purchase["purchaseId"], buyer_app_id=buyer_app_id
            )
        return await self.get_quote_by_request(request_id, buyer_app_id)

    async def access_state(self, *, purchase_id, buyer_app_id, conn=None):
        async def operation(c):
            p = await self._row(
                c,
                "SELECT * FROM scope_commerce_purchases WHERE purchase_id=$1 AND buyer_app_id=$2",
                UUID(str(purchase_id)),
                buyer_app_id,
            )
            if not p or p["erased_at"]:
                raise CommerceError("purchase_unavailable")
            result = public(p)
            if await c.fetchval(
                "SELECT EXISTS(SELECT 1 FROM scope_commerce_allocations a JOIN scope_commerce_funding_lots f USING(lot_id) WHERE a.purchase_id=$1 AND f.frozen)",
                p["purchase_id"],
            ):
                result["status"] = "payment_disputed"
            if result["status"] == "active":
                try:
                    await self._registered_key(c, p)
                except CommerceError:
                    result["status"] = "access_blocked"
                if result["status"] == "active":
                    grant = await c.fetchrow(
                        "SELECT token_id,metadata FROM consent_audit WHERE request_id=$1 AND action='CONSENT_GRANTED' AND metadata->>'commerce_purchase_id'=$2 ORDER BY issued_at DESC LIMIT 1",
                        p["request_id"],
                        str(p["purchase_id"]),
                    )
                    from hushh_mcp.consent.paid_admission import paid_grant_is_admitted

                    metadata = (
                        json.loads(grant["metadata"])
                        if grant and isinstance(grant["metadata"], str)
                        else dict(grant["metadata"])
                        if grant
                        else {}
                    )
                    if not grant or not await paid_grant_is_admitted(
                        grant["token_id"], metadata, connection=c
                    ):
                        result["status"] = "access_blocked"
            result["accessAllowed"] = result["status"] == "active"
            return result

        return await self._transaction(operation, conn)

    async def get_purchase(self, *, purchase_id, viewer_user_id, conn=None):
        async def operation(c):
            p = await self._row(
                c,
                "SELECT * FROM scope_commerce_purchases WHERE purchase_id=$1 AND (owner_user_id=$2 OR payer_user_id=$2)",
                UUID(str(purchase_id)),
                viewer_user_id,
            )
            if not p:
                raise CommerceError("purchase_unavailable")
            return await self.access_state(
                purchase_id=p["purchase_id"], buyer_app_id=p["buyer_app_id"], conn=c
            )

        return await self._transaction(operation, conn)

    async def balance(self, *, payer_user_id, buyer_app_id="shared", conn=None):
        async def operation(c):
            wallet = await c.fetchrow(
                "SELECT wallet_id FROM scope_commerce_wallets WHERE payer_user_id=$1 AND buyer_app_id='shared' AND erased_at IS NULL",
                payer_user_id,
            )
            if not wallet:
                return {
                    "balanceCents": 0,
                    "reservedCents": 0,
                    "frozenCents": 0,
                    "fundingLots": [],
                    "currency": "usd",
                }
            values = {
                kind: await self._amount(c, account(kind, wallet["wallet_id"]))
                for kind in ("wallet_available", "wallet_reserved", "wallet_frozen")
            }
            lots = await c.fetch(
                """SELECT source.funding_id,source.gross_micro_usd,source.refunded_micro_usd,
                source.refund_reserved_micro_usd,source.frozen,source.created_at,
                GREATEST(0,LEAST(credit.available_micro_usd,source.gross_micro_usd
                    -source.refunded_micro_usd-source.refund_reserved_micro_usd)) AS available_micro_usd
                FROM scope_commerce_funding_lots source
                CROSS JOIN LATERAL (
                    SELECT COALESCE(sum(child.available_micro_usd),0) AS available_micro_usd
                    FROM scope_commerce_funding_lots child
                    WHERE child.lot_id=source.lot_id OR child.source_lot_id=source.lot_id
                ) credit
                WHERE source.wallet_id=$1 AND source.payment_intent_id IS NOT NULL
                ORDER BY (NOT source.frozen AND LEAST(credit.available_micro_usd,
                    source.gross_micro_usd-source.refunded_micro_usd-source.refund_reserved_micro_usd)
                    >=10000) DESC,source.created_at DESC,source.lot_id DESC LIMIT 100""",
                wallet["wallet_id"],
            )
            projected = [
                {
                    "fundingId": str(lot["funding_id"]),
                    "amountCents": lot["gross_micro_usd"] // MICRO_PER_CENT,
                    "unusedCents": lot["available_micro_usd"] // MICRO_PER_CENT,
                    "refundedCents": lot["refunded_micro_usd"] // MICRO_PER_CENT,
                    "refundReservedCents": lot["refund_reserved_micro_usd"] // MICRO_PER_CENT,
                    "frozen": lot["frozen"],
                    "createdAt": lot["created_at"].isoformat(),
                }
                for lot in lots
            ]
            return {
                "balanceCents": values["wallet_available"] // MICRO_PER_CENT,
                "reservedCents": values["wallet_reserved"] // MICRO_PER_CENT,
                "frozenCents": values["wallet_frozen"] // MICRO_PER_CENT,
                "fundingLots": projected,
                "currency": "usd",
            }

        return await self._transaction(operation, conn)
