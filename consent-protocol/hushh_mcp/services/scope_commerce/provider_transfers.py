"""Settled-backing transfer delivery and durable transfer reversals."""

from __future__ import annotations

from typing import Any

from .domain import MICRO_PER_CENT as _MICRO_PER_CENT
from .provider_contracts import ProviderContext, _derived_id
from .stripe_adapter import CommerceProviderError


class TransferAdmission(ProviderContext):
    async def _ensure_withdrawal_transfer(
        self,
        *,
        user_id: str | None,
        withdrawal_id: str,
        reservation: dict[str, Any],
        account_id: str,
        metadata: dict[str, str],
    ) -> str:
        amount = reservation["net_cents"]
        platform_balance = await self.adapter.balance()
        available = self._available_usd(platform_balance)
        # Routing fees may debit the platform in addition to principal.
        # The canonical treasury admission protects all customer liabilities
        # plus this reserve against both actual and attributed platform cash.
        await self.store.treasury_check(
            available_micro_usd=available * _MICRO_PER_CENT,
            withdrawal_id=withdrawal_id,
            fee_reserve_micro_usd=reservation["fee_micro_usd"],
        )
        transfer_amount = amount + (reservation["fee_micro_usd"] + 9_999) // 10_000
        request = {
            "amount": transfer_amount,
            "currency": "usd",
            "destination": account_id,
            "transfer_group": f"scope_{withdrawal_id}",
            "metadata": metadata,
        }
        existing = await self._existing_operation(withdrawal_id)
        if existing:
            request = self._saved_request(existing)
            metadata = request["metadata"]
            if request.get("destination") != account_id or request.get("amount") != transfer_amount:
                raise CommerceProviderError("provider_operation_conflict")

        def validate_transfer(transfer: dict[str, Any]) -> None:
            self._validate_object(transfer, object_type="transfer", metadata=metadata)
            if (
                transfer.get("amount") != transfer_amount
                or transfer.get("currency") != "usd"
                or transfer.get("destination") != account_id
                or transfer.get("reversed") is not False
            ):
                raise CommerceProviderError("provider_response_mismatch")

        transfer = await self._run_operation(
            user_id=user_id,
            operation_id=withdrawal_id,
            kind="transfer",
            request=request,
            validate=validate_transfer,
        )
        transfer_id = transfer["id"]
        await self.store.settle_withdrawal(
            withdrawal_id=withdrawal_id, transfer_id=transfer_id, status="transferred"
        )
        return transfer_id

    def _available_usd(self, balance: dict[str, Any]) -> int:
        if balance.get("livemode") is not self.config.livemode:
            raise CommerceProviderError("provider_account_mismatch")
        amounts = [
            row.get("amount")
            for row in balance.get("available", [])
            if row.get("currency") == "usd"
        ]
        if any(type(value) is not int for value in amounts):
            raise CommerceProviderError("provider_invalid_response")
        return sum(amounts)


