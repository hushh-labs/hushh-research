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
import importlib.util
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

# Load the owning pure contract beside this exact entrypoint; retain the old
# module attributes as compatibility facades for capture/rollback callers.
_CONTRACT_SPEC = importlib.util.spec_from_file_location(
    "drive_scheduler_contract",
    Path(__file__).with_name("work_drain_scheduler_contract.py"),
)
assert _CONTRACT_SPEC and _CONTRACT_SPEC.loader
_contract = importlib.util.module_from_spec(_CONTRACT_SPEC)
_CONTRACT_SPEC.loader.exec_module(_contract)
PROJECT = _contract.PROJECT
LOCATION = _contract.LOCATION
PUBLIC_ORIGIN = _contract.PUBLIC_ORIGIN
RUNTIME_ORIGIN = _contract.RUNTIME_ORIGIN
SCHEDULER_ACCOUNT = _contract.SCHEDULER_ACCOUNT
DRAIN_PATH = _contract.DRAIN_PATH
JOB_STAGES = _contract.JOB_STAGES
WORKER_ORIGIN = _contract.WORKER_ORIGIN
SchedulerStateError = _contract.SchedulerStateError
_normalize = _contract._normalize
_candidate_job = _contract._candidate_job
matches_candidate = _contract.matches_candidate


def _gcloud(*arguments: str) -> str:
    result = subprocess.run(
        [shutil.which("gcloud") or "gcloud", *arguments],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode:
        raise SchedulerStateError("Drive scheduler state command failed")
    return result.stdout


def _job_inventory() -> dict[str, dict]:
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
    if any(not isinstance(row, dict) for row in rows):
        raise SchedulerStateError("Drive scheduler listing contains an invalid job")
    names = [row.get("name") for row in rows]
    if any(
        not isinstance(name, str) or not name.startswith(prefix) for name in names
    ) or len(names) != len(set(names)):
        raise SchedulerStateError("Drive scheduler listing is ambiguous")
    return {row["name"].removeprefix(prefix): row for row in rows}


def _job_names() -> set[str]:
    return set(_job_inventory())


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
    inventory = _job_inventory()
    if "drive-work-drain-uat" not in inventory:
        raise SchedulerStateError("Existing Drive document scheduler is missing")
    jobs = {
        name: _normalize(inventory[name], name=name, worker_origin=worker_origin)
        if name in inventory
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


def plan_configuration(worker_origin: str) -> list[str]:
    """Read-only bulk verification; the release Bash retains every setup write."""
    actual_origin = _gcloud(
        "run",
        "services",
        "describe",
        "consent-protocol-drive-worker",
        f"--project={PROJECT}",
        f"--region={LOCATION}",
        "--format=value(status.url)",
    ).strip()
    if actual_origin != worker_origin:
        raise SchedulerStateError(
            "Drive worker origin does not match its fixed service"
        )
    identity_exists = True
    try:
        _gcloud(
            "iam",
            "service-accounts",
            "describe",
            SCHEDULER_ACCOUNT,
            f"--project={PROJECT}",
        )
    except SchedulerStateError:
        identity_exists = False
    inventory = _job_inventory()
    return [
        name
        for name in JOB_STAGES
        if not identity_exists
        or not matches_candidate(
            inventory.get(name), name=name, worker_origin=worker_origin
        )
    ]


def verify_configuration(worker_origin: str) -> None:
    """After any repair, independently recheck all three complete fixed records."""
    inventory = _job_inventory()
    for name in JOB_STAGES:
        if not matches_candidate(
            inventory.get(name), name=name, worker_origin=worker_origin
        ):
            raise SchedulerStateError(
                "Drive scheduler configuration did not match its fixed job"
            )


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
        "command",
        choices=(
            "capture",
            "restore",
            "verify",
            "quarantine",
            "plan-configuration",
            "verify-configuration",
        ),
    )
    parser.add_argument("--snapshot", type=Path)
    parser.add_argument("--worker-origin", default="")
    args = parser.parse_args()
    worker_origin = args.worker_origin or None
    if worker_origin and not WORKER_ORIGIN.fullmatch(worker_origin):
        raise SchedulerStateError(
            "Drive worker origin is outside the reviewed boundary"
        )
    if args.command in {"plan-configuration", "verify-configuration"}:
        if worker_origin is None:
            raise SchedulerStateError(
                "Drive scheduler configuration requires its fixed worker"
            )
        if args.command == "plan-configuration":
            print("\n".join(plan_configuration(worker_origin)))
        else:
            verify_configuration(worker_origin)
        return
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
