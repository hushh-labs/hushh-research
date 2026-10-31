"""Verified bank-payout receipts, actual fees and principal return settlement."""

from __future__ import annotations

from typing import Any

from .domain import MICRO_PER_CENT as _MICRO_PER_CENT
from .provider_contracts import ProviderContext, _derived_id, _operation_id
from .stripe_adapter import CommerceProviderError


class PayoutReceiptValidator(ProviderContext):
    @staticmethod
    def _validate_balance_transaction(
        value: dict[str, Any],
        *,
        transaction_id: str,
        source_id: str,
        amount_cents: int,
        nonnegative_fee: bool = True,
    ) -> None:
        if (
            value.get("id") != transaction_id
            or value.get("object") != "balance_transaction"
            or value.get("currency") != "usd"
            or value.get("source") != source_id
            or any(type(value.get(key)) is not int for key in ("amount", "fee", "net"))
            or value["amount"] != amount_cents
            or value["net"] != value["amount"] - value["fee"]
            or (nonnegative_fee and value["fee"] < 0)
        ):
            raise CommerceProviderError("provider_payout_receipt_mismatch")

    async def _failed_payout_fee_cents(self, payout: dict[str, Any], *, account_id: str) -> int:
        original_id = payout.get("balance_transaction")
        failure_id = payout.get("failure_balance_transaction")
        if (
            not isinstance(original_id, str)
            or not isinstance(failure_id, str)
            or original_id == failure_id
        ):
            raise CommerceProviderError("provider_payout_receipt_unavailable")
        original = await self.adapter.retrieve(
            "balance_transaction", original_id, account_id=account_id
        )
        returned = await self.adapter.retrieve(
            "balance_transaction", failure_id, account_id=account_id
        )
        self._validate_balance_transaction(
            original,
            transaction_id=original_id,
            source_id=payout["id"],
            amount_cents=-payout["amount"],
        )
        self._validate_balance_transaction(
            returned,
            transaction_id=failure_id,
            source_id=payout["id"],
            amount_cents=payout["amount"],
            nonnegative_fee=False,
        )
        retained = -(original["net"] + returned["net"])
        if retained < 0:
            raise CommerceProviderError("provider_payout_receipt_mismatch")
        return retained

    async def _payout_withdrawal(
        self, payout: dict[str, Any], *, account_id: str, transfer_id: str | None
    ) -> tuple[dict[str, Any], str]:
        withdrawal_id = _operation_id((payout.get("metadata") or {}).get("withdrawal_id"))

        async def read(connection: Any) -> dict[str, Any] | None:
            row = await connection.fetchrow(
                "SELECT * FROM scope_commerce_withdrawals WHERE withdrawal_id=$1::uuid",
                withdrawal_id,
            )
            return dict(row) if row else None

        withdrawal = await self.store._transaction(read)
        if (
            withdrawal is None
            or type(payout.get("amount")) is not int
            or payout.get("object") != "payout"
            or payout.get("currency") != "usd"
            or payout.get("livemode") is not self.config.livemode
            or withdrawal.get("account_id") != account_id
            or withdrawal.get("net_cents") != payout.get("amount")
            or withdrawal.get("payout_id") not in {None, payout.get("id")}
        ):
            raise CommerceProviderError("provider_payout_receipt_mismatch")
        transfer_id = transfer_id or withdrawal.get("transfer_id")
        if not transfer_id:
            raise CommerceProviderError("provider_payout_receipt_mismatch")
        return withdrawal, transfer_id


