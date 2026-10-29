#!/usr/bin/env python3
"""Record the bounded failure and rollback path for a One Chat UAT release."""

from __future__ import annotations

import sys
from collections.abc import Callable
from typing import Any


def handle_failed_release(
    report: dict[str, Any],
    old_revision: str,
    candidate: str,
    tag: str,
    error: Exception,
    *,
    service_state: Callable[[], dict[str, Any]],
    remove_candidate_tag: Callable[[str], bool],
    live_traffic: Callable[[], dict[str, int]],
    command: Callable[..., Any],
    service: str,
    project: str,
    region: str,
) -> int:
    report["error"] = f"{type(error).__name__}: {error}"
    print(report["error"], file=sys.stderr)
    if old_revision:
        try:
            current = service_state()
            tagged = [
                entry
                for entry in (current.get("status") or {}).get("traffic") or []
                if entry.get("tag") == tag
            ]
            if tagged and not candidate:
                candidate = str(tagged[0].get("revisionName") or "")
                if candidate:
                    report["candidate_revision"] = candidate
            report["candidate_tag_removed"] = remove_candidate_tag(tag)
        except Exception as cleanup_error:  # noqa: BLE001 - retain rollback attempt
            report["candidate_tag_cleanup_error"] = str(cleanup_error)
    if old_revision and candidate:
        try:
            traffic = live_traffic()
            if set(traffic) - {old_revision, candidate}:
                raise RuntimeError(
                    "Unknown revision receives backend traffic; refusing rollback"
                )
            if traffic.get(candidate, 0) > 0:
                command(
                    "gcloud",
                    "run",
                    "services",
                    "update-traffic",
                    service,
                    f"--project={project}",
                    f"--region={region}",
                    f"--to-revisions={old_revision}=100",
                    "--quiet",
                )
                if live_traffic() != {old_revision: 100}:
                    raise RuntimeError(
                        "Rollback did not restore 100% old backend traffic"
                    )
                report["rollback"] = True
                report["status"] = "rolled_back"
        except Exception as rollback_error:  # noqa: BLE001 - include failure in receipt
            report["rollback_error"] = str(rollback_error)
            report["status"] = "rollback_failed"
    if (
        "candidate_tag_cleanup_error" in report
        and report["status"] != "rollback_failed"
    ):
        report["status"] = "cleanup_failed"
    return 1
