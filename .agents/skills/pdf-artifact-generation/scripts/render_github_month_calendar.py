#!/usr/bin/env python3
"""Render one contributor's source-linked month calendar from frozen GitHub evidence."""

from __future__ import annotations

import argparse
import calendar
import json
import re
import sys
from datetime import date
from pathlib import Path
from typing import Any


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path, help="frozen collector JSON")
    parser.add_argument("--person", required=True, help="display name exactly as recorded in evidence")
    return parser.parse_args(argv)


def source_priority(source: dict[str, Any], pull_requests: dict[int, dict[str, Any]]) -> tuple[int, int, int, int]:
    kind_rank = {"pull_request_merged": 3, "pull_request_opened": 2, "issue_created": 1}.get(source["kind"], 0)
    pull_request = pull_requests.get(source["number"], {})
    return (
        kind_rank,
        int(pull_request.get("changedFiles") or 0),
        int(pull_request.get("additions") or 0) + int(pull_request.get("deletions") or 0),
        -int(source["number"]),
    )


def concise_title(title: str, limit: int = 38) -> str:
    cleaned = re.sub(r"^(?:feat|fix|chore|docs|refactor|test|build)(?:\([^)]*\))?:\s*", "", title, flags=re.I)
    cleaned = " ".join(cleaned.replace("|", "/").split())
    return cleaned if len(cleaned) <= limit else f"{cleaned[: limit - 1].rstrip()}…"


def source_detail(source: dict[str, Any]) -> str:
    kind = {
        "pull_request_merged": "PR",
        "pull_request_opened": "PR",
        "issue_created": "Issue",
    }.get(source["kind"], "Source")
    detail = f"[{kind} #{source['number']}]({source['url']})"
    head_commit = source.get("head_commit") or {}
    if head_commit.get("url") and head_commit.get("short_oid"):
        detail += f" · [c {head_commit['short_oid']}]({head_commit['url']})"
    return f"{detail} — {concise_title(source['title'])}"


def event_measure(activity: dict[str, Any]) -> str:
    parts: list[str] = []
    if activity.get("prs_merged"):
        parts.append(f"M {activity['prs_merged']}")
    if activity.get("prs_opened"):
        parts.append(f"O {activity['prs_opened']}")
    if activity.get("issues_created"):
        parts.append(f"I {activity['issues_created']}")
    return " · ".join(parts)


def render_calendar(evidence: dict[str, Any], person: str) -> str:
    if person not in evidence["people"]:
        raise ValueError(f"unknown person {person!r}")
    audit_month = evidence["audit_window"]["month"]
    year, month = (int(part) for part in audit_month.split("-", 1))
    days = evidence["calendar"]["days"]
    person_data = evidence["people"][person]
    pull_requests = {
        node["number"]: node
        for node in [
            *person_data["pull_requests"]["opened_in_window"],
            *person_data["pull_requests"]["merged_in_window"],
        ]
    }

    rows = ["| Local date | Recorded event | Audited delivery |", "| --- | --- | --- |"]
    inactive_start: int | None = None

    def flush_inactive(end_day: int) -> None:
        nonlocal inactive_start
        if inactive_start is None:
            return
        start_label = date(year, month, inactive_start).strftime("%b %-d")
        end_label = date(year, month, end_day).strftime("%-d · %a")
        local_date = (
            date(year, month, end_day).strftime("%b %-d · %a")
            if inactive_start == end_day
            else f"{start_label}–{end_label}"
        )
        rows.append(f"| {local_date} | — | No retrieved GitHub event for this account. |")
        inactive_start = None

    last_day = calendar.monthrange(year, month)[1]
    for day_number in range(1, last_day + 1):
        day_key = date(year, month, day_number).isoformat()
        activity = (days.get(day_key, {}).get("contributors", {}).get(person) or {})
        measure = event_measure(activity)
        if not measure:
            inactive_start = inactive_start or day_number
            continue
        flush_inactive(day_number - 1)
        sources = activity.get("events") or []
        source = max(sources, key=lambda item: source_priority(item, pull_requests)) if sources else None
        detail = source_detail(source) if source else "No source record retained"
        local_date = date(year, month, day_number).strftime("%b %-d · %a")
        rows.append(f"| {local_date} | {measure} | {detail} |")
    flush_inactive(last_day)
    return "\n".join(rows)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    evidence = json.loads(args.input.read_text(encoding="utf-8"))
    print(render_calendar(evidence, args.person))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
