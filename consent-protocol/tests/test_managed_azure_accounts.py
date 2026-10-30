"""Named managed Azure accounts: one selected identity, shared deployment names."""

from __future__ import annotations

import json

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
        (_noncanonical_exam_identity, "own Entra application"),
        (_insecure_standby, "primary_endpoint"),
    ],
)
def test_account_configuration_fails_closed(tmp_path, mutate, message):
    document = _document()
    mutate(document)
    with pytest.raises(ValueError, match=message):
        validate_runtime_config(_write(tmp_path, document))
