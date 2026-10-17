"""Provider receipt, operation replay and live-admission security contracts."""

from __future__ import annotations

import copy
import hashlib
import hmac
import json
import time
from datetime import timedelta
from types import SimpleNamespace
from uuid import uuid4

import pytest

from hushh_mcp.services.scope_commerce.provider_prerequisites import provider_prerequisites
from hushh_mcp.services.scope_commerce.provider_sandbox import SandboxPolicy
from hushh_mcp.services.scope_commerce.provider_service import (
    CountryPayoutPolicy,
    ScopeCommerceProviderConfig,
    ScopeCommerceProviderService,
    _projection,
)
from hushh_mcp.services.scope_commerce.stripe_adapter import (
    CommerceProviderError,
    StripeScopeCommerceAdapter,
)
from tests.helpers.scope_commerce_provider import (
    _capital_fixture,
    _FinancialAdapter,
    _funding_service,
    _FundingAdapter,
    _OperationAdapter,
    _OperationStore,
    _receipt_fixture,
)
from tests.helpers.scope_commerce_provider_db import provider_postgres as provider_postgres


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "mutation", [None, "source", "mode", "currency", "pending", "net", "missing", "connected"]
)
async def test_operating_capital_requires_actual_platform_available_receipt(mutation):
    adapter = _FundingAdapter()
    store = _OperationStore()
    records = []

    async def record(**receipt):
        records.append(receipt)

    store.record_operating_capital_balance_transaction = record
    service = _funding_service(store, adapter)
    topup, transactions = _capital_fixture(adapter, reversed=True)
    event = {"id": "evt_capital", "type": "topup.reversed"}
    if mutation == "source":
        transactions[0]["source"] = "tu_unrelated"
    elif mutation == "mode":
        topup["livemode"] = True
    elif mutation == "currency":
        transactions[0]["currency"] = "cad"
    elif mutation == "pending":
        transactions[0]["status"] = "pending"
    elif mutation == "net":
        transactions[0]["net"] = 999
    elif mutation == "missing":
        transactions.pop()
    elif mutation == "connected":
        event["account"] = "acct_unrelated"
    if mutation:
        with pytest.raises(CommerceProviderError, match="provider_capital_receipt"):
            await service._handle_capital_event(event, topup)
        assert records == []
    else:
        await service._handle_capital_event(event, topup)
        assert [row["net_micro_usd"] for row in records] == [1_000_000, -1_000_000]
        assert all(row["platform_account_id"] == "acct_platform" for row in records)


@pytest.mark.asyncio
async def test_country_policy_requires_actual_usd_payout_routing():
    adapter = _FinancialAdapter()
    service = ScopeCommerceProviderService(
        _OperationStore(),
        adapter=adapter,
        config=ScopeCommerceProviderConfig(countries={"CA": CountryPayoutPolicy(1, 90, 0, 0)}),
    )
    account = await adapter.retrieve("seller_account", "acct_fixture")
    account["country"] = "CA"
    assert service._seller_eligible(account, "CA")
    account["default_currency"] = "cad"
    assert not service._seller_eligible(account, "CA")
    account["default_currency"] = "usd"
    account["external_accounts"]["data"][0]["currency"] = "cad"
    assert not service._seller_eligible(account, "CA")
    account["external_accounts"] = {"data": []}
    assert not service._seller_eligible(account, "CA")


