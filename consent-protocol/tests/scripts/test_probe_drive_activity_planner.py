"""Synthetic planner qualification and fail-closed Azure wrapper contracts."""

import importlib.util
import json
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services.drive_request_semantic_plan import parse_semantic_plan
from scripts.probe_drive_activity_planner import ActivityPlannerContractError, grade_plan


def ordinary_plan():
    common = {"match": "token", "negated": False, "discovery_terms": []}
    return {
        "version": 2,
        "status": "ready",
        "metadata_listing": False,
        "date_basis": "activity_union",
        "clarification": None,
        "clauses": [
            {
                "predicates": [
                    {
                        **common,
                        "id": "person_" + term,
                        "kind": "entity",
                        "value": "Cedar Vale",
                        "sparse_fallback_any_token": True,
                    },
                    {
                        **common,
                        "id": "concept_" + term,
                        "kind": "semantic",
                        "value": term,
                        "sparse_fallback_any_token": False,
                    },
                ]
            }
            for term in ("resume", "cv")
        ],
    }


@pytest.mark.parametrize("extra_concept", [False, True])
def test_executable_alternatives_share_primary_and_bounded_fallback(extra_concept):
    plan = ordinary_plan()
    if extra_concept:
        extra = deepcopy(plan["clauses"][1])
        extra["predicates"][0]["id"] = "person_biodata"
        extra["predicates"][1].update(id="concept_biodata", value="biodata")
        plan["clauses"].append(extra)
    queries = grade_plan(parse_semantic_plan(plan), "ordinary")
    assert [query["role"] for query in queries] == ["primary", "frozen_fallback"]
    assert "resume" in queries[0]["arguments"]["query"]
    assert "cv" in queries[0]["arguments"]["query"]
    if extra_concept:
        assert "biodata" in queries[0]["arguments"]["query"]


CORE_ENTITY = "clause_core_entity_or_sparse_fallback_missing"


@pytest.mark.parametrize(
    "defect,reason,leg",
    [
        ("duplicate_concept", "distinct_executable_concepts_missing", None),
        ("missing_entity", CORE_ENTITY, "entity_missing"),
        ("extra_required_middle_name", CORE_ENTITY, "tokens_mismatch"),
        ("phrase_match", CORE_ENTITY, "match_not_token"),
        ("missing_fallback", CORE_ENTITY, "fallback_missing"),
    ],
)
def test_ordinary_contract_failure_has_fixed_reason_without_plan_text(capsys, defect, reason, leg):
    plan = ordinary_plan()
    entity = plan["clauses"][0]["predicates"][0]
    if defect == "duplicate_concept":
        plan["clauses"][1]["predicates"][1]["value"] = "resume"
    elif defect == "missing_entity":
        entity.update(kind="content", sparse_fallback_any_token=False)
    elif defect == "phrase_match":
        entity.update(match="phrase", sparse_fallback_any_token=False)
    elif defect == "missing_fallback":
        entity["sparse_fallback_any_token"] = False
    else:
        entity["value"] = "Cedar Rowan Vale"
    with pytest.raises(ActivityPlannerContractError, match=reason):
        grade_plan(parse_semantic_plan(plan), "ordinary")
    output = capsys.readouterr().out
    expected = {
        "schema": "drive.activity_planner.probe.v1",
        "case": "ordinary",
        "stage": "grade",
        "result": "failed",
        "reason": reason,
    }
    assert json.loads(output) == (expected | {"leg": leg} if leg else expected)
    assert "Cedar" not in output


def _former_core_entity_check(clause):
    """The single condition the grader applied before legs were named."""
    return any(
        p.kind == "entity"
        and p.match == "token"
        and set(p.value.casefold().split()) == {"cedar", "vale"}
        and p.sparse_fallback_any_token
        for p in clause.predicates
    )


def test_core_entity_legs_keep_the_former_strictness():
    from itertools import product

    from scripts.probe_drive_activity_planner import _core_entity_leg

    variants = [
        SimpleNamespace(kind=k, match=m, value=v, sparse_fallback_any_token=f, negated=n)
        for k, m, v, f, n in product(
            ("entity", "content"),
            ("token", "phrase"),
            ("Cedar Vale", "cedar  VALE", "Cedar Rowan Vale", "Vale"),
            (True, False),
            (False, True),
        )
    ]
    clauses = [SimpleNamespace(predicates=[v]) for v in variants]
    clauses += [SimpleNamespace(predicates=[a, b]) for a, b in product(variants, repeat=2)]
    for clause in clauses:
        assert (_core_entity_leg(clause) is None) == _former_core_entity_check(clause)


