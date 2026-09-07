#!/usr/bin/env python3
"""Focused contract tests for the portable monthly GitHub evidence collector."""

from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import unittest


SCRIPT = Path(__file__).with_name("collect_github_month.py")
SPEC = importlib.util.spec_from_file_location("collect_github_month", SCRIPT)
assert SPEC and SPEC.loader
collector = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = collector
SPEC.loader.exec_module(collector)


class GithubMonthCollectorTests(unittest.TestCase):
    def test_builds_an_inclusive_local_calendar_month(self) -> None:
        window = collector.parse_window("2026-07", "America/Los_Angeles")

        self.assertEqual(window.from_utc, "2026-07-01T07:00:00Z")
        self.assertEqual(window.to_utc, "2026-08-01T06:59:59Z")
        self.assertEqual(len(collector.empty_calendar(window)), 31)

    def test_rejects_non_month_input(self) -> None:
        with self.assertRaisesRegex(Exception, "YYYY-MM"):
            collector.parse_window("July 2026", "America/Los_Angeles")

    def test_rejects_unknown_timezone(self) -> None:
        with self.assertRaisesRegex(Exception, "IANA"):
            collector.parse_window("2026-07", "Mars/Olympus")

    def test_calendar_records_only_events_inside_the_requested_month(self) -> None:
        window = collector.parse_window("2026-07", "America/Los_Angeles")
        days = collector.empty_calendar(window)

        collector.add_daily_event(
            days,
            collector.date_in_window("2026-08-01T06:59:59Z", window),
            "Akshat",
            "prs_merged",
        )
        collector.add_daily_event(
            days,
            collector.date_in_window("2026-08-01T07:00:00Z", window),
            "Akshat",
            "prs_merged",
        )

        self.assertEqual(days["2026-07-31"]["prs_merged"], 1)
        self.assertEqual(days["2026-07-31"]["contributors"]["Akshat"]["prs_merged"], 1)

    def test_local_window_keeps_last_local_day_and_excludes_next_local_day(self) -> None:
        window = collector.parse_window("2026-07", "America/Los_Angeles")

        self.assertEqual(collector.date_in_window("2026-08-01T06:59:59Z", window), "2026-07-31")
        self.assertIsNone(collector.date_in_window("2026-08-01T07:00:00Z", window))

    def test_daily_event_preserves_an_auditable_source_reference(self) -> None:
        window = collector.parse_window("2026-07", "America/Los_Angeles")
        days = collector.empty_calendar(window)
        source = {
            "kind": "pull_request_merged",
            "number": 4726,
            "url": "https://github.com/hushh-labs/hushh-research/pull/4726",
            "title": "feat(pkm): add opt-in automatic memory saving",
            "event_at": "2026-07-30T03:43:38Z",
            "head_commit": {"short_oid": "abc1234", "url": "https://github.com/example/commit/abc1234"},
        }

        collector.add_daily_event(days, "2026-07-29", "Akshat", "prs_merged", source)

        self.assertEqual(days["2026-07-29"]["contributors"]["Akshat"]["events"], [source])


if __name__ == "__main__":
    unittest.main()
