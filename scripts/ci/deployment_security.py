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
from github_team_authority import LOGIN, TEAM_IDS, read_teams, team_reader

REPOSITORY = "hushh-labs/hushh-research"
BROKER_PATH = ".github/workflows/deployment-security.yml"
IMPLEMENTATIONS = {
    name: f".github/workflows/deploy-{name}-implementation.yml"
    for name in ("dev", "uat")
}
CALLERS = {
    "deploy-dev.yml",
    "deploy-uat.yml",
    "deploy-production.yml",
    "deploy-personal-backend.yml",
    "validate-plg-frontend-source.yml",
    "release-ios-appstore.yml",
    "ship-ios-testflight.yml",
    "ship-android-playstore-v1.yml",
    "publish-hushh-mcp.yml",
    "rollback.yml",
}


def verify_run(read, env: dict, *, broker: bool = False) -> dict:
    repository = env.get("GITHUB_REPOSITORY")
    workflow = env.get("GITHUB_WORKFLOW_REF", "")
    path = workflow.removeprefix(REPOSITORY + "/").removesuffix("@refs/heads/main")
    if (
        repository != REPOSITORY
        or env.get("GITHUB_REF") != "refs/heads/main"
        or env.get("GITHUB_EVENT_NAME") != "workflow_dispatch"
        or workflow != f"{REPOSITORY}/{path}@refs/heads/main"
        or path
        not in (
            {BROKER_PATH}
            if broker
            else {f".github/workflows/{name}" for name in CALLERS}
        )
        or not SHA.fullmatch(env.get("GITHUB_SHA", ""))
    ):
        raise Refused("Deployment security requires an explicit Main-owned release")
    run_id = positive(int(env["GITHUB_RUN_ID"]), "deployment run")
    attempt = positive(int(env["GITHUB_RUN_ATTEMPT"]), "deployment attempt")
    run = read(f"repos/{repository}/actions/runs/{run_id}")
    if (
        not isinstance(run, dict)
        or any(
            run.get(key) != value
            for key, value in {
                "id": run_id,
                "run_attempt": attempt,
                "head_sha": env["GITHUB_SHA"],
                "event": "workflow_dispatch",
                "status": "in_progress",
            }.items()
        )
        or run.get("path", "").split("@", 1)[0] != path
    ):
        raise Refused("Deployment run, attempt or workflow changed")
    if run.get("repository", {}).get("full_name") != repository:
        raise Refused("Deployment repository mismatch")
    return {
        "repository": repository,
        "run_id": run_id,
        "attempt": attempt,
        "workflow_path": path,
        "workflow_sha": env["GITHUB_SHA"],
    }


