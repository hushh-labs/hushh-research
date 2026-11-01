"""The real record path accepts authored Vertex probes and keeps history closed."""

import json
import sys

import pytest

from tests.scripts.test_managed_provider_receipt import _provider_capture_fixture
from tests.test_uat_deploy_no_traffic_contract import _managed_provider_gate, _provider_fixture


def _execution_fixture(value, expected, environment):
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
                            "args": ["scripts/verify_managed_vertex_runtime.py"],
                            "env": [
                                {"name": name, "value": item} for name, item in environment.items()
                            ],
                        }
                    ],
                }
            }
        },
        "status": {"conditions": [{"type": "Completed", "status": "True"}]},
    }


def _record_vertex(monkeypatch, scope):
    gate = _managed_provider_gate()
    expected, value = _provider_fixture(gate, "vertex")
    target = value["core"]["scopes"]["drive_document_requests"]
    model = target["model"] + "@" + target["location"]
    names = [
        "text:" + model,
        "adk:" + model,
        scope + ":" + model,
        "location_command:audio",
        "location_command:semantics",
        "one_voice_live:gemini-live-2.5-flash-native-audio@us-central1",
    ]
    terminal = {
        "check": "managed_vertex_runtime",
        "ok": True,
        "classification": "dependency_ok",
        "managed_text_provider_probe": value["core"],
        "probes": [
            {
                "probe": name,
                "ok": True,
                "classification": "dependency_ok",
                "attempts": [{"ok": True, "classification": "dependency_ok", "elapsed_ms": 10765}],
            }
            for name in names
        ],
    }
    environment = {
        "ENVIRONMENT": "uat",
        "HUSHH_GENAI_AUTH_MODE": "vertex_adc",
        "HUSHH_UAT_MANAGED_AI_PROVIDER": "vertex",
        "HUSHH_UAT_MANAGED_TEXT_PROVIDER": "vertex",
    }
    document = gate.json.loads(
        (gate.ROOT / "consent-protocol/config/managed-ai-runtime.json").read_text()
    )
    environment["GENAI_GOOGLE_CLOUD_PROJECT"] = document["environments"]["uat"]["project"]
    execution = _execution_fixture(value, expected, environment)

    def cloud(arguments):
        if arguments[:4] == ["run", "jobs", "executions", "list"]:
            return [{"metadata": {"name": value["execution"]}}]
        if arguments[:4] == ["run", "jobs", "executions", "describe"]:
            return execution
        assert arguments[:2] == ["logging", "read"] and value["execution"] in arguments[2]
        return [
            {"jsonPayload": terminal},
            {"jsonPayload": {"managed_capabilities_probe": value["capability_proof"]}},
        ]

    for name, item in expected.items():
        monkeypatch.setenv("READINESS_" + name.upper(), str(item))
    monkeypatch.setenv("READINESS_STEP_EXIT", "0")
    monkeypatch.setattr(gate, "run_json", cloud)
    monkeypatch.setattr(gate.time, "sleep", lambda _: None)
    monkeypatch.setattr(
        sys, "argv", ["readiness", "record", "--provider=vertex", "--job=" + value["job"]]
    )
    saved = []
    monkeypatch.setattr(gate, "write", lambda _path, receipt: saved.append(receipt))
    assert gate.main() == 0 and len(saved) == 1
    return gate, expected, saved[0], names


@pytest.mark.parametrize("scope", ["drive_document_requests", "one_chat"])
def test_vertex_record_preserves_actual_authored_probe_roster(monkeypatch, scope):
    gate, expected, observed, names = _record_vertex(monkeypatch, scope)
    assert observed["verified"] is True and observed["core_ready"] is True
    assert [row["probe"] for row in observed["probe_history"]] == names
    assert all("recovered_after_retry" not in row for row in observed["probe_history"])
    aggregate = gate.evaluate({"vertex": observed}, expected)
    assert aggregate["providers"]["vertex"]["ready"] is True
    assert aggregate["ready"] is False and aggregate["selected_provider"] is None


@pytest.mark.parametrize(
    "defect", ["scope", "model", "location", "suffix", "length", "azure", "history"]
)
def test_drive_probe_history_still_refuses_unreviewed_names_and_attempts(defect):
    helper = _managed_provider_gate()._capability_proof()
    name = "drive_document_requests:gemini-3.8-flash@global"
    invalid = {
        "scope": name.replace("drive_document_requests", "unreviewed"),
        "model": name.replace("gemini-3.8-flash", "gpt-test"),
        "location": name.replace("global", "global/extra"),
        "suffix": name + "\nPRIVATE_PROVIDER_BODY",
        "length": "drive_document_requests:gemini-" + "a" * 97 + "@global",
    }
    row = {
        "probe": invalid.get(defect, name),
        "attempts": [{"ok": True, "classification": "dependency_ok", "elapsed_ms": 10765}],
    }
    if defect == "history":
        row["attempts"] *= 3
    with pytest.raises(ValueError):
        helper.sanitize_probe_history(
            [row], provider="azure_openai" if defect == "azure" else "vertex"
        )


