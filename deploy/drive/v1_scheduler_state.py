#!/usr/bin/env python3
"""Manage only the isolated UAT V1 Drive drain job.

The existing three Drive jobs are deliberately outside this helper's mutation
boundary. A snapshot records whether this one job existed and its reviewed
configuration so a failed rollout can restore or remove it.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import json
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlsplit

PROJECT = "hushh-pda-uat"
REGION = "us-central1"
SERVICE = "consent-protocol-drive-v1-worker"
JOB = "drive-work-v1-uat"
ACCOUNT = "drive-work-drain-sched@hushh-pda-uat.iam.gserviceaccount.com"
AUDIENCE = "https://api.uat.hushh.ai"
PATH = "/api/internal/drive-work/drain"
SCHEDULE = "* * * * *"
BODY = b'{"stage":"v1"}'
ORIGIN = re.compile(
    r"https://consent-protocol-drive-v1-worker-[a-z0-9-]+\.a\.run\.app\Z"
)
FULL_JOB = f"projects/{PROJECT}/locations/{REGION}/jobs/{JOB}"
SCHEMA = "drive.v1.scheduler.v1"


def select_stage(stage: str) -> None:
    """Two reviewed jobs on the same private service; no caller-defined target."""
    global JOB, BODY, FULL_JOB, SCHEMA
    if stage not in {"v1", "groups"}:
        raise V1SchedulerError("Unknown scheduler stage")
    JOB = {"v1": "drive-work-v1-uat", "groups": "drive-work-groups-uat"}[stage]
    BODY = json.dumps({"stage": stage}, separators=(",", ":")).encode()
    FULL_JOB = f"projects/{PROJECT}/locations/{REGION}/jobs/{JOB}"
    SCHEMA = f"drive.{stage}.scheduler.v1"


class V1SchedulerError(ValueError):
    """A redacted, fixed-boundary scheduler error."""


def _run(*args: str) -> str:
    result = subprocess.run(  # noqa: S603 -- fixed gcloud binary and reviewed job arguments
        ["gcloud", *args], capture_output=True, text=True, check=False
    )
    if result.returncode:
        raise V1SchedulerError("V1 scheduler command failed")
    return result.stdout


def _origin() -> str:
    url = (
        _run(
            "run",
            "services",
            "describe",
            SERVICE,
            f"--project={PROJECT}",
            f"--region={REGION}",
            "--format=value(status.url)",
        )
        .strip()
        .rstrip("/")
    )
    if not ORIGIN.fullmatch(url):
        raise V1SchedulerError("V1 worker origin is outside the UAT boundary")
    return url


def _describe() -> dict | None:
    rows = json.loads(
        _run(
            "scheduler",
            "jobs",
            "list",
            f"--project={PROJECT}",
            f"--location={REGION}",
            "--format=json",
        )
    )
    if not isinstance(rows, list):
        raise V1SchedulerError("V1 scheduler listing is invalid")
    matches = [
        row for row in rows if isinstance(row, dict) and row.get("name") == FULL_JOB
    ]
    if len(matches) > 1:
        raise V1SchedulerError("V1 scheduler job is ambiguous")
    if not matches:
        return None
    job = json.loads(
        _run(
            "scheduler",
            "jobs",
            "describe",
            JOB,
            f"--project={PROJECT}",
            f"--location={REGION}",
            "--format=json",
        )
    )
    if not isinstance(job, dict) or job.get("name") != FULL_JOB:
        raise V1SchedulerError("V1 scheduler description is invalid")
    return job


def _state(job: dict | None, origin: str) -> dict | None:
    if job is None:
        return None
    target = job.get("httpTarget") or {}
    oidc = target.get("oidcToken") or {}
    uri = target.get("uri")
    parsed = urlsplit(uri) if isinstance(uri, str) else None
    try:
        body = base64.b64decode(target.get("body"), validate=True)
    except (TypeError, ValueError, binascii.Error):
        raise V1SchedulerError("V1 scheduler body is invalid") from None
    retry = job.get("retryConfig") or {}
    if (
        not parsed
        or parsed.scheme != "https"
        or parsed.netloc != urlsplit(origin).netloc
        or parsed.path != PATH
        or parsed.query
        or parsed.fragment
        or uri != origin + PATH
        or target.get("httpMethod") != "POST"
        or target.get("headers")
        != {
            "Content-Type": "application/json",
            "User-Agent": "Google-Cloud-Scheduler",
        }
        or body != BODY
        or oidc.get("serviceAccountEmail") != ACCOUNT
        or oidc.get("audience") != AUDIENCE
        or job.get("schedule") != SCHEDULE
        or job.get("timeZone") != "Etc/UTC"
        or job.get("attemptDeadline") != "240s"
        or retry.get("retryCount") != 3
        or retry.get("minBackoffDuration") != "10s"
        or retry.get("maxBackoffDuration") != "120s"
        or retry.get("maxDoublings") != 3
        or job.get("state") not in {"PAUSED", "ENABLED"}
    ):
        raise V1SchedulerError(
            "V1 scheduler configuration is outside the reviewed boundary"
        )
    return {"origin": origin, "state": job["state"]}


def _set_job(origin: str) -> None:
    exists = _describe() is not None
    action = "update" if exists else "create"
    args = [
        "scheduler",
        "jobs",
        action,
        "http",
        JOB,
        f"--project={PROJECT}",
        f"--location={REGION}",
        f"--schedule={SCHEDULE}",
        "--time-zone=Etc/UTC",
        f"--uri={origin}{PATH}",
        "--http-method=POST",
        f"--message-body={BODY.decode()}",
        f"--oidc-service-account-email={ACCOUNT}",
        f"--oidc-token-audience={AUDIENCE}",
        "--attempt-deadline=240s",
        "--max-retry-attempts=3",
        "--min-backoff=10s",
        "--max-backoff=120s",
        "--max-doublings=3",
    ]
    args += (
        ["--update-headers=Content-Type=application/json"]
        if exists
        else ["--headers=Content-Type=application/json"]
    )
    _run(*args)


def _quarantine() -> None:
    """Pause the exact V1 job even when a partial update changed its target."""
    job = _describe()
    if job is None:
        return
    if job.get("state") != "PAUSED":
        _run(
            "scheduler",
            "jobs",
            "pause",
            JOB,
            f"--project={PROJECT}",
            f"--location={REGION}",
        )
    after = _describe()
    if after is not None and after.get("state") != "PAUSED":
        raise V1SchedulerError("V1 scheduler quarantine failed")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "mode",
        choices=(
            "capture",
            "capture-if-present",
            "capture-paused",
            "apply",
            "verify",
            "verify-paused",
            "restore",
            "quarantine",
        ),
    )
    parser.add_argument("--snapshot", type=Path)
    parser.add_argument("--stage", choices=("v1", "groups"), default="v1")
    args = parser.parse_args()
    select_stage(args.stage)
    if (
        args.mode
        in {
            "capture",
            "capture-if-present",
            "capture-paused",
            "restore",
            "verify-paused",
        }
        and args.snapshot is None
    ):
        parser.error("--snapshot is required")
    try:
        if args.mode == "quarantine":
            _quarantine()
            return 0
        raw_current = _describe()
        if args.mode == "capture-if-present" and raw_current is None:
            args.snapshot.write_text(
                json.dumps({"schema": SCHEMA, "job": None}), encoding="utf-8"
            )
            return 0
        if args.mode == "restore" and raw_current is None:
            snapshot = json.loads(args.snapshot.read_text(encoding="utf-8"))
            if snapshot.get("schema") != SCHEMA:
                raise V1SchedulerError("V1 scheduler snapshot is invalid")
            if snapshot.get("job") is None:
                return 0
        origin = _origin()
        # A partially applied target can be malformed. Restore validates the
        # trusted fixed-lane snapshot first, then reconstructs only this job.
        current = _state(raw_current, origin) if args.mode != "restore" else None
        if args.mode in {"capture", "capture-if-present", "capture-paused"}:
            if args.mode == "capture-paused" and current != {
                "origin": origin,
                "state": "PAUSED",
            }:
                raise V1SchedulerError("V1 paused release requires a paused baseline")
            args.snapshot.write_text(
                json.dumps({"schema": SCHEMA, "job": current}, sort_keys=True),
                encoding="utf-8",
            )
        elif args.mode == "verify-paused":
            snapshot = json.loads(args.snapshot.read_text(encoding="utf-8"))
            if (
                snapshot.get("schema") != SCHEMA
                or snapshot.get("job") != {"origin": origin, "state": "PAUSED"}
                or current != snapshot["job"]
            ):
                raise V1SchedulerError("V1 paused scheduler baseline changed")
        elif args.mode == "apply":
            _set_job(origin)
            applied = _state(_describe(), origin)
            if applied is not None and applied["state"] == "PAUSED":
                _run(
                    "scheduler",
                    "jobs",
                    "resume",
                    JOB,
                    f"--project={PROJECT}",
                    f"--location={REGION}",
                )
            if _state(_describe(), origin) != {"origin": origin, "state": "ENABLED"}:
                raise V1SchedulerError("V1 scheduler apply could not be verified")
        elif args.mode == "verify":
            if current != {"origin": origin, "state": "ENABLED"}:
                raise V1SchedulerError(
                    "V1 scheduler is not enabled on the verified worker"
                )
        else:
            snapshot = json.loads(args.snapshot.read_text(encoding="utf-8"))
            if snapshot.get("schema") != SCHEMA:
                raise V1SchedulerError("V1 scheduler snapshot is invalid")
            before = snapshot.get("job")
            if before is not None and before not in (
                {"origin": origin, "state": "ENABLED"},
                {"origin": origin, "state": "PAUSED"},
            ):
                raise V1SchedulerError(
                    "V1 scheduler snapshot is outside the UAT boundary"
                )
            try:
                restored = _state(raw_current, origin)
            except V1SchedulerError:
                restored = None
            if restored == before and (raw_current is None or restored is not None):
                return 0
            if before is None:
                if raw_current is not None:
                    _run(
                        "scheduler",
                        "jobs",
                        "delete",
                        JOB,
                        f"--project={PROJECT}",
                        f"--location={REGION}",
                        "--quiet",
                    )
            else:
                _set_job(origin)
                verb = "pause" if before["state"] == "PAUSED" else "resume"
                applied = _state(_describe(), origin)
                if applied is None or applied["state"] != before["state"]:
                    _run(
                        "scheduler",
                        "jobs",
                        verb,
                        JOB,
                        f"--project={PROJECT}",
                        f"--location={REGION}",
                    )
            if _state(_describe(), origin) != before:
                raise V1SchedulerError("V1 scheduler restoration could not be verified")
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        print(f"V1 scheduler state failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