def verify_deployment_source(read, request: dict) -> dict:
    """Observe one active, immutable matching-branch source; grant no permission.

    Requested values are not authority: GitHub must independently establish the
    caller, current attempt, protected source and Main reusable implementation.
    No candidate code or artifact is executed beside the alert credential.
    """
    fields = {
        "run_id",
        "attempt",
        "caller_sha",
        "application_sha",
        "environment",
        "requested_scope",
        "tooling_sha",
    }
    if not isinstance(request, dict) or set(request) not in (
        fields,
        fields | {"application_branch"},
    ):
        raise Refused("Deployment security request fields are incomplete or unknown")
    environment = request["environment"]
    if (
        not isinstance(environment, str)
        or environment not in IMPLEMENTATIONS
        or request["requested_scope"]
        not in {
            "auto",
            "all",
            "backend",
            "frontend",
        }
    ):
        raise Refused("Broker only accepts explicit Dev/UAT deployment scopes")
    application_branch = request.get("application_branch", environment)
    if application_branch != environment and (environment, application_branch) != (
        "uat",
        "uat-isolated",
    ):
        raise Refused("Deployment application branch is not governed")
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
    expected = {
        "id": run_id,
        "run_attempt": attempt,
        "head_sha": request["caller_sha"],
        "head_branch": environment,
        "event": "workflow_dispatch",
        "status": "in_progress",
        "workflow_id": workflow_id,
    }
    if (
        workflow.get("path") != path
        or any(run.get(k) != v for k, v in expected.items())
        or run.get("path", "").split("@", 1)[0] != path
        or any(
            run.get(key, {}).get("id") != repository_id
            or run.get(key, {}).get("full_name") != REPOSITORY
            for key in ("repository", "head_repository")
        )
    ):
        raise Refused("Source deployment identity or attempt is not admitted")
    implementation = f"{REPOSITORY}/{IMPLEMENTATIONS[environment]}"
    references = run.get("referenced_workflows")
    if (
        not isinstance(references, list)
        or len(references) > 20
        or not all(isinstance(item, dict) for item in references)
    ):
        raise Refused("Trusted deployment implementation inventory is unavailable")
    matches = [
        item
        for item in references
        if isinstance(item.get("path"), str)
        and item["path"].split("@", 1)[0] == implementation
    ]
    if (
        len(matches) != 1
        or matches[0].get("sha") != request["tooling_sha"]
        or matches[0].get("ref") != "refs/heads/main"
        or matches[0]["path"]
        not in {
            f"{implementation}@main",
            f"{implementation}@refs/heads/main",
            f"{implementation}@{request['tooling_sha']}",
        }
    ):
        raise Refused("Source does not use the recorded Main deployment implementation")
    if application_branch == "uat-isolated":
        selected = read(f"{prefix}/branches/uat-isolated")
        if (
            not isinstance(selected, dict)
            or selected.get("protected") is not True
            or selected.get("commit", {}).get("sha") != request["application_sha"]
        ):
            raise Refused("Deployment requires the protected isolated UAT tip")
    for revision, branch in (
        (request["tooling_sha"], "main"),
        (request["application_sha"], application_branch),
    ):
        comparison = read(f"{prefix}/compare/{revision}...{branch}?per_page=1&page=2")
        if (
            comparison.get("status") not in {"identical", "ahead"}
            or comparison.get("merge_base_commit", {}).get("sha") != revision
        ):
            raise Refused("Deployment source is outside its protected branch history")
    return {
        **request,
        "repository": REPOSITORY,
        "repository_id": repository_id,
        "workflow_path": path,
        "workflow_id": workflow_id,
        "caller_branch": environment,
        "implementation_path": IMPLEMENTATIONS[environment],
    }


def verify_deployment(read, request: dict, policy: dict, *, operators=None) -> dict:
    """Retained roster-based contract for historical receipt consumers."""
    source = verify_deployment_source(read, request)
    allowed = set(
        policy[source["environment"]]["manual_dispatch_users"]
        if operators is None else operators
    )
    run = read(f"repos/{REPOSITORY}/actions/runs/{source['run_id']}")
    if (
        run.get("id") != source["run_id"]
        or run.get("run_attempt") != source["attempt"]
        or run.get("head_sha") != source["caller_sha"]
        or any(run.get(key, {}).get("login") not in allowed
               for key in ("actor", "triggering_actor"))
    ):
        raise Refused("Source deployment identity, attempt or operator is not admitted")
    return source


def release_authorization_binding(read, source: dict, *, producer=None) -> dict:
    """Expected operation identity, not permission to execute it.

    Membership is established only by the protected producer. A consumer must
    first verify that producer and its immutable artifact before using this
    binding to check the captured decision against GitHub's current source run.
    """
    caller = Path(source["workflow_path"]).name
    surface, environment = {
        "deploy-dev.yml": ("dev", "dev"),
        "deploy-uat.yml": ("uat", "uat"),
        "deploy-personal-backend.yml": ("uat", "uat"),
        "deploy-production.yml": ("production", "production"),
        "ship-ios-testflight.yml": ("uat", "native"),
        "release-ios-appstore.yml": ("production", "native"),
        "ship-android-playstore-v1.yml": ("production", "native"),
        "publish-hushh-mcp.yml": ("production", "package"),
        "validate-plg-frontend-source.yml": ("production", "validation"),
        "rollback.yml": (source["environment"], source["environment"]),
    }.get(caller, (None, None))
    if (
        surface not in {"dev", "uat", "production"}
        or source["environment"] != environment
        or (caller == "rollback.yml" and surface not in {"uat", "production"})
    ):
        raise Refused("Release caller does not establish its deployment capability")
    team = f"deploy-{surface}"
    run = read(f"repos/{REPOSITORY}/actions/runs/{source['run_id']}")
    if (
        run.get("id") != source["run_id"]
        or run.get("run_attempt") != source["attempt"]
        or run.get("head_sha") != source.get("caller_sha", source.get("workflow_sha"))
        or run.get("status") != "in_progress"
        or run.get("event") != "workflow_dispatch"
        or run.get("path", "").split("@", 1)[0] != source["workflow_path"]
    ):
        raise Refused("Release operator observation belongs to another source attempt")
    principals = {}
    for key in ("actor", "triggering_actor"):
        user = run.get(key, {})
        if (
            user.get("type") != "User"
            or not LOGIN.fullmatch(str(user.get("login", "")))
            or type(user.get("id")) is not int
            or user["id"] <= 0
        ):
            raise Refused(
                "Release operator or rerunner is not a current deployment-team member"
            )
        principals[key] = {"id": user["id"], "login": user["login"]}
    return {
        "schema_version": 1,
        "team": team,
        "team_id": TEAM_IDS[team],
        "source": source,
        "producer": producer or source,
        **principals,
    }


