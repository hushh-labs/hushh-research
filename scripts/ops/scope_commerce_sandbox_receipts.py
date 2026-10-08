"""Read-only provider receipts correlated with canonical commerce provenance."""

from __future__ import annotations

import json
from typing import Any

from hushh_mcp.services.scope_commerce.capital import OperatingCapitalReceipt
from hushh_mcp.services.scope_commerce.provider_config import (
    ScopeCommerceProviderConfig,
)
from hushh_mcp.services.scope_commerce.provider_contracts import _opaque
from hushh_mcp.services.scope_commerce.provider_payouts import PayoutReceiptValidator
from hushh_mcp.services.scope_commerce.provider_service import (
    ScopeCommerceProviderService,
)
from hushh_mcp.services.scope_commerce.provider_webhooks import OperatingCapitalEvents
from hushh_mcp.services.scope_commerce.stripe_adapter import (
    CommerceProviderError,
    StripeScopeCommerceAdapter,
)


class FundingAndCapitalProof:
    adapter: StripeScopeCommerceAdapter
    config: ScopeCommerceProviderConfig

    async def funding_evidence(
        self, connection: Any, reviewers: dict[str, str]
    ) -> dict[str, Any]:
        evidence = {}
        for role, user_id in reviewers.items():
            rows = await connection.fetch(
                """SELECT f.*,o.provider_id,o.request_json FROM scope_commerce_fundings f
                JOIN scope_commerce_wallets w USING(wallet_id)
                LEFT JOIN scope_commerce_provider_operations o ON o.operation_id=f.funding_id AND o.kind='funding'
                WHERE w.payer_user_id=$1 OR o.request_json->'metadata'->>'payer_ref'=$2
                ORDER BY f.created_at LIMIT 501""",
                user_id,
                _opaque(user_id),
            )
            if len(rows) > 500:
                raise CommerceProviderError("sandbox_funding_evidence_incomplete")
            attempts = []
            used = 0
            for row in rows:
                attempt = await self._funding_attempt(connection, dict(row), user_id)
                attempts.append(attempt)
                if row["status"] != "cancelled":
                    used += row["amount_cents"]
            if used > self.config.sandbox_policy.reviewer_funding_cap_cents:
                raise CommerceProviderError("sandbox_funding_budget_exceeded")
            evidence[role] = {"usedCents": used, "fundingAttempts": attempts}
        return evidence

    async def _funding_attempt(
        self, connection: Any, row: dict[str, Any], user_id: str
    ) -> dict[str, Any]:
        verified = credited = False
        if row["provider_id"]:
            request = row["request_json"]
            request = json.loads(request) if isinstance(request, str) else request
            session = await self.adapter.retrieve("funding", row["provider_id"])
            metadata = request["metadata"]
            if (
                metadata.get("payer_ref") != _opaque(user_id)
                or session.get("metadata") != metadata
                or session.get("id") != row["provider_id"]
                or session.get("object") != "checkout.session"
                or session.get("client_reference_id") != str(row["funding_id"])
                or session.get("amount_total") != row["amount_cents"]
                or session.get("currency") != "usd"
                or session.get("livemode") is not False
                or session.get("customer") != request["customer"]
            ):
                raise CommerceProviderError("sandbox_funding_receipt_mismatch")
            if session.get("payment_status") == "paid":
                receipt = await self.adapter.historical_funding_receipt(
                    session["payment_intent"],
                    expected={
                        "metadata": metadata,
                        "customer_id": request["customer"],
                        "livemode": False,
                        "amount_cents": row["amount_cents"],
                    },
                )
                verified = True
                lot = await connection.fetchrow(
                    "SELECT * FROM scope_commerce_funding_lots WHERE funding_id=$1",
                    row["funding_id"],
                )
                if lot is None and row["status"] in {
                    "paid",
                    "refund_pending",
                    "refunded",
                }:
                    raise CommerceProviderError("sandbox_funding_journal_mismatch")
                if lot and (
                    lot["charge_id"] != receipt.charge_id
                    or lot["balance_transaction_id"] != receipt.balance_transaction_id
                    or lot["fee_total_micro_usd"] != receipt.fee_micro_usd
                    or lot["gross_micro_usd"] != receipt.amount_cents * 10000
                    or lot["livemode"] is not False
                ):
                    raise CommerceProviderError("sandbox_funding_journal_mismatch")
            elif row["status"] == "cancelled" and session.get("status") != "expired":
                raise CommerceProviderError("sandbox_funding_cancellation_unverified")
            credited = await connection.fetchval(
                "SELECT count(*)=1 FROM scope_commerce_journal WHERE idempotency_key=$1 AND kind='funding'",
                f"funding:{row['funding_id']}",
            )
        return {
            "fundingId": str(row["funding_id"]),
            "amountCents": row["amount_cents"],
            "status": row["status"],
            "providerVerified": verified,
            "creditedOnce": bool(credited),
        }

    async def capital_backing(
        self, connection: Any, topups: list[dict[str, Any]]
    ) -> bool:
        verified = False
        for topup in topups:
            if topup.get("status") not in {"succeeded", "reversed"}:
                continue
            transactions = await self.adapter.balance_transactions(
                source_id=topup["id"]
            )
            original = topup.get("balance_transaction")
            original_id = (
                original if isinstance(original, str) else (original or {}).get("id")
            )
            if not any(
                item.get("id") == original_id and item.get("type") == "topup"
                for item in transactions
            ):
                raise CommerceProviderError("sandbox_capital_receipt_missing")
            if topup["status"] == "reversed" and not any(
                item.get("type") == "topup_reversal" for item in transactions
            ):
                raise CommerceProviderError("sandbox_capital_receipt_missing")
            for transaction in transactions:
                OperatingCapitalEvents._validate_capital_transaction(transaction, topup)
                recorded = await connection.fetchrow(
                    "SELECT * FROM scope_commerce_financial_events WHERE event_id=$1",
                    "operating_capital:" + transaction["id"],
                )
                if not recorded:
                    return False
                receipt = OperatingCapitalReceipt(
                    topup["id"],
                    transaction["id"],
                    self.config.platform_account_id,
                    False,
                    "usd",
                    transaction["amount"] * 10000,
                    transaction["fee"] * 10000,
                    transaction["net"] * 10000,
                )
                if (
                    recorded["kind"] != "operating_capital"
                    or recorded["reference_id"] != topup["id"]
                    or recorded["request_hash"] != receipt.digest()
                ):
                    raise CommerceProviderError("sandbox_capital_journal_mismatch")
            if topup["status"] == "succeeded":
                verified = True
        return verified


