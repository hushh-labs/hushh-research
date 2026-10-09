"""Sandbox setup cannot bypass real provider identity, budgets or receipt provenance."""

from __future__ import annotations

import copy
import json
import time
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

import pytest

from hushh_mcp.services.scope_commerce.provider_config import (
    CountryPayoutPolicy,
    ScopeCommerceProviderConfig,
)
from hushh_mcp.services.scope_commerce.provider_contracts import _opaque
from hushh_mcp.services.scope_commerce.provider_sandbox import SandboxPolicy
from hushh_mcp.services.scope_commerce.provider_service import ScopeCommerceProviderService
from hushh_mcp.services.scope_commerce.stripe_adapter import (
    CommerceProviderError,
    StripeScopeCommerceAdapter,
)
from tests.helpers.scope_commerce_provider import (
    _FinancialAdapter,
    _OperationAdapter,
    _OperationStore,
)
from tests.helpers.scope_commerce_provider import (
    sandbox_operator_helper as _operator_helper,
)

_secret_sink = _operator_helper("")._secret_sink
_secret_destination = _operator_helper("")._secret_destination
_policy = _operator_helper("_policy")
capital_budget, isolation_evidence, reviewer_bindings = (
    _policy.capital_budget,
    _policy.isolation_evidence,
    _policy.reviewer_bindings,
)
_provider = _operator_helper("_provider")
SandboxProvider, WebhookProvisioner = _provider.SandboxProvider, _provider.WebhookProvisioner


@pytest.fixture
def provider(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "sandbox")
    monkeypatch.delenv("HUSHH_DEPLOY_ENV", raising=False)
    facts = {
        "account": {
            "id": "acct_fixture",
            "country": "US",
            "default_currency": "usd",
            "settings": {"payouts": {"schedule": {"interval": "manual"}}},
        },
        "balance": {"livemode": False},
        "topups": [],
        "endpoints": [],
        "created": 0,
    }

    def topup(**parameters):
        facts["created"] += 1
        value = {
            "id": "tu_fixture",
            "object": "topup",
            "livemode": False,
            "status": "pending",
            "amount": parameters["amount"],
            "currency": parameters["currency"],
            "metadata": parameters["metadata"],
        }
        facts["topups"].append(value)
        return value

    def endpoint(**parameters):
        facts["created"] += 1
        value = {
            "id": "we_fixture",
            "object": "webhook_endpoint",
            "livemode": False,
            "status": "enabled",
            "url": parameters["url"],
            "metadata": parameters["metadata"],
            "api_version": parameters["api_version"],
            "enabled_events": parameters["enabled_events"],
            "secret": "whsec_synthetic_setup_fixture",
            "application": "ca_fixture" if parameters["connect"] else None,
        }
        facts["endpoints"].append(value)
        return value

    api = SimpleNamespace(
        Account=SimpleNamespace(retrieve=lambda **_kwargs: facts["account"]),
        Balance=SimpleNamespace(retrieve=lambda **_kwargs: facts["balance"]),
        Topup=SimpleNamespace(
            list=lambda **_kwargs: {"data": facts["topups"], "has_more": False}, create=topup
        ),
        WebhookEndpoint=SimpleNamespace(
            list=lambda **_kwargs: {"data": facts["endpoints"], "has_more": False}, create=endpoint
        ),
    )
    for name in (
        "Customer",
        "Refund",
        "Transfer",
        "Payout",
        "Charge",
        "BalanceTransaction",
        "PaymentIntent",
        "Event",
        "Dispute",
    ):
        setattr(api, name, SimpleNamespace())
    api.checkout = SimpleNamespace(Session=SimpleNamespace())
    config = ScopeCommerceProviderConfig(
        platform_account_id="acct_fixture",
        frontend_origin="https://example.test",
        sandbox_policy_required=True,
        sandbox_policy=SandboxPolicy("acct_fixture", ("owner", "buyer")),
    )
    return SandboxProvider(
        StripeScopeCommerceAdapter("test-only", "test-only", stripe_api=api), config
    ), facts


@pytest.mark.asyncio
@pytest.mark.parametrize("mutation", ["mode", "account", "currency", "schedule"])
async def test_sandbox_platform_mismatch_stops_before_provider_mutation(provider, mutation):
    service, facts = provider
    if mutation == "mode":
        facts["balance"]["livemode"] = True
    elif mutation == "account":
        facts["account"]["id"] = "acct_other"
    elif mutation == "currency":
        facts["account"]["default_currency"] = "cad"
    else:
        facts["account"]["settings"]["payouts"]["schedule"]["interval"] = "daily"
    with pytest.raises(CommerceProviderError, match="sandbox_platform_custody_mismatch"):
        await service.provision_capital(
            {}, operation_id=str(uuid4()), amount_cents=2500, persist=lambda _state: None
        )
    assert facts["created"] == 0