def authorize_release(read, source: dict, teams: dict, *, producer=None) -> dict:
    """Only the protected Main producer grants current deployment-team access."""
    decision = release_authorization_binding(read, source, producer=producer)
    if any(
        decision[key]["login"] not in teams[decision["team"]]
        for key in ("actor", "triggering_actor")
    ):
        raise Refused("Release operator or rerunner is not a current deployment-team member")
    return decision


def forwarded_authorization(receipt: dict, env: dict) -> dict:
    """Carry verified Main authority through trusted workflow job outputs only."""
    authorization = receipt.get("authorization")
    if receipt.get("verdict") != "clear" or not isinstance(authorization, dict):
        raise Refused("Current release jobs require modern Main authorization")
    repository_id = positive(int(env["GITHUB_REPOSITORY_ID"]), "repository identity")
    if receipt["source"].get("repository_id", repository_id) != repository_id:
        raise Refused("Release authorization repository identity changed")
    return {
        "schema_version": 1,
        "repository_id": repository_id,
        "authorization": authorization,
    }


def verify_forwarded_authorization(env: dict, raw: str, surface: str, actor: str) -> None:
    """Validate a trusted Main DAG binding, not a portable bearer credential.

    Main assigns this value directly from the protected producer or verified
    requester output. Workflow inputs and candidate files are never issuers.
    Keep this assertion before candidate code and cloud credentials.
    """
    if (
        env.get("GITHUB_ACTIONS") != "true"
        or env.get("GITHUB_REPOSITORY") != REPOSITORY
        or not raw or len(raw) > 64 * 1024
    ):
        raise Refused("Release authorization requires a trusted Main job output")
    document = json.loads(raw)
    decision = document["authorization"]
    source = decision["source"]
    team = f"deploy-{surface}"
    original, rerunner = decision["actor"], decision["triggering_actor"]
    if (
        document.get("schema_version") != 1
        or positive(document.get("repository_id"), "repository identity")
        != positive(int(env["GITHUB_REPOSITORY_ID"]), "repository identity")
        or decision.get("schema_version") != 1
        or decision.get("team") != team
        or decision.get("team_id") != TEAM_IDS[team]
        or source.get("repository") != REPOSITORY
        or source.get("run_id") != int(env["GITHUB_RUN_ID"])
        or source.get("attempt") != int(env["GITHUB_RUN_ATTEMPT"])
        or source.get("caller_sha", source.get("workflow_sha")) != env["GITHUB_SHA"]
        or env.get("GITHUB_WORKFLOW_REF")
        != f"{REPOSITORY}/{source['workflow_path']}@{env['GITHUB_REF']}"
        or source.get("application_sha") != env.get("RELEASE_APPLICATION_SHA")
        or not SHA.fullmatch(str(source.get("application_sha", "")))
        or original.get("login") != env.get("GITHUB_ACTOR")
        or positive(original.get("id"), "original operator") != int(env["GITHUB_ACTOR_ID"])
        or rerunner.get("login") != env.get("GITHUB_TRIGGERING_ACTOR")
        or actor not in {original.get("login"), rerunner.get("login")}
    ):
        raise Refused("Release authorization does not match this job, role or attempt")
    positive(rerunner.get("id"), "rerun operator")
    if "tooling_sha" in source and source["tooling_sha"] != env.get("RELEASE_TOOLING_SHA"):
        raise Refused("Release authorization does not match the Main implementation")
    producer = decision["producer"]
    if "tooling_sha" in source:
        if (
            producer.get("repository") != REPOSITORY
            or producer.get("workflow_path") != BROKER_PATH
            or not SHA.fullmatch(str(producer.get("workflow_sha", "")))
            or env["GITHUB_REF"] != f"refs/heads/{source['caller_branch']}"
        ):
            raise Refused("Release authorization has an invalid Main producer")
        positive(producer.get("run_id"), "Main producer run")
        positive(producer.get("attempt"), "Main producer attempt")
    elif producer != source or env["GITHUB_REF"] != "refs/heads/main":
        raise Refused("Release authorization has an invalid inline Main producer")


