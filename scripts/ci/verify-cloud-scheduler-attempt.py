#!/usr/bin/env python3
"""Verify fresh, completed Cloud Scheduler HTTP execution evidence."""

from __future__ import annotations

import argparse
from datetime import datetime
import json
from pathlib import Path
import sys
from typing import Any


ATTEMPT_FINISHED_TYPE = (
    "type.googleapis.com/google.cloud.scheduler.logging.AttemptFinished"
)


def parse_instant(value: object) -> datetime:
    raw = str(value or "").strip()
    if raw.endswith("Z"):
        raw = f"{raw[:-1]}+00:00"
    parsed = datetime.fromisoformat(raw)
    if parsed.tzinfo is None:
        raise ValueError("Scheduler evidence timestamp must include a timezone")
    return parsed


def _latest_completion(
    entries: object, *, triggered_at: datetime, expected_job: str, expected_uri: str
):
    if not isinstance(entries, list):
        raise ValueError("Cloud Scheduler completion log response is not a list")
    matching: list[tuple[datetime, dict[str, Any], dict[str, Any], dict[str, Any]]] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        payload = entry.get("jsonPayload") or {}
        http_request = entry.get("httpRequest") or {}
        if not isinstance(payload, dict) or not isinstance(http_request, dict):
            continue

        try:
            completed_at = parse_instant(entry.get("timestamp"))
        except ValueError:
            continue
        if (
            payload.get("@type") != ATTEMPT_FINISHED_TYPE
            or payload.get("jobName") != expected_job
            or payload.get("url") != expected_uri
            or completed_at < triggered_at
        ):
            continue
        matching.append((completed_at, entry, payload, http_request))

    if not matching:
        return None

    # Never skip past a newer failed or incomplete finish record to accept an
    # older success. The latest exact-job/URI completion is the scheduler's
    # current bounded-drain evidence.
    return max(matching, key=lambda item: item[0])


def successful_completion(
    entries: object,
    *,
    triggered_at: datetime,
    expected_job: str,
    expected_uri: str,
) -> dict[str, Any] | None:
    latest = _latest_completion(
        entries,
        triggered_at=triggered_at,
        expected_job=expected_job,
        expected_uri=expected_uri,
    )
    if latest is None:
        return None
    _, entry, payload, http_request = latest
    # Do not default a missing HTTP status to success. Job.lastAttemptTime is
    # attempt-start evidence only; this concrete 2xx is the acknowledgement
    # from the HTTP target.
    raw_http_status = http_request.get("status")
    try:
        http_status = int(raw_http_status)
    except (TypeError, ValueError):
        return None
    if (
        not 200 <= http_status < 300
        or str(entry.get("severity") or "").upper() == "ERROR"
        # Successful Scheduler logs commonly omit jsonPayload.status. If
        # present, however, it must be the explicit OK state.
        or str(payload.get("status") or "OK").upper() != "OK"
    ):
        return None

    return {
        "completed_at": str(entry.get("timestamp") or ""),
        "http_status": http_status,
        "insert_id": str(entry.get("insertId") or ""),
        "job_name": str(payload.get("jobName") or ""),
        "target_type": str(payload.get("targetType") or ""),
        "uri": str(payload.get("url") or ""),
    }


def completion_state(entries: object, **identity) -> str:
    """Classify polling; permission/configuration/invalid evidence never waits."""
    latest = _latest_completion(entries, **identity)
    if latest is None:
        return "pending"
    _, _entry, payload, request = latest
    code = request.get("status")
    if (
        type(code) is int
        and code in {408, 429, 502, 503, 504}
        and str(payload.get("status") or "OK").upper()
        in {
            "OK",
            "UNAVAILABLE",
            "DEADLINE_EXCEEDED",
            "RESOURCE_EXHAUSTED",
            "UNKNOWN",
            "INTERNAL",
        }
    ):
        return "transient_failure"
    return (
        "complete" if successful_completion(entries, **identity) else "terminal_failure"
    )


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--logs-json", required=True, type=Path)
    parser.add_argument("--triggered-at", required=True)
    parser.add_argument("--expected-job", required=True)
    parser.add_argument("--expected-uri", required=True)
    parser.add_argument("--evidence-path", required=True, type=Path)
    parser.add_argument("--pending-exit-code", type=int, choices=(1, 75), default=1)
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    try:
        entries = json.loads(args.logs_json.read_text(encoding="utf-8"))
        triggered_at = parse_instant(args.triggered_at)
        selected = successful_completion(
            entries,
            triggered_at=triggered_at,
            expected_job=args.expected_job,
            expected_uri=args.expected_uri,
        )
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 1

    state = (
        completion_state(
            entries,
            triggered_at=triggered_at,
            expected_job=args.expected_job,
            expected_uri=args.expected_uri,
        )
        if args.pending_exit_code == 75
        else None
    )
    checks = {
        "fresh_attempt_finished": selected is not None,
        "http_2xx": bool(selected and 200 <= selected["http_status"] < 300),
    }
    args.evidence_path.write_text(
        json.dumps(
            {
                "status": (
                    "healthy"
                    if all(checks.values())
                    else "blocked"
                    if state == "terminal_failure"
                    else "waiting"
                ),
                **({"classification": state} if state is not None else {}),
                "triggered_at": args.triggered_at,
                "checks": checks,
                "completion": selected,
            },
            indent=2,
            sort_keys=True,
        ),
        encoding="utf-8",
    )
    if all(checks.values()):
        return 0
    if state in {"pending", "transient_failure"}:
        return 75
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
