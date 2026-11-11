from __future__ import annotations

import json

import pytest

from tests.test_uat_deploy_no_traffic_contract import (
    _managed_provider_gate,
    _provider_fixture,
    _read,
)


def _provider_execution_fixture(expected, value, provider, *, failed=False):
    document = json.loads(_read("consent-protocol/config/managed-ai-runtime.json"))
    vertex_project = document["environments"]["uat"]["project"]
    return {
        "metadata": {"ownerReferences": [{"name": value["job"]}]},
        "spec": {
            "template": {
                "spec": {
                    "serviceAccountName": expected["runtime_account"],
                    "containers": [
                        {
                            "image": expected["image"],
                            "command": ["python3"],
                            "args": [
                                "scripts/verify_azure_pwm_runtime.py"
                                if provider == "azure_openai"
                                else "scripts/verify_managed_vertex_runtime.py"
                            ],
                            "env": [
                                {"name": "ENVIRONMENT", "value": "uat"},
                                {"name": "GENAI_GOOGLE_CLOUD_PROJECT", "value": vertex_project},
                                {"name": "HUSHH_GENAI_AUTH_MODE", "value": "vertex_adc"},
                                {
                                    "name": "HUSHH_UAT_MANAGED_TEXT_PROVIDER",
                                    "value": provider,
                                },
                                {
                                    "name": "HUSHH_UAT_MANAGED_AI_PROVIDER",
                                    "value": provider,
                                },
                            ],
                        }
                    ],
                }
            }
        },
        "status": {"conditions": [{"type": "Completed", "status": "False" if failed else "True"}]},
    }


@pytest.mark.parametrize(
    "contract_failure", [False, True, "terminal_first", "delayed_capabilities"]
)
def test_collector_waits_for_terminal_and_retains_later_contract_failure(
    monkeypatch, contract_failure
):
    failed = contract_failure in (True, "terminal_first")
    module = _managed_provider_gate()
    expected, value = _provider_fixture(module, "azure_openai")
    core_log = {"jsonPayload": {"managed_text_provider_probe": value["core"]}}
    success = [
        core_log,
        {"jsonPayload": value["pwm_proof"]},
        {"jsonPayload": {"managed_capabilities_probe": value["capability_proof"]}},
        {"jsonPayload": {"azure_pwm_runtime_probe_result": "ok"}},
    ]
    failure = [
        core_log,
        {
            "jsonPayload": {
                "azure_pwm_probe_failure": "source attribution",
                "failed_fields": ["namesake"],
            }
        },
        {"jsonPayload": {"azure_pwm_runtime_probe_result": "failed", "error_type": "RuntimeError"}},
    ]
    if contract_failure == "terminal_first":
        # The terminal line carries the trust verdict even if the separate
        # authored-case marker has not reached Cloud Logging yet.
        failure = [
            core_log,
            {
                "jsonPayload": {
                    "azure_pwm_runtime_probe_result": "failed",
                    "error_type": "AzurePwmTrustError",
                    "pwm_trust_failure": True,
                }
            },
        ]
    calls = []

    def cloud(args):
        if args[:4] == ["run", "jobs", "executions", "list"]:
            return [{"metadata": {"name": value["execution"]}}]
        if args[:4] == ["run", "jobs", "executions", "describe"]:
            return _provider_execution_fixture(expected, value, "azure_openai", failed=failed)
        assert args[:2] == ["logging", "read"]
        calls.append(args)
        if len(calls) == 1:
            return (
                success[:2] + success[3:]
                if contract_failure == "delayed_capabilities"
                else [core_log]
            )
        return failure if failed else success

    monkeypatch.setattr(module, "run_json", cloud)
    monkeypatch.setattr(module.time, "sleep", lambda _: None)
    collected = module.collect("azure_openai", expected, int(failed), value["job"])
    assert len(calls) >= 2
    assert collected["core_ready"] is (not failed)
    assert collected["pwm_trust"] == ("failed" if failed else "passed")
    _, alternate = _provider_fixture(module, "vertex")
    admitted = module.evaluate({"azure_openai": collected, "vertex": alternate}, expected)
    assert admitted["ready"] is (not failed)


@pytest.mark.parametrize("case", ["success", "failed_modality", "missing_terminal", "invalid_core"])
def test_vertex_collector_finishes_from_its_own_terminal_receipt(monkeypatch, case):
    module = _managed_provider_gate()
    expected, value = _provider_fixture(module, "vertex")
    failed = case == "failed_modality"
    verdict = {
        "check": "managed_vertex_runtime",
        "ok": not failed,
        "managed_text_provider_probe": value["core"],
        "probes": [
            {
                "probe": "one_voice_live:synthetic",
                "ok": not failed,
                "classification": "provider_unavailable" if failed else "dependency_ok",
            }
        ],
    }
    if case == "missing_terminal":
        verdict.pop("check")
    if case == "invalid_core":
        verdict["managed_text_provider_probe"] = {**value["core"], "config_fingerprint": "stale"}
    calls, sleeps = [], []

    def cloud(args):
        if args[:4] == ["run", "jobs", "executions", "list"]:
            return [{"metadata": {"name": value["execution"]}}]
        if args[:4] == ["run", "jobs", "executions", "describe"]:
            return _provider_execution_fixture(expected, value, "vertex", failed=failed)
        assert args[:2] == ["logging", "read"]
        calls.append(args)
        return [{"jsonPayload": verdict}]

    monkeypatch.setattr(module, "run_json", cloud)
    monkeypatch.setattr(module.time, "sleep", sleeps.append)
    collected = module.collect("vertex", expected, int(failed), value["job"])
    assert len(calls) == (6 if case == "missing_terminal" else 1)
    assert sleeps == ([5] * 5 if case == "missing_terminal" else [])
    assert collected["core_ready"] is (case != "invalid_core")
    if case != "missing_terminal":
        assert collected["capabilities"] == {"one_voice_live:synthetic": not failed}
        assert collected["capability_classifications"] == {
            "one_voice_live:synthetic": "provider_unavailable" if failed else "dependency_ok"
        }
    if case == "invalid_core":
        assert (
            module.evaluate({"vertex": collected}, expected)["providers"]["vertex"]["ready"]
            is False
        )
