"""One root qualification names the round-trip leg that failed, at the same strictness."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

from scripts.capability_probe_failure import _REASONS, FAILURE_REASONS, failure_reason
from scripts.probe_azure_openai_readiness import valid_failure_reason
from scripts.probe_one_text_root import roundtrip_failure

REPO_ROOT = Path(__file__).resolve().parents[3]
EXPECTED = {"code": "nonce", "color": "red", "time_zone": "UTC"}
EXACT = json.dumps(EXPECTED)


def _former_check_passes(deltas: str, answer: str) -> bool:
    """The single boolean the probe used before reasons were split."""
    try:
        return bool(deltas) and deltas == answer and json.loads(answer) == EXPECTED
    except json.JSONDecodeError:
        return False


@pytest.mark.parametrize(
    "deltas,answer,reason",
    [
        ("", "", "root.no_deltas"),
        ('{"code": "nonce"}', EXACT, "root.stream_mismatch"),
        ("not json", "not json", "root.non_json"),
        (
            '{"code": "nonce", "color": "red"}',
            '{"code": "nonce", "color": "red"}',
            "root.shape_mismatch",
        ),
        ('["nonce", "red", "UTC"]', '["nonce", "red", "UTC"]', "root.shape_mismatch"),
        (EXACT.replace("nonce", "other"), EXACT.replace("nonce", "other"), "root.code_mismatch"),
        (EXACT.replace("red", "Red"), EXACT.replace("red", "Red"), "root.color_mismatch"),
        (EXACT.replace("UTC", "Etc/UTC"), EXACT.replace("UTC", "Etc/UTC"), "root.zone_mismatch"),
    ],
)
def test_each_failed_leg_has_its_own_admitted_reason(deltas, answer, reason):
    failure = roundtrip_failure(deltas, answer, EXPECTED)
    assert failure is not None
    assert failure_reason("one_text_root", ValueError(failure)) == reason
    assert valid_failure_reason("one_text_root", reason)
    assert len(reason) < 24  # Under the runtime log redactor's token threshold.


def test_exact_streamed_json_still_passes():
    assert roundtrip_failure(EXACT, EXACT, EXPECTED) is None


@pytest.mark.parametrize(
    "deltas,answer",
    [
        ("", ""),
        (EXACT, ""),
        (EXACT, EXACT),
        (EXACT + " ", EXACT + " "),
        ("{}", "{}"),
        ("null", "null"),
        (json.dumps({**EXPECTED, "extra": "x"}),) * 2,
        (EXACT.replace("red", "red "),) * 2,
    ],
)
def test_split_reasons_keep_the_former_strictness(deltas, answer):
    assert (roundtrip_failure(deltas, answer, EXPECTED) is None) == _former_check_passes(
        deltas, answer
    )


def test_ci_proof_admits_exactly_the_reasons_probes_emit():
    spec = importlib.util.spec_from_file_location(
        "managed_capability_proof", REPO_ROOT / "scripts/ci/managed_capability_proof.py"
    )
    assert spec and spec.loader
    proof = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(proof)
    assert proof.FAILURE_REASONS == FAILURE_REASONS
    for (capability, _error_type, _args), reason in _REASONS.items():
        assert valid_failure_reason(capability, reason), (capability, reason)