def test_vertex_capability_failure_survives_collection_without_private_payloads():
    helper = _managed_provider_gate()._capability_proof()
    diagnostics = helper.execution_diagnostics(
        "vertex",
        [
            {
                "check": "managed_vertex_runtime",
                "probes": [
                    {
                        "probe": "capability:one_text_root",
                        "ok": False,
                        "classification": "candidate_misconfigured",
                        "attempts": [
                            {
                                "ok": False,
                                "classification": "candidate_misconfigured",
                                "elapsed_ms": 3,
                                "error_type": "ValueError",
                                "failure_reason": "root.roundtrip_failed",
                                "error": "SYNTHETIC_PRIVATE_PROVIDER_BODY",
                            }
                        ],
                    }
                ],
            }
        ],
    )
    assert diagnostics["capabilities"]["capability:one_text_root"] is False
    assert (
        diagnostics["probe_history"][0]["attempts"][0]["failure_reason"] == "root.roundtrip_failed"
    )
    assert "SYNTHETIC_PRIVATE_PROVIDER_BODY" not in str(diagnostics)


@pytest.mark.parametrize(
    "classification", ["provider_unavailable", "candidate_misconfigured", "application_broken"]
)
def test_capture_accepts_only_qualified_degraded_provider_receipt(monkeypatch, classification):
    collector, expected, document, label, entries, _ = _provider_capture_fixture(
        monkeypatch, vertex=True
    )
    gate = _managed_provider_gate()
    _, azure = _provider_fixture(gate, "azure_openai", document=document)
    _, vertex = _provider_fixture(gate, "vertex", document=document)
    azure.update(
        core_ready=False,
        execution_terminal="False",
        step_exit=1,
        pwm_trust="unverified",
        failure_classification=classification,
    )
    aggregate = gate.evaluate(
        {"azure_openai": azure, "vertex": vertex}, expected, document=document
    )
    for entry in entries[:2]:
        entry["textPayload"] = label + ": " + json.dumps({"managed_provider_readiness": aggregate})
    selection = json.loads(entries[2]["textPayload"][len(label) + 2 :])
    selection["managed_provider_selection"]["provider"] = "vertex"
    entries[2]["textPayload"] = label + ": " + json.dumps(selection)
    if classification != "provider_unavailable":
        with pytest.raises(collector.ReceiptError, match="provider_readiness_unverified"):
            collector.from_entries(entries, expected, document, label)
        return
    result = collector.from_entries(entries, expected, document, label)
    assert result["readiness"]["status"] == "degraded_fallback"
    assert result["readiness"]["selected_provider"] == "vertex"
    assert (
        result["readiness"]["providers"]["azure_openai"]["failure_classification"] == classification
    )


@pytest.mark.parametrize(
    "result,classification",
    [
        ("ok", "dependency_ok"),
        ("failed", "provider_unavailable"),
        ("failed", "candidate_misconfigured"),
    ],
)
@pytest.mark.parametrize("reverse", [False, True])
def test_primary_transport_repeat_is_collected_without_erasing_either_outcome(
    result, classification, reverse
):
    helper = _managed_provider_gate()._capability_proof()
    rows = [
        {
            "azure_pwm_runtime_probe_stage": "primary_http",
            "result": "transport_retry",
            "attempt": 1,
            "classification": "provider_unavailable",
            "elapsed_ms": 30000,
            "error_type": "TimeoutError",
        },
        {
            "azure_pwm_runtime_probe_stage": "primary_http",
            "result": result,
            "attempt": 2,
            "classification": classification,
            "elapsed_ms": 2000,
        },
    ]
    history = helper.execution_diagnostics("azure_openai", rows[::-1] if reverse else rows)[
        "probe_history"
    ][0]
    assert [r["classification"] for r in history["attempts"]] == [
        "provider_unavailable",
        classification,
    ]
    assert history.get("recovered_after_retry", False) is (result == "ok")


@pytest.mark.parametrize(
    "defect", ["duplicate", "third", "orphan", "semantic_retry", "success_retry"]
)
def test_primary_retry_collection_rejects_missing_or_unauthorized_lineage(defect):
    helper = _managed_provider_gate()._capability_proof()
    first = {
        "azure_pwm_runtime_probe_stage": "primary_http",
        "result": "transport_retry",
        "attempt": 1,
        "classification": "provider_unavailable",
        "elapsed_ms": 30000,
    }
    second = {**first, "result": "ok", "attempt": 2, "classification": "dependency_ok"}
    rows = [first, second]
    if defect == "duplicate":
        rows.append(first)
    elif defect == "third":
        rows.append({**second, "attempt": 3})
    elif defect == "orphan":
        rows = [second]
    elif defect == "semantic_retry":
        first["classification"] = "candidate_misconfigured"
    else:
        first["result"] = "ok"
    with pytest.raises(ValueError):
        helper.execution_diagnostics("azure_openai", rows)


@pytest.mark.parametrize("stage", ["federation", "primary_http", "response_validation"])
def test_collector_keeps_azure_failure_stage_without_claiming_recovery(stage):
    helper = _managed_provider_gate()._capability_proof()
    timing = {
        "credential_setup": 2000,
        "token_acquisition": 1000,
        "primary_http": 27001,
        "response_validation": 0,
    }
    metadata = {
        "classification": "provider_unavailable",
        "elapsed_ms": 30001,
        "error_type": "TimeoutError",
        "failure_stage": stage,
        "phase_ms": timing,
        "deadline_expired": True,
    }
    result = helper.execution_diagnostics(
        "azure_openai",
        [
            {
                **metadata,
                "azure_pwm_runtime_probe_stage": "primary_http",
                "result": "failed",
                "error": "PRIVATE_PROVIDER_BODY",
            }
        ],
    )
    assert result == {
        "probe_history": [{"probe": "primary_http", "attempts": [{"ok": False, **metadata}]}]
    }
