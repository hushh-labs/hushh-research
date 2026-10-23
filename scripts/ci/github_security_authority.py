#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Read repository alerts only from the protected, main-owned CI worker."""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
import subprocess
import sys
from typing import Any, Callable
import urllib.error
import urllib.request
from urllib.parse import parse_qs, urlsplit
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[2]
WORKER_PATH = ".github/workflows/ci-security.yml"
CI_PATH = ".github/workflows/ci.yml"
MAX_PAGE_BYTES = 2 * 1024 * 1024
MAX_PAGES = 50
SHA = re.compile(r"[0-9a-f]{40}")
Document = dict[str, Any]
Read = Callable[[str], Any]
ReadPage = Callable[[str], tuple[Any, str]]


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
        return self.read_page(path)[0]

    def read_page(self, path: str) -> tuple[Any, str]:
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
                links = response.headers.get("Link", "")
        except urllib.error.HTTPError as error:
            error.close()
            raise Refused(f"GitHub authority unavailable (HTTP {error.code})") from None
        except (urllib.error.URLError, TimeoutError):
            raise Refused("GitHub authority request failed") from None
        if len(raw) > MAX_PAGE_BYTES:
            raise Refused("GitHub response exceeded its bound")
        try:
            return json.loads(raw), links
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


def next_alert_page(
    links: str, repository: str, family: str, repository_id: int | None = None
) -> str | None:
    """Follow only GitHub's next link for this exact open-alert inventory."""
    if not isinstance(links, str) or len(links) > 16384:
        raise Refused("Alert pagination header exceeded its bound")
    next_path = None
    for part in links.split(",") if links else ():
        match = re.fullmatch(r'\s*<([^<>]+)>\s*;\s*rel="([^"]+)"\s*', part)
        if not match:
            raise Refused("Alert pagination header is malformed")
        if "next" not in match[2].split():
            continue
        if next_path is not None:
            raise Refused("Alert pagination has multiple next links")
        url = urlsplit(match[1])
        expected = f"/repos/{repository}/{family}/alerts"
        paths = {expected}
        if repository_id is not None:
            paths.add(
                f"/repositories/{positive(repository_id, 'repository identity')}/{family}/alerts"
            )
        if (
            url.scheme != "https"
            or url.netloc != "api.github.com"
            or url.path not in paths
            or url.fragment
        ):
            raise Refused("Alert pagination left its repository inventory")
        try:
            query = parse_qs(
                url.query, strict_parsing=True, max_num_fields=5, keep_blank_values=True
            )
        except ValueError:
            raise Refused("Alert pagination query is malformed") from None
        allowed = {"state", "per_page", "after", "before"}
        if family == "secret-scanning":
            allowed.add("page")
        if (
            query.keys() - allowed
            or query.get("state") != ["open"]
            or query.get("per_page") != ["100"]
            or any(len(values) != 1 or not values[0] for values in query.values())
            or len(query.keys() & {"after", "before", "page"}) != 1
            or any(
                len(query[key][0]) > 2048 for key in ("after", "before") if key in query
            )
            or ("page" in query and not re.fullmatch(r"[1-9][0-9]*", query["page"][0]))
        ):
            raise Refused("Alert pagination changed its inventory filters")
        # GitHub may return its immutable numeric alias. Keep every request on
        # the already verified named repository, preserving the opaque cursor.
        next_path = expected.lstrip("/") + "?" + url.query
    return next_path


def inventory(
    read: ReadPage, repository: str, family: str, repository_id: int | None = None
) -> Document:
    if family not in {"secret-scanning", "dependabot"}:
        raise Refused("Unknown alert inventory")
    count, severities = 0, {}
    path = f"repos/{repository}/{family}/alerts?state=open&per_page=100"
    visited = set()
    for _ in range(MAX_PAGES):
        if path in visited:
            raise Refused("Alert pagination repeated a page")
        visited.add(path)
        rows, links = read(path)
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
        path = next_alert_page(links, repository, family, repository_id)
        if path is None:
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
    secrets = inventory(
        alert_api.read_page, repository, "secret-scanning", source["repository_id"]
    )
    dependencies = inventory(
        alert_api.read_page, repository, "dependabot", source["repository_id"]
    )
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


def local_alerts(
    environment: Document,
    repository: str,
    read: ReadPage,
    repository_id: int | None = None,
) -> int:
    """Keep local parity complete and memory-only, with independent read policies."""
    strict = environment.get("REQUIRE_GITHUB_ALERTS_CLEAN", "0") == "1"
    secret_required = (
        environment.get("REQUIRE_GITHUB_SECRET_ALERTS_CLEAN", "1" if strict else "0")
        == "1"
    )
    dependency_required = (
        environment.get("REQUIRE_GITHUB_DEPENDABOT_ALERTS_CLEAN", "0") == "1"
    )
    failed = False
    for family, required in (
        ("secret-scanning", secret_required),
        ("dependabot", dependency_required),
    ):
        try:
            result = inventory(read, repository, family, repository_id)
        except Refused:
            print(f"GitHub {family} alert inventory unavailable.")
            failed = failed or strict or required
            continue
        print(f"GitHub {family} open alerts: {result['open']} (complete inventory).")
        failed = failed or (required and result["open"] > 0)
    return 1 if failed else 0


def local_main(environment: Document) -> int:
    strict = any(
        environment.get(name) == "1"
        for name in (
            "REQUIRE_GITHUB_ALERTS_CLEAN",
            "REQUIRE_GITHUB_SECRET_ALERTS_CLEAN",
            "REQUIRE_GITHUB_DEPENDABOT_ALERTS_CLEAN",
        )
    )
    try:
        repository = (
            environment.get("GITHUB_REPOSITORY")
            or subprocess.run(
                [
                    "gh",
                    "repo",
                    "view",
                    "--json",
                    "nameWithOwner",
                    "--jq",
                    ".nameWithOwner",
                ],
                capture_output=True,
                text=True,
                check=True,
                timeout=10,
            ).stdout.strip()
        )
        token = (
            environment.get("GH_TOKEN")
            or subprocess.run(
                ["gh", "auth", "token"],
                capture_output=True,
                text=True,
                check=True,
                timeout=10,
            ).stdout.strip()
        )
        api = GitHub(repository, token)
    except (Refused, OSError, subprocess.SubprocessError):
        print(
            "GitHub security alert authority unavailable; local authentication is required."
        )
        return 1 if strict else 0
    try:
        repository_id = positive(
            api.read(f"repos/{repository}").get("id"), "repository identity"
        )
        return local_alerts(environment, repository, api.read_page, repository_id)
    except (Refused, AttributeError):
        print("GitHub repository identity unavailable.")
        return 1 if strict else 0


if __name__ == "__main__":
    raise SystemExit(
        local_main(dict(os.environ)) if sys.argv[1:] == ["--local"] else main()
    )
