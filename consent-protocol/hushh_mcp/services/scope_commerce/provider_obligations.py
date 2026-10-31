"""Drain reserved source refunds and attributable transfer recovery obligations."""

from __future__ import annotations

from typing import Any

from .domain import MICRO_PER_CENT as _MICRO_PER_CENT
from .domain import CommerceError
from .provider_contracts import ProviderContext
from .stripe_adapter import CommerceProviderError


class TransferRecovery(ProviderContext):
    async def _drain_transfer_recoveries(self, *, limit: int) -> int:
        """Recover only attributable, still reversible connected-account funds.

        Cash already paid to a bank is not manufactured as recovered credit.
        Unavailable amounts remain durable recovery obligations for operations.
        """

        async def pending(connection: Any) -> list[str]:
            rows = await connection.fetch(
                """SELECT substring(idempotency_key from 10) AS dispute_id
                FROM scope_commerce_obligations WHERE kind='recovery'
                AND idempotency_key LIKE 'recovery:%' AND status<>'succeeded'
                AND next_check_at<=clock_timestamp()
                ORDER BY next_check_at,obligation_id LIMIT $1""",
                max(1, min(limit, 20)),
            )
            return [row["dispute_id"] for row in rows]

        completed = attempted = 0
        for dispute_id in await self.store._transaction(pending):
            if attempted >= limit:
                break
            for recovery in (await self.store.recovery_candidates(dispute_id))[:limit]:
                if attempted >= limit:
                    break
                attempted += 1
                try:
                    completed += await self._recover_attributable_transfer(recovery, dispute_id)
                except (CommerceProviderError, CommerceError):
                    # Original operation/remaining obligation survives worker
                    # restart and provider failures; never credit guessed cash.
                    continue
                finally:
                    await self._defer_recovery_candidate(recovery["recovery_id"])
            await self._defer_transfer_recovery(dispute_id)
        return completed

    async def _defer_transfer_recovery(self, dispute_id: str) -> None:
        async def defer(connection: Any) -> None:
            await connection.execute(
                """UPDATE scope_commerce_obligations SET next_check_at=clock_timestamp()+interval '1 minute'
                WHERE idempotency_key=$1 AND status<>'succeeded'""",
                f"recovery:{dispute_id}",
            )

        await self.store._transaction(defer)

    async def _defer_recovery_candidate(self, recovery_id: str) -> None:
        async def defer(connection: Any) -> None:
            await connection.execute(
                """UPDATE scope_commerce_transfer_recoveries SET next_check_at=clock_timestamp()+interval '1 minute'
                WHERE recovery_id=$1::uuid AND recovered_micro_usd<amount_micro_usd""",
                recovery_id,
            )

        await self.store._transaction(defer)

    async def _recover_attributable_transfer(
        self, recovery: dict[str, Any], dispute_id: str
    ) -> int:
        operation_id = self._derived_id(
            recovery["recovery_id"], f"dispute-recovery:{recovery['amount_cents']}"
        )
        existing = await self._existing_operation(operation_id)
        if existing:
            request = self._saved_request(existing)
            amount = request["amount"]
        else:
            transfer = await self.adapter.retrieve("transfer", recovery["transfer_id"])
            if (
                transfer.get("id") != recovery["transfer_id"]
                or transfer.get("object") != "transfer"
                or transfer.get("destination") != recovery["account_id"]
                or transfer.get("currency") != "usd"
                or transfer.get("livemode") is not self.config.livemode
                or type(transfer.get("amount")) is not int
                or type(transfer.get("amount_reversed", 0)) is not int
            ):
                raise CommerceProviderError("provider_recovery_receipt_mismatch")
            balance = await self.adapter.balance(account_id=recovery["account_id"])
            if balance.get("livemode") is not self.config.livemode:
                raise CommerceProviderError("provider_account_mismatch")
            available = self._available_usd(balance)
            amount = min(
                recovery["amount_cents"],
                transfer["amount"] - transfer.get("amount_reversed", 0),
                available,
            )
        if amount <= 0:
            return 0
        reversal = await self._reverse_transfer(
            user_id=existing["user_id"] if existing else None,
            transfer_id=recovery["transfer_id"],
            amount_cents=amount,
            operation_id=operation_id,
            withdrawal_id=recovery["withdrawal_id"],
            recovery_id=recovery["recovery_id"],
            dispute_id=dispute_id,
        )
        await self.store.settle_transfer_recovery(
            recovery_id=recovery["recovery_id"],
            provider_reversal_id=reversal["id"],
            amount_cents=reversal["amount"],
        )
        return 1


class FundingRefundDrain(ProviderContext):
    async def _drain_source_refunds(self, *, limit: int) -> int:
        """Dispatch already-reserved obligations, including erased identities."""
        completed = 0
        for obligation in await self.store.claim_obligations(kinds=("source_refund",), limit=limit):
            operation_id = str(obligation["obligation_id"])
            try:
                existing = await self._existing_operation(operation_id)
                if existing:
                    if existing["kind"] != "refund":
                        raise CommerceProviderError("provider_operation_conflict")
                    request, user_id = self._saved_request(existing), existing["user_id"]
                else:
                    if not obligation["create_allowed"]:
                        raise CommerceProviderError("provider_reconciliation_required")

                    async def owner(
                        connection: Any, wallet_id: Any = obligation["wallet_id"]
                    ) -> str | None:
                        return await connection.fetchval(
                            "SELECT payer_user_id FROM scope_commerce_wallets WHERE wallet_id=$1",
                            wallet_id,
                        )

                    user_id = await self.store._transaction(owner)
                    metadata = self._metadata(
                        operation_id, user_id or f"wallet:{obligation['wallet_id']}"
                    )
                    request = {
                        "payment_intent": obligation["source_id"],
                        "amount": obligation["amount_micro_usd"] // _MICRO_PER_CENT,
                        "metadata": metadata,
                    }
                if (
                    request.get("payment_intent") != obligation["source_id"]
                    or request.get("amount") * _MICRO_PER_CENT != obligation["amount_micro_usd"]
                ):
                    raise CommerceProviderError("provider_operation_conflict")

                def validate(value: dict[str, Any], frozen: dict[str, Any] = request) -> None:
                    self._validate_object(value, object_type="refund", metadata=frozen["metadata"])
                    if (
                        value.get("amount") != frozen["amount"]
                        or value.get("payment_intent") != frozen["payment_intent"]
                        or value.get("currency") != "usd"
                    ):
                        raise CommerceProviderError("provider_response_mismatch")

                refund = await self._run_operation(
                    user_id=user_id,
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
                completed += 1
            except (CommerceProviderError, CommerceError):

                async def hold(connection: Any, reference: str = operation_id) -> None:
                    await connection.execute(
                        """UPDATE scope_commerce_obligations SET status='unknown',
                        lease_expires_at=NULL,next_check_at=clock_timestamp()+interval '1 minute'
                        WHERE obligation_id=$1::uuid AND status NOT IN ('succeeded','failed')""",
                        reference,
                    )

                await self.store._transaction(hold)
        return completed

    @staticmethod
    def _refund_state(status: str) -> str:
        if status == "canceled":
            return "failed"
        if status == "requires_action":
            return "pending"
        return status