def produce(env: dict, source_read, alert_read) -> dict:
    if env.get("GITHUB_WORKFLOW_REF") == f"{REPOSITORY}/{BROKER_PATH}@refs/heads/main":
        return produce_broker(env, source_read, alert_read)
    if env.get("DEPLOY_SECURITY_REQUEST"):
        raise Refused("Cross-run requests require the Main-owned broker")
    admission = verify_run(source_read, env)
    reference = env.get("DEPLOY_SECURITY_REF", "")
    if not reference or len(reference) > 200 or any(c.isspace() for c in reference):
        raise Refused("Deployment needs a bounded application reference")
    commit = source_read(f"repos/{REPOSITORY}/commits/{quote(reference, safe='')}")
    sha = commit.get("sha") if isinstance(commit, dict) else None
    if not isinstance(sha, str) or not SHA.fullmatch(sha):
        raise Refused("Application reference could not be resolved")
    environment = env.get("DEPLOY_SECURITY_ENVIRONMENT")
    if environment not in {
        "dev",
        "uat",
        "production",
        "native",
        "package",
        "validation",
    }:
        raise Refused("Unknown deployment environment")
    scope = env.get("DEPLOY_SECURITY_SCOPE", "all")
    if scope not in {
        "auto",
        "all",
        "backend",
        "frontend",
        "native",
        "package",
        "validation",
    }:
        raise Refused("Unknown deployment scope")
    repo = source_read(f"repos/{REPOSITORY}")
    if not isinstance(repo, dict) or repo.get("full_name") != REPOSITORY:
        raise Refused("Repository identity unavailable")
    repo_id = positive(repo.get("id"), "repository identity")
    source = {
        **admission,
        "application_sha": sha,
        "environment": environment,
        "requested_scope": scope,
    }
    members = team_reader(env.get("CI_TEAM_MEMBERS_TOKEN", ""))
    authorization = authorize_release(source_read, source, read_teams(members))
    secrets = inventory(alert_read, REPOSITORY, "secret-scanning", repo_id)
    dependencies = inventory(alert_read, REPOSITORY, "dependabot", repo_id)
    # A later attempt cannot inherit the result while the inventory is read.
    if (
        verify_run(source_read, env) != admission
        or authorize_release(source_read, source, read_teams(members)) != authorization
    ):
        raise Refused("Deployment authority changed during alert inventory")
    return {
        "schema_version": 1,
        "source": source,
        "authorization": authorization,
        "recorded_at": datetime.now(timezone.utc).isoformat(),
        "secret_scanning": secrets,
        "dependabot": dependencies,
        "verdict": "clear" if secrets["open"] == 0 else "blocked",
    }


def produce_broker(
    env: dict, source_read, alert_read, *, policy: dict | None = None
) -> dict:
    producer = verify_run(source_read, env, broker=True)
    raw = env.get("DEPLOY_SECURITY_REQUEST", "")
    if not raw or len(raw) > 4096:
        raise Refused("Broker needs one bounded deployment request")
    request = json.loads(raw)
    members = team_reader(env.get("CI_TEAM_MEMBERS_TOKEN", ""))
    teams = read_teams(members)
    source = verify_deployment_source(source_read, request)
    authorization = authorize_release(source_read, source, teams, producer=producer)
    secrets = inventory(
        alert_read, REPOSITORY, "secret-scanning", source["repository_id"]
    )
    dependencies = inventory(
        alert_read, REPOSITORY, "dependabot", source["repository_id"]
    )
    current_teams = read_teams(members)
    if (
        verify_deployment_source(source_read, request) != source
        or verify_run(source_read, env, broker=True) != producer
        or authorize_release(source_read, source, current_teams, producer=producer)
        != authorization
    ):
        raise Refused("Deployment or broker authority changed during alert inventory")
    return {
        "schema_version": 2,
        "source": source,
        "producer": producer,
        "authorization": authorization,
        "recorded_at": datetime.now(timezone.utc).isoformat(),
        "secret_scanning": secrets,
        "dependabot": dependencies,
        "verdict": "clear" if secrets["open"] == 0 else "blocked",
    }


