"""The founder report fits one screen, uses 'x of n', always shows both bars, names
the measured mode and SHA, and carries no private text."""

import pytest

from hushh_eval.drive_packets.privacy import PrivacyError, assert_public_text
from hushh_eval.drive_packets.report import comparable, delta_line, engineer_report, founder_report

CARD = {
    "batch_id": "B001",
    "mode": "replay",
    "code_sha": "c8faf48dd6a1b2c3",
    "label_version": "labels.v1",
    "strata_version": "strata.v1",
    "request_set_version": "requests.v1",
    "judge_signature": "j",
    "files": 300,
    "bars": {"n95": 59, "n999": 2995},
    "human_confirmed_ready": 0,
    "scores": [
        {
            "metric": "ready_correct_one_per_family",
            "successes": 41,
            "trials": 41,
            "rate": 1.0,
            "cp_lower_95": 0.93,
            "wilson_lower_95": 0.94,
            "unit": "independent_family",
            "independence": "one",
            "n_unknown": 3,
            "extra": {"open_s1": 0},
        },
        {
            "metric": "extraction_accuracy",
            "successes": 276,
            "trials": 300,
            "rate": 0.92,
            "cp_lower_95": 0.89,
            "wilson_lower_95": 0.89,
            "unit": "document",
            "independence": "doc",
            "n_unknown": 0,
            "extra": {},
        },
        {
            "metric": "false_ready_rate",
            "successes": 0,
            "trials": 41,
            "rate": 0.0,
            "cp_lower_95": 0.0,
            "wilson_lower_95": 0.0,
            "unit": "x",
            "independence": "x",
            "n_unknown": 3,
            "extra": {"severity": {"S1": 0}},
        },
    ],
}
GATE = {
    "status": "insufficient",
    "reasons": ["needs_59_independent_ready_has_41", "human_confirmation_missing"],
}


def test_founder_report_is_short_plain_and_shows_both_bars():
    text = founder_report(CARD, GATE)
    lines = text.strip().splitlines()
    assert len(lines) <= 12
    assert (
        "Ready packets wrong: 0 of 41 (95% bar needs 0 of 59; 99.9% bar needs 0 of 2,995)." in text
    )
    assert "replay of code c8faf48" in text
    assert "Files read with the right page count: 276 of 300; with unreadable pages:" in text
    assert "Checked by a person: 0 of 41" in text
    assert "Buyer search finds it in the top 5: not measured yet." in text
    assert (
        "Safe to list: not yet, because 41 independent Ready packets were checked and 59 are needed"
        in text
    )
    for jargon in ("Clopper", "Wilson", "kappa", "ECE", "S1"):
        assert jargon not in text


def test_engineer_report_passes_the_public_allowlist_and_rejects_private_text():
    report = engineer_report(CARD, [{"gate": "listing", **GATE}])
    assert report["scores"][2]["extra"]["severity"] == {"s1": 0}
    leaked = dict(CARD, batch_id="Statements for Pat Example")
    with pytest.raises(PrivacyError):
        engineer_report(leaked, [])
    with pytest.raises(PrivacyError, match="private_value_leak"):
        assert_public_text(founder_report(CARD, GATE) + "pat example", private={"pat example"})


def test_deltas_only_between_comparable_batches():
    later = dict(CARD, label_version="labels.v2")
    assert comparable(CARD, CARD) == (True, [])
    assert delta_line(CARD, later, "extraction_accuracy") == (
        "extraction_accuracy: not comparable (label_version changed)"
    )
    assert delta_line(CARD, CARD, "extraction_accuracy") == (
        "extraction_accuracy: 276 of 300 before, 276 of 300 now"
    )
