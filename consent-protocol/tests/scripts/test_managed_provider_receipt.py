"""Capture preserves only exact-build readiness evidence and bounded diagnostics."""

import importlib
import json
import sys

import pytest
import yaml

from tests.test_uat_deploy_no_traffic_contract import (
    REPO_ROOT,
    _managed_provider_gate,
    _provider_fixture,
    _read,
)


def _provider_capture_fixture(monkeypatch, azure=True, vertex=False):
    monkeypatch.syspath_prepend(str(REPO_ROOT / "scripts/ci"))
    collector = importlib.import_module("capture_managed_provider_receipt")
    gate = _managed_provider_gate()
    expected, a = _provider_fixture(gate, "azure_openai")
    _, v = _provider_fixture(gate, "vertex")
    aggregate = gate.evaluate(
        {"azure_openai": a if azure else None, "vertex": v if vertex else None}, expected
    )
    document = json.loads(_read("consent-protocol/config/managed-ai-runtime.json"))
    selection = {
        "context": expected,
        "managed_provider_selection": {
            "provider": aggregate["selected_provider"],
            "status": "verified",
            "revision": "consent-protocol-test-rev",
            "image": expected["image"],
            "traffic_percent": 0,
        },
    }
    build_steps = yaml.safe_load(_read("deploy/backend.cloudbuild.yaml"))["steps"]
    aggregate_index, aggregate_step = next(
        (index, step)
        for index, step in enumerate(build_steps)
        if step.get("id") == "verify-managed-provider-readiness"
    )
    label = f'Step #{aggregate_index} - "verify-managed-provider-readiness"'

    def entry(value, number):
        return {
            "resource": {
                "type": "build",
                "labels": {"build_id": expected["build_id"], "project_id": expected["project"]},
            },
            "labels": {"build_step": label},
            "textPayload": label + ": " + json.dumps(value),
            "insertId": str(number),
            "timestamp": "2026-10-21T12:00:01Z",
        }

    entries = [
        entry({"managed_provider_readiness": aggregate}, 1),
        entry({"managed_provider_readiness": aggregate}, 2),
        entry(selection, 3),
    ]
    build = {
        "id": expected["build_id"],
        "projectId": expected["project"],
        "status": "SUCCESS",
        "startTime": "2026-10-21T12:00:00Z",
        "finishTime": "2026-10-21T12:01:00Z",
        "substitutions": dict(
            _DEPLOY_SHA=expected["source_sha"],
            _GITHUB_RUN_ID=expected["github_run"],
            _IMAGE_REFERENCE=expected["image"],
            _RUNTIME_SERVICE_ACCOUNT=expected["runtime_account"],
            _DEPLOY_ENV=expected["environment"],
            _REGION=expected["region"],
            _BACKEND_SERVICE="consent-protocol",
            _CLOUD_RUN_TAG="account-deletion-" + expected["github_run"],
            _SKIP_MANAGED_VERTEX_RUNTIME_FOR_RELEASE="false",
        ),
        "steps": [{}] * aggregate_index + [{**aggregate_step, "status": "SUCCESS"}],
    }
    return collector, expected, document, label, entries, build


@pytest.mark.parametrize(
    "azure,vertex,preferred",
    [
        (True, False, "azure_openai"),
        (False, True, None),
        (True, True, "azure_openai"),
        (False, False, None),
    ],
)
def test_uploaded_provider_receipt_uses_exact_remote_build_without_stdout(
    monkeypatch, azure, vertex, preferred
):
    collector, expected, document, label, entries, build = _provider_capture_fixture(
        monkeypatch, azure, vertex
    )
    calls = []

    def read(arguments, deadline):
        calls.append(arguments)
        return build if arguments[:2] == ["builds", "describe"] else entries

    if preferred is None:
        with pytest.raises(collector.ReceiptError, match="provider_readiness_unverified"):
            collector.collect(expected, document, read=read)
    else:
        result = collector.collect(expected, document, read=read)
        assert result["selection_verified"] is True
        assert result["readiness"]["selected_provider"] == preferred
        assert len(result["collection"]["logs"]) == 3
        assert collector.check_build(build, expected) == label
    assert calls[0][2] == expected["build_id"]
    assert expected["build_id"] in calls[1][2]


