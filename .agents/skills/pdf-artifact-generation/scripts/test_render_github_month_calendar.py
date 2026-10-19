#!/usr/bin/env python3
"""Focused contract tests for source-linked contributor calendar rendering."""

from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import unittest


SCRIPT = Path(__file__).with_name("render_github_month_calendar.py")
SPEC = importlib.util.spec_from_file_location("render_github_month_calendar", SCRIPT)
assert SPEC and SPEC.loader
renderer = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = renderer
SPEC.loader.exec_module(renderer)


class GithubMonthCalendarRendererTests(unittest.TestCase):
    def test_prefers_a_merged_pr_and_emits_pr_commit_and_title_links(self) -> None:
        evidence = {
            "audit_window": {"month": "2026-07"},
            "calendar": {"days": {f"2026-07-{day:02d}": {"contributors": {}} for day in range(1, 32)}},
            "people": {"Akshat": {"pull_requests": {"opened_in_window": [], "merged_in_window": [{"number": 4726, "changedFiles": 32, "additions": 1594, "deletions": 521}]}}},
        }
        evidence["calendar"]["days"]["2026-07-01"]["contributors"]["Akshat"] = {
            "prs_opened": 1,
            "prs_merged": 1,
            "issues_created": 0,
            "events": [
                {"kind": "pull_request_opened", "number": 4725, "url": "https://github.com/example/pull/4725", "title": "draft"},
                {
                    "kind": "pull_request_merged",
                    "number": 4726,
                    "url": "https://github.com/example/pull/4726",
                    "title": "feat(pkm): add opt-in automatic memory saving",
                    "head_commit": {"short_oid": "abc1234", "url": "https://github.com/example/commit/abc1234"},
                },
            ],
        }

        markdown = renderer.render_calendar(evidence, "Akshat")

        self.assertIn("[PR #4726](https://github.com/example/pull/4726)", markdown)
        self.assertIn("[c abc1234](https://github.com/example/commit/abc1234)", markdown)
        self.assertIn("add opt-in automatic memory saving", markdown)

    def test_lists_inactive_date_ranges_to_account_for_the_full_month(self) -> None:
        evidence = {
            "audit_window": {"month": "2026-02"},
            "calendar": {"days": {f"2026-02-{day:02d}": {"contributors": {}} for day in range(1, 29)}},
            "people": {"Akshat": {"pull_requests": {"opened_in_window": [], "merged_in_window": []}}},
        }
        evidence["calendar"]["days"]["2026-02-02"]["contributors"]["Akshat"] = {
            "prs_opened": 1,
            "prs_merged": 0,
            "issues_created": 0,
            "events": [{"kind": "pull_request_opened", "number": 1, "url": "https://github.com/example/pull/1", "title": "first"}],
        }

        markdown = renderer.render_calendar(evidence, "Akshat")

        self.assertIn("| Feb 1 · Sun | — | No retrieved GitHub event for this account. |", markdown)
        self.assertIn("| Feb 3–28 · Sat | — | No retrieved GitHub event for this account. |", markdown)


if __name__ == "__main__":
    unittest.main()
