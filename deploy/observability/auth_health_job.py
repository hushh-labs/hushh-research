#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Run the existing protected-list check once under an expiring conditional lease."""

import json
import os
import sys
import tempfile
import time
import uuid
from contextlib import contextmanager
from enum import Enum
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts/ci"))
from process_group import BoundedReadError, bounded_stdout  # noqa: E402

PROJECTS = {"hushh-pda-uat", "hushh-pda"}
LEASE_SECONDS = 900  # Greater than the job's hard 600-second task timeout.


class HealthCommandStage(str, Enum):
    OPERATION = "operation"
    LEASE_CLAIM = "lease_claim"
    LEASE_READ = "lease_read"
    LEASE_RELEASE = "lease_release"
    PROTECTED_LIST_CHECK = "protected_list_check"


class BoundedFailureReason(str, Enum):
    ARGUMENTS = "arguments"
    TIMEOUT = "timeout"
    READ = "read"
    SIZE = "size"
    EXIT = "exit"
    CLEANUP = "cleanup"
    UNCLASSIFIED = "unclassified"


class HealthCommandFailure(BoundedReadError):
    def __init__(
        self,
        stage: HealthCommandStage,
        reason: BoundedFailureReason,
        *,
        exitcode: int | None = None,
    ):
        super().__init__(reason.value, exitcode=exitcode)
        self.stage = stage
        self.reason = reason


def command(
    args: list[str], *, stage: HealthCommandStage, timeout: int = 45, limit: int = 65536
) -> bytes:
    if not isinstance(stage, HealthCommandStage):
        raise ValueError("Unclassified health command stage")
    try:
        return bounded_stdout(args, max_bytes=limit, timeout=timeout)
    except BoundedReadError as exc:
        try:
            reason = BoundedFailureReason(exc.reason)
        except (TypeError, ValueError):
            reason = BoundedFailureReason.UNCLASSIFIED
        raise HealthCommandFailure(stage, reason, exitcode=exc.exitcode) from None
    except OSError:
        raise HealthCommandFailure(
            stage, BoundedFailureReason.UNCLASSIFIED
        ) from None


@contextmanager
def lease(project: str, *, run=command, clock=time.time):
    if project not in PROJECTS:
        raise ValueError("Ungoverned health project")
    uri = f"gs://{project}-auth-health-ops/lease.json"
    holder = uuid.uuid4().hex
    generation = "0"
    with tempfile.TemporaryDirectory(prefix="auth-health-") as directory:
        payload = Path(directory, "lease.json")
        payload.write_text(json.dumps({"holder": holder, "expires": int(clock()) + LEASE_SECONDS}))
        payload.chmod(0o600)

        def claim(expected):
            run(
                ["gcloud", "storage", "cp", str(payload), uri,
                 f"--if-generation-match={expected}", "--quiet"],
                stage=HealthCommandStage.LEASE_CLAIM,
            )

        try:
            claim(generation)
        except BoundedReadError:
            # A denied or lost write is not an unlocked state. Read exact state
            # and use generation CAS for expiry takeover or lost-response recovery.
            generation = run(
                ["gcloud", "storage", "objects", "describe", uri,
                 "--format=value(generation)"],
                stage=HealthCommandStage.LEASE_READ,
            ).decode().strip()
            raw = run(
                ["gcloud", "storage", "cat", f"{uri}#{generation}", "--range=0-4096"],
                stage=HealthCommandStage.LEASE_READ,
                limit=4096,
            )
            existing = json.loads(raw)
            if (not generation.isdecimal() or not isinstance(existing, dict)
                    or type(existing.get("expires")) is not int
                    or not isinstance(existing.get("holder"), str)):
                raise ValueError("Unverifiable health lease")
            if existing["holder"] != holder:
                if existing["expires"] > clock():
                    yield False
                    return
                claim(generation)
        generation = run(
            ["gcloud", "storage", "objects", "describe", uri,
             "--format=value(generation)"],
            stage=HealthCommandStage.LEASE_READ,
        ).decode().strip()
        if not generation.isdecimal():
            raise ValueError("Unverifiable acquired lease")
        exact = json.loads(
            run(
                ["gcloud", "storage", "cat", f"{uri}#{generation}", "--range=0-4096"],
                stage=HealthCommandStage.LEASE_READ,
                limit=4096,
            )
        )
        if (not isinstance(exact, dict) or exact.get("holder") != holder
                or type(exact.get("expires")) is not int or exact["expires"] <= clock()):
            raise ValueError("Health lease holder changed before execution")
        try:
            yield True
        finally:
            # Never remove a successor's lease. Failure leaves a bounded lease
            # for the next scheduled run rather than claiming successful cleanup.
            run(
                ["gcloud", "storage", "rm", uri,
                 f"--if-generation-match={generation}", "--quiet"],
                stage=HealthCommandStage.LEASE_RELEASE,
            )


def main() -> int:
    project = os.environ.get("AUTH_HEALTH_PROJECT", "")
    runtime = os.environ.get("AUTH_PHONE_RUNTIME_HEALTH_ENABLED", "false")
    if project not in PROJECTS or runtime not in {"true", "false"}:
        print("Auth health configuration unavailable")
        return 2
    try:
        with lease(project) as acquired:
            if not acquired:
                print("Auth health check already running; duplicate execution settled")
                return 0
            args = [sys.executable, str(ROOT / "scripts/ops/verify_secret_list_invariants.py"),
                    "--project", project, "--emit-health-log"]
            if runtime == "true":
                args.append("--check-phone-runtime")
            result = command(
                args, stage=HealthCommandStage.PROTECTED_LIST_CHECK, timeout=450
            )
            print(result.decode("utf-8"))  # Existing checker emits counts/status only.
            return 0
    except HealthCommandFailure as exc:
        # These fields are fixed enums; never echo provider stderr or command input.
        message = (
            f"Auth health check unavailable; stage={exc.stage.value}; "
            f"reason={exc.reason.value}"
        )
        if exc.exitcode is not None:
            message += f"; exitcode={exc.exitcode}"
        print(message)
        return 2
    except (BoundedReadError, ValueError, OSError):
        # Do not label an unreadable source healthy, or echo provider stderr.
        print(
            f"Auth health check unavailable; stage={HealthCommandStage.OPERATION.value}; "
            f"reason={BoundedFailureReason.UNCLASSIFIED.value}"
        )
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
