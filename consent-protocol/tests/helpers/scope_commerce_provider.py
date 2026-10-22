"""Synthetic provider adapters and receipt fixtures; never a runtime fallback."""

from __future__ import annotations

import hashlib
import hmac
import importlib
import json
import sys
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import ModuleType
from uuid import uuid4

from hushh_mcp.services.scope_commerce.provider_service import (
    CountryPayoutPolicy,
    ScopeCommerceProviderConfig,
    ScopeCommerceProviderService,
)
from hushh_mcp.services.scope_commerce.stripe_adapter import (
    CommerceProviderError,
    FundingReceipt,
    StripeScopeCommerceAdapter,
)


def sandbox_operator_helper(name: str) -> ModuleType:
    """Load root-owned CLI helpers in protocol CI without retaining path changes."""
    sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
    try:
        return importlib.import_module("scripts.ops.scope_commerce_sandbox" + name)
    finally:
        sys.path.pop(0)


def _receipt_fixture():
    metadata = {
        "payment_kind": "scope_commerce",
        "scope_operation_id": str(uuid4()),
        "payer_ref": "opaque",
    }
    charge = {
        "object": "charge",
        "id": "ch_fixture",
        "payment_intent": "pi_fixture",
        "customer": "cus_fixture",
        "currency": "usd",
        "amount": 50,
        "amount_captured": 50,
        "paid": True,
        "captured": True,
        "refunded": False,
        "disputed": False,
        "amount_refunded": 0,
        "livemode": False,
        "balance_transaction": {
            "object": "balance_transaction",
            "id": "txn_fixture",
            "source": "ch_fixture",
            "currency": "usd",
            "amount": 50,
            "fee": 32,
            "net": 18,
        },
    }
    intent = {
        "id": "pi_fixture",
        "status": "succeeded",
        "currency": "usd",
        "amount": 50,
        "amount_received": 50,
        "customer": "cus_fixture",
        "livemode": False,
        "metadata": metadata,
        "latest_charge": charge,
    }
    expected = {
        "metadata": metadata,
        "amount_cents": 50,
        "customer_id": "cus_fixture",
        "livemode": False,
    }
    return intent, expected


class _OperationStore:
    """Test-only transactional fixture; production always uses the Postgres store."""

    def __init__(self):
        self.operations = {}

    async def _transaction(self, operation):
        return await operation(self)

    async def execute(self, sql, *args):
        if sql.lstrip().startswith("INSERT"):
            key, user, kind, digest, request = args
            self.operations.setdefault(
                key,
                {
                    "operation_id": key,
                    "user_id": user,
                    "kind": kind,
                    "request_hash": digest,
                    "request_json": request,
                    "status": "prepared",
                    "provider_id": None,
                    "provider_response": None,
                    "created_at": datetime.now(UTC),
                    "lease_until": None,
                },
            )
        elif "status='submitted'" in sql:
            self.operations[args[0]]["status"] = "submitted"
            self.operations[args[0]]["lease_until"] = datetime.now(UTC) + timedelta(minutes=2)
        elif "status='reconciliation_required'" in sql:
            self.operations[args[0]]["status"] = "reconciliation_required"
            self.operations[args[0]]["lease_until"] = None
        elif "provider_response=$3" in sql:
            key, provider, response, *_rest = args
            self.operations[key].update(
                status="succeeded",
                provider_id=provider,
                provider_response=response,
                lease_until=None,
            )

    async def fetchrow(self, _sql, key):
        if key not in self.operations:
            return None
        return {**self.operations[key], "server_now": datetime.now(UTC)}


class _OperationAdapter:
    def __init__(self):
        self.created = 0
        self.recovered = None
        self.fail_after_create = False
        self.response = {"object": "customer", "id": "cus_fixture", "livemode": False}

    async def create(self, _kind, request, **_kwargs):
        self.created += 1
        self.response["metadata"] = request["metadata"]
        if self.fail_after_create:
            self.recovered = self.response.copy()
            raise CommerceProviderError("provider_unavailable")
        return self.response.copy()

    async def recover(self, *_args, **_kwargs):
        return self.recovered


