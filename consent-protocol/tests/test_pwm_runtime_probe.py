"""Synthetic model guidance and attribution are mandatory candidate checks."""

import asyncio
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]


def primary_fixture(monkeypatch, defect):
    from unittest.mock import AsyncMock

    from hushh_mcp.one_adk import world_model_azure

    script = REPO_ROOT / "consent-protocol/scripts/verify_azure_pwm_runtime.py"
    spec = importlib.util.spec_from_file_location("azure_pwm_runtime_probe", script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    rows = [
        {"case_id": key, "supported": expected} for key, _, _, expected in module._ATTRIBUTION_CASES
    ]
    if defect == "wrong_attribution":
        rows[0]["supported"] = True
    elif defect == "reject_supported_attribution":
        for row in rows:
            if row["case_id"] in {"metric", "authorship"}:
                row["supported"] = False
    elif defect == "missing_case":
        rows.pop()
    elif defect == "unknown_case":
        rows[-1]["case_id"] = "untrusted-model-identifier"
    examples, _schemas = module._production_contract_examples()
    if defect == "wording":
        examples["report"]["summary"] = "No search was performed in this fictional evaluation."
    elif defect == "wrong_contract":
        examples["planner"]["action"] = "search"
    elif defect == "invented_attempt":
        examples["report"]["coverage"][0]["attempt_ids"] = [1]
    elif defect == "wrong_finding":
        examples["finding"] = {"skip": False}
    structured = AsyncMock(
        side_effect=[
            {"decisions": rows, **examples},
            {"query": "Alex Example LumenForge Transit Atlas"},
        ]
    )
    plan = AsyncMock(
        return_value={
            "action": "search",
            "plan": {
                "purpose": "identity",
                "seed_fields": ["full_name"],
                "anchor_ids": [],
                "candidate_id": None,
                "topics": ["publications"],
                "question": "Find public authorship records for the supplied paper.",
            },
        }
    )
    monkeypatch.setattr(
        world_model_azure,
        "AzurePwmGateway",
        lambda **kwargs: SimpleNamespace(structured=structured, plan=plan),
    )
    config = {
        "primary_endpoint": "https://synthetic.openai.azure.com/openai/v1/",
        "primary_deployment": "synthetic-primary",
    }
    return module, structured, config


@pytest.mark.parametrize(
    "defect",
    [
        None,
        "wording",
        "wrong_attribution",
        "reject_supported_attribution",
        "missing_case",
        "wrong_contract",
        "invented_attempt",
        "wrong_finding",
        "unknown_case",
    ],
)
def test_azure_pwm_primary_probe_requires_actual_attribution_decisions(monkeypatch, capsys, defect):
    module, structured, config = primary_fixture(monkeypatch, defect)
    if defect not in {None, "wording"}:
        with pytest.raises(RuntimeError, match="evaluation failed"):
            asyncio.run(module._probe_primary(config, lambda: "synthetic"))
        diagnostic = json.loads(capsys.readouterr().out)
        assert set(diagnostic["failed_fields"]) <= {
            "owner_declaration_source",
            "owner_declaration_identity",
            "repository",
            "degree",
            "merge",
            "namesake",
            "metric",
            "authorship",
            "assessment",
            "finding",
            "planner",
            "report",
        }
        assert "untrusted-model-identifier" not in json.dumps(diagnostic)
        if defect == "reject_supported_attribution":
            assert diagnostic == {
                "azure_pwm_probe_failure": "source attribution",
                "failed_fields": ["metric", "authorship"],
            }
    else:
        asyncio.run(module._probe_primary(config, lambda: "synthetic"))
        event = json.loads(capsys.readouterr().out)
        assert event["azure_pwm_attribution_cases"] == 8
        assert event["azure_pwm_confirmed_guidance"] == 2
        assert event["azure_pwm_production_contracts"] == 4
        assert len(event["policy_sha256"]) == 64
    assert structured.await_count == (2 if defect in {None, "wording"} else 1)
    request = structured.call_args_list[0].kwargs
    assert request["purpose"] == "source_attribution_evaluation"
    assert len(request["payload"]["cases"]) == 8
    assert all("supported" not in case for case in request["payload"]["cases"])


@pytest.mark.parametrize("defect", ["ignored_planner", "finished_planner", "ignored_query"])
def test_azure_pwm_probe_fails_when_confirmed_leads_are_ignored(defect, capsys):
    from unittest.mock import AsyncMock

    script = REPO_ROOT / "consent-protocol/scripts/verify_azure_pwm_runtime.py"
    spec = importlib.util.spec_from_file_location("azure_pwm_guidance_probe", script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    plan = {
        "purpose": "identity",
        "seed_fields": ["full_name"],
        "anchor_ids": [],
        "candidate_id": None,
        "topics": ["career" if defect == "ignored_planner" else "publications"],
        "question": "Find public original work.",
    }
    choice = (
        {"action": "finish", "plan": None}
        if defect == "finished_planner"
        else {"action": "search", "plan": plan}
    )
    gateway = SimpleNamespace(
        plan=AsyncMock(return_value=choice),
        structured=AsyncMock(return_value={"query": "Alex Example generic"}),
    )
    with pytest.raises(RuntimeError, match="evaluation failed"):
        asyncio.run(module._probe_confirmed_guidance(gateway))
    receipt = json.loads(capsys.readouterr().out)
    assert receipt["failed_fields"] == [
        "query_lead" if defect == "ignored_query" else "planner_lead"
    ]
    if defect != "ignored_query":
        has_plan = defect != "finished_planner"
        assert receipt["planner_conditions"] == {
            "search_plan": has_plan,
            "identity_purpose": has_plan,
            "no_anchors": has_plan,
            "no_candidate": has_plan,
            "publications": False,
        }
    assert "Alex" not in json.dumps(receipt)
    assert "LumenForge" not in json.dumps(receipt)


def pwm_proof_fixture(document):
    return {
        "azure_pwm_production_contracts": 4,
        "azure_pwm_attribution_cases": 8,
        "azure_pwm_confirmed_guidance": 2,
        "deployment": document["pwm_research_uat"]["azure"]["primary_deployment"],
        "policy_sha256": "c" * 64,
    }


@pytest.mark.parametrize(
    "error_type,stage,http_status,classification",
    [
        ("TimeoutError", "primary_http", None, "provider_unavailable"),
        ("TimeoutError", "federation", None, "provider_unavailable"),
        ("APITimeoutError", "primary_http", None, "provider_unavailable"),
        ("ReadinessResponseError", "response_validation", 200, "candidate_misconfigured"),
    ],
)
def test_outer_azure_probe_preserves_leaf_failure_provenance(
    monkeypatch, capsys, error_type, stage, http_status, classification
):
    from unittest.mock import AsyncMock, Mock

    module, _, config = primary_fixture(monkeypatch, None)
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.setattr(module, "_initialize_synthetic_runtime", lambda: None)
    monkeypatch.setattr(
        module,
        "load_pwm_policy",
        lambda **_: {"provider": "azure_openai_web_search", "azure": config},
    )
    monkeypatch.setattr(
        module,
        "run_probe",
        AsyncMock(
            return_value={
                "status": "unavailable",
                "http_status": http_status,
                "latency_ms": 30001,
                "deployment": config["primary_deployment"],
                "error_class": error_type,
                "stage": stage,
                "classification": classification,
            }
        ),
    )
    forbidden = Mock(side_effect=AssertionError("must stop at failed readiness"))
    monkeypatch.setattr(module, "_probe_managed_text", forbidden)
    assert module.main() == 1
    events = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert events[0]["result"] == "failed"
    assert events[-1] == {
        "azure_pwm_runtime_probe_result": "failed",
        "pwm_trust_failure": False,
        "classification": classification,
        "error_type": error_type,
        "failure_stage": stage,
        "elapsed_ms": 30001,
        "attempt": 1,
    }
    forbidden.assert_not_called()


def capability_fixture(monkeypatch):
    from unittest.mock import AsyncMock

    from hushh_mcp.managed_ai_config import PROFILE_PATH
    from scripts import probe_azure_openai_readiness, probe_managed_capabilities

    module, _, config = primary_fixture(monkeypatch, None)
    policy = {
        **json.loads(PROFILE_PATH.read_text())["managed_runtime_uat"],
        "provider": "azure_openai",
        "generation": "synthetic-generation",
    }
    config = {**config, "tenant_id": "synthetic", "client_id": "synthetic"}
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.setattr(module, "_initialize_synthetic_runtime", lambda: None)
    monkeypatch.setattr(
        module,
        "load_pwm_policy",
        lambda **_: {"provider": "azure_openai_web_search", "azure": config},
    )
    monkeypatch.setattr(
        module,
        "run_probe",
        AsyncMock(
            return_value={
                "status": "ready",
                "http_status": 200,
                "latency_ms": 7107,
                "deployment": config["primary_deployment"],
                "error_class": None,
                "stage": "response_validation",
                "classification": "dependency_ok",
            }
        ),
    )
    monkeypatch.setattr(module, "_probe_managed_text", AsyncMock())
    monkeypatch.setattr(module, "_token_provider", lambda **_: lambda: "synthetic")
    monkeypatch.setattr(module, "_probe_primary", AsyncMock())
    monkeypatch.setattr(probe_azure_openai_readiness, "load_managed_runtime_policy", lambda: policy)
    report = {
        "provider": "azure_openai",
        "policy_generation": "synthetic-generation",
        "ready": False,
        "capabilities": {
            name: {"ready": True, "elapsed_ms": 1} for name in policy["required_capabilities"]
        },
    }
    for name, error_type, elapsed_ms in (
        ("public_search", "TimeoutError", 87114),
        ("embeddings", "LocationBrainEmbeddingUnavailable", 8047),
    ):
        report["capabilities"][name] = {
            "ready": False,
            "elapsed_ms": elapsed_ms,
            "error_type": error_type,
            "classification": "provider_unavailable",
            "error": "PRIVATE_PROVIDER_OR_RESPONSE_TEXT",
        }
    capability_probe = AsyncMock(return_value=report)
    monkeypatch.setattr(probe_managed_capabilities, "probe_managed_capabilities", capability_probe)
    return module, report, capability_probe


@pytest.mark.parametrize("timeout_type", ["TimeoutError", "APITimeoutError"])
@pytest.mark.parametrize("embedding_first", [False, True])
@pytest.mark.parametrize("failure_reason", [None, "unlisted", "root.clock_selection"])
def test_capability_timeouts_reach_one_terminal_without_runtimeerror_masking(
    monkeypatch, capsys, timeout_type, embedding_first, failure_reason
):
    module, report, capability_probe = capability_fixture(monkeypatch)
    capability = "one_text_root" if failure_reason == "root.clock_selection" else "public_search"
    report["capabilities"]["public_search"], report["capabilities"][capability] = (
        report["capabilities"][capability],
        report["capabilities"]["public_search"],
    )
    report["capabilities"][capability]["error_type"] = timeout_type
    if failure_reason is not None:
        report["capabilities"][capability]["failure_reason"] = failure_reason
    if embedding_first:
        report["capabilities"][capability] = report["capabilities"].pop(capability)

    assert module.main() == 1

    output = capsys.readouterr().out
    events = [json.loads(line) for line in output.splitlines()]
    terminals = [event for event in events if "azure_pwm_runtime_probe_result" in event]
    failures = [
        {
            "capability": name,
            **{key: row[key] for key in ("classification", "error_type", "elapsed_ms")},
            **({"failure_reason": row["failure_reason"]} if "failure_reason" in row else {}),
        }
        for name, row in report["capabilities"].items()
        if not row["ready"]
    ]
    assert terminals == [
        {
            "azure_pwm_runtime_probe_result": "failed",
            "pwm_trust_failure": False,
            "classification": "provider_unavailable",
            "error_type": timeout_type,
            "failure_stage": capability,
            "elapsed_ms": 87114,
            "attempt": 1,
            "capability_failures": failures,
        }
    ]
    assert events[0]["result"] == "ok" and events[0]["http_status"] == 200
    assert "PRIVATE_PROVIDER_OR_RESPONSE_TEXT" not in output
    capability_probe.assert_awaited_once_with("azure_openai")


def test_wrapped_embedding_failure_is_not_inferred_to_be_a_timeout(monkeypatch, capsys):
    module, report, _ = capability_fixture(monkeypatch)
    report["capabilities"]["public_search"]["ready"] = True

    assert module.main() == 1

    terminal = json.loads(capsys.readouterr().out.splitlines()[-1])
    assert terminal["classification"] == "provider_unavailable"
    assert terminal["error_type"] == "LocationBrainEmbeddingUnavailable"
    assert terminal["failure_stage"] == "embeddings"
    assert terminal["elapsed_ms"] == 8047


@pytest.mark.parametrize(
    ("error_type", "classification"),
    [
        ("ValueError", "candidate_misconfigured"),
        ("PermissionError", "application_broken"),
        ("UnknownException", "application_broken"),
    ],
)
def test_mixed_capability_fault_stays_blocking(monkeypatch, capsys, error_type, classification):
    module, report, _ = capability_fixture(monkeypatch)
    report["capabilities"]["structured_text"] = {
        "ready": False,
        "elapsed_ms": 42,
        "error_type": error_type,
        "classification": classification,
    }

    assert module.main() == 1

    terminal = json.loads(capsys.readouterr().out.splitlines()[-1])
    assert terminal["classification"] == classification
    assert terminal["error_type"] == error_type
    assert terminal["failure_stage"] == "structured_text"
    assert terminal["elapsed_ms"] == 42
    assert len(terminal["capability_failures"]) == 3
    assert terminal["pwm_trust_failure"] is False


@pytest.mark.parametrize(
    "defect",
    [
        "missing",
        "unknown",
        "classification",
        "elapsed",
        "no_failure",
        "generation",
        "reason",
        "reason_type",
        "root.clock_selection",
        "live.response_incomplete",
    ],
)
def test_malformed_capability_failure_never_becomes_provider_advisory(monkeypatch, capsys, defect):
    module, report, _ = capability_fixture(monkeypatch)
    if defect == "missing":
        del report["capabilities"]["structured_text"]
    elif defect == "unknown":
        report["capabilities"]["PRIVATE_PROVIDER_OR_RESPONSE_TEXT"] = {
            "ready": True,
            "elapsed_ms": 1,
        }
    elif defect == "classification":
        report["capabilities"]["public_search"]["classification"] = "unknown"
    elif defect == "elapsed":
        report["capabilities"]["public_search"]["elapsed_ms"] = True
    elif defect == "generation":
        report["policy_generation"] = "changed-generation"
    elif defect in {"reason", "root.clock_selection", "live.response_incomplete"}:
        report["capabilities"]["public_search"]["failure_reason"] = (
            "PRIVATE_PROVIDER_OR_RESPONSE_TEXT" if defect == "reason" else defect
        )
    elif defect == "reason_type":
        report["capabilities"]["public_search"]["failure_reason"] = {
            "PRIVATE_PROVIDER_OR_RESPONSE_TEXT": True
        }
    else:
        for row in report["capabilities"].values():
            row["ready"] = True

    assert module.main() == 1

    output = capsys.readouterr().out
    terminal = json.loads(output.splitlines()[-1])
    assert terminal["classification"] == "candidate_misconfigured"
    assert terminal["error_type"] == "ReadinessResponseError"
    assert "capability_failures" not in terminal
    assert "PRIVATE_PROVIDER_OR_RESPONSE_TEXT" not in output


def test_ready_capability_pass_predicate_is_unchanged(monkeypatch, capsys):
    module, report, capability_probe = capability_fixture(monkeypatch)
    report["ready"] = True
    for row in report["capabilities"].values():
        row["ready"] = True

    assert module.main() == 0

    assert json.loads(capsys.readouterr().out.splitlines()[-1]) == {
        "azure_pwm_runtime_probe_result": "ok"
    }
    capability_probe.assert_awaited_once_with("azure_openai")
