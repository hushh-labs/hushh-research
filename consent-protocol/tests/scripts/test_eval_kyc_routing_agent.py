"""Self-tests for scripts/eval_kyc_routing_agent.py.

Mirrors tests/scripts/test_eval_pkm_structure_agent.py:
- Asserts the inline dataset is well-formed.
- Asserts run_eval with a stubbed classifier returns 100% accuracy.

No real Gemini calls are made.
"""

from __future__ import annotations

import pytest

from scripts import eval_kyc_routing_agent as eval_script

# ---------------------------------------------------------------------------
# Dataset shape
# ---------------------------------------------------------------------------


def test_dataset_has_minimum_size():
    assert len(eval_script.DATASET) >= 8, (
        f"Dataset must have at least 8 cases, got {len(eval_script.DATASET)}"
    )


def test_dataset_cases_have_required_keys():
    required = eval_script._REQUIRED_KEYS
    for case in eval_script.DATASET:
        missing = required - set(case.keys())
        assert not missing, f"Case {case.get('id')!r} is missing keys: {missing}"


def test_dataset_covers_required_scenario_types():
    """The dataset must include at least one of each mandated scenario type."""
    ids = {case["id"] for case in eval_script.DATASET}
    classifications = {case["expected_classification"] for case in eval_script.DATASET}
    domains = {
        case["expected_domain"]
        for case in eval_script.DATASET
        if case["expected_domain"] is not None
    }

    # hotel-booking regression case must be present
    assert "hotel_booking_identity" in ids, "hotel_booking_identity case is missing from dataset"

    # unsupported cases
    assert "unsupported" in classifications, "Dataset must include at least one unsupported case"

    # identity and financial domains
    assert "identity" in domains, "Dataset must include at least one identity-domain case"
    assert "financial" in domains, "Dataset must include at least one financial-domain case"


def test_dataset_ids_are_unique():
    ids = [case["id"] for case in eval_script.DATASET]
    assert len(ids) == len(set(ids)), "Dataset case IDs must be unique"


# ---------------------------------------------------------------------------
# run_eval with stubbed classifier
# ---------------------------------------------------------------------------


async def _perfect_stub(
    *,
    subject: str,  # noqa: ARG001
    body: str,  # noqa: ARG001
    pkm_index: dict,  # noqa: ARG001
    _case: dict,
) -> dict:
    """Stub that returns exactly the expected answer for each case."""
    cls = _case["expected_classification"]
    domain = _case["expected_domain"]
    primary = [domain] if domain is not None else []
    return {
        "classification": cls,
        "requested_items": [],
        "primary_domains": primary,
        "confidence": 1.0,
        "reasoning": "stub",
    }


@pytest.mark.asyncio
async def test_run_eval_perfect_stub_reports_100_percent():
    """A classifier that always returns the expected label must score 100%."""
    dataset = eval_script.DATASET

    # Build per-case lookup so the stub knows what to return.
    case_by_position: list[dict] = list(dataset)

    call_index = 0

    async def classifier(*, subject: str, body: str, pkm_index: dict) -> dict:
        nonlocal call_index
        case = case_by_position[call_index]
        call_index += 1
        return await _perfect_stub(subject=subject, body=body, pkm_index=pkm_index, _case=case)

    report = await eval_script.run_eval(classifier=classifier)
    assert report["passed"] == report["total"], (
        f"Expected 100% accuracy but got {report['passed']}/{report['total']}"
    )
    assert report["accuracy"] == 1.0
    assert report["total"] == len(dataset)


@pytest.mark.asyncio
async def test_run_eval_raises_without_live_flag_and_no_classifier():
    """Without KYC_EVAL_LIVE=1 and no stub, run_eval must refuse, not hit Gemini."""
    import os

    # Ensure the env flag is absent for this test.
    env_backup = os.environ.pop("KYC_EVAL_LIVE", None)
    try:
        with pytest.raises(RuntimeError, match="KYC_EVAL_LIVE"):
            await eval_script.run_eval()
    finally:
        if env_backup is not None:
            os.environ["KYC_EVAL_LIVE"] = env_backup


@pytest.mark.asyncio
async def test_run_eval_custom_dataset_single_case():
    """run_eval works with a custom single-case dataset passed via dataset=."""
    single_case = [
        {
            "id": "test_single",
            "subject": "Identity check",
            "body": "Please provide your name.",
            "pkm_index": {
                "available_domains": ["identity"],
                "domain_summaries": {"identity": "full name"},
            },
            "expected_domain": "identity",
            "expected_classification": "kyc",
        }
    ]

    async def stub(*, subject: str, body: str, pkm_index: dict) -> dict:  # noqa: ARG001
        return {
            "classification": "kyc",
            "requested_items": [],
            "primary_domains": ["identity"],
            "confidence": 1.0,
            "reasoning": "stub",
        }

    report = await eval_script.run_eval(classifier=stub, dataset=single_case)
    assert report["passed"] == 1
    assert report["total"] == 1
    assert report["accuracy"] == 1.0