@pytest.mark.parametrize(
    "defect",
    [
        "build",
        "failed_build",
        "failed_step",
        "dependency_deploy-backend",
        "dependency_verify-azure-pwm-runtime",
        "dependency_verify-managed-vertex-runtime",
        "dependency_unexpected",
        "run",
        "image",
        "log_build",
        "log_step",
        "context",
        "selection",
        "conflict",
        "trust",
        "truncated",
    ],
)
def test_uploaded_provider_receipt_refuses_unbound_or_ambiguous_evidence(monkeypatch, defect):
    collector, expected, document, label, entries, build = _provider_capture_fixture(monkeypatch)
    if defect == "build":
        build["id"] = "foreign-build"
    elif defect == "failed_build":
        build["status"] = "FAILURE"
    elif defect == "failed_step":
        build["steps"][-1]["status"] = "FAILURE"
    elif defect.startswith("dependency_"):
        dependency = defect.removeprefix("dependency_")
        parents = build["steps"][-1]["waitFor"]
        if dependency == "unexpected":
            parents.append(dependency)
        else:
            parents.remove(dependency)
    elif defect == "run":
        build["substitutions"]["_GITHUB_RUN_ID"] = "wrong-run"
    elif defect == "image":
        build["substitutions"]["_IMAGE_REFERENCE"] = "wrong-image"
    elif defect == "log_build":
        entries[0]["resource"]["labels"]["build_id"] = "foreign-build"
    elif defect == "log_step":
        entries[0]["labels"]["build_step"] = "another-step"
    elif defect == "selection":
        entries[-1]["textPayload"] = (
            label + ": " + json.dumps({"context": {}, "managed_provider_selection": {}})
        )
    elif defect == "truncated":
        entries *= 34
    else:
        value = json.loads(entries[0]["textPayload"][len(label) + 2 :])
        if defect == "context":
            value["managed_provider_readiness"]["context"] = {}
        elif defect == "trust":
            value["managed_provider_readiness"]["pwm_trust"] = "failed"
        else:
            value["managed_provider_readiness"]["ready"] = False
        entries[0]["textPayload"] = label + ": " + json.dumps(value)
        if defect != "conflict":
            entries[1]["textPayload"] = entries[0]["textPayload"]
    with pytest.raises(collector.ReceiptError):
        collector.collect(
            expected,
            document,
            read=lambda arguments, deadline: (
                build if arguments[:2] == ["builds", "describe"] else entries
            ),
        )


@pytest.mark.parametrize("visible", [True, False])
def test_uploaded_provider_receipt_has_bounded_log_visibility_recovery(monkeypatch, visible):
    collector, expected, document, _, entries, build = _provider_capture_fixture(monkeypatch)
    reads = 0
    sleeps = []

    def read(arguments, deadline):
        nonlocal reads
        if arguments[:2] == ["builds", "describe"]:
            return build
        reads += 1
        return entries if visible and reads > 1 else []

    if visible:
        assert (
            collector.collect(expected, document, read=read, sleep=sleeps.append)["collection"][
                "attempts"
            ]
            == 2
        )
    else:
        with pytest.raises(collector.ReceiptError, match="receipt_logs_not_visible"):
            collector.collect(expected, document, read=read, sleep=sleeps.append)
        assert reads == 6
    assert sleeps == [5] * (reads - 1)


def test_provider_capture_failure_writes_artifact_and_fails(monkeypatch, tmp_path):
    collector, _, _, _, _, _ = _provider_capture_fixture(monkeypatch)
    path = tmp_path / "provider-receipt.json"
    monkeypatch.setattr(sys, "argv", ["capture", "--output", str(path)])
    monkeypatch.setenv("READINESS_BUILD_ID", "invalid")
    assert collector.main() == 1
    assert json.loads(path.read_text())["selection_verified"] is False
    assert path.stat().st_mode & 0o777 == 0o600


def test_provider_capture_missing_target_companion_still_writes_failure_artifact(
    monkeypatch, tmp_path
):
    collector, _, _, _, _, _ = _provider_capture_fixture(monkeypatch)
    path = tmp_path / "provider-receipt.json"
    monkeypatch.setattr(sys, "argv", ["capture", "--output", str(path)])

    def unavailable(name):
        raise ModuleNotFoundError(name)

    monkeypatch.setattr(collector.importlib, "import_module", unavailable)
    assert collector.main() == 1
    assert json.loads(path.read_text()) == {
        "selection_verified": False,
        "collection": {"status": "failed", "reason": "receipt_collection_unavailable"},
    }


