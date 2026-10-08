"""Authenticated funding, verified funding receipts and original-source refunds."""

from __future__ import annotations

import json
from typing import Any
from urllib.parse import urlencode

from .domain import MICRO_PER_CENT as _MICRO_PER_CENT
from .provider_contracts import ProviderContext, _derived_id, _hosted_url, _opaque, _operation_id
from .provider_sandbox import reserve_reviewer_funding
from .stripe_adapter import CommerceProviderError


class FundingCheckout(ProviderContext):
    async def _customer(self, user_id: str) -> str:
        async def read(connection: Any) -> dict[str, Any] | None:
            row = await connection.fetchrow(
                "SELECT * FROM scope_commerce_stripe_customers WHERE user_id=$1", user_id
            )
            return dict(row) if row is not None else None

        saved = await self.store._transaction(read)
        if saved is not None:
            if saved["livemode"] is not self.config.livemode:
                raise CommerceProviderError("provider_account_mismatch")
            return saved["customer_id"]
        operation_id = _derived_id(user_id, "customer")
        metadata = self._metadata(operation_id, user_id)
        response = await self._run_operation(
            user_id=user_id,
            operation_id=operation_id,
            kind="customer",
            request={"metadata": metadata},
            validate=lambda value: self._validate_object(
                value, object_type="customer", metadata=metadata
            ),
        )

        async def bind(connection: Any) -> None:
            await connection.execute(
                """INSERT INTO scope_commerce_stripe_customers(user_id,customer_id,livemode)
                VALUES($1,$2,$3) ON CONFLICT(user_id) DO NOTHING""",
                user_id,
                response["id"],
                self.config.livemode,
            )
            row = await connection.fetchrow(
                "SELECT customer_id,livemode FROM scope_commerce_stripe_customers WHERE user_id=$1",
                user_id,
            )
            if row["customer_id"] != response["id"] or row["livemode"] is not self.config.livemode:
                raise CommerceProviderError("provider_account_mismatch")

        await self.store._transaction(bind)
        return response["id"]

    async def funding_checkout(
        self,
        *,
        payer_user_id: str,
        buyer_app_id: str | None,
        amount_cents: int,
        operation_id: str,
    ) -> dict[str, Any]:
        if type(amount_cents) is not int or not 50 <= amount_cents <= 100_000:
            raise CommerceProviderError("funding_amount_invalid")
        operation_id = _operation_id(operation_id)
        await self._admit()
        parameters = dict(
            payer_user_id=payer_user_id,
            buyer_app_id=buyer_app_id,
            funding_id=operation_id,
            amount_cents=amount_cents,
        )
        if self.config.sandbox_policy is not None:
            await reserve_reviewer_funding(self.store, self.config.sandbox_policy, **parameters)
        else:
            await self.store.reserve_funding(**parameters)
        customer = await self._customer(payer_user_id)
        metadata = self._metadata(operation_id, payer_user_id)
        metadata["buyer_app_ref"] = _opaque(buyer_app_id or "person")
        return_path = (
            self.config.frontend_origin
            + self.config.return_path
            + "?"
            + urlencode({"commerceAttemptId": operation_id, "commerceReturn": "1"})
        )
        request = {
            "mode": "payment",
            "customer": customer,
            "client_reference_id": operation_id,
            "metadata": metadata,
            "payment_intent_data": {"metadata": metadata},
            "allowed_payment_method_types": ["card", "link"],
            "line_items": [
                {
                    "price_data": {
                        "currency": "usd",
                        "unit_amount": amount_cents,
                        "product_data": {"name": "Information access balance"},
                    },
                    "quantity": 1,
                }
            ],
            "success_url": return_path,
            "cancel_url": return_path,
        }

        def validate(session: dict[str, Any]) -> None:
            self._validate_object(session, object_type="checkout.session", metadata=metadata)
            if (
                session.get("mode") != "payment"
                or session.get("customer") != customer
                or session.get("client_reference_id") != operation_id
                or session.get("amount_total") != amount_cents
                or session.get("currency") != "usd"
                or session.get("livemode") is not self.config.livemode
                or not _hosted_url(session.get("url"), {"checkout.stripe.com"})
            ):
                raise CommerceProviderError("provider_response_mismatch")

        session = await self._run_operation(
            user_id=payer_user_id,
            operation_id=operation_id,
            kind="funding",
            request=request,
            validate=validate,
        )
        return {"fundingId": operation_id, "checkoutUrl": session["url"], "status": "checkout_open"}