@pytest.mark.parametrize("defect", [None, "unconstrained_or", "relaxed_title", "lost_exclusion"])
def test_explicit_filename_date_and_exclusion_remain_required(defect):
    plan = ordinary_plan()
    predicate = plan["clauses"][0]["predicates"][0]
    plan.update(
        date_basis="created",
        clauses=[
            {
                "predicates": [
                    {
                        **predicate,
                        "id": "title",
                        "kind": "title",
                        "value": "Research Charter.pdf",
                        "match": "exact",
                        "sparse_fallback_any_token": False,
                    },
                    {
                        **predicate,
                        "id": "draft",
                        "kind": "content",
                        "value": "draft",
                        "negated": True,
                        "sparse_fallback_any_token": False,
                    },
                ]
            }
        ],
    )
    reason = "explicit_exact_filename_lost"
    if defect == "unconstrained_or":
        plan["clauses"].append(
            {
                "predicates": [
                    {
                        **plan["clauses"][0]["predicates"][0],
                        "id": "unconstrained",
                        "kind": "semantic",
                        "match": "token",
                        "value": "resume",
                    }
                ]
            }
        )
    elif defect == "relaxed_title":
        plan["clauses"][0]["predicates"][0]["match"] = "token"
    elif defect == "lost_exclusion":
        plan["clauses"][0]["predicates"][1]["negated"] = False
        reason = "explicit_exclusion_lost"
    if defect is not None:
        with pytest.raises(ActivityPlannerContractError, match=reason):
            grade_plan(parse_semantic_plan(plan), "explicit")
    else:
        queries = grade_plan(parse_semantic_plan(plan), "explicit")
        assert len(queries) == 1
        assert "createdTime >=" in queries[0]["arguments"]["query"]


@pytest.fixture
def azure_wrapper(monkeypatch):
    root = Path(__file__).resolve().parents[3]
    spec = importlib.util.spec_from_file_location(
        "azure_pwm_runtime_probe", root / "consent-protocol/scripts/verify_azure_pwm_runtime.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    config = {
        "primary_deployment": "synthetic-primary",
        "tenant_id": "synthetic",
        "client_id": "synthetic",
    }
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.setattr(module, "_initialize_synthetic_runtime", lambda: None)
    monkeypatch.setattr(
        module,
        "load_pwm_policy",
        lambda **_: {"provider": "azure_openai_web_search", "azure": config},
    )
    readiness = AsyncMock(
        return_value={
            "status": "ready",
            "http_status": 200,
            "latency_ms": 1,
            "deployment": config["primary_deployment"],
            "error_class": None,
            "stage": "response_validation",
            "classification": "dependency_ok",
        }
    )
    managed_text = module._probe_managed_text
    monkeypatch.setattr(module, "run_probe", readiness)
    monkeypatch.setattr(module, "_probe_managed_text", AsyncMock())
    monkeypatch.setattr(module, "_token_provider", lambda **_: lambda: "synthetic")
    primary = AsyncMock(side_effect=module.AzurePwmTrustError("PRIVATE_SYNTHETIC_ERROR"))
    monkeypatch.setattr(module, "_probe_primary", primary)
    return SimpleNamespace(
        module=module, readiness=readiness, primary=primary, managed_text=managed_text
    )


@pytest.mark.parametrize("defect", ["foreign_deployment", "later_schema", "activity_planner"])
def test_primary_http_success_never_erases_later_qualification_failure(
    monkeypatch, capsys, azure_wrapper, defect
):
    module = azure_wrapper.module
    if defect == "foreign_deployment":
        azure_wrapper.readiness.return_value["deployment"] = "foreign"
    elif defect == "activity_planner":
        from scripts import probe_managed_text

        monkeypatch.setattr(module, "_probe_managed_text", azure_wrapper.managed_text)
        monkeypatch.setattr(
            probe_managed_text,
            "probe_managed_text",
            AsyncMock(side_effect=ActivityPlannerContractError("PRIVATE_SYNTHETIC_ERROR")),
        )
    assert module.main() == 1
    output = capsys.readouterr().out
    events = [json.loads(line) for line in output.splitlines()]
    terminal = events[-1]
    assert terminal["classification"] == "candidate_misconfigured"
    assert terminal["pwm_trust_failure"] is (defect != "foreign_deployment")
    assert events[0]["result"] == ("failed" if defect == "foreign_deployment" else "ok")
    assert azure_wrapper.primary.await_count == (1 if defect == "later_schema" else 0)
    assert "PRIVATE_SYNTHETIC_ERROR" not in output
    if defect == "activity_planner":
        assert terminal["error_type"] == "AzurePwmTrustError"
        assert not any(
            "managed_text_provider_probe" in event or "azure_managed_text_contract" in event
            for event in events
        )
