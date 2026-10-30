#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh Research

"""Plain-English timeline of Personal World Model research on a hosted environment.

Answers "is research running, blocked, rate limited or idle" from Cloud Logging
alone, using the operator's existing gcloud auth. Every call is read-only.

    python3 scripts/ops/pwm_uat_status.py --env uat --hours 2
    python3 scripts/ops/pwm_uat_status.py --env production --hours 6 --json

What it reads:

- backend lifecycle lines from hushh_mcp.services.profile_research_jobs:
  ``one.pwm_decision``, ``one.pwm_started``, ``one.pwm_finished``,
  ``one.pwm_failed`` and ``one.pwm_checkpoint_unavailable`` (revisions older
  than the ``one.pwm_`` prefix log the same runs as ``one.magic_discovery_*``,
  which is read too and labelled as such);
- Cloud Run request logs for ``/world-model/`` paths on both services, so
  ``/ensure`` and ``/jobs`` status counts (including 429) are visible;
- provider failures the redaction filter rewrites to ``SDK failure ...
  status_code=403``;
- the serving backend revision and its ``GENAI_GOOGLE_CLOUD_PROJECT``.

The lifecycle lines carry codes and counts only; this script parses a fixed
set of keys and prints nothing else from a log line, so owner text, emails and
tokens cannot reach the terminal even if a future line were to contain them.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from collections import Counter
from datetime import datetime, timezone
from typing import Any

ENVIRONMENTS = {
    "uat": {"project": "hushh-pda-uat"},
    "production": {"project": "hushh-pda"},
}
REGION = "us-central1"
BACKEND_SERVICE = "consent-protocol"
FRONTEND_SERVICE = "hushh-webapp"
# Per-query cap; the report says so when a window hits it.
LOG_LIMIT = 3000
# A retry storm repeats the same three lines every minute; the text view shows
# the first and last of a long timeline and --json keeps all of it.
TIMELINE_ROWS = 24

_LIFECYCLE_RE = re.compile(r"one\.(pwm|magic_discovery)_([a-z_]+)\b(.*)$")
_PAIR_RE = re.compile(r"\b([a-z_]+)=(\S+)")
# Values are codes and counts. Anything else is replaced, never echoed.
_SAFE_VALUE_RE = re.compile(r"^[A-Za-z0-9_.:\-\[\]]{1,48}$")
_LIFECYCLE_KEYS = {
    "op",
    "decision",
    "status",
    "job",
    "prior",
    "starts_hour",
    "searches_used",
    "model_calls_used",
    "resumed",
    "committed",
    "research_exhausted",
    "duration_ms",
    "searches",
    "model_calls",
    "stage",
    "error_type",
    "cause_type",
    "cause_origin",
    "provider_code",
    "provider_status",
    "llm_calls",
    "elapsed_ms",
}
_SDK_403_RE = re.compile(r"SDK failure type=(\w+) status_code=403(?: status=([A-Z_]+))?")
_GOOD_STATUSES = {"offered", "low_confidence", "saved"}


def gcloud(args: list[str]) -> Any:
    """Run a read-only gcloud command and parse its JSON output."""
    completed = subprocess.run(  # noqa: S603 - fixed executable and argv; never shell=True
        ["gcloud", *args],
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        first = (completed.stderr.strip().splitlines() or ["gcloud failed"])[0]
        raise SystemExit(f"gcloud {args[0]} {args[1]} failed: {first}")
    return json.loads(completed.stdout or "[]")


def read_logs(project: str, hours: int, log_filter: str) -> list[dict[str, Any]]:
    """Newest rows first (the fast order); callers sort what they keep."""
    return gcloud(
        [
            "logging",
            "read",
            log_filter,
            f"--project={project}",
            f"--freshness={hours}h",
            f"--limit={LOG_LIMIT}",
            "--format=json(timestamp,severity,textPayload,httpRequest,resource.labels)",
        ]
    )


def parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def clock(value: str | None) -> str:
    return parse_time(value).strftime("%H:%M:%SZ") if value else "-"


def safe(value: str | None) -> str:
    if value is None:
        return "-"
    return value if _SAFE_VALUE_RE.match(value) else "?"


def lifecycle_events(entries: list[dict[str, Any]], owner_ref: str | None) -> list[dict]:
    events: list[dict] = []
    for entry in entries:
        text = entry.get("textPayload") or ""
        match = _LIFECYCLE_RE.search(text)
        if not match:
            continue
        if owner_ref and owner_ref not in text:
            continue
        prefix, name, rest = match.groups()
        fields = {
            key: safe(value) for key, value in _PAIR_RE.findall(rest) if key in _LIFECYCLE_KEYS
        }
        events.append(
            {
                "at": entry.get("timestamp"),
                "event": name,
                "legacy_prefix": prefix != "pwm",
                "severity": entry.get("severity") or "DEFAULT",
                "revision": entry.get("resource", {}).get("labels", {}).get("revision_name"),
                **fields,
            }
        )
    return sorted(events, key=lambda event: event["at"])


def http_summary(entries: list[dict[str, Any]]) -> tuple[dict, list[dict]]:
    """Status counts per service and path, plus the 429s as timeline events."""
    counts: Counter = Counter()
    limited = []
    for entry in entries:
        request = entry.get("httpRequest") or {}
        url = request.get("requestUrl") or ""
        path = url.split("?", 1)[0]
        tail = path.split("/world-model/", 1)[-1] if "/world-model/" in path else "other"
        service = entry.get("resource", {}).get("labels", {}).get("service_name", "?")
        status = int(request.get("status") or 0)
        counts[(service, tail, status)] += 1
        if status == 429:
            limited.append(
                {
                    "at": entry.get("timestamp"),
                    "event": "rate_limited",
                    "service": service,
                    "path": tail,
                    "method": request.get("requestMethod"),
                }
            )
    table = {}
    for (service, tail, status), count in sorted(counts.items()):
        table.setdefault(service, {}).setdefault(tail, {})[str(status)] = count
    return table, sorted(limited, key=lambda event: event["at"])


def provider_403(entries: list[dict[str, Any]]) -> list[dict]:
    hits = []
    for entry in entries:
        match = _SDK_403_RE.search(entry.get("textPayload") or "")
        if match:
            hits.append(
                {
                    "at": entry.get("timestamp"),
                    "event": "provider_403",
                    "error_type": match.group(1),
                    "provider_status": match.group(2) or "-",
                }
            )
    return sorted(hits, key=lambda event: event["at"])


def collapse(events: list[dict], window_seconds: int = 60) -> list[dict]:
    """Fold bursts of the same event into one line with a count and span."""
    folded: list[dict] = []
    keys = ("event", "op", "decision", "status", "provider_status", "service", "path")
    for event in sorted(events, key=lambda item: item["at"]):
        last = folded[-1] if folded else None
        same = last is not None and all(last.get(k) == event.get(k) for k in keys)
        if same and (parse_time(event["at"]) - parse_time(last["last_at"])).total_seconds() <= (
            window_seconds
        ):
            last["count"] += 1
            last["last_at"] = event["at"]
        else:
            folded.append({**event, "count": 1, "last_at": event["at"]})
    return folded


def serving_revision(project: str) -> dict[str, Any]:
    service = gcloud(
        [
            "run",
            "services",
            "describe",
            BACKEND_SERVICE,
            f"--project={project}",
            f"--region={REGION}",
            "--format=json",
        ]
    )
    serving = [
        item.get("revisionName")
        for item in service.get("status", {}).get("traffic", [])
        if item.get("percent")
    ]
    env = {
        item["name"]: item.get("value", "(secret)")
        for item in service["spec"]["template"]["spec"]["containers"][0].get("env", [])
        if item["name"]
        in {"GENAI_GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT", "HUSHH_GENAI_AUTH_MODE"}
    }
    return {
        "service": BACKEND_SERVICE,
        "serving": serving or [service.get("status", {}).get("latestReadyRevisionName")],
        "latest_ready": service.get("status", {}).get("latestReadyRevisionName"),
        "env": env,
    }


def verdict(lifecycle: list[dict], blocked: list[dict], limited: list[dict]) -> str:
    def last_at(items: list[dict]) -> str | None:
        return items[-1]["at"] if items else None

    finished_ok = [
        event
        for event in lifecycle
        if event["event"] == "finished" and event.get("status") in _GOOD_STATUSES
    ]
    failed_403 = [
        e for e in lifecycle if e["event"] == "failed" and e.get("provider_code") == "403"
    ]
    first_block = min((e["at"] for e in [*blocked, *failed_403]), default=None)
    last_block = max((e["at"] for e in [*blocked, *failed_403]), default=None)
    if last_block and (not finished_ok or last_block > last_at(finished_ok)):
        return f"Provider blocked (403) since at least {clock(first_block)}"
    started = [e for e in lifecycle if e["event"] == "started"]
    if limited and (not started or last_at(limited) > last_at(started)):
        return "Owner is rate limited"
    if lifecycle:
        return "Research can run"
    return "Idle"


def describe(event: dict) -> str:
    """One plain-English timeline line; only whitelisted codes and counts."""
    name = event["event"]
    span = (
        f" x{event['count']} until {clock(event['last_at'])}" if event.get("count", 1) > 1 else ""
    )
    legacy = " (older log prefix)" if event.get("legacy_prefix") else ""

    def fields(*names: str) -> str:
        present = [f"{n}={event[n]}" for n in names if event.get(n) not in (None, "-")]
        return f" ({', '.join(present)})" if present else ""

    if name == "decision":
        line = f"{event.get('op', '-')} decided {event.get('decision', '-')}" + fields(
            "prior", "starts_hour", "searches_used", "model_calls_used"
        )
    elif name == "started":
        line = "run started" + fields("resumed", "searches_used", "model_calls_used")
    elif name == "finished":
        line = f"run finished status={event.get('status', '-')}" + fields(
            "searches", "model_calls", "duration_ms"
        )
    elif name == "failed":
        line = f"run failed stage={event.get('stage', '-')}" + fields(
            "provider_code", "provider_status", "cause_type"
        )
    elif name == "provider_403":
        line = f"provider refused with 403 {event.get('provider_status', '-')}"
    elif name == "rate_limited":
        line = f"{event.get('service')} answered 429 on /{event.get('path')}"
    else:
        line = name.replace("_", " ")
    return f"{clock(event['at'])}  {line}{legacy}{span}"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--env", choices=sorted(ENVIRONMENTS), default="uat")
    parser.add_argument("--hours", type=int, default=2)
    parser.add_argument(
        "--owner-ref",
        help="Keep only lifecycle lines containing this reference, exactly as the logs carry it.",
    )
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    project = ENVIRONMENTS[args.env]["project"]
    backend = (
        f'resource.type="cloud_run_revision" AND resource.labels.service_name="{BACKEND_SERVICE}"'
    )

    lifecycle_rows = read_logs(
        project,
        args.hours,
        f'{backend} AND (textPayload:"one.pwm_" OR textPayload:"one.magic_discovery_")',
    )
    http_filter = (
        'resource.type="cloud_run_revision" AND logName:"requests"'
        ' AND httpRequest.requestUrl:"/world-model/"'
    )
    # Polling makes /jobs noisy; errors come from their own query so a capped
    # sample of the successes can never hide a 429.
    error_rows = read_logs(project, args.hours, f"{http_filter} AND httpRequest.status>=400")
    http_rows = read_logs(project, args.hours, f"{http_filter} AND httpRequest.status<400")
    sdk_rows = read_logs(
        project,
        args.hours,
        f'{backend} AND textPayload:"SDK failure" AND textPayload:"status_code=403"',
    )
    lifecycle = lifecycle_events(lifecycle_rows, args.owner_ref)
    http_table, limited = http_summary([*error_rows, *http_rows])
    blocked = provider_403(sdk_rows)
    revision = serving_revision(project)
    capped = [
        name
        for name, rows in (
            ("lifecycle", lifecycle_rows),
            ("http errors", error_rows),
            ("http successes", http_rows),
            ("provider 403", sdk_rows),
        )
        if len(rows) >= LOG_LIMIT
    ]
    timeline = [*lifecycle, *blocked, *limited]
    report = {
        "env": args.env,
        "project": project,
        "hours": args.hours,
        "owner_filter": bool(args.owner_ref),
        "verdict": verdict(lifecycle, blocked, limited),
        "revision": revision,
        "counts": {
            "lifecycle": dict(Counter(event["event"] for event in lifecycle)),
            "finished_by_status": dict(
                Counter(e.get("status", "-") for e in lifecycle if e["event"] == "finished")
            ),
            "failed_by_provider_code": dict(
                Counter(e.get("provider_code", "-") for e in lifecycle if e["event"] == "failed")
            ),
            "provider_403": len(blocked),
            "http_429": len(limited),
            "legacy_prefix_lines": sum(1 for e in lifecycle if e.get("legacy_prefix")),
        },
        "http": http_table,
        "timeline": collapse(timeline),
        "capped_queries": capped,
    }
    if args.json:
        print(json.dumps(report, indent=2))
        return 0

    print(f"Personal World Model on {args.env} ({project}), last {args.hours}h, times UTC")
    print(f"Verdict: {report['verdict']}")
    print(
        f"Serving {revision['service']}: {', '.join(r or '-' for r in revision['serving'])}"
        f" (latest ready {revision['latest_ready']})"
    )
    for key, value in sorted(revision["env"].items()):
        print(f"  {key}={value}")
    if args.owner_ref:
        print(f"Owner filter on: {len(lifecycle)} lifecycle lines matched")
    print()
    print("Runs:")
    counts = report["counts"]
    print(f"  lifecycle events: {counts['lifecycle'] or 'none'}")
    print(f"  finished by status: {counts['finished_by_status'] or 'none'}")
    print(f"  failed by provider code: {counts['failed_by_provider_code'] or 'none'}")
    print(f"  provider 403 lines: {counts['provider_403']}")
    if counts["legacy_prefix_lines"]:
        print(f"  {counts['legacy_prefix_lines']} lines use the older one.magic_discovery_ prefix")
    print()
    print("HTTP /world-model/* by service, path and status:")
    if not http_table:
        print("  none")
    for service, paths in http_table.items():
        for path, statuses in paths.items():
            cells = ", ".join(f"{status}: {count}" for status, count in sorted(statuses.items()))
            print(f"  {service} /{path}  {cells}")
    print()
    print("Timeline:")
    if not report["timeline"]:
        print("  nothing in this window")
    rows = report["timeline"]
    hidden = max(0, len(rows) - 2 * TIMELINE_ROWS)
    for index, event in enumerate(rows):
        if hidden and TIMELINE_ROWS <= index < len(rows) - TIMELINE_ROWS:
            if index == TIMELINE_ROWS:
                print(f"  ... {hidden} more lines (use --json for all) ...")
            continue
        print(f"  {describe(event)}")
    if capped:
        print()
        print(f"Note: {', '.join(capped)} hit the {LOG_LIMIT}-row cap; counts there are a sample.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
