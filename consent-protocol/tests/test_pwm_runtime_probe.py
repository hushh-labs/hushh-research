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


@pytest.mark.parametrize("defect", ["foreign_deployment", "later_schema"])
def test_primary_http_success_never_erases_later_qualification_failure(monkeypatch, capsys, defect):
    from unittest.mock import AsyncMock

    module, _, config = primary_fixture(monkeypatch, None)
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
                "latency_ms": 1,
                "deployment": "foreign"
                if defect == "foreign_deployment"
                else config["primary_deployment"],
                "error_class": None,
                "stage": "response_validation",
                "classification": "dependency_ok",
            }
        ),
    )
    monkeypatch.setattr(module, "_probe_managed_text", AsyncMock())
    monkeypatch.setattr(module, "_token_provider", lambda **_: lambda: "synthetic")
    primary = AsyncMock(side_effect=module.AzurePwmTrustError("PRIVATE_SYNTHETIC_ERROR"))
    monkeypatch.setattr(module, "_probe_primary", primary)
    assert module.main() == 1
    output = capsys.readouterr().out
    events = [json.loads(line) for line in output.splitlines()]
    assert events[-1]["classification"] == "candidate_misconfigured"
    assert events[-1]["pwm_trust_failure"] is (defect == "later_schema")
    assert events[0]["result"] == ("failed" if defect == "foreign_deployment" else "ok")
    assert primary.await_count == (1 if defect == "later_schema" else 0)
    assert "PRIVATE_SYNTHETIC_ERROR" not in output