class SourceRefundProof:
    adapter: StripeScopeCommerceAdapter

    async def refunds(
        self, connection: Any, reviewers: dict[str, str]
    ) -> dict[str, list[dict[str, Any]]]:
        evidence = {}
        for role, user_id in reviewers.items():
            rows = await connection.fetch(
                """SELECT r.*,f.funding_id,f.payment_intent_id,o.request_json,o.provider_id AS operation_provider_id
                FROM scope_commerce_obligations r JOIN scope_commerce_wallets w USING(wallet_id)
                JOIN scope_commerce_funding_lots f ON f.lot_id=r.funding_lot_id
                LEFT JOIN scope_commerce_provider_operations o ON o.operation_id=r.obligation_id AND o.kind='refund'
                WHERE r.kind='source_refund' AND w.payer_user_id=$1 ORDER BY r.created_at LIMIT 501""",
                user_id,
            )
            if len(rows) > 500:
                raise CommerceProviderError("sandbox_refund_evidence_incomplete")
            evidence[role] = [
                await self._refund_receipt(dict(row), user_id) for row in rows
            ]
        return evidence

    async def _refund_receipt(
        self, row: dict[str, Any], user_id: str
    ) -> dict[str, Any]:
        verified = False
        if row["provider_id"]:
            request = _request_json(row["request_json"])
            value = await self.adapter.retrieve("refund", row["provider_id"])
            intent = await self.adapter.retrieve(
                "payment_intent", row["payment_intent_id"]
            )
            if (
                row["operation_provider_id"] != row["provider_id"]
                or value.get("id") != row["provider_id"]
                or value.get("object") != "refund"
                or value.get("metadata") != request["metadata"]
                or request["metadata"].get("payer_ref") != _opaque(user_id)
                or value.get("payment_intent") != row["payment_intent_id"]
                or request.get("payment_intent") != row["payment_intent_id"]
                or type(value.get("amount")) is not int
                or value.get("amount") * 10000 != row["amount_micro_usd"]
                or value.get("currency") != "usd"
                or intent.get("id") != row["payment_intent_id"]
                or intent.get("livemode") is not False
            ):
                raise CommerceProviderError("sandbox_refund_receipt_mismatch")
            verified = (
                value.get("status") == "succeeded" and row["status"] == "succeeded"
            )
        return {
            "fundingId": str(row["funding_id"]),
            "refundId": str(row["obligation_id"]),
            "amountCents": row["amount_micro_usd"] // 10000,
            "status": row["status"],
            "providerVerified": verified,
            "originalSourceVerified": verified,
        }


def _request_json(value: Any) -> dict[str, Any]:
    request = json.loads(value) if isinstance(value, str) else value
    if not isinstance(request, dict) or not isinstance(request.get("metadata"), dict):
        raise CommerceProviderError("sandbox_operation_evidence_missing")
    return request


