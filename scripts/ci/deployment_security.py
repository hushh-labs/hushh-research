#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Read repository alerts in a protected job of an explicit Main-owned release."""

from __future__ import annotations

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import time
from urllib.parse import quote

from github_security_authority import GitHub, Refused, SHA, inventory, positive

REPOSITORY = "hushh-labs/hushh-research"
BROKER_PATH = ".github/workflows/deployment-security.yml"
IMPLEMENTATIONS = {
    name: f".github/workflows/deploy-{name}-implementation.yml" for name in ("dev", "uat")
}
CALLERS = {
    "deploy-dev.yml", "deploy-uat.yml", "deploy-production.yml",
    "validate-plg-frontend-source.yml", "release-ios-appstore.yml", "ship-ios-testflight.yml",
    "ship-android-playstore-v1.yml", "publish-hushh-mcp.yml",
    "rollback.yml",
}


def verify_run(read, env: dict, *, broker: bool = False) -> dict:
    repository = env.get("GITHUB_REPOSITORY")
    workflow = env.get("GITHUB_WORKFLOW_REF", "")
    path = workflow.removeprefix(REPOSITORY + "/").removesuffix("@refs/heads/main")
    if (
        repository != REPOSITORY or env.get("GITHUB_REF") != "refs/heads/main"
        or env.get("GITHUB_EVENT_NAME") != "workflow_dispatch"
        or workflow != f"{REPOSITORY}/{path}@refs/heads/main"
        or path not in ({BROKER_PATH} if broker else {f".github/workflows/{name}" for name in CALLERS})
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


def verify_deployment(read, request: dict, policy: dict) -> dict:
    """A Main broker observes one active, governed matching-branch deployment.

    Requested values are not authority: GitHub must independently establish the
    caller, current attempt, protected source and Main reusable implementation.
    No candidate code or artifact is executed beside the alert credential.
    """
    fields = {"run_id", "attempt", "caller_sha", "application_sha", "environment",
              "requested_scope", "tooling_sha"}
    if not isinstance(request, dict) or set(request) != fields:
        raise Refused("Deployment security request fields are incomplete or unknown")
    environment = request["environment"]
    if not isinstance(environment, str) or environment not in IMPLEMENTATIONS or request["requested_scope"] not in {
        "auto", "all", "backend", "frontend",
    }:
        raise Refused("Broker only accepts explicit Dev/UAT deployment scopes")
    for field in ("caller_sha", "application_sha", "tooling_sha"):
        if not isinstance(request[field], str) or not SHA.fullmatch(request[field]):
            raise Refused("Deployment security requires immutable source revisions")
    run_id = positive(request["run_id"], "source deployment run")
    attempt = positive(request["attempt"], "source deployment attempt")
    prefix = f"repos/{REPOSITORY}"
    repo = read(prefix)
    if not isinstance(repo, dict):
        raise Refused("Deployment repository inventory is unavailable")
    repository_id = positive(repo.get("id"), "repository identity")
    if repo.get("full_name") != REPOSITORY:
        raise Refused("Deployment repository mismatch")
    path = f".github/workflows/deploy-{environment}.yml"
    workflow = read(f"{prefix}/actions/workflows/deploy-{environment}.yml")
    if not isinstance(workflow, dict):
        raise Refused("Deployment workflow inventory is unavailable")
    workflow_id = positive(workflow.get("id"), "deployment workflow")
    run = read(f"{prefix}/actions/runs/{run_id}")
    if not isinstance(run, dict):
        raise Refused("Deployment source run is unavailable")
    expected = {"id": run_id, "run_attempt": attempt, "head_sha": request["caller_sha"],
                "head_branch": environment, "event": "workflow_dispatch", "status": "in_progress",
                "workflow_id": workflow_id}
    allowed = set(policy[environment]["manual_dispatch_users"])
    if (workflow.get("path") != path or any(run.get(k) != v for k, v in expected.items())
            or run.get("path", "").split("@", 1)[0] != path
            or any(run.get(key, {}).get("id") != repository_id
                   or run.get(key, {}).get("full_name") != REPOSITORY
                   for key in ("repository", "head_repository"))
            or any(run.get(key, {}).get("login") not in allowed
                   for key in ("actor", "triggering_actor"))):
        raise Refused("Source deployment identity, attempt or operator is not admitted")
    implementation = f"{REPOSITORY}/{IMPLEMENTATIONS[environment]}"
    references = run.get("referenced_workflows")
    if (not isinstance(references, list) or len(references) > 20
            or not all(isinstance(item, dict) for item in references)):
        raise Refused("Trusted deployment implementation inventory is unavailable")
    matches = [item for item in references
               if isinstance(item.get("path"), str)
               and item["path"].split("@", 1)[0] == implementation]
    if (len(matches) != 1 or matches[0].get("sha") != request["tooling_sha"]
            or matches[0].get("ref") != "refs/heads/main"
            or matches[0]["path"] not in {
                f"{implementation}@main", f"{implementation}@refs/heads/main",
                f"{implementation}@{request['tooling_sha']}",
            }):
        raise Refused("Source does not use the recorded Main deployment implementation")
    for revision, branch in ((request["tooling_sha"], "main"),
                             (request["application_sha"], environment)):
        comparison = read(f"{prefix}/compare/{revision}...{branch}?per_page=1&page=2")
        if (comparison.get("status") not in {"identical", "ahead"}
                or comparison.get("merge_base_commit", {}).get("sha") != revision):
            raise Refused("Deployment source is outside its protected branch history")
    return {**request, "repository": REPOSITORY, "repository_id": repository_id,
            "workflow_path": path, "workflow_id": workflow_id,
            "caller_branch": environment, "implementation_path": IMPLEMENTATIONS[environment]}


def produce(env: dict, source_read, alert_read) -> dict:
    if env.get("GITHUB_WORKFLOW_REF") == f"{REPOSITORY}/{BROKER_PATH}@refs/heads/main":
        return produce_broker(env, source_read, alert_read)
    if env.get("DEPLOY_SECURITY_REQUEST"):
        raise Refused("Cross-run requests require the Main-owned broker")
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


def produce_broker(env: dict, source_read, alert_read, *, policy: dict | None = None) -> dict:
    producer = verify_run(source_read, env, broker=True)
    raw = env.get("DEPLOY_SECURITY_REQUEST", "")
    if not raw or len(raw) > 4096:
        raise Refused("Broker needs one bounded deployment request")
    request = json.loads(raw)
    if policy is None:
        policy = json.loads((Path(__file__).resolve().parents[2] / "config/ci-governance.json").read_text())
    source = verify_deployment(source_read, request, policy)
    secrets = inventory(alert_read, REPOSITORY, "secret-scanning", source["repository_id"])
    dependencies = inventory(alert_read, REPOSITORY, "dependabot", source["repository_id"])
    if (verify_deployment(source_read, request, policy) != source
            or verify_run(source_read, env, broker=True) != producer):
        raise Refused("Deployment or broker authority changed during alert inventory")
    return {"schema_version": 2, "source": source, "producer": producer,
            "recorded_at": datetime.now(timezone.utc).isoformat(),
            "secret_scanning": secrets, "dependabot": dependencies,
            "verdict": "clear" if secrets["open"] == 0 else "blocked"}


def consume_broker(api, request: dict, broker_run_id: int, policy: dict) -> dict:
    """Verify an exact broker result; its green aggregate alone is insufficient."""
    from github_security_receipt import archive_read, require, timestamp, unpack

    source = verify_deployment(api.read, request, policy)
    prefix = f"repos/{REPOSITORY}/actions"
    identifier = positive(broker_run_id, "broker run")
    run = api.read(f"{prefix}/runs/{identifier}")
    workflow = api.read(f"{prefix}/workflows/deployment-security.yml")
    attempt = positive(run.get("run_attempt"), "broker attempt")
    main_sha = run.get("head_sha", "")
    require(
        isinstance(main_sha, str) and SHA.fullmatch(main_sha) is not None
        and run.get("id") == identifier and workflow.get("path") == BROKER_PATH
        and run.get("workflow_id") == positive(workflow.get("id"), "broker workflow")
        and run.get("path", "").split("@", 1)[0] == BROKER_PATH
        and run.get("head_branch") == "main" and run.get("event") == "workflow_dispatch"
        and run.get("status") == "completed" and run.get("conclusion") == "success"
        and all(run.get(key, {}).get("id") == source["repository_id"]
                and run.get(key, {}).get("full_name") == REPOSITORY
                for key in ("repository", "head_repository")),
        "Deployment security broker identity or outcome is unverified",
    )
    comparison = api.read(f"repos/{REPOSITORY}/compare/{main_sha}...main?per_page=1&page=2")
    require(comparison.get("status") in {"identical", "ahead"}
            and comparison.get("merge_base_commit", {}).get("sha") == main_sha,
            "Deployment security broker revision is outside Main")
    jobs = api.read(f"{prefix}/runs/{identifier}/attempts/{attempt}/jobs?per_page=100")
    require(jobs.get("total_count") == len(jobs.get("jobs", [])) == 1,
            "Deployment security job inventory is incomplete")
    job = jobs["jobs"][0]
    steps = [step for step in job.get("steps", [])
             if step.get("name") == "Read protected repository inventory"]
    require(job.get("run_id") == identifier and job.get("run_attempt") == attempt
            and job.get("name") == "Verify repository secret clearance"
            and job.get("conclusion") == "success" and len(steps) == 1
            and steps[0].get("conclusion") == "success",
            "Deployment security inventory step did not pass on this attempt")
    inventory_result = api.read(f"{prefix}/runs/{identifier}/artifacts?per_page=100")
    artifacts = inventory_result.get("artifacts", [])
    require(type(inventory_result.get("total_count")) is int
            and inventory_result["total_count"] == len(artifacts) <= 100,
            "Deployment security artifact inventory is incomplete")
    matches = [item for item in artifacts
               if item.get("name") == f"deployment-security-{identifier}-{attempt}"]
    require(len(matches) == 1, "Deployment security artifact is missing or ambiguous")
    artifact = matches[0]
    require(artifact.get("expired") is False
            and artifact.get("workflow_run", {}).get("id") == identifier
            and type(artifact.get("size_in_bytes")) is int
            and 0 < artifact["size_in_bytes"] <= 64 * 1024,
            "Deployment security artifact has invalid ownership or size")
    raw = archive_read(positive(artifact.get("id"), "artifact identity"))
    require(len(raw) == artifact["size_in_bytes"], "Deployment security artifact size changed")
    receipt = unpack(raw, artifact.get("digest", ""), filename="deployment-security.json")
    require(receipt.get("schema_version") == 2 and receipt.get("source") == source
            and receipt.get("producer") == {
                "repository": REPOSITORY, "run_id": identifier, "attempt": attempt,
                "workflow_path": BROKER_PATH, "workflow_sha": main_sha,
            } and receipt.get("verdict") == "clear", "Deployment security receipt binding mismatch")
    for family in ("secret_scanning", "dependabot"):
        result = receipt.get(family, {})
        require(result.get("complete") is True and type(result.get("open")) is int
                and result["open"] >= 0, "Deployment security inventory is incomplete")
    require(receipt["secret_scanning"]["open"] == 0, "Open secret alerts refuse deployment")
    require(timestamp(run["run_started_at"]) <= timestamp(receipt["recorded_at"])
            <= timestamp(run["updated_at"])
            and timestamp(run["run_started_at"]) <= timestamp(artifact["created_at"])
            <= timestamp(run["updated_at"]), "Deployment security receipt belongs to another attempt")
    current = api.read(f"{prefix}/runs/{identifier}")
    require(all(current.get(key) == run.get(key) for key in (
        "id", "run_attempt", "head_sha", "workflow_id", "status", "conclusion",
    )), "Deployment security broker changed during verification")
    require(verify_deployment(api.read, request, policy) == source,
            "Deployment request changed during receipt verification")
    return receipt


def request_broker(env: dict, *, api=None, monotonic=time.monotonic, sleep=time.sleep) -> dict:
    """Dispatch once; a lost response is uncertain, never an automatic retry.

    The intent and returned run URL are retained by the caller's artifact step.
    This request process has only the ordinary Actions token, never the PAT.
    """
    from github_security_receipt import require

    if api is None:
        from release_cadence_github import api
    environment = env.get("DEPLOY_SECURITY_ENVIRONMENT", "")
    if (environment not in IMPLEMENTATIONS or env.get("GITHUB_REPOSITORY") != REPOSITORY
            or env.get("GITHUB_REF") != f"refs/heads/{environment}"
            or env.get("GITHUB_EVENT_NAME") != "workflow_dispatch"):
        raise Refused("Security requests require matching-branch Dev/UAT dispatch")
    request = {
        "run_id": positive(int(env["GITHUB_RUN_ID"]), "deployment run"),
        "attempt": positive(int(env["GITHUB_RUN_ATTEMPT"]), "deployment attempt"),
        "caller_sha": env["GITHUB_SHA"], "tooling_sha": env["RELEASE_TOOLING_SHA"],
        "application_sha": env["DEPLOY_SECURITY_REF"], "environment": environment,
        "requested_scope": env["DEPLOY_SECURITY_SCOPE"],
    }
    policy = json.loads((Path(__file__).resolve().parents[2] / "config/ci-governance.json").read_text())
    verify_deployment(api, request, policy)
    intent = Path(env["RUNNER_TEMP"]) / "deployment-security-request.json"
    # The x-mode refuses a repeated invocation within the same job, including
    # uncertain dispatch. A new workflow attempt gets its own request.
    with intent.open("x", encoding="utf-8") as output:
        json.dump({"state": "dispatching", "request": request}, output, indent=2)
    intent.chmod(0o600)
    response = api(f"repos/{REPOSITORY}/actions/workflows/deployment-security.yml/dispatches",
                   {"ref": "main",
                    "inputs": {"source_request": json.dumps(request, sort_keys=True)}})
    identifier = positive(response.get("workflow_run_id"), "broker dispatch")
    url = f"https://github.com/{REPOSITORY}/actions/runs/{identifier}"
    require(response.get("html_url") == url, "Security dispatch outcome is uncertain; inspect before retry")
    intent.write_text(json.dumps({"state": "dispatched", "request": request,
                                  "broker_run_id": identifier, "url": url}, indent=2))
    print(f"Deployment security: {url}")
    deadline = monotonic() + 300
    while monotonic() < deadline:
        run = api(f"repos/{REPOSITORY}/actions/runs/{identifier}")
        if run.get("status") == "completed":
            from types import SimpleNamespace

            return consume_broker(SimpleNamespace(read=api), request, identifier, policy)
        require(run.get("status") in {"queued", "pending", "waiting", "requested", "in_progress"},
                "Security broker state is unavailable")
        verify_deployment(api, request, policy)
        sleep(10)
    raise Refused(f"Deployment security is still pending: {url}; no mutation admitted")


def main() -> int:
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request-broker", action="store_true")
    args = parser.parse_args()
    try:
        env = dict(os.environ)
        if args.request_broker:
            receipt = request_broker(env)
        else:
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
