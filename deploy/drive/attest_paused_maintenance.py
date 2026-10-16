#!/usr/bin/env python3
"""Attest a UAT release that preserves the operator-paused Drive worker.

The release runner supplies read-only Cloud Scheduler and Cloud Run snapshots.
No scheduler or worker mutation is performed by this helper.
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from urllib.parse import urlsplit

from verify_scheduler_state import STAGE_JOBS, WORKER_HOST, _scheduler_set

SCHEMA = "drive.paused-maintenance.v1"
SERVICE = "consent-protocol-drive-worker"
REVISION = re.compile(r"consent-protocol-drive-worker-[0-9]{5}-[a-z0-9]+\Z")


def _worker_state(snapshot: Path) -> dict[str, str]:
    service = json.loads(snapshot.read_text(encoding="utf-8"))
    if not isinstance(service, dict):
        raise ValueError("Drive worker service snapshot is invalid")
    metadata = service.get("metadata") or {}
    status = service.get("status") or {}
    if (
        not isinstance(metadata, dict)
        or not isinstance(status, dict)
        or metadata.get("name") != SERVICE
        or status.get("observedGeneration") != metadata.get("generation")
    ):
        raise ValueError("Drive worker service is not settled")
    ready = [
        condition
        for condition in status.get("conditions") or []
        if isinstance(condition, dict) and condition.get("type") == "Ready"
    ]
    if len(ready) != 1 or ready[0].get("status") != "True":
        raise ValueError("Drive worker service is not ready")
    origin = status.get("url")
    if not isinstance(origin, str):
        raise ValueError("Drive worker origin is missing")
    parsed = urlsplit(origin)
    if (
        parsed.scheme != "https"
        or not WORKER_HOST.fullmatch(parsed.hostname or "")
        or parsed.netloc != parsed.hostname
        or parsed.path not in ("", "/")
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("Drive worker origin is outside the reviewed UAT service")
    traffic = status.get("traffic") or []
    if not isinstance(traffic, list):
        raise ValueError("Drive worker traffic is invalid")
    serving = [
        target
        for target in traffic
        if isinstance(target, dict)
        and type(target.get("percent")) is int
        and target["percent"] > 0
    ]
    if len(serving) != 1 or serving[0]["percent"] != 100:
        raise ValueError("Drive worker serving revision is ambiguous")
    revision = serving[0].get("revisionName")
    if not isinstance(revision, str) or not REVISION.fullmatch(revision):
        raise ValueError("Drive worker serving revision is outside the reviewed service")
    return {"origin": origin, "revision": revision}


def _reviewed_state(scheduler_snapshot: Path, worker_snapshot: Path) -> dict:
    worker = _worker_state(worker_snapshot)
    jobs = _scheduler_set(
        scheduler_snapshot,
        worker_origin=worker["origin"],
        expected_state="PAUSED",
        require_all=True,
    )
    return {"schema": SCHEMA, "worker": worker, "jobs": jobs}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("capture", "verify"))
    parser.add_argument("--scheduler-snapshot", type=Path, required=True)
    parser.add_argument("--worker-snapshot", type=Path, required=True)
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--github-output", type=Path, required=True)
    args = parser.parse_args()

    try:
        current = _reviewed_state(args.scheduler_snapshot, args.worker_snapshot)
        if args.mode == "capture":
            args.baseline.write_text(json.dumps(current, sort_keys=True), encoding="utf-8")
            output = "paused_drive_baseline_captured=true\n"
        else:
            baseline = json.loads(args.baseline.read_text(encoding="utf-8"))
            if (
                not isinstance(baseline, dict)
                or baseline.get("schema") != SCHEMA
                or set(baseline.get("jobs") or {}) != set(STAGE_JOBS)
                or baseline != current
            ):
                raise ValueError("Paused Drive scheduler or worker changed during release")
            output = "paused_drive_unchanged=true\n"
    except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError) as exc:
        raise SystemExit(f"Paused Drive maintenance attestation failed: {exc}") from None

    with args.github_output.open("a", encoding="utf-8") as stream:
        stream.write(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
