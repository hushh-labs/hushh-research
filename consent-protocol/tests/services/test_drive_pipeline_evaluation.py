"""Protect benchmark honesty: independent labels, failed attempts and denominators."""

from __future__ import annotations

import copy
import importlib.util
import json
from pathlib import Path

import pytest

from hushh_mcp.services.drive_pipeline_evaluation import (
    adapter_input,
    build_report,
    exact_lower_bound,
    load_dataset,
    pricing_monotonicity,
    zero_failure_sample_size,
)

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = ROOT / "tests/fixtures/drive_pipeline_eval/manifest.json"


def observed(case):
    """Test oracle only: not a provider adapter or an evaluation result."""
    return {
        "case_id": case["id"],
        "status": "completed",
        "discovered_refs": [document["ref"] for document in case["documents"]],
        "selected_refs": case["expected_packet"]["selected_refs"],
        "document_decisions": {
            document["ref"]: document["relevance"] for document in case["documents"]
        },
        "document_facts": {document["ref"]: document["facts"] for document in case["documents"]},
        "packet_status": case["expected_packet"]["status"],
        "coverage": case["expected_packet"]["coverage"],
        "extraction": {
            document["ref"]: {"complete": True, "has_gaps": False} for document in case["documents"]
        },
        "evaluator_accept": case["expected_packet"]["status"] == "ready",
        "suggested_price_cents": 500,
    }


def test_999_requires_2995_independent_zero_failure_trials():
    assert zero_failure_sample_size() == 2995
    assert exact_lower_bound(2994, 2994) < 0.999
    assert exact_lower_bound(2995, 2995) >= 0.999
    assert exact_lower_bound(36, 36) == pytest.approx(0.9201534904801056)
    # Independently tabulated one-sided exact bound: one success out of two.
    assert exact_lower_bound(1, 2) == pytest.approx(1 - 0.95**0.5)
    assert exact_lower_bound(19, 20) == pytest.approx(0.7838938357931527)
    assert exact_lower_bound(0, 0) is None
    assert exact_lower_bound(0, 3) == 0
    with pytest.raises(ValueError):
        exact_lower_bound(True, 1)


def test_original_bytes_are_bound_and_labels_never_reach_adapter(tmp_path):
    dataset = load_dataset(MANIFEST)
    supplied = adapter_input(dataset["cases"][0], MANIFEST.parent)
    assert set(supplied) == {"case_id", "request", "documents"}
    assert set(supplied["documents"][0]) == {
        "ref",
        "mime_type",
        "source_version",
        "sha256",
        "content",
    }
    assert supplied["documents"][0]["content"].startswith(b"%PDF-")
    manifest = json.loads(MANIFEST.read_text())
    for document in manifest["cases"][0]["documents"]:
        (tmp_path / document["path"]).write_bytes(b"changed original bytes")
    path = tmp_path / "manifest.json"
    path.write_text(json.dumps(manifest))
    with pytest.raises(ValueError, match="artifact_hash_mismatch"):
        load_dataset(path)


def test_error_and_missing_cases_stay_in_recall_and_packet_denominators():
    dataset = load_dataset(MANIFEST)
    row = observed(dataset["cases"][0])
    row.update(status="timeout", selected_refs=["d3"], error_stage="packet_verification")
    report = build_report(dataset, [row], runtime={})
    assert report["all"]["completed"] == 0
    assert report["all"]["failed_or_missing"] == 5
    assert report["all"]["selection_precision"]["rate"] == 0
    assert report["all"]["false_positives"] == 1
    assert report["all"]["false_negatives"] == 4
    assert report["all"]["recall_all_attempts"]["rate"] == 0
    assert report["all"]["packet_correctness_all_attempts"]["trials"] == 5
    assert report["all"]["evaluator_agreement"]["successes"] == 0
    assert report["error_stages"]["packet_verification"] == 1


def test_perfect_synthetic_outcomes_and_self_confidence_never_prove_999():
    dataset = load_dataset(MANIFEST)
    rows = [observed(case) | {"confidence": 100} for case in dataset["cases"]]
    report = build_report(dataset, rows, runtime={})
    assert report["all"]["packet_correctness_all_attempts"]["rate"] == 1
    assert not report["acceptance"]["supports_target"]
    assert not report["acceptance"]["selection_precision_supports_target"]
    assert report["all"]["delivery_correctness"]["rate"] is None
    assert report["usage"]["cost_usd"] is None
    assert report["usage"]["input_tokens"] is None
    assert report["usage"]["unknown_cost_attempts"] == 5
    assert report["all"]["evaluator_agreement"]["rate"] == 1


def test_ready_packet_with_ocr_gap_is_wrong_even_when_selected_ids_match():
    dataset = load_dataset(MANIFEST)
    rows = [observed(case) for case in dataset["cases"]]
    rows[3]["extraction"]["d1"]["has_gaps"] = True
    report = build_report(dataset, rows, runtime={})
    assert report["all"]["selection_precision"]["rate"] == 1
    assert report["all"]["false_ready_packets"] == 1
    assert report["all"]["ready_packet_correctness"]["rate"] == pytest.approx(2 / 3)
    assert report["all"]["evaluator_agreement"]["rate"] == 0.8


def test_forged_delivery_without_observed_receipt_stays_unknown():
    dataset = load_dataset(MANIFEST)
    rows = [observed(case) for case in dataset["cases"]]
    rows[0]["delivery"] = {"observed": True, "delivered_refs": ["d1"], "approved_refs": ["d1"]}
    report = build_report(dataset, rows, runtime={})
    assert report["all"]["delivery_correctness"]["trials"] == 0
    rows[0]["delivery"]["evidence_source"] = "isolated-provider-receipt-test"
    rows[0]["delivery"]["delivered_refs"] = ["d1", "d3"]
    report = build_report(dataset, rows, runtime={})
    assert report["all"]["delivery_correctness"]["rate"] == 0
    assert report["all"]["unauthorized_deliveries"] == 1


