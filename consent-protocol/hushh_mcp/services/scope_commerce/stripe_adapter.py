"""Replaceable Stripe boundary for scope commerce; no ledger authority lives here."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any, Protocol

import stripe


class CommerceProviderError(RuntimeError):
    """A safe code, never a provider response or credential-bearing exception."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


def provider_dict(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if hasattr(value, "to_dict_recursive"):
        return value.to_dict_recursive()
    if hasattr(value, "to_dict"):
        return value.to_dict()
    raise CommerceProviderError("provider_invalid_response")


@dataclass(frozen=True)
class FundingReceipt:
    payment_intent_id: str
    charge_id: str
    balance_transaction_id: str
    customer_id: str
    amount_cents: int
    fee_micro_usd: int
    livemode: bool


class ScopeCommerceProvider(Protocol):
    async def platform_identity(self) -> dict[str, Any]: ...

    async def create(
        self, kind: str, request: dict[str, Any], *, idempotency_key: str
    ) -> dict[str, Any]: ...

    async def retrieve(
        self, kind: str, provider_id: str, *, account_id: str | None = None
    ) -> dict[str, Any]: ...

    async def recover(
        self, kind: str, operation_id: str, request: dict[str, Any], *, created: int
    ) -> dict[str, Any] | None: ...

    def verify_webhook(self, payload: bytes, signature: str | None) -> dict[str, Any]: ...

    async def funding_receipt(
        self, payment_intent_id: str, *, expected: dict[str, Any]
    ) -> FundingReceipt: ...

    async def balance(self, *, account_id: str | None = None) -> dict[str, Any]: ...

    async def balance_transactions(self, *, source_id: str) -> list[dict[str, Any]]: ...


@dataclass
class StripeScopeCommerceAdapter:
    """SDK calls use per-call credentials and run outside database transactions."""

    secret_key: str = field(repr=False)
    webhook_secret: str = field(repr=False)
    stripe_api: Any = field(default=stripe, repr=False)
    connect_webhook_secret: str = field(default="", repr=False)
    webhook_mode: str = "endpoints"

    async def _call(self, callback: Any, *args: Any, **kwargs: Any) -> dict[str, Any]:
        try:
            result = await asyncio.to_thread(callback, *args, api_key=self.secret_key, **kwargs)
            return provider_dict(result)
        except CommerceProviderError:
            raise
        except Exception:
            raise CommerceProviderError("provider_unavailable") from None

    async def platform_identity(self) -> dict[str, Any]:
        return await self._call(self.stripe_api.Account.retrieve)

    async def create(
        self, kind: str, request: dict[str, Any], *, idempotency_key: str
    ) -> dict[str, Any]:
        if kind == "transfer_reversal":
            options = dict(request)
            transfer_id = options.pop("transfer_id")
            return await self._call(
                self.stripe_api.Transfer.create_reversal,
                transfer_id,
                **options,
                idempotency_key=idempotency_key,
            )
        resources = {
            "customer": self.stripe_api.Customer,
            "funding": self.stripe_api.checkout.Session,
            "seller_account": self.stripe_api.Account,
            "onboarding": self.stripe_api.AccountLink,
            "refund": self.stripe_api.Refund,
            "transfer": self.stripe_api.Transfer,
            "payout": self.stripe_api.Payout,
        }
        resource = resources.get(kind)
        if resource is None:
            raise CommerceProviderError("provider_operation_invalid")
        return await self._call(resource.create, **request, idempotency_key=idempotency_key)

    async def retrieve(
        self, kind: str, provider_id: str, *, account_id: str | None = None
    ) -> dict[str, Any]:
        resources = {
            "customer": self.stripe_api.Customer,
            "funding": self.stripe_api.checkout.Session,
            "seller_account": self.stripe_api.Account,
            "refund": self.stripe_api.Refund,
            "transfer": self.stripe_api.Transfer,
            "payout": self.stripe_api.Payout,
            "charge": self.stripe_api.Charge,
            "balance_transaction": self.stripe_api.BalanceTransaction,
            "payment_intent": self.stripe_api.PaymentIntent,
            "event": self.stripe_api.Event,
            "dispute": self.stripe_api.Dispute,
            "topup": self.stripe_api.Topup,
        }
        resource = resources.get(kind)
        if resource is None:
            raise CommerceProviderError("provider_operation_invalid")
        options = {"stripe_account": account_id} if account_id else {}
        return await self._call(resource.retrieve, provider_id, **options)

    async def recover(
        self, kind: str, operation_id: str, request: dict[str, Any], *, created: int
    ) -> dict[str, Any] | None:
        """Find a prior success. Absence never authorizes a post-24h retry."""
        resources = {
            "customer": self.stripe_api.Customer,
            "funding": self.stripe_api.checkout.Session,
            "seller_account": self.stripe_api.Account,
            "refund": self.stripe_api.Refund,
            "transfer": self.stripe_api.Transfer,
            "payout": self.stripe_api.Payout,
        }
        resource = resources.get(kind)
        if resource is None and kind != "transfer_reversal":
            return None  # Account links cannot be listed or recovered.
        options: dict[str, Any] = {"limit": 100, "api_key": self.secret_key}
        if kind != "seller_account":
            options["created"] = {"gte": created - 60}
        if kind == "funding":
            options["customer"] = request["customer"]
        if kind == "refund":
            options.pop("created", None)
            options["payment_intent"] = request["payment_intent"]
        if kind == "payout":
            options["stripe_account"] = request["stripe_account"]
        if kind == "transfer_reversal":
            options.pop("created", None)

        def find() -> dict[str, Any] | None:
            matches = []
            scanned = 0
            listed = (
                self.stripe_api.Transfer.list_reversals(request["transfer_id"], **options)
                if kind == "transfer_reversal"
                else resource.list(**options)
            )
            for item in listed.auto_paging_iter():
                scanned += 1
                if scanned > 10_000:
                    raise CommerceProviderError("provider_recovery_incomplete")
                candidate = provider_dict(item)
                if (candidate.get("metadata") or {}).get("scope_operation_id") == operation_id:
                    matches.append(candidate)
                    if len(matches) > 1:
                        raise CommerceProviderError("provider_recovery_ambiguous")
            return matches[0] if matches else None

        try:
            return await asyncio.to_thread(find)
        except CommerceProviderError:
            raise
        except Exception:
            raise CommerceProviderError("provider_recovery_unavailable") from None

    def verify_webhook(self, payload: bytes, signature: str | None) -> dict[str, Any]:
        from .provider_webhook_signatures import verify_scoped_signature

        return verify_scoped_signature(
            payload=payload,
            signature=signature,
            platform_secret=self.webhook_secret,
            connect_secret=self.connect_webhook_secret,
            mode=self.webhook_mode,
            construct_event=self.stripe_api.Webhook.construct_event,
            allow_cli=not self.secret_key.startswith("sk_live_"),
        )

    async def funding_receipt(
        self, payment_intent_id: str, *, expected: dict[str, Any]
    ) -> FundingReceipt:
        return await self._funding_receipt(payment_intent_id, expected=expected, historical=False)

    async def historical_funding_receipt(
        self, payment_intent_id: str, *, expected: dict[str, Any]
    ) -> FundingReceipt:
        """Original charge proof for read-only reconciliation, never credit admission."""
        return await self._funding_receipt(payment_intent_id, expected=expected, historical=True)

    async def _funding_receipt(
        self, payment_intent_id: str, *, expected: dict[str, Any], historical: bool
    ) -> FundingReceipt:
        intent = await self._call(
            self.stripe_api.PaymentIntent.retrieve,
            payment_intent_id,
            expand=["latest_charge.balance_transaction"],
        )
        charge = intent.get("latest_charge")
        if isinstance(charge, str):
            charge = await self.retrieve("charge", charge)
        charge = provider_dict(charge)
        transaction = charge.get("balance_transaction")
        if isinstance(transaction, str):
            transaction = await self.retrieve("balance_transaction", transaction)
        transaction = provider_dict(transaction)
        metadata = expected["metadata"]
        amount = expected["amount_cents"]
        mode = expected["livemode"]
        if (
            type(amount) is not int
            or not 50 <= amount <= 100_000
            or type(intent.get("amount")) is not int
            or type(intent.get("amount_received")) is not int
            or type(charge.get("amount")) is not int
            or type(charge.get("amount_captured")) is not int
            or type(transaction.get("amount")) is not int
            or type(transaction.get("net")) is not int
            or intent.get("id") != payment_intent_id
            or intent.get("status") != "succeeded"
            or intent.get("currency") != "usd"
            or intent.get("amount") != amount
            or intent.get("amount_received") != amount
            or intent.get("customer") != expected["customer_id"]
            or intent.get("livemode") is not mode
            or any((intent.get("metadata") or {}).get(k) != v for k, v in metadata.items())
            or charge.get("object") != "charge"
            or not isinstance(charge.get("id"), str)
            or charge.get("payment_intent") != payment_intent_id
            or charge.get("customer") != expected["customer_id"]
            or charge.get("currency") != "usd"
            or charge.get("amount") != amount
            or charge.get("amount_captured") != amount
            or charge.get("paid") is not True
            or charge.get("captured") is not True
            or (
                not historical
                and (
                    charge.get("refunded") is not False
                    or charge.get("disputed") is not False
                    or charge.get("amount_refunded") != 0
                )
            )
            or charge.get("livemode") is not mode
            or transaction.get("object") != "balance_transaction"
            or not isinstance(transaction.get("id"), str)
            or transaction.get("source") != charge["id"]
            or transaction.get("currency") != "usd"
            or transaction.get("amount") != amount
            or type(transaction.get("fee")) is not int
            or transaction["fee"] < 0
            or transaction.get("net") != amount - transaction["fee"]
        ):
            raise CommerceProviderError("provider_receipt_mismatch")
        return FundingReceipt(
            payment_intent_id=payment_intent_id,
            charge_id=charge["id"],
            balance_transaction_id=transaction["id"],
            customer_id=expected["customer_id"],
            amount_cents=amount,
            fee_micro_usd=transaction["fee"] * 10_000,
            livemode=mode,
        )

    async def balance(self, *, account_id: str | None = None) -> dict[str, Any]:
        options = {"stripe_account": account_id} if account_id else {}
        return await self._call(self.stripe_api.Balance.retrieve, **options)

    async def balance_transactions(self, *, source_id: str) -> list[dict[str, Any]]:
        """Platform-only, exact-source capital evidence with bounded pagination."""
        transactions: list[dict[str, Any]] = []
        options: dict[str, Any] = {"source": source_id, "limit": 100}
        seen: set[str] = set()
        for _page in range(5):
            listed = await self._call(self.stripe_api.BalanceTransaction.list, **options)
            if not isinstance(listed.get("data"), list) or type(listed.get("has_more")) is not bool:
                raise CommerceProviderError("provider_invalid_response")
            for raw in listed["data"]:
                value = provider_dict(raw)
                identity = value.get("id")
                if not isinstance(identity, str) or identity in seen:
                    raise CommerceProviderError("provider_capital_receipt_mismatch")
                seen.add(identity)
                transactions.append(value)
            if not listed["has_more"]:
                return transactions
            if not listed["data"]:
                raise CommerceProviderError("provider_capital_reconciliation_incomplete")
            options["starting_after"] = transactions[-1]["id"]
        raise CommerceProviderError("provider_capital_reconciliation_incomplete")