def recovery_history():
    return [
        {
            "probe": "one_chat:gemini-test@global",
            "attempts": [
                {
                    "ok": False,
                    "classification": "provider_unavailable",
                    "elapsed_ms": 25000,
                    "error_type": "TimeoutError",
                    "error": "PRIVATE_PROVIDER_BODY",
                },
                {"ok": True, "classification": "dependency_ok", "elapsed_ms": 1200},
            ],
        }
    ]


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


@pytest.mark.parametrize("history_kind", ["recovered", "clean", "foreign_context"])
def test_receipt_preserves_only_actual_same_candidate_retry_history(monkeypatch, history_kind):
    collector, expected, document, label, entries, _ = _provider_capture_fixture(monkeypatch)
    gate = _managed_provider_gate()
    _, azure = _provider_fixture(gate, "azure_openai")
    _, vertex = _provider_fixture(gate, "vertex")
    history = recovery_history()
    if history_kind == "clean":
        history[0]["attempts"] = history[0]["attempts"][1:]
    probe = {
        "probe": history[0]["probe"],
        "ok": True,
        "classification": "dependency_ok",
        "attempts": history[0]["attempts"],
    }
    vertex.update(
        gate._capability_proof().execution_diagnostics(
            "vertex", [{"check": "managed_vertex_runtime", "probes": [probe]}]
        )
    )
    if history_kind == "foreign_context":
        vertex["context"] = {**expected, "source_sha": "f" * 40}
    aggregate = gate.evaluate({"azure_openai": azure, "vertex": vertex}, expected)
    for entry in entries[:2]:
        entry["textPayload"] = label + ": " + json.dumps({"managed_provider_readiness": aggregate})
    result = collector.from_entries(entries, expected, document, label)
    diagnostic = result["readiness"]["providers"]["vertex"]
    if history_kind == "foreign_context":
        assert "probe_history" not in diagnostic
    else:
        actual = diagnostic["probe_history"][0]
        assert actual["attempts"][-1] == history[0]["attempts"][-1]
        if history_kind == "recovered":
            assert actual["attempts"][0] == {
                "ok": False,
                "classification": "provider_unavailable",
                "elapsed_ms": 25000,
                "error_type": "TimeoutError",
            }
            assert actual["recovered_after_retry"] is True
        else:
            assert "recovered_after_retry" not in actual
    assert "PRIVATE_PROVIDER_BODY" not in json.dumps(result)
    assert result["readiness"]["context"] == expected


@pytest.mark.parametrize(
    "defect",
    ["too_many", "negative_latency", "hard_fault", "false_recovery", "azure_retry", "reason_scope"],
)
def test_receipt_refuses_unproven_retry_lineage(monkeypatch, defect):
    collector, expected, document, label, entries, _ = _provider_capture_fixture(monkeypatch)
    history = recovery_history()
    if defect == "too_many":
        history[0]["attempts"] *= 2
    elif defect == "negative_latency":
        history[0]["attempts"][0]["elapsed_ms"] = -1
    elif defect == "hard_fault":
        history[0]["attempts"][0]["classification"] = "candidate_misconfigured"
    elif defect == "azure_retry":
        history[0]["probe"] = "primary_http"
    elif defect == "reason_scope":
        history[0]["attempts"][0]["failure_reason"] = "root.clock_selection"
    else:
        history[0].update(attempts=history[0]["attempts"][1:], recovered_after_retry=True)
    value = json.loads(entries[0]["textPayload"][len(label) + 2 :])
    provider = "azure_openai" if defect == "azure_retry" else "vertex"
    value["managed_provider_readiness"]["providers"][provider]["probe_history"] = history
    for entry in entries[:2]:
        entry["textPayload"] = label + ": " + json.dumps(value)
    with pytest.raises(ValueError):
        collector.from_entries(entries, expected, document, label)


def azure_capability_failure_logs(failure_reason=None):
    capability = "one_text_root" if failure_reason == "root.clock_selection" else "public_search"
    rows = [
        {"azure_pwm_runtime_probe_stage": "primary_http", "result": "ok", "elapsed_ms": 7107},
        {
            "azure_pwm_runtime_probe_result": "failed",
            "attempt": 1,
            "capability_failures": [
                {
                    "capability": capability,
                    "classification": "provider_unavailable",
                    "error_type": "TimeoutError",
                    "elapsed_ms": 87114,
                    "error": "PRIVATE_PROVIDER_BODY",
                },
                {
                    "capability": "embeddings",
                    "classification": "provider_unavailable",
                    "error_type": "LocationBrainEmbeddingUnavailable",
                    "elapsed_ms": 8047,
                },
            ],
        },
    ]
    if failure_reason is not None:
        rows[-1]["capability_failures"][0]["failure_reason"] = failure_reason
    return rows