class WithdrawalProof:
    adapter: StripeScopeCommerceAdapter
    config: ScopeCommerceProviderConfig

    async def withdrawals(
        self, connection: Any, reviewers: dict[str, str]
    ) -> dict[str, list[dict[str, Any]]]:
        evidence = {}
        for role, user_id in reviewers.items():
            rows = await connection.fetch(
                "SELECT * FROM scope_commerce_withdrawals WHERE user_id=$1 ORDER BY created_at LIMIT 501",
                user_id,
            )
            if len(rows) > 500:
                raise CommerceProviderError("sandbox_withdrawal_evidence_incomplete")
            evidence[role] = [
                await self._withdrawal_receipt(connection, dict(row), user_id)
                for row in rows
            ]
        return evidence

    async def _bound_operation(
        self, connection: Any, provider_id: str, kind: str, user_id: str
    ) -> dict[str, Any]:
        row = await connection.fetchrow(
            "SELECT request_json FROM scope_commerce_provider_operations WHERE provider_id=$1 AND kind=$2",
            provider_id,
            kind,
        )
        request = _request_json(row["request_json"] if row else None)
        if request["metadata"].get("payer_ref") != _opaque(user_id):
            raise CommerceProviderError("sandbox_withdrawal_actor_mismatch")
        return request

    async def _withdrawal_receipt(
        self, connection: Any, row: dict[str, Any], user_id: str
    ) -> dict[str, Any]:
        kind = await connection.fetchval(
            "SELECT kind FROM scope_commerce_journal WHERE idempotency_key=$1",
            "withdrawal_reserve:" + str(row["withdrawal_id"]),
        )
        source = {
            "withdrawal_reserve_manual": "manual",
            "withdrawal_reserve_weekly": "weekly",
        }.get(kind, "unverified")
        purchase_ids = await connection.fetch(
            "SELECT purchase_id FROM scope_commerce_withdrawal_allocations WHERE withdrawal_id=$1",
            row["withdrawal_id"],
        )
        transfer_verified = bank_verified = fees_verified = False
        account_id = row["account_id"]
        if row["transfer_id"]:
            request = await self._bound_operation(
                connection, row["transfer_id"], "transfer", user_id
            )
            transfer = await self.adapter.retrieve("transfer", row["transfer_id"])
            if (
                transfer.get("id") != row["transfer_id"]
                or transfer.get("livemode") is not False
                or transfer.get("metadata") != request["metadata"]
                or transfer.get("destination") != account_id
                or transfer.get("currency") != "usd"
                or transfer.get("amount") != request["amount"]
                or request["metadata"].get("withdrawal_id") != str(row["withdrawal_id"])
            ):
                raise CommerceProviderError("sandbox_transfer_receipt_mismatch")
            transfer_verified = True
        if row["payout_id"]:
            bank_verified, fees_verified = await self._bank_receipt(
                connection, row, user_id
            )
        return {
            "withdrawalId": str(row["withdrawal_id"]),
            "purchaseIds": [str(item["purchase_id"]) for item in purchase_ids],
            "source": source,
            "status": row["status"],
            "transferVerified": transfer_verified,
            "bankPayoutVerified": bank_verified,
            "feeReceiptsMatched": fees_verified,
            "netCents": row["net_cents"],
            "providerMinimumCents": self.config.countries["US"].minimum_cents,
        }

    async def _bank_receipt(
        self, connection: Any, row: dict[str, Any], user_id: str
    ) -> tuple[bool, bool]:
        request = await self._bound_operation(
            connection, row["payout_id"], "payout", user_id
        )
        payout = await self.adapter.retrieve(
            "payout", row["payout_id"], account_id=row["account_id"]
        )
        if (
            payout.get("id") != row["payout_id"]
            or payout.get("livemode") is not False
            or payout.get("currency") != "usd"
            or payout.get("amount") != row["net_cents"]
            or payout.get("metadata") != request["metadata"]
            or request.get("stripe_account") != row["account_id"]
            or request["metadata"].get("withdrawal_id") != str(row["withdrawal_id"])
        ):
            raise CommerceProviderError("sandbox_payout_receipt_mismatch")
        if payout.get("status") != "paid" or row["status"] != "succeeded":
            return False, False
        transaction_id = payout.get("balance_transaction")
        if not isinstance(transaction_id, str) or not row["transfer_id"]:
            raise CommerceProviderError("sandbox_payout_receipt_missing")
        transaction = await self.adapter.retrieve(
            "balance_transaction", transaction_id, account_id=row["account_id"]
        )
        PayoutReceiptValidator._validate_balance_transaction(
            transaction,
            transaction_id=transaction_id,
            source_id=payout["id"],
            amount_cents=-payout["amount"],
        )
        from hushh_mcp.services.scope_commerce.service import ScopeCommerceService

        validator = ScopeCommerceProviderService(
            ScopeCommerceService(provider_config=self.config),
            adapter=self.adapter,
            config=self.config,
        )
        routing_fee = await validator._transfer_fee_cents(
            transfer_id=row["transfer_id"], account_id=row["account_id"]
        )
        actual_cash = (-transaction["net"] + routing_fee) * 10000
        if row["settled_micro_usd"] != actual_cash:
            raise CommerceProviderError("sandbox_payout_journal_mismatch")
        return True, True


class SandboxReceiptProof(FundingAndCapitalProof, SourceRefundProof, WithdrawalProof):
    """Stable read surface composing provider facts; canonical Postgres remains authority."""
