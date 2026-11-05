"""Named managed Azure accounts: one selected identity, shared deployment names."""

from __future__ import annotations

import json
import os

import pytest

from hushh_mcp.managed_ai_config import (
    AZURE_ACCOUNT_FIELDS,
    PROFILE_PATH,
    load_managed_azure_account,
    load_managed_runtime_policy,
    load_private_drive_text_policy,
    load_pwm_policy,
    managed_azure_inventory,
    validate_runtime_config,
)

SPARE = {
    "tenant_id": "11111111-2222-4333-8444-555555555555",
    "client_id": "66666666-7777-4888-8999-aaaaaaaaaaaa",
    "primary_endpoint": "https://spare-account.openai.azure.com/openai/v1/",
    "phi_endpoint": "https://spare-account.services.ai.azure.com/openai/v1/",
    "readiness_exam_client_id": "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
}


@pytest.fixture(autouse=True)
def _packaged_selection(monkeypatch):
    for key in ("HUSHH_UAT_MANAGED_AI_PROVIDER", "HUSHH_UAT_MANAGED_TEXT_PROVIDER"):
        monkeypatch.delenv(key, raising=False)


def _document() -> dict:
    return json.loads(PROFILE_PATH.read_text())


def _write(tmp_path, document: dict, name: str = "managed-ai-runtime.json"):
    path = tmp_path / name
    path.write_text(json.dumps(document))
    return path


def _bindings(path) -> dict:
    return {
        provider: load_managed_runtime_policy(path, environment="uat", provider=provider)
        for provider in ("azure_openai", "vertex")
    }


def test_personal_sandbox_selects_azure_transport_without_uat_information_grants(monkeypatch):
    from hushh_mcp.managed_ai_config import sandbox_managed_azure_enabled
    from hushh_mcp.runtime_providers.managed_azure import ManagedAzureBinding
    from hushh_mcp.runtime_providers.managed_text import managed_text_policy

    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.delenv("HUSHH_DEPLOY_ENV", raising=False)
    monkeypatch.setenv("K_SERVICE", "backend-dev-akshat")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "hushh-akshat-sandbox-auth")
    monkeypatch.setenv("HUSSH_POD_MODE", "false")
    monkeypatch.delenv("HUSHH_SANDBOX_MANAGED_AI_PROVIDER", raising=False)
    assert ManagedAzureBinding.from_environment() is None
    monkeypatch.setenv("HUSHH_SANDBOX_MANAGED_AI_PROVIDER", "azure_openai")
    assert sandbox_managed_azure_enabled()
    binding = ManagedAzureBinding.from_environment()
    assert binding is not None and binding.capabilities["one_text_root"]["model"] == "gpt-5.4-mini"
    assert load_managed_runtime_policy(environment="production") is None
    assert load_managed_runtime_policy(environment="dev") is None
    assert managed_text_policy() is None
    assert os.environ["ENVIRONMENT"] == "development"
    assert os.environ["GOOGLE_CLOUD_PROJECT"] == "hushh-akshat-sandbox-auth"
    binding.require_current()
    monkeypatch.delenv("HUSHH_SANDBOX_MANAGED_AI_PROVIDER")
    with pytest.raises(RuntimeError, match="selection changed"):
        binding.require_current()


@pytest.mark.parametrize(
    "environment,service,pod,provider",
    [
        ("production", "backend-dev-akshat", "false", "azure_openai"),
        ("uat", "backend-dev-akshat", "false", "azure_openai"),
        ("development", "consent-protocol", "false", "azure_openai"),
        ("development", "backend-dev-akshat", "true", "azure_openai"),
        ("development", "backend-dev-akshat", "false", "unsupported"),
    ],
)
def test_sandbox_azure_flag_refuses_other_runtimes(
    monkeypatch, environment, service, pod, provider
):
    from hushh_mcp.managed_ai_config import sandbox_managed_azure_enabled

    monkeypatch.setenv("ENVIRONMENT", environment)
    monkeypatch.delenv("HUSHH_DEPLOY_ENV", raising=False)
    monkeypatch.setenv("K_SERVICE", service)
    monkeypatch.setenv("HUSSH_POD_MODE", pod)
    monkeypatch.setenv("HUSHH_SANDBOX_MANAGED_AI_PROVIDER", provider)
    with pytest.raises(ValueError, match="dedicated development backend"):
        sandbox_managed_azure_enabled()