@pytest.mark.asyncio
async def test_capital_aggregate_cap_includes_pending_and_unknown_receipts_and_replays_once(
    provider,
):
    service, facts = provider
    state, committed = {}, []
    operation = str(uuid4())

    def persist(value):
        committed.append(copy.deepcopy(value))

    first = await service.provision_capital(
        state, operation_id=operation, amount_cents=2500, persist=persist
    )
    assert committed[0]["capital_attempts"][operation]["amount_cents"] == 2500
    assert "provider_id" not in committed[0]["capital_attempts"][operation]
    assert first["ledgerCredited"] is False
    await service.provision_capital(
        state, operation_id=operation, amount_cents=2500, persist=persist
    )
    assert facts["created"] == 1
    with pytest.raises(CommerceProviderError, match="sandbox_capital_budget_exceeded"):
        await service.provision_capital(
            state, operation_id=str(uuid4()), amount_cents=1, persist=persist
        )
    assert facts["created"] == 1
    unknown = {str(uuid4()): {"amount_cents": 2500, "created_at": datetime.now(UTC).isoformat()}}
    assert capital_budget([], unknown, 2500) == 2500
    with pytest.raises(CommerceProviderError, match="sandbox_capital_budget_exceeded"):
        capital_budget(facts["topups"], unknown, 2500)


@pytest.mark.asyncio
async def test_unknown_capital_attempt_never_resubmits_after_provider_retry_window(provider):
    service, facts = provider
    operation = str(uuid4())
    state = {
        "capital_attempts": {
            operation: {
                "amount_cents": 2500,
                "created_at": (datetime.now(UTC) - timedelta(days=1)).isoformat(),
            }
        }
    }
    with pytest.raises(CommerceProviderError, match="sandbox_capital_reconciliation_required"):
        await service.provision_capital(
            state, operation_id=operation, amount_cents=2500, persist=lambda _state: None
        )
    assert facts["created"] == 0


@pytest.mark.asyncio
async def test_capital_enumeration_failure_never_creates_provider_credit(provider):
    service, facts = provider
    service.adapter.stripe_api.Topup.list = lambda **_kwargs: {"data": [], "has_more": True}
    with pytest.raises(CommerceProviderError, match="sandbox_provider_list_incomplete"):
        await service.provision_capital(
            {}, operation_id=str(uuid4()), amount_cents=2500, persist=lambda _state: None
        )
    assert facts["created"] == 0


@pytest.mark.asyncio
async def test_webhook_provision_scopes_are_explicit_and_secrets_use_only_private_sink(provider):
    service, facts = provider
    secrets, commits = [], []
    result = await WebhookProvisioner(service).provision(
        scope="connect",
        url="https://api.example.test/api/payments/scope-commerce/webhook",
        api_version="2025-02-24.acacia",
        operation_id=str(uuid4()),
        state={},
        persist=lambda state: commits.append(copy.deepcopy(state)),
        write_secret=secrets.append,
    )
    assert result["scope"] == "connect" and result["secretStored"] is True
    assert "secret" not in result and "whsec_" not in str(commits)
    assert secrets == ["whsec_synthetic_setup_fixture"]
    assert set(facts["endpoints"][0]["enabled_events"]) == {
        "account.updated",
        "payout.paid",
        "payout.failed",
        "payout.canceled",
    }
    with pytest.raises(CommerceProviderError, match="sandbox_webhook_configuration_invalid"):
        await WebhookProvisioner(service).provision(
            scope="platform",
            url="http://example.test/api/payments/scope-commerce/webhook",
            api_version="fixture",
            operation_id=str(uuid4()),
            state={},
            persist=lambda _state: None,
            write_secret=secrets.append,
        )
    assert facts["created"] == 1


def test_isolation_is_account_bound_operator_evidence_and_reviewers_are_distinct():
    value = {
        "schema_version": 1,
        "platform_account_id": "acct_fixture",
        "source": "dashboard_general_sandbox",
        "reference": "dashboard-inspection",
        "verification_owner": "operator",
        "verified_at": datetime.now(UTC).isoformat(),
    }
    assert isolation_evidence(value, "acct_fixture") == "dashboard_general_sandbox"
    with pytest.raises(CommerceProviderError, match="sandbox_isolation_evidence_invalid"):
        isolation_evidence(value, "acct_other")
    policy = SandboxPolicy("acct_fixture", ("owner", "buyer"))
    reviewers = {
        "schema_version": 1,
        "reviewers": {
            "primary": {"user_id": "owner", "identity_binding_ref": "canonical"},
            "counterpart": {"user_id": "buyer", "identity_binding_ref": "canonical"},
        },
    }
    assert reviewer_bindings(reviewers, policy) == {"primary": "owner", "counterpart": "buyer"}
    reviewers["reviewers"]["counterpart"]["user_id"] = "owner"
    with pytest.raises(CommerceProviderError, match="sandbox_reviewer_binding_invalid"):
        reviewer_bindings(reviewers, policy)