@pytest.mark.asyncio
async def test_new_platform_activity_requires_manual_usd_custody_but_reconciliation_survives():
    adapter = _FinancialAdapter()
    store = _OperationStore()
    bindings = []

    async def bind(**identity):
        bindings.append(identity)

    store.bind_environment = bind
    service = _funding_service(store, adapter)

    async def automatic_identity():
        return {
            "id": "acct_platform",
            "country": "US",
            "default_currency": "usd",
            "settings": {"payouts": {"schedule": {"interval": "daily"}}},
        }

    adapter.platform_identity = automatic_identity
    with pytest.raises(
        CommerceProviderError, match="provider_platform_custody_configuration_required"
    ):
        await service._admit()
    await service._admit(new_activity=False)
    assert bindings[-1] == {"platform_account_id": "acct_platform", "livemode": False}

    async def foreign_identity():
        return {
            "id": "acct_platform",
            "country": "US",
            "default_currency": "cad",
            "settings": {"payouts": {"schedule": {"interval": "manual"}}},
        }

    adapter.platform_identity = foreign_identity
    with pytest.raises(
        CommerceProviderError, match="provider_platform_custody_configuration_required"
    ):
        await service._admit()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "mutation",
    [
        None,
        "customer",
        "amount",
        "fee_float",
        "fee_net",
        "currency",
        "mode",
        "scope",
        "refunded",
        "disputed",
    ],
)
async def test_funding_receipt_rejects_wrong_binding_and_never_estimates_fee(mutation):
    intent, expected = _receipt_fixture()
    intent = copy.deepcopy(intent)
    if mutation == "customer":
        intent["customer"] = "cus_other"
    elif mutation == "amount":
        intent["amount_received"] = 49
    elif mutation == "fee_float":
        intent["latest_charge"]["balance_transaction"]["fee"] = 32.0
    elif mutation == "fee_net":
        intent["latest_charge"]["balance_transaction"]["net"] = 50
    elif mutation == "currency":
        intent["latest_charge"]["balance_transaction"]["currency"] = "eur"
    elif mutation == "mode":
        intent["livemode"] = True
    elif mutation == "scope":
        intent["metadata"]["scope_operation_id"] = str(uuid4())
    elif mutation == "refunded":
        intent["latest_charge"]["refunded"] = True
    elif mutation == "disputed":
        intent["latest_charge"]["disputed"] = True
    api = SimpleNamespace(PaymentIntent=SimpleNamespace(retrieve=lambda *_args, **_kwargs: intent))
    adapter = StripeScopeCommerceAdapter("test-only", "test-only", stripe_api=api)
    if mutation:
        with pytest.raises(CommerceProviderError, match="provider_receipt_mismatch"):
            await adapter.funding_receipt("pi_fixture", expected=expected)
    else:
        receipt = await adapter.funding_receipt("pi_fixture", expected=expected)
        assert receipt.fee_micro_usd == 320_000
        assert receipt.amount_cents == 50


def test_unsigned_webhook_rejected_before_parsing_and_valid_input_uses_raw_bytes():
    observed = []

    def construct(payload, signature, secret, **kwargs):
        observed.append((payload, signature, secret, kwargs))
        return {"id": "evt_fixture", "livemode": False}

    adapter = StripeScopeCommerceAdapter(
        "test-only",
        "test-only",
        stripe_api=SimpleNamespace(Webhook=SimpleNamespace(construct_event=construct)),
    )
    with pytest.raises(CommerceProviderError, match="provider_invalid_signature"):
        adapter.verify_webhook(b'{"amount":50}', None)
    assert observed == []
    raw = b' {"amount":50} '
    assert adapter.verify_webhook(raw, "fixture-signature")["id"] == "evt_fixture"
    assert observed[0][0] is raw
    assert observed[0][3]["tolerance"] == 300


def test_live_configuration_requires_business_approvals_even_when_enabled():
    config = ScopeCommerceProviderConfig(
        enabled=True,
        livemode=True,
        platform_account_id="acct_fixture",
        frontend_origin="https://example.test",
    )
    with pytest.raises(CommerceProviderError, match="provider_unavailable"):
        config.validate(new_activity=True)
    sandbox = ScopeCommerceProviderConfig(
        enabled=True, platform_account_id="acct_fixture", frontend_origin="https://example.test"
    )
    sandbox.validate(new_activity=True)


def test_country_configuration_rejects_unattributed_costs(monkeypatch):
    policy = {
        "currency": "usd",
        "minimum_cents": 1,
        "retention_days": 90,
        "fixed_fee_micro_usd": 0,
        "fee_basis_points": 0,
        "unattributed_fees": True,
    }
    monkeypatch.setenv("SCOPE_COMMERCE_COUNTRY_POLICIES_JSON", json.dumps({"US": policy}))
    with pytest.raises(CommerceProviderError, match="provider_configuration_invalid"):
        ScopeCommerceProviderConfig.from_env()
    policy["unattributed_fees"] = False
    monkeypatch.setenv("SCOPE_COMMERCE_COUNTRY_POLICIES_JSON", json.dumps({"US": policy}))
    assert ScopeCommerceProviderConfig.from_env().countries["US"].minimum_cents == 1


@pytest.mark.asyncio
async def test_durable_retry_recovers_uncertain_success_and_rejects_changed_request():
    store, adapter = _OperationStore(), _OperationAdapter()
    service = ScopeCommerceProviderService(
        store, adapter=adapter, config=ScopeCommerceProviderConfig()
    )
    operation_id = str(uuid4())
    metadata = service._metadata(operation_id, "owner")

    async def run(request):
        return await service._run_operation(
            user_id="owner",
            operation_id=operation_id,
            kind="customer",
            request=request,
            validate=lambda value: service._validate_object(
                value, object_type="customer", metadata=metadata
            ),
        )

    adapter.fail_after_create = True
    with pytest.raises(CommerceProviderError, match="provider_reconciliation_required"):
        await run({"metadata": metadata})
    assert store.operations[operation_id]["status"] == "reconciliation_required"
    assert (await run({"metadata": metadata}))["id"] == "cus_fixture"
    assert adapter.created == 1
    with pytest.raises(CommerceProviderError, match="provider_operation_conflict"):
        await run({"metadata": metadata, "name": "changed"})
    assert adapter.created == 1


