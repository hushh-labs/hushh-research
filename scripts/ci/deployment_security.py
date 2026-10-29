#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Read repository alerts in a protected job of an explicit Main-owned release."""

from __future__ import annotations

from datetime import datetime, timezone
import json
import os
from pathlib import Path
from urllib.parse import quote

from github_security_authority import GitHub, Refused, SHA, inventory, positive

REPOSITORY = "hushh-labs/hushh-research"
CALLERS = {"release-ios-appstore.yml", "ship-ios-testflight.yml", "validate-plg-frontend-source.yml", "ship-android-playstore-v1.yml", "deploy-uat-one-chat.yml", "deploy-dev.yml", "publish-hushh-mcp.yml", "deploy-uat.yml", "deploy-production.yml", "resume-ios-testflight.yml", "rollback.yml"}


def verify_run(read, env: dict) -> dict:
    repository = env.get("GITHUB_REPOSITORY")
    workflow = env.get("GITHUB_WORKFLOW_REF", "")
    path = workflow.removeprefix(REPOSITORY + "/").removesuffix("@refs/heads/main")
    if (
        repository != REPOSITORY or env.get("GITHUB_REF") != "refs/heads/main"
        or env.get("GITHUB_EVENT_NAME") != "workflow_dispatch"
        or workflow != f"{REPOSITORY}/{path}@refs/heads/main"
        or path not in {f".github/workflows/{name}" for name in CALLERS}
        or not SHA.fullmatch(env.get("GITHUB_SHA", ""))
    ):
        raise Refused("Deployment security requires an explicit Main-owned release")
    run_id = positive(int(env["GITHUB_RUN_ID"]), "deployment run")
    attempt = positive(int(env["GITHUB_RUN_ATTEMPT"]), "deployment attempt")
    run = read(f"repos/{repository}/actions/runs/{run_id}")
    if not isinstance(run, dict) or any(run.get(key) != value for key, value in {
        "id": run_id, "run_attempt": attempt, "head_sha": env["GITHUB_SHA"],
        "event": "workflow_dispatch", "status": "in_progress",
    }.items()) or run.get("path", "").split("@", 1)[0] != path:
        raise Refused("Deployment run, attempt or workflow changed")
    if run.get("repository", {}).get("full_name") != repository:
        raise Refused("Deployment repository mismatch")
    return {"repository": repository, "run_id": run_id, "attempt": attempt,
            "workflow_path": path, "workflow_sha": env["GITHUB_SHA"]}


def produce(env: dict, source_read, alert_read) -> dict:
    source = verify_run(source_read, env)
    reference = env.get("DEPLOY_SECURITY_REF", "")
    if not reference or len(reference) > 200 or any(c.isspace() for c in reference):
        raise Refused("Deployment needs a bounded application reference")
    commit = source_read(f"repos/{REPOSITORY}/commits/{quote(reference, safe='')}")
    sha = commit.get("sha") if isinstance(commit, dict) else None
    if not isinstance(sha, str) or not SHA.fullmatch(sha):
        raise Refused("Application reference could not be resolved")
    environment = env.get("DEPLOY_SECURITY_ENVIRONMENT")
    if environment not in {"dev", "uat", "production", "native", "package", "validation"}:
        raise Refused("Unknown deployment environment")
    scope = env.get("DEPLOY_SECURITY_SCOPE", "all")
    if scope not in {"auto", "all", "backend", "frontend", "native", "package", "validation"}:
        raise Refused("Unknown deployment scope")
    repo = source_read(f"repos/{REPOSITORY}")
    if not isinstance(repo, dict) or repo.get("full_name") != REPOSITORY:
        raise Refused("Repository identity unavailable")
    repo_id = positive(repo.get("id"), "repository identity")
    secrets = inventory(alert_read, REPOSITORY, "secret-scanning", repo_id)
    dependencies = inventory(alert_read, REPOSITORY, "dependabot", repo_id)
    # A later attempt cannot inherit the result while the inventory is read.
    if verify_run(source_read, env) != source:
        raise Refused("Deployment authority changed during alert inventory")
    return {"schema_version": 1, "source": {**source, "application_sha": sha,
            "environment": environment, "requested_scope": scope},
            "recorded_at": datetime.now(timezone.utc).isoformat(),
            "secret_scanning": secrets, "dependabot": dependencies,
            "verdict": "clear" if secrets["open"] == 0 else "blocked"}


def main() -> int:
    try:
        env = dict(os.environ)
        api = GitHub(REPOSITORY, env.get("GH_TOKEN", ""))
        alerts = GitHub(REPOSITORY, env.get("GH_SECURITY_ALERTS_TOKEN", ""))
        receipt = produce(env, api.read, alerts.read_page)
        path = Path(env["RUNNER_TEMP"]) / "deployment-security.json"
        with path.open("x", encoding="utf-8") as output:
            json.dump(receipt, output, indent=2)
        path.chmod(0o600)
        print(f"Open secret alerts: {receipt['secret_scanning']['open']}; "
              f"dependency alerts: {receipt['dependabot']['open']} (advisory).")
        if receipt["verdict"] != "clear":
            return 1
        with Path(env["GITHUB_OUTPUT"]).open("a", encoding="utf-8") as output:
            output.write(f"sha={receipt['source']['application_sha']}\n")
            output.write(f"attempt={receipt['source']['attempt']}\n")
        return 0
    except (Refused, KeyError, TypeError, ValueError, OSError) as error:
        reason = str(error) if isinstance(error, Refused) else "configuration unavailable"
        print(f"Deployment security refused: {reason}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