@pytest.mark.asyncio
async def test_source_refund_proof_requires_actual_original_intent_and_actor(provider):
    service, _facts = provider
    metadata = {"payer_ref": _opaque("buyer")}
    refund = {
        "id": "re_fixture",
        "object": "refund",
        "currency": "usd",
        "payment_intent": "pi_fixture",
        "amount": 50,
        "metadata": metadata,
        "status": "succeeded",
    }
    service.adapter.stripe_api.Refund = SimpleNamespace(retrieve=lambda *_args, **_kwargs: refund)
    service.adapter.stripe_api.PaymentIntent = SimpleNamespace(
        retrieve=lambda *_args, **_kwargs: {"id": "pi_fixture", "livemode": False}
    )
    row = {
        "provider_id": "re_fixture",
        "operation_provider_id": "re_fixture",
        "status": "succeeded",
        "request_json": {"payment_intent": "pi_fixture", "metadata": metadata},
        "payment_intent_id": "pi_fixture",
        "amount_micro_usd": 500000,
        "funding_id": uuid4(),
        "obligation_id": uuid4(),
    }
    assert (await service._refund_receipt(row, "buyer"))["originalSourceVerified"]
    refund["payment_intent"] = "pi_other"
    with pytest.raises(CommerceProviderError, match="sandbox_refund_receipt_mismatch"):
        await service._refund_receipt(row, "buyer")
    refund["payment_intent"] = "pi_fixture"
    with pytest.raises(CommerceProviderError, match="sandbox_refund_receipt_mismatch"):
        await service._refund_receipt(row, "other")


@pytest.mark.asyncio
async def test_bank_receipt_proof_rejects_wrong_source_and_unreconciled_actual_cost(provider):
    service, _facts = provider
    withdrawal_id = uuid4()
    metadata = {
        "payer_ref": _opaque("buyer"),
        "withdrawal_id": str(withdrawal_id),
        "scope_operation_id": str(uuid4()),
    }
    adapter = service.adapter = _FinancialAdapter()
    payout = await adapter.create("payout", {"metadata": metadata, "amount": 50})
    transfer = await adapter.create(
        "transfer",
        {
            "metadata": metadata,
            "amount": 51,
            "destination": "acct_seller",
            "transfer_group": "fixture",
        },
    )

    async def operation(*_args):
        return {"request_json": {"metadata": metadata, "stripe_account": "acct_seller"}}

    connection = SimpleNamespace(fetchrow=operation)
    row = {
        "withdrawal_id": withdrawal_id,
        "payout_id": payout["id"],
        "transfer_id": transfer["id"],
        "account_id": "acct_seller",
        "net_cents": 50,
        "status": "succeeded",
        "settled_micro_usd": 530000,
    }
    assert await service._bank_receipt(connection, row, "buyer") == (True, True)
    transaction_id = payout["balance_transaction"]
    transaction = await adapter.retrieve("balance_transaction", transaction_id)
    adapter.dispute_transactions[transaction_id] = {**transaction, "source": "po_unrelated"}
    with pytest.raises(CommerceProviderError, match="provider_payout_receipt_mismatch"):
        await service._bank_receipt(connection, row, "buyer")
    adapter.dispute_transactions[transaction_id] = transaction
    row["settled_micro_usd"] = 500000
    with pytest.raises(CommerceProviderError, match="sandbox_payout_journal_mismatch"):
        await service._bank_receipt(connection, row, "buyer")


