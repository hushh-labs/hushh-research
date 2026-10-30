"""The consent catalogue must not offer a person's plumbing as their information.

Every case is read out of contracts/pkm/internal-path-keys.v1.json rather than
restated here, so this file and its TypeScript twin cannot drift.
"""

import json
from pathlib import Path

import pytest

from hushh_mcp.consent.internal_path_keys import (
    is_internal_manifest_path,
    is_internal_path_segment,
)

CONTRACT = json.loads(
    (
        Path(__file__).resolve().parents[2] / "contracts" / "pkm" / "internal-path-keys.v1.json"
    ).read_text(encoding="utf-8")
)


def test_contract_is_loadable_and_not_vacuous():
    # If the case list were ever empty every assertion below would pass while
    # proving nothing, which is the failure mode this whole file exists to avoid.
    assert len(CONTRACT["cases"]) >= 10
    assert any(case["internal"] for case in CONTRACT["cases"])
    assert any(not case["internal"] for case in CONTRACT["cases"])


@pytest.mark.parametrize("case", CONTRACT["cases"], ids=lambda c: c["path"])
def test_shared_truth_table(case):
    assert is_internal_manifest_path(case["path"]) is case["internal"], case["why"]


def test_nesting_a_structural_key_does_not_publish_it():
    # The exact near-miss: the previous check rejected any path containing a dot,
    # so only the depth-1 form was ever caught.
    assert is_internal_manifest_path("domain_intent") is True
    assert is_internal_manifest_path("profile.domain_intent.primary") is True
    assert is_internal_manifest_path("analysis.domain_intent.source") is True


def test_a_real_preference_survives_the_filter():
    # A denylist that eats the signal is worse than no denylist.
    assert is_internal_manifest_path("profile.preferences.risk_profile") is False
    assert is_internal_manifest_path("portfolio.holdings.equities") is False
    assert is_internal_path_segment("student_id") is False


def test_leading_underscore_is_checked_before_normalisation():
    assert is_internal_path_segment("_private") is True
    assert is_internal_path_segment("  _hidden") is True