class FundingReceipt(ProviderContext):
    async def _bound_funding_session(self, session: dict[str, Any]) -> dict[str, Any]:
        metadata = session.get("metadata") or {}
        operation_id = _operation_id(metadata.get("scope_operation_id"))

        async def read(connection: Any) -> dict[str, Any] | None:
            row = await connection.fetchrow(
                "SELECT * FROM scope_commerce_provider_operations WHERE operation_id=$1::uuid",
                operation_id,
            )
            return dict(row) if row else None

        operation = await self.store._transaction(read)
        if operation is None or operation["kind"] != "funding":
            raise CommerceProviderError("provider_invalid_event")
        request = operation["request_json"]
        request = json.loads(request) if isinstance(request, str) else request
        amount = request["line_items"][0]["price_data"]["unit_amount"]
        if (
            session.get("object") != "checkout.session"
            or session.get("id") != operation["provider_id"]
            or session.get("mode") != "payment"
            or session.get("amount_total") != amount
            or type(session.get("amount_total")) is not int
            or session.get("currency") != "usd"
            or session.get("customer") != request["customer"]
            or session.get("client_reference_id") != operation_id
            or session.get("livemode") is not self.config.livemode
            or metadata != request["metadata"]
        ):
            raise CommerceProviderError("provider_invalid_event")
        return operation

    async def _cancel_failed_funding_session(self, session: dict[str, Any]) -> bool:
        operation = await self._bound_funding_session(session)
        if session.get("status") != "complete" or session.get("payment_status") != "unpaid":
            return False
        intent_id = session.get("payment_intent")
        if not isinstance(intent_id, str):
            return False
        intent = await self.adapter.retrieve("payment_intent", intent_id)
        if (
            intent.get("object") != "payment_intent"
            or intent.get("id") != intent_id
            or intent.get("amount") != session["amount_total"]
            or type(intent.get("amount")) is not int
            or intent.get("currency") != "usd"
            or intent.get("customer") != session["customer"]
            or intent.get("metadata") != session["metadata"]
            or intent.get("livemode") is not self.config.livemode
        ):
            raise CommerceProviderError("provider_invalid_event")
        if type(intent.get("amount_received")) is not int or intent["amount_received"] != 0:
            return False
        failed = intent.get("status") == "canceled" or (
            intent.get("status") == "requires_payment_method"
            and bool(intent.get("last_payment_error"))
        )
        if not failed:
            return False
        # The checkout is closed and the exact intent has received no funds.
        # A later success is handled by the existing frozen-funding recovery.
        await self.store.cancel_funding(funding_id=str(operation["operation_id"]))
        return True

    async def _settle_funding_session(self, session: dict[str, Any], *, event_id: str) -> None:
        operation = await self._bound_funding_session(session)
        if (
            session.get("payment_status") != "paid"
            or session.get("status") != "complete"
            or not isinstance(session.get("payment_intent"), str)
        ):
            raise CommerceProviderError("provider_invalid_event")
        metadata, amount = session["metadata"], session["amount_total"]
        operation_id = str(operation["operation_id"])
        receipt = await self.adapter.funding_receipt(
            session["payment_intent"],
            expected={
                "metadata": metadata,
                "amount_cents": amount,
                "customer_id": session["customer"],
                "livemode": self.config.livemode,
            },
        )

        # App ownership was checked when reserving the persisted funding row.
        # Never reconstruct authority from provider-supplied metadata.
        async def app(connection: Any) -> str | None:
            return await connection.fetchval(
                """SELECT w.buyer_app_id FROM scope_commerce_fundings f
                JOIN scope_commerce_wallets w ON w.wallet_id=f.wallet_id WHERE f.funding_id=$1::uuid""",
                operation_id,
            )

        buyer_app_id = await self.store._transaction(app)
        await self.store.settle_funding(
            payer_user_id=operation["user_id"],
            buyer_app_id=buyer_app_id,
            funding_id=operation_id,
            payment_intent_id=receipt.payment_intent_id,
            charge_id=receipt.charge_id,
            provider_event_id=event_id,
            amount_cents=receipt.amount_cents,
            fee_micro_usd=receipt.fee_micro_usd,
            balance_transaction_id=receipt.balance_transaction_id,
            livemode=receipt.livemode,
        )


