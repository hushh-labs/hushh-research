#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Select the exact protected UAT tip, keeping workflow/application identities separate.

Selection grants no deployment authority. Existing source CI, capacity, exact
Dev acceptance, schema and runtime gates still run in the deployment workflow.
Only a pinned, current per-service receipt can establish a read-only no-op.
The caller must recheck the selected tip under its mutation admission lock; a
selection-time observation cannot prevent a later branch update.
"""

from __future__ import annotations

import argparse
import importlib
import json
import os
from pathlib import Path
import re
import subprocess

from github_security_authority import GitHub, Refused

REPOSITORY = "hushh-labs/hushh-research"
PREFIX = f"repos/{REPOSITORY}"
UAT_WORKFLOW = ".github/workflows/deploy-uat.yml"
CHAT_WORKFLOW = ".github/workflows/deploy-uat-one-chat.yml"
READ_ONLY_WORKFLOWS = {
    ".github/workflows/ship-ios-testflight.yml",
    ".github/workflows/resume-ios-testflight.yml",
    ".github/workflows/ios-voice-device.yml",
    ".github/workflows/ship-android-playstore-v1.yml",
}
LIVE_STATES = {"requested", "pending", "waiting", "queued", "in_progress"}


def require(condition: object, message: str) -> None:
    if not condition:
        raise Refused(message)


def run_id(status: dict) -> int | None:
    require(isinstance(status, dict), "Deployment status is malformed")
    url = status.get("log_url")
    if not isinstance(url, str):
        return None
    match = re.fullmatch(
        rf"https://github\.com/{re.escape(REPOSITORY)}/actions/runs/([1-9][0-9]*)(?:/job/[1-9][0-9]*)?",
        url,
    )
    return int(match[1]) if match else None


class ObservedRepository:
    """Re-read metadata before a no-op; never reuse an older successful status."""

    def __init__(self, api):
        self.api = api
        self.documents = {}

    def read(self, path):
        value = self.api.read(f"{PREFIX}/{path}")
        self.documents[path] = value
        return value

    def unchanged(self):
        return all(
            self.api.read(f"{PREFIX}/{path}") == value
            for path, value in self.documents.items()
        )


def observation(reason: str, *, noop=False, waiting=False, services=None) -> dict:
    return {
        "noop": noop,
        "waiting": waiting,
        "reason": reason,
        "services": services or {},
    }


def current_attempt(acceptance, identifier: int, observed: dict) -> dict:
    path = f"runs/{identifier}"
    run = acceptance.read(path)
    require(
        type(run.get("run_attempt")) is int and run["run_attempt"] > 0,
        "Current attempt is missing",
    )
    observed[path] = run
    return run


def attempt_unchanged(acceptance, observed: dict) -> bool:
    for path, original in observed.items():
        acceptance.cache.pop(path, None)
        if acceptance.read(path) != original:
            return False
    return True


def inspect_deployment(repository, acceptance, deployment, needed, observed):
    require(isinstance(deployment, dict), "Deployment inventory is malformed")
    identifier = deployment.get("id")
    require(
        type(identifier) is int and identifier > 0, "Deployment identity is missing"
    )
    statuses = repository.read(f"deployments/{identifier}/statuses?per_page=1")
    require(
        isinstance(statuses, list) and len(statuses) <= 1,
        "Deployment status is malformed",
    )
    if not statuses or run_id(statuses[0]) is None:
        return observation("The latest mutation has no verified release provenance")
    status = statuses[0]
    run = current_attempt(acceptance, run_id(status), observed)
    workflow = str(run.get("path", "")).split("@", 1)[0]
    if workflow in READ_ONLY_WORKFLOWS:
        return None
    if workflow == CHAT_WORKFLOW and "backend" not in needed:
        return None  # This existing narrow workflow cannot mutate the frontend.
    if run.get("status") in LIVE_STATES:
        return observation("A relevant UAT deployment is still running", waiting=True)
    if workflow != UAT_WORKFLOW:
        return observation(
            "A later mutation prevents reuse of an older full-release receipt"
        )
    if (
        status.get("state") != "success"
        or run.get("status") != "completed"
        or run.get("conclusion") != "success"
    ):
        return observation("Current deployment or rerun is not healthy")
    pins = [
        pin
        for pin in acceptance.attempt_pins("uat", run["id"])
        if pin["run_attempt"] == run["run_attempt"]
    ]
    if len(pins) != 1:
        return observation(
            "Current deployment has no unique retained acceptance receipt"
        )
    try:
        application = acceptance.accepted_application(pins[0], "uat")
    except ValueError:
        return observation("Current service acceptance could not be qualified")
    touched = needed & application["services"].keys()
    if not touched:
        return None
    return {
        "sha": application["sha"],
        "accepted": {service: application["services"][service] for service in touched},
    }


def current_application(
    repository, acceptance, target: str, scope: str, limit=100
) -> dict:
    require(
        bool(re.fullmatch(r"[0-9a-f]{40}", target)),
        "A full application SHA is required",
    )
    require(
        scope in {"auto", "all", "frontend", "backend"}, "Unsupported requested scope"
    )
    require(type(limit) is int and 1 <= limit <= 300, "Observation bound is invalid")
    needed = {"backend", "frontend"} if scope in {"auto", "all"} else {scope}
    accepted, observed, sources, count = {}, {}, {}, 0
    for page in range(1, 4):
        if count >= limit:
            break
        rows = repository.read(f"deployments?environment=uat&per_page=100&page={page}")
        require(
            isinstance(rows, list) and len(rows) <= 100,
            "Deployment inventory is malformed",
        )
        for deployment in rows[: limit - count]:
            count += 1
            result = inspect_deployment(
                repository, acceptance, deployment, needed, observed
            )
            if result is None:
                continue
            if "accepted" not in result:
                return result
            accepted.update(result["accepted"])
            sources.update({service: result["sha"] for service in result["accepted"]})
            needed -= result["accepted"].keys()
            if not needed:
                if not repository.unchanged() or not attempt_unchanged(
                    acceptance, observed
                ):
                    return observation(
                        "Deployment identity or attempt changed during selection"
                    )
                return {
                    **observation(
                        "Current qualified service receipts are available",
                        noop=all(sha == target for sha in sources.values()),
                        services=accepted,
                    ),
                    "sources": sources,
                }
        if len(rows) < 100:
            break
    return observation(
        "No complete current service coverage was found within the observation bound"
    )


def choose(target: str, current: dict, allow_noop: bool, *, ancestor) -> dict:
    if current["waiting"]:
        return {"decision": "DEPLOY_IN_FLIGHT", "sha": "", "reason": current["reason"]}
    if allow_noop and current["noop"]:
        return {
            "decision": "NO_OP",
            "sha": "",
            "uat_actual_sha": target,
            "reason": current["reason"],
        }
    sources = current.get("sources", {})
    if not sources or not all(ancestor(sha, target) for sha in sources.values()):
        return {
            "decision": "BLOCKED",
            "sha": "",
            "reason": "Automatic selection requires a verified forward path from each current service; review an explicit candidate",
        }
    return {
        "decision": "DEPLOY_EXACT_SHA",
        "sha": target,
        "uat_actual_sha": "",
        "reason": "Selected the exact protected UAT tip; source CI and Dev acceptance remain required",
    }


def ancestor(before: str, after: str) -> bool:
    require(
        all(re.fullmatch(r"[0-9a-f]{40}", sha) for sha in (before, after)),
        "Full immutable application SHAs are required",
    )
    return (
        subprocess.run(
            ["git", "merge-base", "--is-ancestor", before, after],
            stderr=subprocess.DEVNULL,
            timeout=10,
        ).returncode
        == 0
    )


def require_unchanged_uat_tip(target: str) -> None:
    """Refuse a selection if the remote tip changed during evidence collection."""
    require(bool(re.fullmatch(r"[0-9a-f]{40}", target)), "UAT tip is invalid")
    remote = subprocess.check_output(
        ["git", "ls-remote", "--refs", "origin", "refs/heads/uat"],
        text=True,
        timeout=30,
    ).strip()  # noqa: S603
    require(remote == f"{target}\trefs/heads/uat", "UAT tip changed or is unavailable")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scope", default="auto")
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--github-output", action="store_true")
    parser.add_argument("--allow-no-op", action="store_true")
    args = parser.parse_args()
    try:
        subprocess.run(
            ["git", "fetch", "--no-tags", "origin", "refs/heads/uat"], check=True, timeout=30
        )
        target = subprocess.check_output(
            ["git", "rev-parse", "--verify", "FETCH_HEAD^{commit}"],
            text=True,
            timeout=10,
        ).strip()  # noqa: S603
        acceptance = importlib.import_module("verify-predecessor-acceptance").GitHub()
        api = GitHub(
            REPOSITORY, os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN", "")
        )
        current = current_application(
            ObservedRepository(api), acceptance, target, args.scope, args.limit
        )
        result = choose(target, current, args.allow_no_op, ancestor=ancestor)
        require_unchanged_uat_tip(target)
        if args.github_output:
            with Path(os.environ["GITHUB_OUTPUT"]).open("a") as output:
                for key in ("sha", "decision", "uat_actual_sha", "reason"):
                    output.write(f"{key}={result.get(key, '')}\n")
        print(json.dumps(result, sort_keys=True))
        return 0 if result["decision"] in {"NO_OP", "DEPLOY_EXACT_SHA"} else 3
    except (Refused, ValueError, OSError, subprocess.SubprocessError):
        print(
            "UAT selection refused: source, current deployment or acceptance evidence is unavailable."
        )
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
