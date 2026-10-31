"""The server resolver must agree with the browser one, word for word.

Both read ``contracts/pkm/segment-humanization.v1.json``. A label written here
and a label written by the browser land side by side on the same screen, and the
repo already learned what happens when each site carries its own humanizer:
twelve of them, all slightly different.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from hushh_mcp.consent.segment_labels import (
    humanize_path,
    humanize_segment,
    looks_like_opaque_id,
)

FIXTURE_PATH = (
    Path(__file__).resolve().parents[2] / "contracts" / "pkm" / "segment-humanization.v1.json"
)
FIXTURES = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


def test_the_shared_fixture_is_present_and_populated() -> None:
    # A contract file that silently emptied would make every case below pass
    # while asserting nothing.
    assert FIXTURE_PATH.exists(), f"shared truth table missing at {FIXTURE_PATH}"
    assert len(FIXTURES["segments"]) > 5


@pytest.mark.parametrize(
    "case", FIXTURES["segments"], ids=[case["input"] for case in FIXTURES["segments"]]
)
def test_segment_matches_the_shared_truth_table(case: dict) -> None:
    assert humanize_segment(case["input"]) == case["expected"], case["why"]


@pytest.mark.parametrize(
    "case", FIXTURES["opaque_ids"], ids=[case["input"] for case in FIXTURES["opaque_ids"]]
)
def test_opaque_ids_are_suppressed(case: dict) -> None:
    assert looks_like_opaque_id(case["input"]) is True, case["why"]


@pytest.mark.parametrize(
    "case",
    FIXTURES["not_opaque_ids"],
    ids=[case["input"] for case in FIXTURES["not_opaque_ids"]],
)
def test_readable_keys_are_not_suppressed(case: dict) -> None:
    assert looks_like_opaque_id(case["input"]) is False, case["why"]


def test_path_humanizes_every_segment() -> None:
    assert (
        humanize_path("savedPlaces.locations.addressDetails")
        == "Saved Places Locations Address Details"
    )


def test_a_normalized_path_cannot_be_recovered() -> None:
    # Not a defect in this function, and the reason the caller must humanize at
    # capture: once the path has been lowercased for authorization the words are
    # gone, and inventing them back would be a guess.
    assert humanize_path("savedplaces.addressdetails") == "Savedplaces Addressdetails"


def test_never_shortens_to_the_last_word() -> None:
    # Encodes the rationale of the reverted splitScopeLabel heuristic: dropping
    # leading words names a different field.
    assert "Employment" in humanize_segment("employment_status")


def test_empty_and_none_are_safe() -> None:
    assert humanize_segment("") == ""
    assert humanize_segment(None) == ""
    assert humanize_path(None) == ""