class _FundingAdapter(_OperationAdapter):
    def __init__(self):
        super().__init__()
        self.sessions = {}
        self.refunds = {}
        self.topups = {}
        self.capital_transactions = {}
        self.signer = StripeScopeCommerceAdapter(
            "test-only", "test-webhook-secret", webhook_mode="cli"
        )

    async def platform_identity(self):
        return {
            "id": "acct_platform",
            "country": "US",
            "default_currency": "usd",
            "settings": {"payouts": {"schedule": {"interval": "manual"}}},
        }

    async def balance(self, **_kwargs):
        return {"livemode": False, "available": [{"currency": "usd", "amount": 10_000}]}

    async def create(self, kind, request, **_kwargs):
        self.created += 1
        if kind == "customer":
            return {
                "id": "cus_fixture",
                "object": "customer",
                "metadata": request["metadata"],
                "livemode": False,
            }
        if kind == "funding":
            session = {
                "id": "cs_" + request["client_reference_id"],
                "object": "checkout.session",
                "metadata": request["metadata"],
                "livemode": False,
                "mode": "payment",
                "client_reference_id": request["client_reference_id"],
                "customer": request["customer"],
                "amount_total": request["line_items"][0]["price_data"]["unit_amount"],
                "currency": "usd",
                "status": "open",
                "payment_status": "unpaid",
                "url": "https://checkout.stripe.com/c/fixture",
            }
            self.sessions[session["id"]] = session
            return session
        if kind == "refund":
            refund = {
                "id": "re_" + request["metadata"]["scope_operation_id"],
                "object": "refund",
                "metadata": request["metadata"],
                "amount": request["amount"],
                "currency": "usd",
                "payment_intent": request["payment_intent"],
                "status": "succeeded",
            }
            self.refunds[refund["id"]] = refund
            return refund
        raise AssertionError("Unexpected provider mutation")

    async def retrieve(self, kind, provider_id, **_kwargs):
        if kind == "topup":
            return self.topups[provider_id]
        objects = self.sessions if kind == "funding" else self.refunds
        if provider_id not in objects:
            raise CommerceProviderError("provider_object_unavailable")
        return objects[provider_id]

    async def balance_transactions(self, *, source_id):
        return self.capital_transactions[source_id]

    async def funding_receipt(self, payment_intent_id, *, expected):
        return FundingReceipt(
            payment_intent_id,
            "ch_" + payment_intent_id,
            "txn_" + payment_intent_id,
            expected["customer_id"],
            expected["amount_cents"],
            320_000,
            False,
        )

    def verify_webhook(self, payload, signature):
        return self.signer.verify_webhook(payload, signature)


def _signed_event(obj, *, event_id=None, event_type="checkout.session.completed"):
    raw = json.dumps(
        {
            "id": event_id or "evt_" + uuid4().hex,
            "object": "event",
            "livemode": False,
            "type": event_type,
            "data": {"object": obj},
        }
    ).encode()
    timestamp = int(time.time())
    digest = hmac.new(
        b"test-webhook-secret", str(timestamp).encode() + b"." + raw, hashlib.sha256
    ).hexdigest()
    return raw, f"t={timestamp},v1={digest}"


def _funding_service(store, adapter):
    return ScopeCommerceProviderService(
        store,
        adapter=adapter,
        config=ScopeCommerceProviderConfig(
            enabled=True,
            platform_account_id="acct_platform",
            frontend_origin="https://example.test",
            countries={"US": CountryPayoutPolicy(1, 730, 0, 0)},
            fee_configuration_ref="fixture-fees",
        ),
    )


def _capital_fixture(adapter, *, amount_cents=100, fee_cents=0, reversed=False):
    topup_id = "tu_" + uuid4().hex
    original = {
        "id": "txn_" + uuid4().hex,
        "object": "balance_transaction",
        "source": topup_id,
        "type": "topup",
        "status": "available",
        "currency": "usd",
        "amount": amount_cents,
        "fee": fee_cents,
        "net": amount_cents - fee_cents,
    }
    topup = {
        "id": topup_id,
        "object": "topup",
        "livemode": False,
        "currency": "usd",
        "amount": amount_cents,
        "status": "succeeded",
        "metadata": {"payment_kind": "scope_commerce_operating_capital"},
        "balance_transaction": original["id"],
    }
    transactions = [original]
    if reversed:
        topup["status"] = "reversed"
        transactions.append(
            {
                **original,
                "id": "txn_" + uuid4().hex,
                "type": "topup_reversal",
                "amount": -amount_cents,
                "fee": 0,
                "net": -amount_cents,
            }
        )
    adapter.topups[topup_id] = topup
    adapter.capital_transactions[topup_id] = transactions
    return topup, transactions


