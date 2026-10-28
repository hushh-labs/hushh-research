#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Consume a main-owned alert receipt; never read alert credentials from PR code."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import re
import sys
import time
from datetime import datetime, timedelta
from io import BytesIO
from pathlib import Path
from zipfile import BadZipFile, ZipFile

from github_security_authority import (
    ROOT,
    WORKER_PATH,
    GitHub,
    Refused,
    positive,
    requested_source,
    verify_source,
)

REPOSITORY = "hushh-labs/hushh-research"
MAX_BYTES = 64 * 1024

_PROCESS_SPEC = importlib.util.spec_from_file_location(
    "security_receipt_process_group", Path(__file__).with_name("process_group.py")
)
if not _PROCESS_SPEC or not _PROCESS_SPEC.loader:
    raise Refused("Security artifact transport is unavailable")
_process_group = importlib.util.module_from_spec(_PROCESS_SPEC)
_PROCESS_SPEC.loader.exec_module(_process_group)


class MissingReceipt(Refused):
    """A duplicate worker can reuse an earlier receipt without a new artifact."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise Refused(message)


def timestamp(value: str) -> datetime:
    result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    require(result.tzinfo is not None, "Timestamp lacks its timezone")
    return result


def verify_producer(api: GitHub, run: dict, workflow: dict, repo_id: int) -> None:
    require(
        run.get("repository", {}).get("id") == repo_id
        and run.get("repository", {}).get("full_name") == REPOSITORY
        and run.get("head_repository", {}).get("id") == repo_id
        and run.get("head_repository", {}).get("full_name") == REPOSITORY
        and run.get("workflow_id") == workflow.get("id")
        and workflow.get("path") == WORKER_PATH
        and run.get("path", "").split("@", 1)[0] == WORKER_PATH
        and run.get("head_branch") == "main"
        and run.get("event") in {"workflow_run", "workflow_dispatch"}
        and re.fullmatch(r"[0-9a-f]{40}", run.get("head_sha", "")) is not None,
        "Security producer is not the main-owned authority",
    )
    # GitHub includes up to 300 file patches on page one regardless of the
    # commit page size. Page two retains comparison/merge-base metadata without
    # those patches, so an old valid receipt cannot overflow the bounded reader.
    ancestry = api.read(
        f"repos/{REPOSITORY}/compare/{run['head_sha']}...main?per_page=1&page=2"
    )
    require(
        ancestry.get("status") in {"identical", "ahead"}
        and ancestry.get("merge_base_commit", {}).get("sha") == run["head_sha"],
        "Security producer revision is not on main",
    )


def unpack(raw: bytes, digest: str) -> dict:
    require(0 < len(raw) <= MAX_BYTES, "Security artifact exceeds its bound")
    require(
        digest == "sha256:" + hashlib.sha256(raw).hexdigest(),
        "Security artifact digest mismatch",
    )
    with ZipFile(BytesIO(raw)) as archive:
        entries = archive.infolist()
        require(
            len(entries) == 1
            and entries[0].filename == "ci-security.json"
            and not entries[0].is_dir()
            and entries[0].file_size <= MAX_BYTES
            and ((entries[0].external_attr >> 16) & 0o170000) != 0o120000,
            "Security artifact shape is invalid",
        )
        result = json.loads(archive.read(entries[0]))
    require(isinstance(result, dict), "Security receipt is not an object")
    return result


def archive_read(artifact_id: int, *, command=None, timeout=30) -> bytes:
    """Bound output and duration, and reap the read-only gh child on every path."""
    positive(artifact_id, "artifact identity")
    require(0 < timeout <= 30, "Security artifact download timeout is invalid")
    path = f"repos/{REPOSITORY}/actions/artifacts/{artifact_id}/zip"
    try:
        return _process_group.bounded_stdout(
            ["gh", "api", path] if command is None else command,
            max_bytes=MAX_BYTES,
            timeout=timeout,
        )
    except _process_group.BoundedReadError as error:
        reason = {"size": "exceeded its bound", "timeout": "timed out"}.get(error.reason, "failed")
        raise Refused("Security artifact download " + reason) from None
    except OSError:
        raise Refused("Security artifact download failed") from None


def validate(receipt: dict, source: dict, run: dict, artifact: dict) -> None:
    require(
        receipt.get("schema_version") == 1
        and receipt.get("source") == source
        and receipt.get("producer")
        == {
            "workflow_path": WORKER_PATH,
            "main_sha": run["head_sha"],
            "run_id": run["id"],
            "attempt": run["run_attempt"],
        }
        and receipt.get("policy")
        == {"required_secret_clearance": True, "dependabot_blocking": False}
        and receipt.get("verdict") == "clear",
        "Security receipt source, producer or policy does not match",
    )
    for family in ("secret_scanning", "dependabot"):
        inventory = receipt.get(family, {})
        count = inventory.get("open")
        require(
            inventory.get("complete") is True and type(count) is int and count >= 0,
            "Security inventory is incomplete",
        )
    require(receipt["secret_scanning"]["open"] == 0, "Open secret alerts refuse clearance")
    started, finished = timestamp(run["run_started_at"]), timestamp(run["updated_at"])
    recorded, uploaded = (
        timestamp(receipt["recorded_at"]),
        timestamp(artifact["created_at"]),
    )
    require(
        started <= uploaded <= finished and started <= recorded <= uploaded + timedelta(seconds=1),
        "Security receipt belongs to another attempt window",
    )


def consume(api: GitHub, source: dict, run: dict, workflow: dict) -> dict:
    prefix = f"repos/{REPOSITORY}/actions"
    verify_producer(api, run, workflow, source["repository_id"])
    require(
        run.get("status") == "completed" and run.get("conclusion") == "success",
        "Security worker did not succeed",
    )
    positive(run.get("id"), "producer identity")
    positive(run.get("run_attempt"), "producer attempt")
    inventory = api.read(f"{prefix}/runs/{run['id']}/artifacts?per_page=100")
    rows = inventory.get("artifacts", [])
    require(
        type(inventory.get("total_count")) is int and inventory["total_count"] == len(rows) <= 100,
        "Security artifact inventory is incomplete",
    )
    name = f"ci-security-{run['id']}-{run['run_attempt']}"
    matches = [row for row in rows if row.get("name") == name]
    if not matches:
        raise MissingReceipt("Security artifact is missing")
    require(len(matches) == 1, "Security artifact is missing or ambiguous")
    artifact = matches[0]
    require(
        artifact.get("expired") is False
        and artifact.get("workflow_run", {}).get("id") == run["id"]
        and type(artifact.get("size_in_bytes")) is int
        and 0 < artifact["size_in_bytes"] <= MAX_BYTES
        and re.fullmatch(r"sha256:[0-9a-f]{64}", artifact.get("digest", "")) is not None,
        "Security artifact identity or retention is invalid",
    )
    raw = archive_read(artifact.get("id"))
    require(len(raw) == artifact["size_in_bytes"], "Security artifact size mismatch")
    receipt = unpack(raw, artifact["digest"])
    validate(receipt, source, run, artifact)
    current = api.read(f"{prefix}/runs/{run['id']}")
    require(
        all(
            current.get(k) == run.get(k)
            for k in (
                "id",
                "run_attempt",
                "head_sha",
                "workflow_id",
                "status",
                "conclusion",
            )
        ),
        "Security worker changed during receipt verification",
    )
    verify_source(api.read, REPOSITORY, {k: source[k] for k in ("run_id", "attempt", "head_sha")})
    return receipt


def verify_reused_worker(api: GitHub, run: dict) -> None:
    inventory = api.read(f"repos/{REPOSITORY}/actions/runs/{run['id']}/jobs?per_page=100")
    jobs = inventory.get("jobs", [])
    require(
        inventory.get("total_count") == len(jobs) == 1,
        "Duplicate worker job inventory is incomplete",
    )
    job = jobs[0]
    require(
        job.get("run_id") == run["id"] and job.get("conclusion") == "success",
        "Duplicate worker job is unverified",
    )
    expected = {
        "Reuse a verified receipt for this exact source attempt": "success",
        "Read alerts and bind the exact source attempt": "skipped",
        "Upload bounded security receipt": "skipped",
    }
    steps = [step for step in job.get("steps", []) if step.get("name") in expected]
    require(
        len(steps) == len(expected)
        and {step.get("name"): step.get("conclusion") for step in steps} == expected,
        "Missing artifact is not a verified duplicate receipt reuse",
    )


def find_receipt(
    api: GitHub,
    source: dict,
    exclude_run: int | None = None,
    *,
    recover_failed: bool = False,
) -> dict | None:
    workflow = api.read(f"repos/{REPOSITORY}/actions/workflows/ci-security.yml")
    inventory = api.read(
        f"repos/{REPOSITORY}/actions/workflows/ci-security.yml/runs?branch=main&per_page=100"
    )
    rows = inventory.get("workflow_runs", [])
    require(
        isinstance(rows, list) and len(rows) <= 100,
        "Security run inventory is malformed",
    )
    title = f"Security alerts for {source['run_id']} / {source['attempt']} / {source['head_sha']}"
    matches = [
        run
        for run in rows
        if run.get("display_title") == title
        and run.get("id") != exclude_run
        and run.get("status") == "completed"
    ]
    for run in sorted(
        matches,
        key=lambda item: (
            timestamp(item["updated_at"]),
            positive(item.get("id"), "producer run"),
            positive(item.get("run_attempt"), "producer attempt"),
        ),
        reverse=True,
    ):
        if run.get("conclusion") != "success":
            if recover_failed:
                return None
            raise Refused("Latest exact-source security worker did not succeed")
        try:
            return consume(api, source, run, workflow)
        except MissingReceipt:
            verify_reused_worker(api, run)
            continue
    return None


def reuse_existing(environment: dict) -> int:
    require(
        environment.get("GITHUB_REPOSITORY") == REPOSITORY,
        "Security worker is repository-bound",
    )
    require(
        environment.get("GITHUB_REF") == "refs/heads/main"
        and environment.get("GITHUB_WORKFLOW_REF") == f"{REPOSITORY}/{WORKER_PATH}@refs/heads/main",
        "Receipt reuse requires the main-owned worker",
    )
    event = json.loads(Path(environment["GITHUB_EVENT_PATH"]).read_text())
    policy = json.loads((ROOT / "config/ci-governance.json").read_text())
    api = GitHub(REPOSITORY, environment.get("GH_TOKEN", ""))
    source = verify_source(api.read, REPOSITORY, requested_source(event, environment, policy))
    receipt = find_receipt(
        api,
        source,
        positive(int(environment["GITHUB_RUN_ID"]), "current worker"),
        recover_failed=True,
    )
    with Path(environment["GITHUB_OUTPUT"]).open("a", encoding="utf-8") as output:
        output.write(f"reused={'true' if receipt else 'false'}\n")
    print(
        "Verified exact-source receipt reused."
        if receipt
        else "A fresh protected inventory is required."
    )
    return 0


def await_receipt(environment: dict) -> dict:
    require(
        environment.get("GITHUB_REPOSITORY") == REPOSITORY,
        "Security consumer is repository-bound",
    )
    api = GitHub(REPOSITORY, environment.get("GH_TOKEN", ""))
    expected = {
        "run_id": int(environment["GITHUB_RUN_ID"]),
        "attempt": int(environment["GITHUB_RUN_ATTEMPT"]),
        "head_sha": environment["CI_SECURITY_HEAD_SHA"],
    }
    source = verify_source(api.read, REPOSITORY, expected)
    deadline = time.monotonic() + 480
    if expected["attempt"] > 1:
        print(
            "GitHub reruns do not emit the initial security-worker event. "
            "While this attempt is running, a governed operator can request its exact worker:\n"
            f"gh workflow run ci-security.yml --ref main -f source_run_id={expected['run_id']} "
            f"-f source_attempt={expected['attempt']} -f source_sha={expected['head_sha']}\n"
            "For future retries use ./bin/hushh codex ci-rerun to coordinate both requests.",
            flush=True,
        )
    print(
        "Waiting for protected security authority for this exact run and attempt.",
        flush=True,
    )
    while time.monotonic() < deadline:
        receipt = find_receipt(api, source)
        if receipt:
            return receipt
        time.sleep(10)
    raise Refused(
        "Protected security authority was not available within eight minutes; use exact-run manual recovery"
    )


def main() -> int:
    try:
        if sys.argv[1:] == ["--reuse-existing"]:
            return reuse_existing(dict(os.environ))
        receipt = await_receipt(dict(os.environ))
        print(
            f"Protected receipt: secret alerts 0; dependency alerts {receipt['dependabot']['open']} (advisory)."
        )
        return 0
    except (Refused, ValueError, KeyError, TypeError, OSError, BadZipFile):
        print(
            "Security clearance refused: trusted exact-attempt receipt unavailable or invalid. Inspect the main-owned CI Security Alerts run."
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