class TransferDelivery(TransferAdmission):
    async def _deliver_withdrawal(
        self,
        *,
        user_id: str | None,
        withdrawal_id: str,
        reservation: dict[str, Any],
        account_id: str,
    ) -> dict[str, Any]:
        async def disputed(connection: Any) -> bool:
            return await connection.fetchval(
                """SELECT EXISTS(SELECT 1 FROM scope_commerce_withdrawal_allocations w
                JOIN scope_commerce_allocations a USING(purchase_id)
                JOIN scope_commerce_funding_lots f USING(lot_id)
                WHERE w.withdrawal_id=$1::uuid AND f.frozen)""",
                withdrawal_id,
            )

        if await self.store._transaction(disputed):
            # Already-issued payouts reconcile through their durable provider
            # operation; disputed backing never admits another outbound call.
            raise CommerceProviderError("provider_disputed_backing")
        amount = reservation["net_cents"]
        actor_ref = user_id or f"seller:{reservation['seller_id']}"
        metadata = self._metadata(withdrawal_id, actor_ref)
        transfer_id = reservation.get("transfer_id")
        if transfer_id is None:
            transfer_id = await self._ensure_withdrawal_transfer(
                user_id=user_id,
                withdrawal_id=withdrawal_id,
                reservation=reservation,
                account_id=account_id,
                metadata=metadata,
            )
        connected_balance = await self.adapter.balance(account_id=account_id)
        if self._available_usd(connected_balance) < amount:
            return {
                "withdrawalId": withdrawal_id,
                "status": "transferred",
                "transferId": transfer_id,
            }
        return await self._attempt_withdrawal_payout(
            user_id=user_id,
            withdrawal_id=withdrawal_id,
            amount=amount,
            actor_ref=actor_ref,
            account_id=account_id,
            transfer_id=transfer_id,
        )

    async def _reverse_transfer(
        self,
        *,
        user_id: str | None,
        transfer_id: str,
        amount_cents: int,
        operation_id: str,
        withdrawal_id: str | None = None,
        recovery_id: str | None = None,
        dispute_id: str | None = None,
    ) -> dict[str, Any]:
        metadata = self._metadata(operation_id, user_id or f"transfer:{transfer_id}")
        if withdrawal_id is not None:
            metadata["withdrawal_id"] = withdrawal_id
        if recovery_id is not None:
            metadata["recovery_id"] = recovery_id
            metadata["dispute_id"] = dispute_id
        request = {"transfer_id": transfer_id, "amount": amount_cents, "metadata": metadata}
        existing = await self._existing_operation(operation_id)
        if existing:
            request = self._saved_request(existing)
            metadata = request["metadata"]
            if request.get("transfer_id") != transfer_id or request.get("amount") != amount_cents:
                raise CommerceProviderError("provider_operation_conflict")

        def validate(value: dict[str, Any]) -> None:
            self._validate_object(value, object_type="transfer_reversal", metadata=metadata)
            if (
                value.get("transfer") != transfer_id
                or value.get("amount") != amount_cents
                or value.get("currency") != "usd"
            ):
                raise CommerceProviderError("provider_response_mismatch")

        return await self._run_operation(
            user_id=user_id,
            operation_id=operation_id,
            kind="transfer_reversal",
            request=request,
            validate=validate,
        )

    async def _transfer_fee_cents(self, *, transfer_id: str, account_id: str) -> int:
        transfer = await self.adapter.retrieve("transfer", transfer_id)
        transaction_id = transfer.get("balance_transaction")
        if transfer.get("destination") != account_id or not isinstance(transaction_id, str):
            raise CommerceProviderError("provider_payout_receipt_mismatch")
        transaction = await self.adapter.retrieve("balance_transaction", transaction_id)
        if (
            transfer.get("id") != transfer_id
            or transfer.get("object") != "transfer"
            or transfer.get("currency") != "usd"
            or transfer.get("livemode") is not self.config.livemode
            or type(transfer.get("amount")) is not int
        ):
            raise CommerceProviderError("provider_payout_receipt_mismatch")
        self._validate_balance_transaction(
            transaction,
            transaction_id=transaction_id,
            source_id=transfer_id,
            amount_cents=-transfer["amount"],
        )
        return transaction["fee"]

    async def _attempt_withdrawal_payout(
        self,
        *,
        user_id: str | None,
        withdrawal_id: str,
        amount: int,
        actor_ref: str,
        account_id: str,
        transfer_id: str,
    ) -> dict[str, Any]:
        payout_operation = _derived_id(withdrawal_id, "payout")
        payout_metadata = self._metadata(payout_operation, actor_ref)
        payout_metadata["withdrawal_id"] = withdrawal_id
        request = {
            "amount": amount,
            "currency": "usd",
            "method": "standard",
            "metadata": payout_metadata,
            "stripe_account": account_id,
        }
        existing_payout = await self._existing_operation(payout_operation)
        if existing_payout:
            request = self._saved_request(existing_payout)
            payout_metadata = request["metadata"]
            if request.get("stripe_account") != account_id or request.get("amount") != amount:
                raise CommerceProviderError("provider_operation_conflict")

        def validate_payout(payout: dict[str, Any]) -> None:
            self._validate_object(payout, object_type="payout", metadata=payout_metadata)
            if (
                payout.get("amount") != amount
                or payout.get("currency") != "usd"
                or payout.get("livemode") is not self.config.livemode
            ):
                raise CommerceProviderError("provider_response_mismatch")

        payout = await self._run_operation(
            user_id=user_id,
            operation_id=payout_operation,
            kind="payout",
            request=request,
            validate=validate_payout,
        )
        await self._settle_payout(payout, account_id=account_id, transfer_id=transfer_id)
        return {
            "withdrawalId": withdrawal_id,
            "status": payout["status"],
            "transferId": transfer_id,
            "payoutId": payout["id"],
        }