def consume_broker(api, request: dict, broker_run_id: int, policy: dict | None = None) -> dict:
    """Verify an exact broker result; its green aggregate alone is insufficient."""
    from github_security_receipt import archive_read, require, timestamp, unpack

    source = verify_deployment_source(api.read, request)
    prefix = f"repos/{REPOSITORY}/actions"
    identifier = positive(broker_run_id, "broker run")
    run = api.read(f"{prefix}/runs/{identifier}")
    workflow = api.read(f"{prefix}/workflows/deployment-security.yml")
    attempt = positive(run.get("run_attempt"), "broker attempt")
    main_sha = run.get("head_sha", "")
    require(
        isinstance(main_sha, str)
        and SHA.fullmatch(main_sha) is not None
        and run.get("id") == identifier
        and workflow.get("path") == BROKER_PATH
        and run.get("workflow_id") == positive(workflow.get("id"), "broker workflow")
        and run.get("path", "").split("@", 1)[0] == BROKER_PATH
        and run.get("head_branch") == "main"
        and run.get("event") == "workflow_dispatch"
        and run.get("status") == "completed"
        and run.get("conclusion") == "success"
        and all(
            run.get(key, {}).get("id") == source["repository_id"]
            and run.get(key, {}).get("full_name") == REPOSITORY
            for key in ("repository", "head_repository")
        ),
        "Deployment security broker identity or outcome is unverified",
    )
    comparison = api.read(
        f"repos/{REPOSITORY}/compare/{main_sha}...main?per_page=1&page=2"
    )
    require(
        comparison.get("status") in {"identical", "ahead"}
        and comparison.get("merge_base_commit", {}).get("sha") == main_sha,
        "Deployment security broker revision is outside Main",
    )
    jobs = api.read(f"{prefix}/runs/{identifier}/attempts/{attempt}/jobs?per_page=100")
    rows = jobs.get("jobs", [])
    require(
        jobs.get("total_count") == len(rows) and 1 <= len(rows) <= 2
        and all(isinstance(row, dict) for row in rows),
        "Deployment security job inventory is incomplete",
    )
    expected = {"Verify repository secret clearance": "success"}
    if any(row.get("name") == "Verify live team authority" for row in rows):
        expected["Verify live team authority"] = "skipped"
    require(
        {row.get("name"): row.get("conclusion") for row in rows} == expected
        and all(
            row.get("run_id") == identifier
            and row.get("run_attempt") == attempt
            and row.get("status") == "completed"
            for row in rows
        ),
        "Deployment security broker job states are not qualified",
    )
    job = next(
        row for row in rows if row["name"] == "Verify repository secret clearance"
    )
    reported_steps = job.get("steps")
    require(
        isinstance(reported_steps, list) and len(reported_steps) <= 100
        and all(isinstance(step, dict) for step in reported_steps),
        "Deployment security step inventory is malformed",
    )
    steps = [
        step
        for step in reported_steps
        if step.get("name") == "Read protected repository inventory"
    ]
    if reported_steps:
        require(
            len(steps) == 1 and steps[0].get("conclusion") == "success"
            and not any(
                step.get("conclusion") in {"failure", "cancelled", "timed_out", "action_required"}
                for step in reported_steps
            ),
            "Deployment security inventory step did not pass on this attempt",
        )
    inventory_result = api.read(f"{prefix}/runs/{identifier}/artifacts?per_page=100")
    artifacts = inventory_result.get("artifacts", [])
    require(
        type(inventory_result.get("total_count")) is int
        and inventory_result["total_count"] == len(artifacts) <= 100,
        "Deployment security artifact inventory is incomplete",
    )
    matches = [
        item
        for item in artifacts
        if item.get("name") == f"deployment-security-{identifier}-{attempt}"
    ]
    require(len(matches) == 1, "Deployment security artifact is missing or ambiguous")
    artifact = matches[0]
    require(
        artifact.get("expired") is False
        and artifact.get("workflow_run", {}).get("id") == identifier
        and type(artifact.get("size_in_bytes")) is int
        and 0 < artifact["size_in_bytes"] <= 64 * 1024,
        "Deployment security artifact has invalid ownership or size",
    )
    raw = archive_read(positive(artifact.get("id"), "artifact identity"))
    require(
        len(raw) == artifact["size_in_bytes"],
        "Deployment security artifact size changed",
    )
    receipt = unpack(
        raw, artifact.get("digest", ""), filename="deployment-security.json"
    )
    require(
        receipt.get("schema_version") == 2
        and receipt.get("source") == source
        and receipt.get("producer")
        == {
            "repository": REPOSITORY,
            "run_id": identifier,
            "attempt": attempt,
            "workflow_path": BROKER_PATH,
            "workflow_sha": main_sha,
        }
        and receipt.get("verdict") == "clear",
        "Deployment security receipt binding mismatch",
    )
    for family in ("secret_scanning", "dependabot"):
        result = receipt.get(family, {})
        require(
            result.get("complete") is True
            and type(result.get("open")) is int
            and result["open"] >= 0,
            "Deployment security inventory is incomplete",
        )
    require(
        receipt["secret_scanning"]["open"] == 0, "Open secret alerts refuse deployment"
    )
    authorization = receipt.get("authorization")
    if authorization is not None:
        require(
            authorization == release_authorization_binding(
                api.read, source, producer=receipt["producer"]
            ),
            "Deployment security authorization binding mismatch",
        )
    else:
        require(
            isinstance(policy, dict),
            "Current release requests cannot use historical roster-only clearance",
        )
        require(
            verify_deployment(api.read, request, policy) == source,
            "Historical release operator is not admitted by its original contract",
        )
    # GitHub can omit all step rows even for a completed successful job.
    # Its exact Main-owned artifact already binds complete inventory and the
    # modern typed authorization to this attempt. Historical receipts retain
    # their original step-proof requirement; an empty/green aggregate alone
    # never grants clearance.
    require(
        bool(reported_steps) or authorization is not None,
        "Deployment security step metadata is unavailable without typed authorization",
    )
    require(
        timestamp(run["run_started_at"])
        <= timestamp(receipt["recorded_at"])
        <= timestamp(run["updated_at"])
        and timestamp(run["run_started_at"])
        <= timestamp(artifact["created_at"])
        <= timestamp(run["updated_at"]),
        "Deployment security receipt belongs to another attempt",
    )
    current = api.read(f"{prefix}/runs/{identifier}")
    require(
        all(
            current.get(key) == run.get(key)
            for key in (
                "id",
                "run_attempt",
                "head_sha",
                "workflow_id",
                "status",
                "conclusion",
            )
        ),
        "Deployment security broker changed during verification",
    )
    require(
        (verify_deployment(api.read, request, policy) if authorization is None
         else verify_deployment_source(api.read, request)) == source,
        "Deployment request changed during receipt verification",
    )
    return receipt


