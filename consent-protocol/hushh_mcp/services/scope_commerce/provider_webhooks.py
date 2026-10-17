"""Signed event admission and canonical provider-state handlers."""

from __future__ import annotations

import json
from typing import Any

from .domain import MICRO_PER_CENT as _MICRO_PER_CENT
from .provider_contracts import ProviderContext, _operation_id
from .stripe_adapter import CommerceProviderError


class FundingAndDisputeEvents(ProviderContext):
    async def _handle_funding_event(self, event: dict[str, Any], obj: dict[str, Any]) -> None:
        event_type = event["type"]
        if (obj.get("metadata") or {}).get("payment_kind") != "scope_commerce":
            return
        if event.get("account"):
            raise CommerceProviderError("provider_invalid_event")
        if event_type == "checkout.session.async_payment_failed":
            await self._bound_funding_session(obj)
            current = await self.adapter.retrieve("funding", obj["id"])
            if current.get("payment_status") == "paid":
                await self._settle_funding_session(current, event_id=event["id"])
            elif not await self._cancel_failed_funding_session(current):
                raise CommerceProviderError("provider_funding_failure_unconfirmed")
            return
        if event_type == "checkout.session.completed" and obj.get("payment_status") == "unpaid":
            await self._bound_funding_session(obj)
            if obj.get("status") != "complete":
                raise CommerceProviderError("provider_invalid_event")
            # A completed checkout can still await payment. Its bound notice is
            # terminal as an event, while funding awaits an actual paid receipt.
            return
        if event_type.endswith("expired"):
            funding_id = _operation_id((obj.get("metadata") or {}).get("scope_operation_id"))
            current = await self.adapter.retrieve("funding", obj["id"])

            async def binding(connection: Any) -> dict[str, Any] | None:
                row = await connection.fetchrow(
                    "SELECT * FROM scope_commerce_provider_operations WHERE operation_id=$1::uuid",
                    funding_id,
                )
                return dict(row) if row else None

            operation = await self.store._transaction(binding)
            if (
                operation is None
                or operation["kind"] != "funding"
                or operation["provider_id"] != obj["id"]
            ):
                raise CommerceProviderError("provider_invalid_event")
            if current.get("status") == "expired" and current.get("payment_status") != "paid":
                await self.store.expire_funding(funding_id=funding_id)
            return
        await self._settle_funding_session(obj, event_id=event["id"])
        return

    async def _handle_dispute_event(self, event: dict[str, Any], obj: dict[str, Any]) -> None:
        if (
            event.get("account")
            or obj.get("object") != "dispute"
            or obj.get("currency") != "usd"
            or type(obj.get("amount")) is not int
            or not isinstance(obj.get("charge"), str)
        ):
            raise CommerceProviderError("provider_invalid_event")
        charge = await self.adapter.retrieve("charge", obj["charge"])
        if (charge.get("metadata") or {}).get("payment_kind") != "scope_commerce":
            return
        current = await self.adapter.retrieve("dispute", obj["id"])
        if (
            current.get("id") != obj["id"]
            or current.get("charge") != obj["charge"]
            or current.get("currency") != "usd"
            or current.get("amount") != obj["amount"]
            or current.get("livemode") is not self.config.livemode
        ):
            raise CommerceProviderError("provider_invalid_event")
        for listed in current.get("balance_transactions") or []:
            transaction_id = listed if isinstance(listed, str) else listed.get("id")
            if not isinstance(transaction_id, str):
                raise CommerceProviderError("provider_invalid_event")
            transaction = await self.adapter.retrieve("balance_transaction", transaction_id)
            if (
                transaction.get("id") != transaction_id
                or transaction.get("object") != "balance_transaction"
                or transaction.get("currency") != "usd"
                or transaction.get("source") != current["id"]
                or any(type(transaction.get(key)) is not int for key in ("amount", "fee", "net"))
                or transaction["net"] != transaction["amount"] - transaction["fee"]
            ):
                raise CommerceProviderError("provider_dispute_receipt_mismatch")
            await self.store.record_dispute_balance_transaction(
                dispute_id=current["id"],
                charge_id=current["charge"],
                balance_transaction_id=transaction_id,
                amount_micro_usd=transaction["amount"] * _MICRO_PER_CENT,
                fee_micro_usd=transaction["fee"] * _MICRO_PER_CENT,
            )
        if current.get("status") in {"won", "prevented", "warning_closed"}:
            await self.store.release_funding_dispute(charge_id=obj["charge"], dispute_id=obj["id"])
        else:
            await self.store.freeze_funding_dispute(
                charge_id=obj["charge"], dispute_id=obj["id"], amount_cents=obj["amount"]
            )
        return