def test_selected_account_resolves_to_the_inline_contract_without_rotating_bindings(tmp_path):
    named = _document()
    accounts = named["managed_azure_accounts"]
    selected = accounts["accounts"][accounts["selection"]["uat"]]
    inline = json.loads(json.dumps(named))
    del inline["managed_azure_accounts"]
    inline["pwm_research_uat"]["azure"].update({key: selected[key] for key in AZURE_ACCOUNT_FIELDS})
    named_path = _write(tmp_path, named, "named.json")
    inline_path = _write(tmp_path, inline, "inline.json")

    # Candidates predating named accounts keep their release receipts and bindings.
    assert _bindings(named_path) == _bindings(inline_path)
    assert load_pwm_policy(named_path, environment="uat", provider="azure_openai") == (
        load_pwm_policy(inline_path, environment="uat", provider="azure_openai")
    )
    account = load_managed_azure_account(named_path)
    assert account["name"] == accounts["selection"]["uat"]
    assert {key: account[key] for key in AZURE_ACCOUNT_FIELDS} == {
        key: selected[key] for key in AZURE_ACCOUNT_FIELDS
    }


def test_switching_the_selected_account_retargets_identity_without_new_consent(tmp_path):
    document = _document()
    baseline = _bindings(_write(tmp_path, document))
    document["managed_azure_accounts"]["accounts"]["spare"] = dict(SPARE)
    standby = _write(tmp_path, document)
    # A standby account is shape-checked before merge but changes nothing yet.
    assert validate_runtime_config(standby)["valid"] is True
    assert _bindings(standby) == baseline

    document["managed_azure_accounts"]["selection"]["uat"] = "spare"
    switched = _write(tmp_path, document)
    azure = load_pwm_policy(switched, environment="uat", provider="azure_openai")["azure"]
    assert {key: azure[key] for key in AZURE_ACCOUNT_FIELDS} == {
        key: SPARE[key] for key in AZURE_ACCOUNT_FIELDS
    }
    assert (
        azure["primary_deployment"] == document["pwm_research_uat"]["azure"]["primary_deployment"]
    )
    assert (
        load_managed_azure_account(switched)["readiness_exam_client_id"]
        == (SPARE["readiness_exam_client_id"])
    )
    # The operator inventory names every deployment the new account must host.
    inventory = managed_azure_inventory(switched)
    hosted = {
        kind
        for kind, value in document["managed_runtime_uat"]["azure"].items()
        if isinstance(value, dict)
    }
    assert inventory["account"]["name"] == "spare"
    assert set(inventory["deployments"]) == {"primary", *hosted}
    rotated = _bindings(switched)
    assert rotated["azure_openai"]["generation"] != baseline["azure_openai"]["generation"]
    assert load_private_drive_text_policy(switched) == load_private_drive_text_policy()


def _unknown_selection(document):
    document["managed_azure_accounts"]["selection"]["uat"] = "missing"


def _extra_selection(document):
    document["managed_azure_accounts"]["selection"]["dev"] = "azure-trial"


def _account_extra_key(document):
    account = next(iter(document["managed_azure_accounts"]["accounts"].values()))
    account["primary_deployment"] = "elsewhere"


def _both_forms(document):
    account = next(iter(document["managed_azure_accounts"]["accounts"].values()))
    document["pwm_research_uat"]["azure"]["tenant_id"] = account["tenant_id"]


def _shared_exam_identity(document):
    account = next(iter(document["managed_azure_accounts"]["accounts"].values()))
    account["readiness_exam_client_id"] = account["client_id"]


def _exam_identity_is_another_runtime_app(document):
    document["managed_azure_accounts"]["accounts"]["spare"] = {
        **SPARE,
        "client_id": "cccccccc-dddd-4eee-8fff-000000000000",
    }
    accounts = document["managed_azure_accounts"]
    account = accounts["accounts"][accounts["selection"]["uat"]]
    account["readiness_exam_client_id"] = "cccccccc-dddd-4eee-8fff-000000000000"


def _noncanonical_exam_identity(document):
    account = next(iter(document["managed_azure_accounts"]["accounts"].values()))
    account["readiness_exam_client_id"] = SPARE["readiness_exam_client_id"].upper()


def _insecure_standby(document):
    document["managed_azure_accounts"]["accounts"]["spare"] = {
        **SPARE,
        "primary_endpoint": "http://spare-account.openai.azure.com/openai/v1/",
    }


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (_unknown_selection, "account selection"),
        (_extra_selection, "account selection"),
        (_account_extra_key, "Invalid managed Azure account$"),
        (_both_forms, "must not repeat account identity"),
        (_shared_exam_identity, "own Entra application"),
        (_exam_identity_is_another_runtime_app, "own Entra application"),
        (_noncanonical_exam_identity, "own Entra application"),
        (_insecure_standby, "primary_endpoint"),
    ],
)
def test_account_configuration_fails_closed(tmp_path, mutate, message):
    document = _document()
    mutate(document)
    with pytest.raises(ValueError, match=message):
        validate_runtime_config(_write(tmp_path, document))