@pytest.mark.parametrize("binding", [None, "image", "account", "job"])
@pytest.mark.parametrize("failure_reason", [None, "unlisted", "root.clock_selection"])
def test_collector_keeps_closed_capability_failures_only_after_execution_binding(
    monkeypatch, binding, failure_reason
):
    gate = _managed_provider_gate()
    expected, value = _provider_fixture(gate, "azure_openai")
    spec = {
        "serviceAccountName": expected["runtime_account"],
        "containers": [
            {
                "image": expected["image"],
                "command": ["python3"],
                "args": ["scripts/verify_azure_pwm_runtime.py"],
                "env": [
                    {"name": "ENVIRONMENT", "value": "uat"},
                    {"name": "HUSHH_UAT_MANAGED_AI_PROVIDER", "value": "azure_openai"},
                    {"name": "HUSHH_UAT_MANAGED_TEXT_PROVIDER", "value": "azure_openai"},
                ],
            }
        ],
    }
    owner = value["job"]
    if binding == "image":
        spec["containers"][0]["image"] = "foreign-image"
    elif binding == "account":
        spec["serviceAccountName"] = "foreign-account"
    elif binding == "job":
        owner = "foreign-job"

    def cloud(arguments):
        if arguments[:4] == ["run", "jobs", "executions", "list"]:
            return [{"metadata": {"name": value["execution"]}}]
        if arguments[:4] == ["run", "jobs", "executions", "describe"]:
            return {
                "metadata": {"ownerReferences": [{"name": owner}]},
                "spec": {"template": {"spec": spec}},
                "status": {"conditions": [{"type": "Completed", "status": "False"}]},
            }
        assert value["execution"] in arguments[2]
        rows = azure_capability_failure_logs(failure_reason) + [
            {"managed_text_provider_probe": value["core"]},
            value["pwm_proof"],
            {"managed_capabilities_probe": {**value["capability_proof"], "ready": False}},
        ]
        return [{"jsonPayload": row} for row in rows]

    monkeypatch.setattr(gate, "run_json", cloud)
    observed = gate.collect("azure_openai", expected, 1, value["job"])
    aggregate = gate.evaluate({"azure_openai": observed}, expected)
    assert aggregate["ready"] is False and aggregate["selected_provider"] is None
    diagnostic = aggregate["providers"]["azure_openai"]
    if binding:
        assert observed["verified"] is False and "probe_history" not in diagnostic
        return
    history = diagnostic["probe_history"]
    assert observed["core_ready"] is False and "capability_proof" not in observed
    assert [row["probe"] for row in history] == [
        "primary_http",
        "capability:one_text_root"
        if failure_reason == "root.clock_selection"
        else "capability:public_search",
        "capability:embeddings",
    ]
    assert [row["attempts"][0]["elapsed_ms"] for row in history] == [7107, 87114, 8047]
    assert history[1]["attempts"][0]["error_type"] == "TimeoutError"
    assert history[1]["attempts"][0].get("failure_reason") == failure_reason
    assert history[2]["attempts"][0]["error_type"] == "LocationBrainEmbeddingUnavailable"
    assert all("recovered_after_retry" not in row for row in history)
    assert "PRIVATE_PROVIDER_BODY" not in json.dumps(aggregate)


@pytest.mark.parametrize(
    "defect",
    ["unknown", "duplicate", "duration", "classification", "success", "attempt", "reason", "pair"],
)
def test_azure_capability_diagnostics_refuse_unproven_failure_rows(defect):
    logs = azure_capability_failure_logs()
    failures = logs[-1]["capability_failures"]
    if defect == "unknown":
        failures[0]["capability"] = "PRIVATE_PROVIDER_BODY"
    elif defect == "duplicate":
        failures.append(dict(failures[0]))
    elif defect == "duration":
        failures[0]["elapsed_ms"] = 420001
    elif defect == "classification":
        failures[0]["classification"] = "dependency_ok"
    elif defect == "attempt":
        logs[-1]["attempt"] = 2
    elif defect == "reason":
        failures[0]["failure_reason"] = "PRIVATE_PROVIDER_BODY"
    elif defect == "pair":
        failures[0]["failure_reason"] = "root.clock_selection"
    else:
        logs[-1]["azure_pwm_runtime_probe_result"] = "ok"
    with pytest.raises(ValueError):
        _managed_provider_gate()._capability_proof().execution_diagnostics("azure_openai", logs)