class AccountAndPaymentEvents(ProviderContext):
    async def _handle_account_event(self, event: dict[str, Any], obj: dict[str, Any]) -> None:
        async def owner(connection: Any) -> str | None:
            return await connection.fetchval(
                "SELECT user_id FROM scope_commerce_seller_accounts WHERE account_id=$1",
                obj.get("id"),
            )

        user_id = await self.store._transaction(owner)
        if user_id:
            await self.seller_status(user_id)
        return

    async def _handle_payment_event(self, event: dict[str, Any], obj: dict[str, Any]) -> None:
        event_type = event["type"]
        metadata = obj.get("metadata") or {}
        if metadata.get("payment_kind") != "scope_commerce":
            return
        operation_id = _operation_id(metadata.get("scope_operation_id"))

        async def read(connection: Any) -> dict[str, Any] | None:
            row = await connection.fetchrow(
                "SELECT * FROM scope_commerce_provider_operations WHERE operation_id=$1::uuid",
                operation_id,
            )
            return dict(row) if row else None

        operation = await self.store._transaction(read)
        if operation is None:
            raise CommerceProviderError("provider_invalid_event")
        request = operation["request_json"]
        request = json.loads(request) if isinstance(request, str) else request
        if metadata != request.get("metadata"):
            raise CommerceProviderError("provider_invalid_event")
        if event_type.startswith("refund."):
            if event.get("account") or operation["kind"] != "refund":
                raise CommerceProviderError("provider_invalid_event")
            refund = await self.adapter.retrieve("refund", obj["id"])
            if (
                refund.get("payment_intent") != request["payment_intent"]
                or refund.get("amount") != request["amount"]
                or refund.get("currency") != "usd"
                or (refund.get("metadata") or {}) != request["metadata"]
                or operation["provider_id"] not in {None, refund["id"]}
            ):
                raise CommerceProviderError("provider_invalid_event")
            await self.store.settle_funding_refund(
                refund_id=operation_id,
                provider_refund_id=refund["id"],
                status=self._refund_state(refund["status"]),
            )
            return
        if event_type.startswith("payout."):
            if operation["kind"] != "payout" or event.get("account") != request["stripe_account"]:
                raise CommerceProviderError("provider_invalid_event")
            payout = await self.adapter.retrieve(
                "payout", obj["id"], account_id=request["stripe_account"]
            )
            if (
                payout.get("amount") != request["amount"]
                or payout.get("currency") != "usd"
                or payout.get("livemode") is not self.config.livemode
                or (payout.get("metadata") or {}) != request["metadata"]
                or operation["provider_id"] not in {None, payout["id"]}
            ):
                raise CommerceProviderError("provider_invalid_event")
            await self._settle_payout(payout, account_id=request["stripe_account"])