@pytest.mark.asyncio
async def test_old_uncertain_operation_never_recreates_after_idempotency_window():
    store, adapter = _OperationStore(), _OperationAdapter()
    service = ScopeCommerceProviderService(
        store, adapter=adapter, config=ScopeCommerceProviderConfig()
    )
    operation_id = str(uuid4())
    request = {"metadata": service._metadata(operation_id, "owner")}
    adapter.fail_after_create = True

    async def run():
        return await service._run_operation(
            user_id="owner",
            operation_id=operation_id,
            kind="customer",
            request=request,
            validate=lambda _value: None,
        )

    with pytest.raises(CommerceProviderError):
        await run()
    store.operations[operation_id]["created_at"] -= timedelta(days=2)
    adapter.recovered = None
    with pytest.raises(CommerceProviderError, match="provider_reconciliation_required"):
        await run()
    assert adapter.created == 1


def test_provider_projection_drops_customer_and_bank_private_fields():
    projected = _projection(
        "customer",
        {
            "id": "cus_fixture",
            "object": "customer",
            "email": "private@example.test",
            "address": {"line1": "private"},
            "tax_ids": {"data": ["private"]},
            "invoice_settings": {"default_payment_method": "private"},
        },
    )
    assert projected == {"id": "cus_fixture", "object": "customer"}


def test_real_stripe_signature_rejects_payload_mutation():
    adapter = StripeScopeCommerceAdapter("test-only", "test-webhook-secret")
    raw = json.dumps(
        {
            "id": "evt_fixture",
            "object": "event",
            "livemode": False,
            "type": "checkout.session.completed",
            "data": {"object": {"amount_total": 50}},
        }
    ).encode()
    timestamp = int(time.time())
    digest = hmac.new(
        b"test-webhook-secret", str(timestamp).encode() + b"." + raw, hashlib.sha256
    ).hexdigest()
    signature = f"t={timestamp},v1={digest}"
    assert adapter.verify_webhook(raw, signature)["id"] == "evt_fixture"
    with pytest.raises(CommerceProviderError, match="provider_invalid_signature"):
        adapter.verify_webhook(raw.replace(b"50", b"51"), signature)


@pytest.mark.parametrize(
    "scope,secret,accepted",
    [
        (False, "platform", True),
        (True, "connect", True),
        (True, "platform", False),
        (False, "connect", False),
    ],
)
def test_endpoint_signatures_bind_platform_and_connected_event_scopes(scope, secret, accepted):
    fixture_connect_key = "connect"
    adapter = StripeScopeCommerceAdapter(
        "test-only", "platform", connect_webhook_secret=fixture_connect_key
    )
    event = {"id": "evt_fixture", "livemode": False}
    if scope:
        event["account"] = "acct_seller"
    raw = json.dumps(event).encode()
    stamp = int(time.time())
    digest = hmac.new(secret.encode(), str(stamp).encode() + b"." + raw, hashlib.sha256).hexdigest()
    signature = f"t={stamp},v1={digest}"
    if accepted:
        assert adapter.verify_webhook(raw, signature) == event
    else:
        with pytest.raises(CommerceProviderError, match="provider_invalid_event"):
            adapter.verify_webhook(raw, signature)


@pytest.mark.asyncio
async def test_missing_connect_secret_blocks_new_activity_without_blocking_reconciliation(
    monkeypatch,
):
    monkeypatch.setenv("SCOPE_COMMERCE_STRIPE_SECRET_KEY", "sk_test_" + "synthetic_fixture_key")
    monkeypatch.setenv("SCOPE_COMMERCE_STRIPE_WEBHOOK_SECRET", "whsec_" + "synthetic_platform_key")
    monkeypatch.delenv("SCOPE_COMMERCE_STRIPE_CONNECT_WEBHOOK_SECRET", raising=False)
    monkeypatch.delenv("SCOPE_COMMERCE_STRIPE_WEBHOOK_MODE", raising=False)
    store = _OperationStore()

    async def bind(**_kwargs):
        return None

    store.bind_environment = bind
    config = ScopeCommerceProviderConfig(
        platform_account_id="acct_platform", frontend_origin="https://example.test"
    )
    service = ScopeCommerceProviderService(store, config=config)
    assert provider_prerequisites(config, new_activity=False) == {
        "ready": True,
        "reason_code": None,
    }
    assert (
        provider_prerequisites(config)["reason_code"]
        == "provider_connect_webhook_configuration_required"
    )
    service.adapter.stripe_api = SimpleNamespace(
        Account=SimpleNamespace(
            retrieve=lambda **_kwargs: {"id": "acct_platform", "country": "US"}
        ),
        Balance=SimpleNamespace(retrieve=lambda **_kwargs: {"livemode": False}),
    )
    await service._admit(new_activity=False)
    with pytest.raises(
        CommerceProviderError, match="provider_connect_webhook_configuration_required"
    ):
        await service._admit()
    monkeypatch.delenv("SCOPE_COMMERCE_STRIPE_SECRET_KEY")
    await service._admit(new_activity=False)