class SourceRefundAccess(ProviderContext):
    async def refund_unused_funding(
        self,
        *,
        payer_user_id: str,
        buyer_app_id: str | None,
        funding_id: str,
        amount_cents: int,
        operation_id: str,
    ) -> dict[str, Any]:
        if type(amount_cents) is not int or amount_cents < 1:
            raise CommerceProviderError("refund_amount_invalid")
        await self._admit(new_activity=False)
        operation_id, funding_id = _operation_id(operation_id), _operation_id(funding_id)

        # Validate delegated payer authority even on a refund/rollback path.
        async def payer(connection: Any) -> None:
            await self.store._wallet(connection, payer_user_id, buyer_app_id, lock=True)

        await self.store._transaction(payer)
        reservation = await self.store.reserve_funding_refund(
            user_id=payer_user_id,
            funding_id=funding_id,
            refund_id=operation_id,
            amount_cents=amount_cents,
        )
        metadata = self._metadata(operation_id, payer_user_id)
        request = {
            "payment_intent": reservation["payment_intent_id"],
            "amount": amount_cents,
            "metadata": metadata,
        }

        def validate(refund: dict[str, Any]) -> None:
            self._validate_object(refund, object_type="refund", metadata=metadata)
            if (
                refund.get("payment_intent") != request["payment_intent"]
                or refund.get("amount") != amount_cents
                or refund.get("currency") != "usd"
            ):
                raise CommerceProviderError("provider_response_mismatch")

        refund = await self._run_operation(
            user_id=payer_user_id,
            operation_id=operation_id,
            kind="refund",
            request=request,
            validate=validate,
            before_create=self._ensure_refund_backing,
        )
        await self.store.settle_funding_refund(
            refund_id=operation_id,
            provider_refund_id=refund["id"],
            status=self._refund_state(refund["status"]),
        )
        return {"refundId": operation_id, "status": refund["status"]}

    async def _ensure_refund_backing(self) -> None:
        # Recovery of an existing provider receipt remains available during a
        # shortfall. A new cash debit must preserve every reserved liability.
        available = self._available_usd(await self.adapter.balance())
        await self.store.treasury_check(available_micro_usd=available * _MICRO_PER_CENT)

    async def preview_source_refund(
        self,
        *,
        payer_user_id: str,
        funding_id: str,
        amount_cents: int,
    ) -> dict[str, Any]:
        funding_id = _operation_id(funding_id)
        if type(amount_cents) is not int or amount_cents < 1:
            raise CommerceProviderError("refund_amount_invalid")

        async def preview(connection: Any) -> dict[str, Any]:
            row = await connection.fetchrow(
                """SELECT l.gross_micro_usd,l.refunded_micro_usd,l.refund_reserved_micro_usd,l.frozen,
                (SELECT COALESCE(sum(child.available_micro_usd),0) FROM scope_commerce_funding_lots child
                 WHERE child.lot_id=l.lot_id OR child.source_lot_id=l.lot_id) AS available_micro_usd
                FROM scope_commerce_funding_lots l
                JOIN scope_commerce_wallets w ON w.wallet_id=l.wallet_id
                WHERE l.funding_id=$1::uuid AND w.payer_user_id=$2""",
                funding_id,
                payer_user_id,
            )
            available = (
                max(
                    0,
                    min(
                        int(row["available_micro_usd"]),
                        row["gross_micro_usd"]
                        - row["refunded_micro_usd"]
                        - row["refund_reserved_micro_usd"],
                    ),
                )
                if row
                else 0
            )
            eligible = (
                row is not None
                and not row["frozen"]
                and amount_cents * _MICRO_PER_CENT <= available
            )
            return {
                "eligible": eligible,
                "availableCents": available // _MICRO_PER_CENT,
                "blockReason": None if eligible else "funding_not_refundable",
            }

        return await self.store._transaction(preview)