class PayoutReceiptSettlement(PayoutReceiptValidator):
    async def _settle_payout(
        self, payout: dict[str, Any], *, account_id: str, transfer_id: str | None = None
    ) -> None:
        withdrawal, transfer_id = await self._payout_withdrawal(
            payout, account_id=account_id, transfer_id=transfer_id
        )
        withdrawal_id = str(withdrawal["withdrawal_id"])
        actual_fee = retained_payout_fee = 0
        if payout.get("status") == "paid":
            actual_fee = await self._settle_successful_payout_cost(
                payout,
                withdrawal=withdrawal,
                withdrawal_id=withdrawal_id,
                transfer_id=transfer_id,
                account_id=account_id,
            )
        state = {"paid": "succeeded", "failed": "failed", "canceled": "failed"}.get(
            payout.get("status"), "payout_pending"
        )
        if state == "failed":
            if withdrawal["status"] != "failed":
                await self.store.settle_withdrawal(
                    withdrawal_id=withdrawal_id,
                    transfer_id=transfer_id,
                    payout_id=payout["id"],
                    status="unknown",
                )
            retained_payout_fee = await self._failed_payout_fee_cents(payout, account_id=account_id)
            actual_fee = (
                retained_payout_fee
                + await self._transfer_fee_cents(transfer_id=transfer_id, account_id=account_id)
            ) * _MICRO_PER_CENT
        await self.store.settle_withdrawal(
            withdrawal_id=withdrawal_id,
            transfer_id=transfer_id,
            payout_id=payout["id"],
            status=state,
            actual_fee_micro_usd=actual_fee,
            retained_payout_fee_micro_usd=retained_payout_fee * _MICRO_PER_CENT,
        )
        if state == "failed":
            await self._return_failed_payout_principal(
                payout,
                withdrawal=withdrawal,
                withdrawal_id=withdrawal_id,
                transfer_id=transfer_id,
                retained_payout_fee=retained_payout_fee,
                actual_fee=actual_fee,
            )

    async def _settle_successful_payout_cost(
        self,
        payout: dict[str, Any],
        *,
        withdrawal: dict[str, Any],
        withdrawal_id: str,
        transfer_id: str,
        account_id: str,
    ) -> int:
        transaction_id = payout.get("balance_transaction")
        if not isinstance(transaction_id, str):
            raise CommerceProviderError("provider_payout_receipt_unavailable")
        transaction = await self.adapter.retrieve(
            "balance_transaction", transaction_id, account_id=account_id
        )
        self._validate_balance_transaction(
            transaction,
            transaction_id=transaction_id,
            source_id=payout["id"],
            amount_cents=-payout["amount"],
        )
        routing_fee = await self._transfer_fee_cents(transfer_id=transfer_id, account_id=account_id)
        actual_fee = (transaction["fee"] + routing_fee) * _MICRO_PER_CENT
        # Restore backing before releasing unused fee reserves to the ledger.
        # If provider reversal is unavailable, leave earnings held for recovery.
        reserve_cents = (withdrawal["fee_micro_usd"] + 9_999) // 10_000
        unused_fee_cents = max(0, reserve_cents - transaction["fee"])
        if unused_fee_cents:
            await self._reverse_transfer(
                user_id=withdrawal["user_id"],
                transfer_id=transfer_id,
                amount_cents=unused_fee_cents,
                operation_id=_derived_id(withdrawal_id, "unused_payout_fee"),
                withdrawal_id=withdrawal_id,
            )
        return actual_fee

    async def _return_failed_payout_principal(
        self,
        payout: dict[str, Any],
        *,
        withdrawal: dict[str, Any],
        withdrawal_id: str,
        transfer_id: str,
        retained_payout_fee: int,
        actual_fee: int,
    ) -> None:
        if withdrawal["status"] == "failed":
            return

        async def overlap(connection: Any) -> bool:
            return await connection.fetchval(
                """SELECT EXISTS(SELECT 1 FROM scope_commerce_transfer_recoveries
                WHERE withdrawal_id=$1::uuid AND recovered_micro_usd>0)""",
                withdrawal_id,
            )

        if await self.store._transaction(overlap):
            raise CommerceProviderError("provider_payout_recovery_overlap")
        operation_id = _derived_id(withdrawal_id, "failed_payout_reversal")
        existing = await self._existing_operation(operation_id)
        if existing:
            reverse_cents = self._saved_request(existing)["amount"]
        else:

            async def returned(connection: Any) -> int:
                return await connection.fetchval(
                    """SELECT COALESCE(sum((request_json->>'amount')::bigint),0)::bigint
                    FROM scope_commerce_provider_operations WHERE kind='transfer_reversal'
                    AND status='succeeded' AND request_json->>'transfer_id'=$1
                    AND request_json->'metadata'->>'withdrawal_id'=$2""",
                    transfer_id,
                    withdrawal_id,
                )

            prior_returned = await self.store._transaction(returned)
            reverse_cents = max(
                0,
                payout["amount"]
                + (withdrawal["fee_micro_usd"] + 9_999) // 10_000
                - retained_payout_fee
                - prior_returned,
            )
        if reverse_cents:
            await self._reverse_transfer(
                user_id=withdrawal["user_id"],
                transfer_id=transfer_id,
                amount_cents=reverse_cents,
                operation_id=operation_id,
                withdrawal_id=withdrawal_id,
            )
        await self.store.settle_withdrawal(
            withdrawal_id=withdrawal_id,
            transfer_id=transfer_id,
            payout_id=payout["id"],
            status="reversed",
            actual_fee_micro_usd=actual_fee,
            retained_payout_fee_micro_usd=retained_payout_fee * _MICRO_PER_CENT,
        )