@pytest.mark.asyncio
async def test_onboarding_refresh_requires_authenticated_fresh_attempt_and_never_replays_expired_link():
    store, adapter = _OperationStore(), _OperationAdapter()
    service = ScopeCommerceProviderService(
        store,
        adapter=adapter,
        config=ScopeCommerceProviderConfig(
            frontend_origin="https://example.test",
            sandbox_policy=SandboxPolicy("acct_fixture", ("owner", "other")),
            countries={
                "US": CountryPayoutPolicy(1, 90, 0, 0),
                "CA": CountryPayoutPolicy(1, 90, 0, 0),
            },
        ),
    )
    accounts = {
        user: {"account_id": "acct_" + user, "country": "US", "livemode": False}
        for user in ("owner", "other")
    }

    async def admit(**_kwargs):
        return None

    async def binding(user):
        return accounts[user]

    async def create(_kind, request, **_kwargs):
        adapter.created += 1
        adapter.request = request
        return {
            "object": "account_link",
            "url": "https://connect.stripe.com/setup/fixture",
            "expires_at": int(time.time()) + 300,
        }

    service._admit, service._seller_binding, adapter.create = admit, binding, create
    attempt = str(uuid4())
    await service.onboarding(user_id="owner", country="US", operation_id=attempt)
    normal = parse_qs(urlsplit(adapter.request["return_url"]).query)
    refresh = parse_qs(urlsplit(adapter.request["refresh_url"]).query)
    assert normal == {"commerceAttemptId": [attempt], "commerceReturn": ["1"]}
    assert refresh == {**normal, "commerceAction": ["onboarding_refresh"]}
    assert adapter.request["account"] == "acct_owner"
    await service.onboarding(user_id="owner", country="US", operation_id=attempt)
    assert adapter.created == 1
    with pytest.raises(CommerceProviderError, match="provider_operation_conflict"):
        await service.onboarding(user_id="other", country="US", operation_id=attempt)
    with pytest.raises(CommerceProviderError, match="provider_account_mismatch"):
        await service.onboarding(user_id="owner", country="CA", operation_id=str(uuid4()))
    response = json.loads(store.operations[attempt]["provider_response"])
    response["expires_at"] = int(time.time()) - 1
    store.operations[attempt]["provider_response"] = json.dumps(response)
    with pytest.raises(CommerceProviderError, match="provider_onboarding_link_expired"):
        await service.onboarding(user_id="owner", country="US", operation_id=attempt)
    assert adapter.created == 1
    await service.onboarding(user_id="owner", country="US", operation_id=str(uuid4()))
    assert adapter.created == 2
    operation_count = len(store.operations)
    with pytest.raises(CommerceProviderError, match="provider_sandbox_reviewer_required"):
        await service.onboarding(user_id="outsider", country="US", operation_id=str(uuid4()))
    assert adapter.created == 2 and len(store.operations) == operation_count
    from api.routes.scope_commerce_contracts import _error

    denial = _error(CommerceProviderError("provider_sandbox_reviewer_required"))
    assert denial.status_code == 403 and denial.detail == {
        "code": "provider_sandbox_reviewer_required"
    }


@pytest.mark.parametrize(
    "environments,livemode,allowed",
    [({"dev"}, False, True), ({"dev"}, True, False), ({"dev", "production"}, False, False)],
)
def test_shared_dev_sandbox_requires_test_mode_and_excludes_production(
    environments, livemode, allowed
):
    policy = SandboxPolicy("acct_platform", ("owner", "buyer"))
    if allowed:
        policy.validate(
            account_id="acct_platform", livemode=livemode, runtime_environments=environments
        )
    else:
        with pytest.raises(CommerceProviderError, match="provider_sandbox_environment_mismatch"):
            policy.validate(
                account_id="acct_platform", livemode=livemode, runtime_environments=environments
            )


@pytest.mark.parametrize(
    "mutation", ["missing", "live", "production", "account", "users", "funding", "capital"]
)
def test_sandbox_policy_is_required_and_bound_to_test_account_and_fixed_budget(
    monkeypatch, mutation
):
    monkeypatch.setenv("ENVIRONMENT", "sandbox")
    monkeypatch.delenv("HUSHH_DEPLOY_ENV", raising=False)
    value = {
        "environment": "sandbox",
        "platform_account_id": "acct_platform",
        "reviewer_user_ids": ["owner", "buyer"],
        "reviewer_funding_cap_cents": 2000,
        "operating_capital_cap_cents": 2500,
    }
    if mutation == "users":
        value["reviewer_user_ids"] = ["owner", "owner"]
    elif mutation == "funding":
        value["reviewer_funding_cap_cents"] = 2001
    elif mutation == "capital":
        value["operating_capital_cap_cents"] = 2501
    if mutation in {"users", "funding", "capital"}:
        with pytest.raises(CommerceProviderError, match="provider_sandbox_policy_invalid"):
            SandboxPolicy.parse(value)
        return
    policy = None if mutation == "missing" else SandboxPolicy.parse(value)
    if mutation == "production":
        monkeypatch.setenv("ENVIRONMENT", "production")
    config = ScopeCommerceProviderConfig(
        platform_account_id="acct_other" if mutation == "account" else "acct_platform",
        frontend_origin="https://example.test",
        sandbox_policy=policy,
        sandbox_policy_required=True,
        livemode=mutation == "live",
    )
    with pytest.raises(CommerceProviderError, match="provider_sandbox"):
        config.validate(new_activity=False)
