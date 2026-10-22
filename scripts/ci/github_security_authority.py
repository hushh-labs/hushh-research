#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Read repository alerts only from the protected, main-owned CI worker."""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
from typing import Any, Callable
import urllib.error
import urllib.request
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[2]
WORKER_PATH = ".github/workflows/ci-security.yml"
CI_PATH = ".github/workflows/ci.yml"
MAX_PAGE_BYTES = 2 * 1024 * 1024
MAX_PAGES = 50
SHA = re.compile(r"[0-9a-f]{40}")
Document = dict[str, Any]
Read = Callable[[str], Any]


class Refused(RuntimeError):
    """Unavailable or mismatched authority is never a passing scan."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        fp.close()
        raise Refused("GitHub API redirect refused")


class GitHub:
    def __init__(self, repository: str, token: str):
        if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
            raise Refused("Invalid repository")
        if not token:
            raise Refused("Required GitHub credential unavailable")
        self.repository, self.token = repository, token

    def read(self, path: str) -> Any:
        root = f"repos/{self.repository}"
        if path != root and not path.startswith(root + "/"):
            raise Refused("GitHub request left its repository")
        request = urllib.request.Request(
            f"https://api.github.com/{path}",
            headers={
                "Authorization": f"Bearer {self.token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )
        try:
            with urllib.request.build_opener(NoRedirect).open(
                request, timeout=20
            ) as response:
                raw = response.read(MAX_PAGE_BYTES + 1)
        except urllib.error.HTTPError as error:
            error.close()
            raise Refused(f"GitHub authority unavailable (HTTP {error.code})") from None
        except (urllib.error.URLError, TimeoutError):
            raise Refused("GitHub authority request failed") from None
        if len(raw) > MAX_PAGE_BYTES:
            raise Refused("GitHub response exceeded its bound")
        try:
            return json.loads(raw)
        except (ValueError, UnicodeError):
            raise Refused("GitHub response was not valid JSON") from None


def positive(value: Any, label: str) -> int:
    if type(value) is not int or value < 1:
        raise Refused(f"Invalid {label}")
    return value


def requested_source(
    event: Document, environment: Document, policy: Document
) -> Document:
    kind = environment.get("GITHUB_EVENT_NAME")
    if kind == "workflow_run":
        source = event.get("workflow_run") or {}
        result = {
            "run_id": source.get("id"),
            "attempt": source.get("run_attempt"),
            "head_sha": source.get("head_sha"),
        }
    elif kind == "workflow_dispatch":
        allowed = policy["main"]["protected_pipeline_edit_users"]
        actors = {
            environment.get("GITHUB_ACTOR"),
            environment.get("GITHUB_TRIGGERING_ACTOR"),
        }
        if not actors or not actors.issubset(set(allowed)):
            raise Refused("Manual security recovery requires a governed operator")
        inputs = event.get("inputs") or {}
        try:
            result = {
                "run_id": int(inputs["source_run_id"]),
                "attempt": int(inputs["source_attempt"]),
                "head_sha": inputs["source_sha"],
            }
        except (KeyError, ValueError, TypeError):
            raise Refused("Manual recovery needs exact run, attempt and SHA") from None
    else:
        raise Refused("Unsupported security worker event")
    positive(result["run_id"], "source run")
    positive(result["attempt"], "source attempt")
    if not isinstance(result["head_sha"], str) or not SHA.fullmatch(result["head_sha"]):
        raise Refused("Invalid source SHA")
    return result


def verify_source(read: Read, repository: str, expected: Document) -> Document:
    prefix = f"repos/{repository}"
    repo = read(prefix)
    workflow = read(f"{prefix}/actions/workflows/ci.yml")
    source = read(f"{prefix}/actions/runs/{expected['run_id']}")
    if not all(isinstance(item, dict) for item in (repo, workflow, source)):
        raise Refused("Source authority is malformed")
    repo_id = positive(repo.get("id"), "repository identity")
    if (
        repo.get("full_name") != repository
        or workflow.get("path") != CI_PATH
        or source.get("repository", {}).get("id") != repo_id
        or source.get("repository", {}).get("full_name") != repository
        or source.get("workflow_id") != positive(workflow.get("id"), "CI workflow")
        or source.get("path", "").split("@", 1)[0] != CI_PATH
        or positive(source.get("id"), "observed source run") != expected["run_id"]
        or positive(source.get("run_attempt"), "observed source attempt")
        != expected["attempt"]
        or source.get("head_sha") != expected["head_sha"]
        or source.get("event") not in {"pull_request", "workflow_dispatch"}
        or source.get("status") not in {"queued", "in_progress", "completed"}
    ):
        raise Refused("Source repository, workflow, run, attempt or SHA mismatch")
    # Fork code is never read or executed: the canonical base repository owns CI.
    return {
        **expected,
        "repository": repository,
        "repository_id": repo_id,
        "workflow_id": workflow["id"],
        "workflow_path": CI_PATH,
        "event": source["event"],
    }


def inventory(read: Read, repository: str, family: str) -> Document:
    count, severities = 0, {}
    for page in range(1, MAX_PAGES + 1):
        rows = read(
            f"repos/{repository}/{family}/alerts?state=open&per_page=100&page={page}"
        )
        if (
            not isinstance(rows, list)
            or len(rows) > 100
            or any(
                not isinstance(row, dict) or row.get("state") != "open" for row in rows
            )
        ):
            raise Refused("Alert inventory is malformed")
        count += len(rows)
        if family == "dependabot":
            for row in rows:
                advisory = row.get("security_advisory") or {}
                if not isinstance(advisory, dict):
                    raise Refused("Alert advisory is malformed")
                severity = advisory.get("severity", "unknown")
                if severity not in {"critical", "high", "medium", "low", "unknown"}:
                    raise Refused("Alert severity is malformed")
                severities[severity] = severities.get(severity, 0) + 1
        if len(rows) < 100:
            return {"complete": True, "open": count, "severity": severities}
    raise Refused(
        "Alert inventory exceeded its bounded pagination; clearance unavailable"
    )


def produce(environment: Document) -> Document:
    repository = environment["GITHUB_REPOSITORY"]
    if (
        environment.get("GITHUB_REF") != "refs/heads/main"
        or environment.get("GITHUB_WORKFLOW_REF")
        != f"{repository}/{WORKER_PATH}@refs/heads/main"
        or not SHA.fullmatch(environment.get("GITHUB_SHA", ""))
    ):
        raise Refused("Security authority must execute immutable main-owned code")
    event = json.loads(Path(environment["GITHUB_EVENT_PATH"]).read_text())
    policy = json.loads((ROOT / "config/ci-governance.json").read_text())
    attempt = positive(int(environment["GITHUB_RUN_ATTEMPT"]), "producer attempt")
    if (
        attempt > 1
        and environment.get("GITHUB_TRIGGERING_ACTOR")
        not in policy["main"]["protected_pipeline_edit_users"]
    ):
        raise Refused("Rerunning security authority requires a governed operator")
    source_api = GitHub(repository, environment.get("GH_TOKEN", ""))
    expected = requested_source(event, environment, policy)
    source = verify_source(source_api.read, repository, expected)
    alert_api = GitHub(repository, environment.get("GH_SECURITY_ALERTS_TOKEN", ""))
    secrets = inventory(alert_api.read, repository, "secret-scanning")
    dependencies = inventory(alert_api.read, repository, "dependabot")
    # Re-read after inventory; an old attempt cannot mint a current clearance.
    verify_source(source_api.read, repository, expected)
    return {
        "schema_version": 1,
        "source": source,
        "producer": {
            "workflow_path": WORKER_PATH,
            "main_sha": environment["GITHUB_SHA"],
            "run_id": int(environment["GITHUB_RUN_ID"]),
            "attempt": attempt,
        },
        "recorded_at": datetime.now(timezone.utc).isoformat(),
        "policy": {"required_secret_clearance": True, "dependabot_blocking": False},
        "secret_scanning": secrets,
        "dependabot": dependencies,
        "verdict": "clear" if secrets["open"] == 0 else "blocked",
    }


def main() -> int:
    try:
        receipt = produce(dict(os.environ))
        path = Path(os.environ["RUNNER_TEMP"]) / "ci-security.json"
        with path.open("x", encoding="utf-8") as output:
            json.dump(receipt, output, indent=2)
        path.chmod(0o600)
        print(
            f"Secret alerts: {receipt['secret_scanning']['open']}; "
            f"dependency alerts: {receipt['dependabot']['open']} (advisory)."
        )
        return 0 if receipt["verdict"] == "clear" else 1
    except (Refused, KeyError, ValueError, OSError) as error:
        if isinstance(error, Refused):
            print(f"Security authority refused: {error}")
        else:
            print("Security authority refused: configuration or receipt unavailable")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