def request_broker(
    env: dict, *, api=None, monotonic=time.monotonic, sleep=time.sleep
) -> dict:
    """Dispatch once; a lost response is uncertain, never an automatic retry.

    The intent and returned run URL are retained by the caller's artifact step.
    This request process has only the ordinary Actions token, never the PAT.
    """
    from github_security_receipt import require

    if api is None:
        from release_cadence_github import api
    environment = env.get("DEPLOY_SECURITY_ENVIRONMENT", "")
    if (
        environment not in IMPLEMENTATIONS
        or env.get("GITHUB_REPOSITORY") != REPOSITORY
        or env.get("GITHUB_REF") != f"refs/heads/{environment}"
        or env.get("GITHUB_EVENT_NAME") != "workflow_dispatch"
    ):
        raise Refused("Security requests require matching-branch Dev/UAT dispatch")
    application_sha = env.get("DEPLOY_SECURITY_REF", "")
    if not SHA.fullmatch(application_sha):
        require(
            bool(application_sha)
            and len(application_sha) <= 200
            and not any(c.isspace() for c in application_sha),
            "Deployment requires a bounded application reference",
        )
        resolved = api(f"repos/{REPOSITORY}/commits/{quote(application_sha, safe='')}")
        application_sha = resolved.get("sha", "")
        require(
            isinstance(application_sha, str)
            and SHA.fullmatch(application_sha) is not None,
            "Deployment application reference is unresolved",
        )
    request = {
        "run_id": positive(int(env["GITHUB_RUN_ID"]), "deployment run"),
        "attempt": positive(int(env["GITHUB_RUN_ATTEMPT"]), "deployment attempt"),
        "caller_sha": env["GITHUB_SHA"],
        "tooling_sha": env["RELEASE_TOOLING_SHA"],
        "application_sha": application_sha,
        "environment": environment,
        "requested_scope": env["DEPLOY_SECURITY_SCOPE"],
    }
    application_branch = env.get("DEPLOY_SECURITY_APPLICATION_BRANCH")
    if application_branch and application_branch != environment:
        request["application_branch"] = application_branch
    verify_deployment_source(api, request)
    intent = Path(env["RUNNER_TEMP"]) / "deployment-security-request.json"
    # The x-mode refuses a repeated invocation within the same job, including
    # uncertain dispatch. A new workflow attempt gets its own request.
    with intent.open("x", encoding="utf-8") as output:
        json.dump({"state": "dispatching", "request": request}, output, indent=2)
    intent.chmod(0o600)
    response = api(
        f"repos/{REPOSITORY}/actions/workflows/deployment-security.yml/dispatches",
        {
            "ref": "main",
            "inputs": {"source_request": json.dumps(request, sort_keys=True)},
        },
    )
    identifier = positive(response.get("workflow_run_id"), "broker dispatch")
    url = f"https://github.com/{REPOSITORY}/actions/runs/{identifier}"
    require(
        response.get("html_url") == url,
        "Security dispatch outcome is uncertain; inspect before retry",
    )
    intent.write_text(
        json.dumps(
            {
                "state": "dispatched",
                "request": request,
                "broker_run_id": identifier,
                "url": url,
            },
            indent=2,
        )
    )
    print(f"Deployment security: {url}")
    deadline = monotonic() + 300
    while monotonic() < deadline:
        run = api(f"repos/{REPOSITORY}/actions/runs/{identifier}")
        if run.get("status") == "completed":
            from types import SimpleNamespace

            return consume_broker(
                SimpleNamespace(read=api), request, identifier
            )
        require(
            run.get("status")
            in {"queued", "pending", "waiting", "requested", "in_progress"},
            "Security broker state is unavailable",
        )
        verify_deployment_source(api, request)
        sleep(10)
    raise Refused(f"Deployment security is still pending: {url}; no mutation admitted")