@pytest.mark.parametrize(
    "mutation,reason",
    [
        (None, None),
        ("key", "provider_credentials_required"),
        ("mode_key", "provider_credentials_required"),
        ("primary", "provider_webhooks_required"),
        ("connect", "provider_webhooks_required"),
        ("same", "provider_webhooks_required"),
        ("mode", "provider_unavailable"),
        ("cli", "provider_unavailable"),
        ("cli_policy", None),
        ("cli_production", "provider_sandbox_environment_mismatch"),
    ],
)
def test_provider_prerequisites_match_constructor_and_never_project_credentials(
    monkeypatch, mutation, reason
):
    values = {
        "SCOPE_COMMERCE_STRIPE_SECRET_KEY": "sk_test_" + "synthetic_fixture_key",
        "SCOPE_COMMERCE_STRIPE_WEBHOOK_SECRET": "whsec_" + "synthetic_platform_key",
        "SCOPE_COMMERCE_STRIPE_CONNECT_WEBHOOK_SECRET": "whsec_" + "synthetic_connect_key",
        "SCOPE_COMMERCE_STRIPE_WEBHOOK_MODE": "endpoints",
    }
    if mutation == "key":
        values["SCOPE_COMMERCE_STRIPE_SECRET_KEY"] = ""
    elif mutation == "mode_key":
        values["SCOPE_COMMERCE_STRIPE_SECRET_KEY"] = "sk_live_" + "synthetic_fixture_key"
    elif mutation == "primary":
        values["SCOPE_COMMERCE_STRIPE_WEBHOOK_SECRET"] = ""
    elif mutation == "connect":
        values["SCOPE_COMMERCE_STRIPE_CONNECT_WEBHOOK_SECRET"] = "invalid"
    elif mutation == "same":
        values["SCOPE_COMMERCE_STRIPE_CONNECT_WEBHOOK_SECRET"] = values[
            "SCOPE_COMMERCE_STRIPE_WEBHOOK_SECRET"
        ]
    elif mutation in {"mode", "cli"}:
        values["SCOPE_COMMERCE_STRIPE_WEBHOOK_MODE"] = "cli" if mutation == "cli" else "unknown"
    config = ScopeCommerceProviderConfig()
    if mutation in {"cli_policy", "cli_production"}:
        monkeypatch.setenv(
            "ENVIRONMENT", "production" if mutation == "cli_production" else "sandbox"
        )
        values["SCOPE_COMMERCE_STRIPE_WEBHOOK_MODE"] = "cli"
        values["SCOPE_COMMERCE_STRIPE_CONNECT_WEBHOOK_SECRET"] = ""
        config = ScopeCommerceProviderConfig(
            platform_account_id="acct_fixture",
            frontend_origin="https://example.test",
            sandbox_policy=SandboxPolicy("acct_fixture", ("owner", "buyer")),
        )
    assert provider_prerequisites(config, environment=values) == {
        "ready": reason is None,
        "reason_code": reason,
    }
    for name, value in values.items():
        monkeypatch.setenv(name, value)
    if reason:
        error_code = reason if mutation == "cli_production" else "provider_unavailable"
        with pytest.raises(CommerceProviderError, match=error_code):
            ScopeCommerceProviderService(_OperationStore(), config=config)
    else:
        assert isinstance(
            ScopeCommerceProviderService(_OperationStore(), config=config).adapter,
            StripeScopeCommerceAdapter,
        )


@pytest.mark.asyncio
async def test_historical_funding_proof_allows_refund_without_weakening_credit_admission():
    intent, expected = _receipt_fixture()
    intent["latest_charge"].update(refunded=True, amount_refunded=50)
    api = SimpleNamespace(PaymentIntent=SimpleNamespace(retrieve=lambda *_args, **_kwargs: intent))
    adapter = StripeScopeCommerceAdapter("test-only", "test-only", stripe_api=api)
    with pytest.raises(CommerceProviderError, match="provider_receipt_mismatch"):
        await adapter.funding_receipt("pi_fixture", expected=expected)
    assert (
        await adapter.historical_funding_receipt("pi_fixture", expected=expected)
    ).fee_micro_usd == 320_000
    intent["latest_charge"]["balance_transaction"]["source"] = "ch_other"
    with pytest.raises(CommerceProviderError, match="provider_receipt_mismatch"):
        await adapter.historical_funding_receipt("pi_fixture", expected=expected)