class _FinancialAdapter(_FundingAdapter):
    def __init__(self):
        super().__init__()
        self.transfers = {}
        self.payouts = {}
        self.reversals = {}
        self.payout_status = "paid"
        self.dispute_status = "won"
        self.dispute_transactions = {}
        self.connected_available = 10_000
        self.returned_payout_fee = 0
        self.bad_failure_receipt = None

    async def balance(self, *, account_id=None):
        return {
            "livemode": False,
            "available": [
                {"currency": "usd", "amount": self.connected_available if account_id else 10_000}
            ],
        }

    async def retrieve(self, kind, provider_id, **kwargs):
        if kind == "seller_account":
            return {
                "id": provider_id,
                "country": "US",
                "default_currency": "usd",
                "external_accounts": {
                    "data": [
                        {
                            "object": "bank_account",
                            "account": provider_id,
                            "currency": "usd",
                            "default_for_currency": True,
                            "status": "new",
                            "available_payout_methods": ["standard"],
                        }
                    ]
                },
                "details_submitted": True,
                "payouts_enabled": True,
                "capabilities": {"transfers": "active"},
                "settings": {"payouts": {"schedule": {"interval": "manual"}}},
            }
        if kind == "transfer":
            return self.transfers[provider_id]
        if kind == "payout":
            return self.payouts[provider_id]
        if kind == "balance_transaction":
            if provider_id in self.dispute_transactions:
                return self.dispute_transactions[provider_id]
            failed = provider_id.startswith("txn_failure_")
            source = provider_id.removeprefix("txn_failure_" if failed else "txn_")
            operation = self.transfers[source] if source.startswith("tr_") else self.payouts[source]
            fee = -self.returned_payout_fee if failed else 2 if source.startswith("tr_") else 1
            amount = operation["amount"] if failed else -operation["amount"]
            result = {
                "id": provider_id,
                "object": "balance_transaction",
                "currency": "usd",
                "source": source,
                "fee": fee,
                "amount": amount,
                "net": amount - fee,
            }
            if failed and self.bad_failure_receipt == "source":
                result["source"] = "po_unrelated"
            return result
        if kind == "charge":
            session = next(iter(self.sessions.values()))
            return {"id": provider_id, "metadata": session["metadata"]}
        if kind == "dispute":
            return {
                "id": provider_id,
                "charge": "ch_pi_fixture",
                "amount": 50,
                "currency": "usd",
                "livemode": False,
                "status": self.dispute_status,
                "balance_transactions": list(self.dispute_transactions),
            }
        return await super().retrieve(kind, provider_id, **kwargs)

    async def create(self, kind, request, **kwargs):
        if kind == "transfer":
            result = {
                "id": "tr_" + request["metadata"]["scope_operation_id"],
                "object": "transfer",
                "metadata": request["metadata"],
                "amount": request["amount"],
                "currency": "usd",
                "destination": request["destination"],
                "reversed": False,
                "transfer_group": request["transfer_group"],
                "livemode": False,
            }
            result["balance_transaction"] = "txn_" + result["id"]
            self.transfers[result["id"]] = result
            return result
        if kind == "payout":
            result = {
                "id": "po_" + request["metadata"]["scope_operation_id"],
                "object": "payout",
                "metadata": request["metadata"],
                "amount": request["amount"],
                "currency": "usd",
                "livemode": False,
                "status": self.payout_status,
            }
            result["balance_transaction"] = "txn_" + result["id"]
            if result["status"] == "failed" and self.bad_failure_receipt != "missing":
                result["failure_balance_transaction"] = "txn_failure_" + result["id"]
            self.payouts[result["id"]] = result
            return result
        if kind == "transfer_reversal":
            result = {
                "id": "trr_" + request["metadata"]["scope_operation_id"],
                "object": "transfer_reversal",
                "metadata": request["metadata"],
                "amount": request["amount"],
                "currency": "usd",
                "transfer": request["transfer_id"],
            }
            self.reversals[result["id"]] = result
            transfer = self.transfers[request["transfer_id"]]
            transfer["amount_reversed"] = transfer.get("amount_reversed", 0) + request["amount"]
            self.connected_available -= request["amount"]
            return result
        return await super().create(kind, request, **kwargs)


def _payout_service(store, adapter):
    return ScopeCommerceProviderService(
        store,
        adapter=adapter,
        config=ScopeCommerceProviderConfig(
            enabled=True,
            platform_account_id="acct_platform",
            frontend_origin="https://example.test",
            countries={"US": CountryPayoutPolicy(1, 730, 200_000, 0)},
            fee_configuration_ref="fixture-fees",
        ),
    )
