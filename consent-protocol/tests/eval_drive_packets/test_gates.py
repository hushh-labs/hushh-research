"""Each gate is a decision with an exit code: 0 pass, 1 fail, 2 insufficient."""

from hushh_eval.drive_packets.gates import deploy_gate, listing_gate, load_thresholds, ready_gate
from hushh_eval.drive_packets.labels import LABEL_VERSION

THRESHOLDS = load_thresholds()


def card(successes, trials, *, unknown=0, open_s1=0, human=None, severity=None):
    return {
        "label_version": LABEL_VERSION,
        "human_confirmed_ready": trials if human is None else human,
        "scores": [
            {
                "metric": "ready_correct_one_per_family",
                "successes": successes,
                "trials": trials,
                "n_unknown": unknown,
                "extra": {"open_s1": open_s1},
            },
            {
                "metric": "false_ready_rate",
                "successes": trials - successes,
                "trials": trials,
                "extra": {"severity": severity or {}},
            },
        ],
    }


def test_listing_gate_exit_codes():
    assert listing_gate(card(59, 59), THRESHOLDS).exit_code == 0
    assert listing_gate(card(58, 59), THRESHOLDS).exit_code == 1
    assert listing_gate(card(60, 60, open_s1=1), THRESHOLDS).reasons == ["open_s1"]
    short = listing_gate(card(41, 41), THRESHOLDS)
    assert (short.exit_code, short.reasons) == (2, ["needs_59_independent_ready_has_41"])
    # Model-judged only: never cleared without the human slice.
    assert listing_gate(card(59, 59, human=0), THRESHOLDS).reasons == ["human_confirmation_missing"]


def test_unknown_heavy_scorecards_are_insufficient_never_pass():
    result = listing_gate(card(60, 60, unknown=61), THRESHOLDS)
    assert result.exit_code == 2 and "too_many_unknown_verdicts" in result.reasons


def test_ready_gate_demotes_on_open_s1():
    assert ready_gate(card(9, 10, severity={"S1": 1}), THRESHOLDS).exit_code == 1
    assert ready_gate(card(10, 10), THRESHOLDS).exit_code == 0
    assert ready_gate(card(0, 0), THRESHOLDS).exit_code == 2


def test_deploy_gate_blocks_guard_regressions_and_new_anchor_s1():
    clean = {"regressions": [], "known_gaps_open": ["x"]}
    assert (
        deploy_gate(
            guard_status=None, anchor=None, previous_anchor=None, thresholds=THRESHOLDS
        ).exit_code
        == 2
    )
    assert (
        deploy_gate(
            guard_status=clean, anchor=None, previous_anchor=None, thresholds=THRESHOLDS
        ).exit_code
        == 0
    )
    broken = {"regressions": ["wire-request-executed-copy"]}
    assert (
        deploy_gate(
            guard_status=broken, anchor=None, previous_anchor=None, thresholds=THRESHOLDS
        ).exit_code
        == 1
    )
    before = {"A1": None, "A2": "S1"}
    assert (
        deploy_gate(
            guard_status=clean, anchor=dict(before), previous_anchor=before, thresholds=THRESHOLDS
        ).exit_code
        == 0
    )
    worse = deploy_gate(
        guard_status=clean,
        anchor={"A1": "S1", "A2": "S1"},
        previous_anchor=before,
        thresholds=THRESHOLDS,
    )
    assert (worse.exit_code, worse.reasons) == (1, ["anchor_new_s1:A1"])
