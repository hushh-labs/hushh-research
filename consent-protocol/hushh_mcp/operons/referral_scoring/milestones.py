"""Lifetime milestone threshold crossing.

Pure function: given a lifetime count and the configured milestone ladder,
decide which milestones are newly earned. No database, no clock.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class MilestoneAward:
    milestone_key: str
    threshold: int
    reward: str


def milestones_newly_earned(
    lifetime_qualified_count: int,
    settings_milestones: list,
    already_earned_keys: frozenset,
) -> list[MilestoneAward]:
    """Which configured milestones does this count newly cross?

    A milestone already in `already_earned_keys` is never returned again --
    "the same threshold does not issue another item every week" -- and
    nothing here cares what week, reward round, or settings version produced
    the count. Reaching two thresholds in one jump (e.g. a backfill that
    credits several referrals at once) returns both awards, each exactly
    once.
    """
    awards: list[MilestoneAward] = []
    for entry in settings_milestones or []:
        if not isinstance(entry, dict):
            continue
        milestone_key = entry.get("milestone_key")
        threshold = entry.get("threshold")
        reward = entry.get("reward")
        if not isinstance(milestone_key, str) or not milestone_key:
            continue
        if not isinstance(threshold, int) or threshold <= 0:
            continue
        if not isinstance(reward, str) or not reward:
            continue
        if milestone_key in already_earned_keys:
            continue
        if lifetime_qualified_count >= threshold:
            awards.append(MilestoneAward(milestone_key, threshold, reward))
    return awards
