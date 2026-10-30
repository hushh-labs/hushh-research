#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Retry one exact canonical PR validation attempt without additional workflow dispatch."""

from __future__ import annotations

import argparse
import base64
import json
from pathlib import Path
import subprocess
import sys
import time
from typing import Any, Callable

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "scripts/ci"))
from github_security_authority import Refused, SHA, positive, verify_source  # noqa: E402

REPOSITORY = "hushh-labs/hushh-research"
Read = Callable[[str], Any]
Write = Callable[[str, dict | None], None]


def gh(path: str, payload: dict | None = None, *, write: bool = False) -> Any:
    args = ["gh", "api", path]
    if write:
        args.extend(["--method", "POST", "--input", "-"])
    try:
        result = subprocess.run(
            args, input=json.dumps(payload or {}) if write else None,
            capture_output=True, text=True, check=True, timeout=20,
        )
        if len(result.stdout) > 2 * 1024 * 1024:
            raise Refused("GitHub response exceeded its bound")
        return json.loads(result.stdout) if result.stdout.strip() else None
    except (subprocess.SubprocessError, OSError, ValueError):
        raise Refused("GitHub request unavailable; no provider response was recorded") from None


def verify_gate_job(read: Read, source: dict, job_id: int) -> None:
    positive(job_id, "job identity")
    prefix = f"repos/{REPOSITORY}"
    job = read(f"{prefix}/actions/jobs/{job_id}")
    inventory = read(
        f"{prefix}/actions/runs/{source['run_id']}/attempts/{source['attempt']}/jobs?per_page=100"
    )
    jobs, total = inventory.get("jobs"), inventory.get("total_count")
    if (
        not isinstance(jobs, list) or type(total) is not int or not 0 <= total <= 100
        or len(jobs) != total or any(not isinstance(row, dict) for row in jobs)
        or not any(row.get("id") == job_id for row in jobs)
    ):
        raise Refused("Job is absent from the complete bounded source-attempt inventory")
    gate = "CI Status Gate" if source["event"] == "pull_request" else "Branch Validation Gate"
    if any(job.get(key) != value for key, value in {
        "id": job_id, "run_id": source["run_id"], "head_sha": source["head_sha"],
        "status": "completed", "name": gate,
    }.items()):
        raise Refused("Job is not the completed exact-source final gate")


def rerun_validation(
    read: Read, write: Write, expected: dict, *, all_jobs: bool = False,
    job_id: int | None = None,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
) -> dict:
    positive(expected.get("run_id"), "source run")
    positive(expected.get("attempt"), "source attempt")
    if not isinstance(expected.get("head_sha"), str) or not SHA.fullmatch(expected["head_sha"]):
        raise Refused("An exact source SHA is required")
    prefix = f"repos/{REPOSITORY}"
    actor = read("user").get("login")
    policy_file = read(f"{prefix}/contents/config/ci-governance.json?ref=main")
    if policy_file.get("encoding") != "base64" or policy_file.get("size", 0) > 256 * 1024:
        raise Refused("Canonical main governance unavailable")
    policy = json.loads(base64.b64decode("".join(policy_file["content"].split()), validate=True))
    if not actor or actor not in policy["main"]["protected_pipeline_edit_users"]:
        raise Refused("CI rerun requires a governed operator")
    source = verify_source(read, REPOSITORY, expected)
    source_path = f"{prefix}/actions/runs/{expected['run_id']}"
    before = read(source_path)
    if before.get("status") != "completed" or any(
        before.get(key) != expected[field]
        for key, field in (("id", "run_id"), ("run_attempt", "attempt"), ("head_sha", "head_sha"))
    ):
        raise Refused("Source changed or is still running; no rerun requested")
    if job_id is not None:
        if all_jobs:
            raise Refused("Choose one job or the full validation")
        verify_gate_job(read, source, job_id)
    if job_id is None and not all_jobs and before.get("conclusion") not in {"failure", "timed_out", "cancelled"}:
        raise Refused("No failed validation to retry; use --all only for an intentional full rerun")
    endpoint = (
        f"{prefix}/actions/jobs/{job_id}/rerun" if job_id is not None else
        f"{source_path}/{'rerun' if all_jobs else 'rerun-failed-jobs'}"
    )
    # One dispatch only. A lost response is reconciled by observing the attempt.
    try:
        write(endpoint, None)
    except Refused:
        pass
    deadline = clock() + 60
    current = {**expected, "attempt": expected["attempt"] + 1}
    while True:
        observed = read(source_path)
        attempt = positive(observed.get("run_attempt"), "observed attempt")
        if observed.get("head_sha") != expected["head_sha"] or attempt not in {
            expected["attempt"], current["attempt"],
        }:
            raise Refused("Unexpected source attempt or SHA; security dispatch refused")
        if attempt == current["attempt"]:
            verify_source(read, REPOSITORY, current)
            break
        if clock() >= deadline:
            raise Refused("Rerun acceptance unconfirmed; inspect the source before another request")
        sleep(3)
    return {**current, "all_jobs": all_jobs, "job_id": job_id}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", type=int, required=True)
    parser.add_argument("--expected-attempt", type=int, required=True)
    parser.add_argument("--sha", required=True)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--failed", action="store_true", help="Retry failed jobs only (default)")
    mode.add_argument("--all", action="store_true", help="Explicitly retry the entire validation")
    mode.add_argument("--job-id", type=int, help="Retry only the final gate from this exact completed attempt")
    output = parser.add_mutually_exclusive_group()
    output.add_argument("--json", action="store_true")
    output.add_argument("--text", action="store_true")
    args = parser.parse_args()
    try:
        result = rerun_validation(
            gh, lambda path, body: gh(path, body, write=True),
            {"run_id": args.run_id, "attempt": args.expected_attempt, "head_sha": args.sha},
            all_jobs=args.all,
            job_id=args.job_id,
        )
        print(json.dumps(result) if args.json else (
            f"PR Validation {result['run_id']} attempt {result['attempt']} requested; "
            "no additional workflow was dispatched."
        ))
        return 0
    except (Refused, KeyError, TypeError, ValueError) as error:
        message = str(error) if isinstance(error, Refused) else "Canonical authority unavailable"
        print(json.dumps({"status": "refused", "reason": message}) if args.json else message)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
