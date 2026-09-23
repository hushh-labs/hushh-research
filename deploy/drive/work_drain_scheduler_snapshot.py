#!/usr/bin/env python3
"""Capture and restore only the three reviewed UAT Drive scheduler jobs.

The release script uses this after validating its image and traffic boundary.
No arbitrary URL, audience, job name, body, or OAuth identity is accepted from
the snapshot. A job absent before release is deleted only when its current
configuration still matches the newly created worker target.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import json
import re
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlsplit

PROJECT = "hushh-pda-uat"
LOCATION = "us-central1"
PUBLIC_ORIGIN = "https://api.uat.hushh.ai"
RUNTIME_ORIGIN = "https://consent-protocol-f2gsa4kfsq-uc.a.run.app"
SCHEDULER_ACCOUNT = "drive-work-drain-sched@hushh-pda-uat.iam.gserviceaccount.com"
DRAIN_PATH = "/api/internal/drive-work/drain"
JOB_STAGES = {
    "drive-work-drain-uat": "documents",
    "drive-work-suggestions-uat": "suggestions",
    "drive-work-sharing-uat": "sharing",
}
JOB_SCHEDULES = {
    "drive-work-drain-uat": {"*/2 * * * *", "*/4 * * * *"},
    "drive-work-suggestions-uat": {"2-59/4 * * * *"},
    "drive-work-sharing-uat": {"* * * * *"},
}
WORKER_ORIGIN = re.compile(
    r"https://consent-protocol-drive-worker-[a-z0-9-]+\.a\.run\.app\Z"
)
DURATION = re.compile(r"[0-9]{1,3}s\Z")


class SchedulerStateError(RuntimeError):
    """A redacted release failure; never include job body or provider response."""


def _gcloud(*arguments: str) -> str:
    result = subprocess.run(
        ["gcloud", *arguments], capture_output=True, text=True, check=False
    )
    if result.returncode:
        raise SchedulerStateError("Drive scheduler state command failed")
    return result.stdout


def _job_names() -> set[str]:
    rows = json.loads(
        _gcloud(
            "scheduler",
            "jobs",
            "list",
            f"--project={PROJECT}",
            f"--location={LOCATION}",
            "--format=json",
        )
    )
    if not isinstance(rows, list):
        raise SchedulerStateError("Drive scheduler listing is invalid")
    prefix = f"projects/{PROJECT}/locations/{LOCATION}/jobs/"
    names = [row.get("name") for row in rows if isinstance(row, dict)]
    if any(not isinstance(name, str) for name in names) or len(names) != len(
        set(names)
    ):
        raise SchedulerStateError("Drive scheduler listing is ambiguous")
    return {name.removeprefix(prefix) for name in names if name.startswith(prefix)}


def _describe(name: str) -> dict:
    if name not in JOB_STAGES:
        raise SchedulerStateError("Unreviewed Drive scheduler job")
    job = json.loads(
        _gcloud(
            "scheduler",
            "jobs",
            "describe",
            name,
            f"--project={PROJECT}",
            f"--location={LOCATION}",
            "--format=json",
        )
    )
    if not isinstance(job, dict):
        raise SchedulerStateError("Drive scheduler description is invalid")
    return job


def _safe_origin(uri: str, audience: str, *, worker_origin: str | None) -> None:
    parsed = urlsplit(uri)
    origin = f"{parsed.scheme}://{parsed.netloc}"
    if (
        not isinstance(uri, str)
        or parsed.scheme != "https"
        or not parsed.netloc
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path != DRAIN_PATH
        or parsed.query
        or parsed.fragment
    ):
        raise SchedulerStateError("Drive scheduler target is outside the UAT boundary")
    if origin in {PUBLIC_ORIGIN, RUNTIME_ORIGIN}:
        if audience != origin:
            raise SchedulerStateError(
                "Drive scheduler audience is outside the UAT boundary"
            )
    elif origin == worker_origin and WORKER_ORIGIN.fullmatch(origin):
        if audience != PUBLIC_ORIGIN:
            raise SchedulerStateError("Drive worker scheduler audience is invalid")
    else:
        raise SchedulerStateError("Drive scheduler target is outside the UAT boundary")


def _body(raw: object, *, name: str) -> str:
    if not isinstance(raw, str):
        raise SchedulerStateError("Drive scheduler body is missing")
    try:
        value = base64.b64decode(raw, validate=True).decode("utf-8")
        parsed = json.loads(value)
    except (ValueError, UnicodeError, binascii.Error):
        raise SchedulerStateError("Drive scheduler body is invalid") from None
    stage = JOB_STAGES[name]
    if value == "{}" and stage == "documents":
        return value
    if parsed != {"stage": stage} or value != json.dumps(parsed, separators=(",", ":")):
        raise SchedulerStateError("Drive scheduler stage does not match its fixed job")
    return value


def _duration(value: object, *, limit: int) -> str:
    if (
        not isinstance(value, str)
        or not DURATION.fullmatch(value)
        or int(value[:-1]) > limit
    ):
        raise SchedulerStateError("Drive scheduler deadline is outside reviewed bounds")
    return value


def _normalize(job: dict, *, name: str, worker_origin: str | None) -> dict:
    expected_name = f"projects/{PROJECT}/locations/{LOCATION}/jobs/{name}"
    target = job.get("httpTarget")
    if job.get("name") != expected_name or not isinstance(target, dict):
        raise SchedulerStateError("Drive scheduler identity is invalid")
    oidc = target.get("oidcToken")
    if (
        not isinstance(oidc, dict)
        or oidc.get("serviceAccountEmail") != SCHEDULER_ACCOUNT
    ):
        raise SchedulerStateError("Drive scheduler OIDC identity is invalid")
    uri, audience = target.get("uri"), oidc.get("audience")
    if not isinstance(uri, str) or not isinstance(audience, str):
        raise SchedulerStateError("Drive scheduler target is invalid")
    _safe_origin(uri, audience, worker_origin=worker_origin)
    headers = target.get("headers")
    if (
        target.get("httpMethod") != "POST"
        or not isinstance(headers, dict)
        or headers
        != {
            "Content-Type": "application/json",
            "User-Agent": "Google-Cloud-Scheduler",
        }
    ):
        raise SchedulerStateError("Drive scheduler HTTP contract is invalid")
    schedule, zone, state = job.get("schedule"), job.get("timeZone"), job.get("state")
    if (
        schedule not in JOB_SCHEDULES[name]
        or zone != "Etc/UTC"
        or state not in {"ENABLED", "PAUSED"}
    ):
        raise SchedulerStateError("Drive scheduler cadence or state is invalid")
    body = _body(target.get("body"), name=name)
    attempt = _duration(job.get("attemptDeadline"), limit=240)
    if attempt != ("120s" if body == "{}" else "240s"):
        raise SchedulerStateError("Drive scheduler attempt deadline is invalid")
    retry = job.get("retryConfig")
    if (
        not isinstance(retry, dict)
        or retry.get("retryCount") != 3
        or retry.get("maxDoublings") != 3
    ):
        raise SchedulerStateError("Drive scheduler retry policy is invalid")
    normalized_retry = {
        "retryCount": 3,
        "minBackoffDuration": _duration(retry.get("minBackoffDuration"), limit=120),
        "maxBackoffDuration": _duration(retry.get("maxBackoffDuration"), limit=120),
        "maxDoublings": 3,
        "maxRetryDuration": _duration(retry.get("maxRetryDuration", "0s"), limit=240),
    }
    if normalized_retry != {
        "retryCount": 3,
        "minBackoffDuration": "10s",
        "maxBackoffDuration": "120s",
        "maxDoublings": 3,
        "maxRetryDuration": "0s",
    }:
        raise SchedulerStateError("Drive scheduler retry policy is invalid")
    return {
        "name": name,
        "uri": uri,
        "audience": audience,
        "serviceAccountEmail": SCHEDULER_ACCOUNT,
        "schedule": schedule,
        "timeZone": zone,
        "state": state,
        "httpMethod": "POST",
        "body": body,
        "headers": headers,
        "attemptDeadline": attempt,
        "retryConfig": normalized_retry,
    }


def _snapshot(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    if (
        not isinstance(value, dict)
        or value.get("schema") != "drive.scheduler.snapshot.v1"
        or not isinstance(value.get("jobs"), dict)
        or set(value["jobs"]) != set(JOB_STAGES)
    ):
        raise SchedulerStateError("Drive scheduler snapshot is invalid")
    return value["jobs"]


def capture(path: Path, *, worker_origin: str | None) -> None:
    names = _job_names()
    if "drive-work-drain-uat" not in names:
        raise SchedulerStateError("Existing Drive document scheduler is missing")
    jobs = {
        name: _normalize(_describe(name), name=name, worker_origin=worker_origin)
        if name in names
        else None
        for name in JOB_STAGES
    }
    path.write_text(
        json.dumps(
            {"schema": "drive.scheduler.snapshot.v1", "jobs": jobs}, sort_keys=True
        ),
        encoding="utf-8",
    )


def _validate_snapshot(jobs: dict, *, worker_origin: str | None) -> None:
    for name, prior in jobs.items():
        if prior is None:
            continue
        if not isinstance(prior, dict) or prior.get("name") != name:
            raise SchedulerStateError("Drive scheduler snapshot entry is invalid")
        # Round-trip the normalized record through the same boundary check.
        encoded = base64.b64encode(str(prior.get("body", "")).encode()).decode()
        raw = {
            "name": f"projects/{PROJECT}/locations/{LOCATION}/jobs/{name}",
            "httpTarget": {
                "uri": prior.get("uri"),
                "httpMethod": prior.get("httpMethod"),
                "body": encoded,
                "headers": prior.get("headers"),
                "oidcToken": {
                    "serviceAccountEmail": prior.get("serviceAccountEmail"),
                    "audience": prior.get("audience"),
                },
            },
            "schedule": prior.get("schedule"),
            "timeZone": prior.get("timeZone"),
            "state": prior.get("state"),
            "attemptDeadline": prior.get("attemptDeadline"),
            "retryConfig": prior.get("retryConfig"),
        }
        if _normalize(raw, name=name, worker_origin=worker_origin) != prior:
            raise SchedulerStateError("Drive scheduler snapshot entry changed")


def _configuration_flags(prior: dict, *, create: bool) -> list[str]:
    retry = prior["retryConfig"]
    return [
        f"--project={PROJECT}",
        f"--location={LOCATION}",
        f"--schedule={prior['schedule']}",
        f"--time-zone={prior['timeZone']}",
        f"--uri={prior['uri']}",
        "--http-method=POST",
        f"--message-body={prior['body']}",
        f"--oidc-service-account-email={SCHEDULER_ACCOUNT}",
        f"--oidc-token-audience={prior['audience']}",
        f"--attempt-deadline={prior['attemptDeadline']}",
        f"--max-retry-attempts={retry['retryCount']}",
        f"--min-backoff={retry['minBackoffDuration']}",
        f"--max-backoff={retry['maxBackoffDuration']}",
        f"--max-doublings={retry['maxDoublings']}",
        f"--max-retry-duration={retry['maxRetryDuration']}",
        ("--headers=" if create else "--update-headers=")
        + "Content-Type=application/json",
    ]


def verify(path: Path, *, worker_origin: str | None) -> None:
    jobs = _snapshot(path)
    _validate_snapshot(jobs, worker_origin=worker_origin)
    names = _job_names()
    for name, prior in jobs.items():
        if prior is None:
            if name in names:
                raise SchedulerStateError("New Drive scheduler was not removed")
        elif (
            name not in names
            or _normalize(_describe(name), name=name, worker_origin=worker_origin)
            != prior
        ):
            raise SchedulerStateError("Drive scheduler was not restored exactly")


def _candidate_job(name: str, worker_origin: str) -> dict:
    return {
        "name": name,
        "uri": worker_origin + DRAIN_PATH,
        "audience": PUBLIC_ORIGIN,
        "serviceAccountEmail": SCHEDULER_ACCOUNT,
        "schedule": next(iter(JOB_SCHEDULES[name] - {"*/2 * * * *"})),
        "timeZone": "Etc/UTC",
        "state": "ENABLED",
        "httpMethod": "POST",
        "body": json.dumps({"stage": JOB_STAGES[name]}, separators=(",", ":")),
        "headers": {
            "Content-Type": "application/json",
            "User-Agent": "Google-Cloud-Scheduler",
        },
        "attemptDeadline": "240s",
        "retryConfig": {
            "retryCount": 3,
            "minBackoffDuration": "10s",
            "maxBackoffDuration": "120s",
            "maxDoublings": 3,
            "maxRetryDuration": "0s",
        },
    }


def restore(path: Path, *, worker_origin: str) -> None:
    jobs = _snapshot(path)
    _validate_snapshot(jobs, worker_origin=worker_origin)
    names = _job_names()
    for name, prior in jobs.items():
        if prior is None:
            if name not in names:
                continue
            current = _normalize(
                _describe(name), name=name, worker_origin=worker_origin
            )
            if current != _candidate_job(name, worker_origin):
                raise SchedulerStateError("New Drive scheduler changed before rollback")
            _gcloud(
                "scheduler",
                "jobs",
                "delete",
                name,
                f"--project={PROJECT}",
                f"--location={LOCATION}",
                "--quiet",
            )
            continue
        if name not in names:
            _gcloud(
                "scheduler",
                "jobs",
                "create",
                "http",
                name,
                *_configuration_flags(prior, create=True),
            )
        else:
            _gcloud(
                "scheduler",
                "jobs",
                "update",
                "http",
                name,
                *_configuration_flags(prior, create=False),
            )
        current_state = _describe(name).get("state")
        if prior["state"] == "PAUSED" and current_state != "PAUSED":
            _gcloud(
                "scheduler",
                "jobs",
                "pause",
                name,
                f"--project={PROJECT}",
                f"--location={LOCATION}",
            )
        elif prior["state"] == "ENABLED" and current_state != "ENABLED":
            _gcloud(
                "scheduler",
                "jobs",
                "resume",
                name,
                f"--project={PROJECT}",
                f"--location={LOCATION}",
            )
    for _ in range(3):
        try:
            verify(path, worker_origin=worker_origin)
            return
        except SchedulerStateError:
            time.sleep(2)
    raise SchedulerStateError("Drive scheduler rollback could not be verified")


def quarantine() -> None:
    """Stop fixed jobs if exact restoration is uncertain; never use a wildcard."""
    for name in sorted(_job_names() & set(JOB_STAGES)):
        if _describe(name).get("state") != "PAUSED":
            _gcloud(
                "scheduler",
                "jobs",
                "pause",
                name,
                f"--project={PROJECT}",
                f"--location={LOCATION}",
            )
    for name in _job_names() & set(JOB_STAGES):
        if _describe(name).get("state") != "PAUSED":
            raise SchedulerStateError("Drive scheduler quarantine was not verified")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "command", choices=("capture", "restore", "verify", "quarantine")
    )
    parser.add_argument("--snapshot", type=Path)
    parser.add_argument("--worker-origin", default="")
    args = parser.parse_args()
    worker_origin = args.worker_origin or None
    if worker_origin and not WORKER_ORIGIN.fullmatch(worker_origin):
        raise SchedulerStateError(
            "Drive worker origin is outside the reviewed boundary"
        )
    if args.command != "quarantine" and args.snapshot is None:
        raise SchedulerStateError("Drive scheduler snapshot path is required")
    if args.command == "capture":
        capture(args.snapshot, worker_origin=worker_origin)
    elif args.command == "restore":
        if worker_origin is None:
            raise SchedulerStateError("Drive worker origin is required for rollback")
        restore(args.snapshot, worker_origin=worker_origin)
    elif args.command == "verify":
        verify(args.snapshot, worker_origin=worker_origin)
    else:
        quarantine()


if __name__ == "__main__":
    try:
        main()
    except (SchedulerStateError, OSError, ValueError, KeyError, TypeError) as error:
        print(f"Drive scheduler state unavailable: {error}", file=sys.stderr)
        raise SystemExit(1) from None
