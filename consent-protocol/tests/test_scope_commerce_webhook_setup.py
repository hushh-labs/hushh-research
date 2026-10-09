"""Platform and Connect webhook credentials have exact environment destinations."""

from dataclasses import replace
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest

from hushh_mcp.services.scope_commerce.stripe_adapter import CommerceProviderError
from tests import test_scope_commerce_sandbox as setup

provider = setup.provider
_secret_destination = setup._secret_destination
_secret_sink = setup._secret_sink


@pytest.mark.parametrize("scope", ["platform", "connect"])
@pytest.mark.parametrize("mutation", [None, "account", "prefix", "scope", "project", "mode"])
def test_webhook_secret_destination_binds_preview_scope_account_and_project(
    provider, scope, mutation
):
    service, _facts = provider
    names = {
        "platform": "SCOPE_COMMERCE_SANDBOX_SCOPE_COMMERCE_STRIPE_WEBHOOK_SECRET",
        "connect": "SCOPE_COMMERCE_SANDBOX_SCOPE_COMMERCE_STRIPE_CONNECT_WEBHOOK_SECRET",
    }
    args = SimpleNamespace(
        **{
            "account_id": "acct_fixture",
            "webhook_scope": scope,
            "secret_name": names[scope],
            "secret_project": "hushh-pda-dev",
        },
    )
    evidence = {
        "schema_version": 1,
        "platform_account_id": "acct_fixture",
        "source": "dashboard_general_sandbox",
        "reference": "operator-inspection",
        "verification_owner": "operator",
        "verified_at": datetime.now(UTC).isoformat(),
        "secret_project": "hushh-pda-dev",
    }
    pin = {"platform_account_id": "acct_fixture", "livemode": False}
    if mutation == "account":
        pin["platform_account_id"] = "acct_other"
    elif mutation == "prefix":
        args.secret_name = names[scope].removeprefix("SCOPE_COMMERCE_SANDBOX_")
    elif mutation == "scope":
        args.webhook_scope = "connect" if scope == "platform" else "platform"
    elif mutation == "project":
        args.secret_project = evidence["secret_project"] = "production-project"
    elif mutation == "mode":
        pin["livemode"] = True
    if mutation:
        with pytest.raises(CommerceProviderError, match="sandbox_secret_destination_unapproved"):
            _secret_destination(args, evidence, config=service.config, pin=pin)
        return
    expected = f"projects/{args.secret_project}/secrets/{args.secret_name}"
    assert _secret_destination(args, evidence, config=service.config, pin=pin) == expected
    assert callable(_secret_sink(args, evidence, config=service.config, pin=pin))
    evidence["source"] = "stripe_cli_anonymous_sandbox"
    with pytest.raises(CommerceProviderError, match="sandbox_secret_destination_unapproved"):
        _secret_destination(args, evidence, config=service.config, pin=pin)
    args.secret_name = f"scope-commerce-sandbox-acct_fixture-{scope}-webhook"
    expected = f"projects/{args.secret_project}/secrets/{args.secret_name}"
    assert _secret_destination(args, evidence, config=service.config, pin=pin) == expected


@pytest.mark.parametrize("scope", ["platform", "connect"])
@pytest.mark.parametrize(
    "mutation",
    [
        None,
        "drive",
        "scope",
        "project",
        "origin",
        "callback",
        "service",
        "mode",
        "account",
        "policy",
    ],
)
def test_shared_dev_webhook_sink_requires_exact_commerce_callback_and_test_pin(
    provider, scope, mutation
):
    service, _ = provider
    config = replace(service.config, frontend_origin="https://dev.one.hushh.ai")
    names = {
        "platform": "SCOPE_COMMERCE_STRIPE_WEBHOOK_SECRET",
        "connect": "SCOPE_COMMERCE_STRIPE_CONNECT_WEBHOOK_SECRET",
    }
    backend = "https://consent-protocol-fixture-uc.a.run.app"
    args = SimpleNamespace(
        account_id="acct_fixture",
        webhook_scope=scope,
        secret_name=names[scope],
        **{"secret_project": "hushh-pda-dev"},
        webhook_url=backend + "/api/payments/scope-commerce/webhook",
    )
    evidence = {
        "schema_version": 1,
        "platform_account_id": "acct_fixture",
        "source": "dashboard_general_sandbox",
        "reference": "operator-inspection",
        "verification_owner": "operator",
        "verified_at": datetime.now(UTC).isoformat(),
        "secret_project": "hushh-pda-dev",
        "app_origin": config.frontend_origin,
        "backend_origin": backend,
        "backend_service": "projects/hushh-pda-dev/locations/us-central1/services/consent-protocol",
    }
    pin = {"platform_account_id": "acct_fixture", "livemode": False}
    if mutation == "drive":
        args.secret_name = "STRIPE_WEBHOOK_SECRET"
    elif mutation == "scope":
        args.webhook_scope = "connect" if scope == "platform" else "platform"
    elif mutation == "project":
        args.secret_project = evidence["secret_project"] = "production-project"
    elif mutation == "origin":
        evidence["app_origin"] = "https://other.example"
    elif mutation == "callback":
        args.webhook_url = "https://other.example/api/payments/scope-commerce/webhook"
    elif mutation == "service":
        evidence["backend_service"] = "projects/hushh-pda-dev/locations/us-central1/services/other"
    elif mutation == "mode":
        pin["livemode"] = True
    elif mutation == "account":
        pin["platform_account_id"] = "acct_other"
    elif mutation == "policy":
        config = replace(config, sandbox_policy_required=False)
    if mutation:
        with pytest.raises(CommerceProviderError, match="sandbox_secret_destination_unapproved"):
            _secret_destination(args, evidence, config=config, pin=pin)
    else:
        assert (
            _secret_destination(args, evidence, config=config, pin=pin)
            == f"projects/hushh-pda-dev/secrets/{names[scope]}"
        )
