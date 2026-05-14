#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path


SCRIPT = Path(__file__).with_name("contributor_impact_report.py")
SPEC = importlib.util.spec_from_file_location("contributor_impact_report", SCRIPT)
assert SPEC and SPEC.loader
report = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = report
SPEC.loader.exec_module(report)


def _assert(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def _fake_pr(number: int, author: str, title: str) -> dict[str, object]:
    return {
        "number": number,
        "title": title,
        "author": {"login": author},
        "url": f"https://github.com/hushh-labs/hushh-research/pull/{number}",
        "createdAt": "2026-05-14T00:00:00Z",
        "closedAt": "2026-05-14T01:00:00Z",
        "mergedAt": None,
        "additions": 12,
        "deletions": 4,
        "changedFiles": 1,
        "labels": [],
        "files": [{"path": "hushh-webapp/components/app-ui/top-app-bar.tsx"}],
        "comments": [{"body": "Closed as superseded after maintainer harvest."}],
    }


def test_harvested_source_gets_internal_credit() -> None:
    records = report._analysis(
        [_fake_pr(808, "imsharukhan", "fix: improve TopAppBar back button touch target")]
    )

    item = records[0]
    _assert(item["lifecycle"] == "harvested_source", "source PR must be a harvest lifecycle")
    _assert(item["author"] == "imsharukhan", "source author must keep credit")
    _assert(item["harvestedInto"] == 1013, "source PR must link to maintainer landing PR")
    _assert(item["score"] > 0, "harvested source must receive positive internal impact")

    leaderboard = report._leaderboard(records)
    _assert(leaderboard[0]["harvested"] == 1, "leaderboard must count harvest credits")


def test_harvest_attribution_names_external_ledger_boundary() -> None:
    records = report._analysis(
        [_fake_pr(808, "imsharukhan", "fix: improve TopAppBar back button touch target")]
    )

    lines = "\n".join(report._harvest_attribution_lines(records))
    _assert(
        "co-authored on the harvest replay follow-up once it lands" in lines,
        "harvest report must name the external GitHub attribution path",
    )
    _assert(
        "does not change #1013's original merge authorship or original additions/deletions" in lines,
        "harvest report must not imply original merge history changed",
    )


if __name__ == "__main__":
    test_harvested_source_gets_internal_credit()
    test_harvest_attribution_names_external_ledger_boundary()
    print("contributor impact tests passed")
