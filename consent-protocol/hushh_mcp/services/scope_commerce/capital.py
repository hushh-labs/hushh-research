"""Provider-attested operating capital; never a consumer credit authority."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .domain import CommerceError, account, fingerprint, integer


@dataclass(frozen=True)
class OperatingCapitalReceipt:
    topup_id: str
    balance_transaction_id: str
    platform_account_id: str
    livemode: bool
    currency: str
    amount_micro_usd: int
    fee_micro_usd: int
    net_micro_usd: int

    def validate(self) -> None:
        if (
            not isinstance(self.topup_id, str)
            or not self.topup_id.startswith("tu_")
            or not isinstance(self.balance_transaction_id, str)
            or not self.balance_transaction_id.startswith("txn_")
            or not isinstance(self.platform_account_id, str)
            or not self.platform_account_id.startswith("acct_")
            or type(self.livemode) is not bool
            or self.currency != "usd"
        ):
            raise CommerceError("invalid_operating_capital_receipt")
        for amount in (self.amount_micro_usd, self.fee_micro_usd, self.net_micro_usd):
            integer(amount, -(10**18), 10**18, "invalid_operating_capital_amount")
        if not self.amount_micro_usd or self.net_micro_usd != (
            self.amount_micro_usd - self.fee_micro_usd
        ):
            raise CommerceError("invalid_operating_capital_amount")

    def digest(self) -> str:
        return fingerprint(list(self.__dict__.values()))

    def projection(self) -> dict[str, str]:
        return {
            "balanceTransactionId": self.balance_transaction_id,
            "topupId": self.topup_id,
            "status": "recorded",
        }


class OperatingCapital:
    async def record_operating_capital_balance_transaction(
        self,
        *,
        topup_id: str,
        balance_transaction_id: str,
        platform_account_id: str,
        livemode: bool,
        currency: str,
        amount_micro_usd: int,
        fee_micro_usd: int,
        net_micro_usd: int,
        conn: Any = None,
    ) -> dict[str, str]:
        """Trusted adapter port after exact settled Topup/transaction verification.

        No aggregate balance delta, feature flag, or caller-supplied amount can
        stand in for that provider proof. Reconciliation remains available when
        new commerce admission is disabled.
        """
        receipt = OperatingCapitalReceipt(
            topup_id,
            balance_transaction_id,
            platform_account_id,
            livemode,
            currency,
            amount_micro_usd,
            fee_micro_usd,
            net_micro_usd,
        )
        receipt.validate()

        async def operation(c: Any) -> dict[str, str]:
            pin = await self._environment(c, livemode=receipt.livemode)
            if pin["platform_account_id"] != receipt.platform_account_id:
                raise CommerceError("commerce_environment_mismatch")
            key = f"operating_capital:{receipt.balance_transaction_id}"
            old = await self._row(
                c, "SELECT * FROM scope_commerce_financial_events WHERE event_id=$1", key
            )
            if old:
                if (
                    old["kind"] != "operating_capital"
                    or old["reference_id"] != receipt.topup_id
                    or old["request_hash"] != receipt.digest()
                ):
                    raise CommerceError("idempotency_conflict")
                return receipt.projection()
            await self._post(
                c,
                key,
                "operating_capital",
                {
                    account("bank"): -receipt.net_micro_usd,
                    account("platform_capital"): receipt.amount_micro_usd,
                    account("platform_capital_cost"): -receipt.fee_micro_usd,
                },
                receipt.topup_id,
            )
            await c.execute(
                "INSERT INTO scope_commerce_financial_events(event_id,kind,reference_id,request_hash) VALUES($1,'operating_capital',$2,$3)",
                key,
                receipt.topup_id,
                receipt.digest(),
            )
            return receipt.projection()

        return await self._transaction(operation, conn)