def main() -> int:
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request-broker", action="store_true")
    args = parser.parse_args()
    try:
        env = dict(os.environ)
        request = json.loads(env.get("DEPLOY_SECURITY_REQUEST") or "{}")
        if request.get("kind") in {"queue", "operation"}:
            from github_team_authority import produce_queue_request, produce_operation_request
            api = GitHub(REPOSITORY, env.get("GH_TOKEN", ""))
            authority_producer = produce_queue_request if request["kind"] == "queue" else produce_operation_request
            receipt = authority_producer(env, api.read, request)
            with Path(env["RUNNER_TEMP"], "merge-authorization.json").open("x") as output:
                json.dump(receipt, output)
            print("Current merge permission verified; no secret scan, application or cloud mutation performed.")
            return 0
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
        print(
            f"Open secret alerts: {receipt['secret_scanning']['open']}; "
            f"dependency alerts: {receipt['dependabot']['open']} (advisory)."
        )
        if receipt["verdict"] != "clear":
            return 1
        with Path(env["GITHUB_OUTPUT"]).open("a", encoding="utf-8") as output:
            output.write(f"sha={receipt['source']['application_sha']}\n")
            output.write(f"attempt={receipt['source']['attempt']}\n")
            output.write("authorization=" + json.dumps(
                forwarded_authorization(receipt, env), separators=(",", ":")
            ) + "\n")
        return 0
    except (Refused, KeyError, TypeError, ValueError, OSError) as error:
        reason = (
            str(error) if isinstance(error, Refused) else "configuration unavailable"
        )
        print(f"Deployment security refused: {reason}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