def test_reference_pricing_checks_ranges_and_comparable_scope_pairs():
    dataset = load_dataset(MANIFEST)
    rows = {case["id"]: observed(case) for case in dataset["cases"]}
    rows["dev-001"]["suggested_price_cents"] = 1000
    rows["dev-002"]["suggested_price_cents"] = 500
    assert pricing_monotonicity(dataset["cases"], rows)["rate"] == 0
    rows["dev-002"]["suggested_price_cents"] = 1800
    assert pricing_monotonicity(dataset["cases"], rows)["rate"] == 1
    rows["heldout-002"]["suggested_price_cents"] = 50_000
    report = build_report(dataset, list(rows.values()), runtime={})
    assert report["all"]["price_within_reference"]["successes"] == 2
    assert report["all"]["price_within_reference"]["trials"] == 3
    assert not report["acceptance"]["price_accuracy_claim"]


def test_population_gate_requires_actual_runtime_and_uncorrelated_sampling():
    # Pure statistical gate test. These are constructed observations, not a run.
    dataset = load_dataset(MANIFEST)
    template = dataset["cases"][0]
    dataset["cases"] = []
    for i in range(2995):
        case = copy.deepcopy(template)
        case.update(id=str(i), partition="heldout", correlation_group=str(i))
        for j, document in enumerate(case["documents"]):
            document["sha256"] = f"{i * 2 + j:064x}"
        dataset["cases"].append(case)
    dataset["corpus_kind"] = "authorized_real"
    dataset["sampling"] = {
        "representative_independent_holdout": True,
        "source": "test-only sampling plan",
        "fixed_sample_size": 2995,
    }
    rows = [observed(case) for case in dataset["cases"]]
    runtime = dict.fromkeys(
        (
            "code_sha",
            "manifest_sha256",
            "schema_sha256",
            "provider_model_version",
            "extraction_version",
        ),
        "test-version",
    )
    report = build_report(dataset, rows, runtime=runtime)
    assert report["acceptance"]["supports_target"]
    assert report["acceptance"]["ready_packet_supports_target"]
    # Document trials within a packet need their own sampling justification.
    assert not report["acceptance"]["selection_precision_supports_target"]
    dataset["cases"][1]["correlation_group"] = "0"
    assert not build_report(dataset, rows, runtime=runtime)["acceptance"]["supports_target"]
    dataset["cases"][1]["correlation_group"] = "1"
    runtime["provider_model_version"] = None
    assert not build_report(dataset, rows, runtime=runtime)["acceptance"]["supports_target"]


async def test_extraction_only_runner_does_not_invent_semantic_success():
    spec = importlib.util.spec_from_file_location(
        "pipeline_eval", ROOT / "scripts/eval_drive_pipeline.py"
    )
    script = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(script)

    def extractor(**kwargs):
        assert kwargs["content"].startswith(b"%PDF-")
        return {
            "pages": [],
            "next_page": None,
            "complete": False,
            "has_gaps": True,
            "profile": "test-only",
            "engine_versions": {},
        }

    report = await script.run_dataset(MANIFEST, extractor=extractor)
    assert report["statuses"] == {"not_run": 5}
    assert report["all"]["packet_correctness_all_attempts"]["rate"] == 0
    assert report["all"]["extraction_completeness"]["rate"] == 0
    assert not report["acceptance"]["supports_target"]


@pytest.mark.parametrize(
    "claim,expected",
    [
        (
            "Missing statement coverage for period 2026-10-01 to 2026-10-09.",
            [["2026-10-01", "2026-10-09"]],
        ),
        ("2026-10-01 through 2026-10-09", [["2026-10-01", "2026-10-09"]]),
        ("Missing 2026-10-01–2026-10-09", [["2026-10-01", "2026-10-09"]]),
        ("Missing October coverage", None),
        ("Missing 2026-10-01", None),
        ("Missing 2026-10-09 to 2026-10-01", None),
        ("Missing 2026-02-30 to 2026-03-01", None),
        ("Missing 2026-10-01 to 2026-10-09 or 2026-11-01 to 2026-11-09", None),
        ("Missing 2026-10-01 or 2026-10-09", None),
    ],
)
def test_adapter_serializes_only_one_explicit_valid_gap_interval(claim, expected):
    from scripts.drive_pipeline_model_adapter import normalize_coverage_gaps

    assert normalize_coverage_gaps([claim]) == (expected if expected is not None else [claim])


def test_gap_serialization_does_not_fix_wrong_dates_or_modify_reference():
    from hushh_mcp.services.drive_pipeline_evaluation import grade_attempt
    from scripts.drive_pipeline_model_adapter import normalize_coverage_gaps

    dataset = load_dataset(MANIFEST.with_name("manifest-v2.json"))
    case = next(case for case in dataset["cases"] if case["id"] == "dev-v2-002")
    original = copy.deepcopy(case)
    row = observed(case)
    row["coverage"] = {
        **row["coverage"],
        "gaps": normalize_coverage_gaps(
            ["Missing statement coverage for period 2026-10-01 to 2026-10-09."]
        ),
    }
    assert grade_attempt(case, row)["coverage_correct"] is True
    for claim in ["Missing October coverage", "Missing 2026-10-01 to 2026-10-08."]:
        row["coverage"]["gaps"] = normalize_coverage_gaps([claim])
        assert grade_attempt(case, row)["coverage_correct"] is False
        assert grade_attempt(case, row)["packet_correct"] is False
    assert case == original