class OperatingCapitalEvents(ProviderContext):
    async def _handle_capital_event(self, event: dict[str, Any], obj: dict[str, Any]) -> None:
        tag = "scope_commerce_operating_capital"
        if (obj.get("metadata") or {}).get("payment_kind") != tag:
            return
        if (
            event.get("account")
            or obj.get("object") != "topup"
            or not isinstance(obj.get("id"), str)
        ):
            raise CommerceProviderError("provider_capital_receipt_mismatch")
        current = await self.adapter.retrieve("topup", obj["id"])
        if (
            current.get("id") != obj["id"]
            or current.get("object") != "topup"
            or current.get("currency") != "usd"
            or current.get("livemode") is not self.config.livemode
            or (current.get("metadata") or {}).get("payment_kind") != tag
            or type(current.get("amount")) is not int
            or current["amount"] <= 0
            or current.get("status") not in {"succeeded", "reversed"}
        ):
            raise CommerceProviderError("provider_capital_receipt_mismatch")
        transactions = await self.adapter.balance_transactions(source_id=current["id"])
        for transaction in transactions:
            self._validate_capital_transaction(transaction, current)
        original = current.get("balance_transaction")
        original_id = original if isinstance(original, str) else (original or {}).get("id")
        if not any(t["id"] == original_id and t["type"] == "topup" for t in transactions):
            raise CommerceProviderError("provider_capital_receipt_missing")
        if current["status"] == "reversed" and not any(
            t["type"] == "topup_reversal" for t in transactions
        ):
            raise CommerceProviderError("provider_capital_receipt_missing")
        for transaction in transactions:
            await self.store.record_operating_capital_balance_transaction(
                topup_id=current["id"],
                balance_transaction_id=transaction["id"],
                platform_account_id=self.config.platform_account_id,
                livemode=self.config.livemode,
                currency="usd",
                amount_micro_usd=transaction["amount"] * _MICRO_PER_CENT,
                fee_micro_usd=transaction["fee"] * _MICRO_PER_CENT,
                net_micro_usd=transaction["net"] * _MICRO_PER_CENT,
            )

    @staticmethod
    def _validate_capital_transaction(transaction: dict[str, Any], topup: dict[str, Any]) -> None:
        kind = transaction.get("type")
        expected_amount = topup["amount"] if kind == "topup" else -topup["amount"]
        if (
            transaction.get("object") != "balance_transaction"
            or not isinstance(transaction.get("id"), str)
            or transaction.get("source") != topup["id"]
            or transaction.get("currency") != "usd"
            or transaction.get("status") != "available"
            or kind not in {"topup", "topup_reversal"}
            or any(type(transaction.get(key)) is not int for key in ("amount", "fee", "net"))
            or transaction["amount"] != expected_amount
            or transaction["net"] != transaction["amount"] - transaction["fee"]
            or (kind == "topup" and transaction["fee"] < 0)
        ):
            raise CommerceProviderError("provider_capital_receipt_mismatch")


class VerifiedWebhookHandlers(
    FundingAndDisputeEvents, AccountAndPaymentEvents, OperatingCapitalEvents
):
    async def process_webhook(self, *, payload: bytes, signature: str | None) -> dict[str, str]:
        event = self.adapter.verify_webhook(payload, signature)
        if (
            not isinstance(event.get("id"), str)
            or event.get("livemode") is not self.config.livemode
        ):
            raise CommerceProviderError("provider_invalid_event")
        await self._admit(new_activity=False)
        supported = {
            "checkout.session.completed",
            "checkout.session.async_payment_succeeded",
            "checkout.session.async_payment_failed",
            "checkout.session.expired",
            "refund.updated",
            "refund.created",
            "charge.dispute.created",
            "charge.dispute.closed",
            "account.updated",
            "payout.paid",
            "payout.failed",
            "payout.canceled",
            "topup.succeeded",
            "topup.reversed",
        }
        if event.get("type") not in supported:
            return {"status": "ignored"}

        async def register(connection: Any) -> bool:
            await connection.execute(
                """INSERT INTO scope_commerce_provider_events(event_id,event_type,livemode,status)
                VALUES($1,$2,$3,'received') ON CONFLICT DO NOTHING""",
                event["id"],
                event["type"],
                self.config.livemode,
            )
            row = await connection.fetchrow(
                "SELECT * FROM scope_commerce_provider_events WHERE event_id=$1", event["id"]
            )
            if row["event_type"] != event["type"] or row["livemode"] is not self.config.livemode:
                raise CommerceProviderError("provider_invalid_event")
            return row["status"] == "processed"

        if await self.store._transaction(register):
            return {"status": "duplicate"}
        obj = event.get("data", {}).get("object")
        if not isinstance(obj, dict):
            raise CommerceProviderError("provider_invalid_event")
        await self._apply_event(event, obj)

        async def complete(connection: Any) -> None:
            await connection.execute(
                "UPDATE scope_commerce_provider_events SET status='processed' WHERE event_id=$1",
                event["id"],
            )

        await self.store._transaction(complete)
        return {"status": "processed"}

    async def _apply_event(self, event: dict[str, Any], obj: dict[str, Any]) -> None:
        event_type = event["type"]
        if event_type.startswith("checkout.session."):
            await self._handle_funding_event(event, obj)
        elif event_type.startswith("charge.dispute."):
            await self._handle_dispute_event(event, obj)
        elif event_type == "account.updated":
            await self._handle_account_event(event, obj)
        elif event_type.startswith("topup."):
            await self._handle_capital_event(event, obj)
        else:
            await self._handle_payment_event(event, obj)
