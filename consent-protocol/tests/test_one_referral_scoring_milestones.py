"""Lifetime milestone threshold crossing. Pure function, no database."""

from __future__ import annotations

from hushh_mcp.operons.referral_scoring.milestones import milestones_newly_earned

MILESTONES = [
    {"milestone_key": "tee_5", "threshold": 5, "reward": "hushh_tee"},
    {"milestone_key": "backpack_15", "threshold": 15, "reward": "hushh_backpack"},
]


def test_below_every_threshold_earns_nothing():
    assert milestones_newly_earned(4, MILESTONES, frozenset()) == []


def test_crossing_the_first_threshold_earns_it():
    awards = milestones_newly_earned(5, MILESTONES, frozenset())

    assert [a.milestone_key for a in awards] == ["tee_5"]
    assert awards[0].reward == "hushh_tee"
    assert awards[0].threshold == 5


def test_jumping_past_two_thresholds_at_once_earns_both():
    """A backfill or a batch of simultaneous qualifications can cross more
    than one threshold in a single evaluation; every newly-crossed one is
    returned, not just the nearest."""
    awards = milestones_newly_earned(15, MILESTONES, frozenset())

    assert [a.milestone_key for a in awards] == ["tee_5", "backpack_15"]


def test_an_already_earned_milestone_is_never_returned_again():
    awards = milestones_newly_earned(20, MILESTONES, frozenset({"tee_5", "backpack_15"}))

    assert awards == []


def test_the_same_threshold_does_not_repeat_on_a_later_week():
    """A person stays at 5 lifetime qualifiers for weeks; re-evaluating every
    week must not keep re-earning tee_5."""
    first = milestones_newly_earned(5, MILESTONES, frozenset())
    already_earned = frozenset(a.milestone_key for a in first)

    second = milestones_newly_earned(5, MILESTONES, already_earned)

    assert second == []


def test_malformed_milestone_entries_are_ignored_not_fatal():
    malformed = [
        {},
        {"milestone_key": "", "threshold": 5, "reward": "x"},
        {"milestone_key": "bad_threshold", "threshold": 0, "reward": "x"},
        {"milestone_key": "bad_threshold_type", "threshold": "five", "reward": "x"},
        {"milestone_key": "no_reward", "threshold": 5},
        None,
        "garbage",
    ]

    assert milestones_newly_earned(100, malformed, frozenset()) == []


def test_empty_milestone_list_earns_nothing():
    assert milestones_newly_earned(1000, [], frozenset()) == []
