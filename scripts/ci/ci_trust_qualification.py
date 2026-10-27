#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Synthetic target-event/cache qualification; never release or merge authority."""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import urllib.error
import urllib.request

from github_security_authority import GitHub, NoRedirect, Refused

REPOSITORY = "hushh-labs/hushh-research"
WORKFLOW = ".github/workflows/ci-trust-qualification.yml"


def require(condition: object, message: str) -> None:
    if not condition:
        raise Refused(message)


def observe(environment: dict, api: GitHub) -> dict:
    event = json.loads(Path(environment["GITHUB_EVENT_PATH"]).read_text())
    run = api.read(f"repos/{REPOSITORY}/actions/runs/{environment['GITHUB_RUN_ID']}")
    jobs = api.read(
        f"repos/{REPOSITORY}/actions/runs/{run['id']}/attempts/{run['run_attempt']}/jobs?per_page=100"
    )
    checkout = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()  # noqa: S603
    return {
        "schema_version": 1,
        "kind": "ci-platform-qualification",
        "run_id": run["id"],
        "attempt": run["run_attempt"],
        "workflow": environment.get("GITHUB_WORKFLOW_REF"),
        "workflow_sha": environment.get("GITHUB_WORKFLOW_SHA"),
        "context_sha": environment.get("GITHUB_SHA"),
        "context_ref": environment.get("GITHUB_REF"),
        "checkout_sha": checkout,
        "api_head_sha": run["head_sha"],
        "pr_head_sha": event["pull_request"]["head"]["sha"],
        "pr_base_sha": event["pull_request"]["base"]["sha"],
        "pr_number": event["pull_request"]["number"],
        "api_associated_prs": [
            item.get("number") for item in run.get("pull_requests", [])
        ],
        "job_head_shas": sorted({item["head_sha"] for item in jobs.get("jobs", [])}),
        "cache_mode": environment.get("ACTIONS_CACHE_MODE"),
        "privileged_credentials_present": any(
            environment.get(key)
            for key in (
                "GH_SECURITY_ALERTS_TOKEN",
                "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
                "ACTIONS_ID_TOKEN_REQUEST_URL",
            )
        ),
        "runner_os": environment["RUNNER_OS"],
        "status": "observed",
    }


def denied_check_write(environment: dict, head_sha: str) -> None:
    request = urllib.request.Request(
        f"https://api.github.com/repos/{REPOSITORY}/check-runs",
        data=json.dumps(
            {
                "name": "Synthetic denied-write probe",
                "head_sha": head_sha,
                "status": "completed",
                "conclusion": "cancelled",
            }
        ).encode(),
        method="POST",
        headers={
            "Authorization": f"Bearer {environment['GH_TOKEN']}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    try:
        with urllib.request.build_opener(NoRedirect).open(
            request, timeout=20
        ) as response:
            # A permission regression may leave only a cancelled synthetic check
            # on the disposable PR; it can never satisfy CI Status Gate.
            response.read(4096)
    except urllib.error.HTTPError as error:
        code = error.code
        raw = error.read(4097)
        error.close()
        require(
            code == 403
            and len(raw) <= 4096
            and json.loads(raw).get("message")
            == "Resource not accessible by integration",
            "Check write did not produce the expected integration-permission refusal",
        )
        return
    raise Refused("Candidate token unexpectedly had check-write authority")


def verify(record: dict, environment: dict, api: GitHub) -> None:
    require(
        environment.get("GITHUB_REPOSITORY") == REPOSITORY
        and environment.get("GITHUB_EVENT_NAME") == "pull_request_target"
        and record["workflow"] == f"{REPOSITORY}/{WORKFLOW}@refs/heads/main"
        and record["checkout_sha"] == record["workflow_sha"]
        and record["cache_mode"] == "read"
        and record["privileged_credentials_present"] is False,
        "Target workflow or candidate privilege boundary differs from the required configuration",
    )
    key = f"ci-trust-{record['run_id']}-{record['attempt']}-{record['runner_os']}"
    caches = api.read(f"repos/{REPOSITORY}/actions/caches?key={key}&per_page=100")
    require(
        caches.get("total_count") == 0 and caches.get("actions_caches") == [],
        "Candidate cache-save attempt created an object or could not be verified",
    )
    denied_check_write(environment, record["pr_head_sha"])
    record.update(
        status="boundary-observed", cache_object_absent=True, check_write_denied=True
    )


def main() -> int:
    path = Path(os.environ["RUNNER_TEMP"]) / "ci-trust.json"
    try:
        environment = dict(os.environ)
        api = GitHub(REPOSITORY, environment.get("GH_TOKEN", ""))
        if sys.argv[1:] == ["observe"]:
            record = observe(environment, api)
            with path.open("x", encoding="utf-8") as output:
                json.dump(record, output, indent=2)
        else:
            require(sys.argv[1:] == ["verify"], "Unknown qualification operation")
            record = json.loads(path.read_text())
            verify(record, environment, api)
            path.write_text(json.dumps(record, indent=2) + "\n")
        print("Recorded bounded CI platform evidence; no release authority issued.")
        return 0
    except (Refused, OSError, ValueError, KeyError, subprocess.SubprocessError):
        print(
            "CI qualification refused; inspect the bounded receipt and workflow configuration."
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
