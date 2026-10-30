#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Qualify an exact UAT CI attempt using Main-owned release authority.

This read-only verifier grants no deployment authority by itself. The caller
must recheck the selected source and release state under the mutation lock.
Reviewed application and test code use the existing protected-branch trust model.
Privileged release execution and credential clearance remain Main-owned. This
verifier does not claim to sandbox malicious reviewed application code.
"""

from __future__ import annotations

import json
import os
import re
import runpy
import tomllib
from datetime import datetime
from pathlib import Path

from github_security_authority import GitHub, Refused, verify_source
from process_group import BoundedReadError, bounded_stdout

REPOSITORY = "hushh-labs/hushh-research"
SHA = re.compile(r"[0-9a-f]{40}")
MAX_TREE_BYTES = 4 * 1024 * 1024

# Fail closed when a UAT candidate changes CI or release execution authority.
# The Main-owned UAT workflow consumes Cloud Build recipes under deploy/ and
# invokes a small set of candidate migration controllers with database access.
# Those controllers remain reviewed Main authority; migration manifests and SQL
# remain candidate content. Application source need not match Main.
AUTHORITY_PATHS = (
    ".agents",
    ".github",
    "bin",
    "scripts",
    "deploy",
    "consent-protocol/.github",
    "consent-protocol/scripts",
    "consent-protocol/db/migrate.py",
    "consent-protocol/db/migration_authority.py",
    "consent-protocol/db/dev_migration_manifest.py",
    "consent-protocol/hushh_mcp/services/hushh_tech_uat_database_attestation.py",
    "hushh-webapp/scripts",
    "hushh-webapp/playwright.config.ts",
    "hushh-webapp/vitest.config.ts",
    "hushh-webapp/__tests__/setup.ts",
    "packages/hushh-mcp/scripts",
    "deploy/mail-api/test",
    "config/ci-governance.json",
)
MANIFEST_FILES = (
    "hushh-webapp/package.json", "packages/hushh-mcp/package.json",
    "deploy/mail-api/package.json", "consent-protocol/pyproject.toml",
)

REQUIRED_JOBS = {
    "Secret Scan",
    "DCO",
    "Governance",
    "Path filters",
    "UI Contracts",
    "Preflight Gate",
    "Web Core (Next.js)",
    "Web Editor Performance (macOS)",
    "iOS Native (Xcode)",
    "Android Native (Gradle)",
    "Protocol (Python)",
    "MCP Package",
    "Integration",
    "Branch Validation Gate",
    *(f"Protocol Database ({index}/2)" for index in (1, 2)),
    *(f"Web Full Suite (Vitest) {index}/3" for index in (1, 2, 3)),
    "Web Targeted Contracts (node)",
    *(f"Web Targeted Contracts (browser-{index}-of-4)" for index in (1, 2, 3, 4)),
}


def require(value: object, message: str) -> None:
    if not value:
        raise Refused(message)


def git(*arguments: str) -> bytes:
    try:
        return bounded_stdout(["git", *arguments], max_bytes=MAX_TREE_BYTES, timeout=30)
    except (BoundedReadError, OSError):
        raise Refused("Git authority lookup failed") from None


def verify_invocation_authority(candidate: str, authority: str) -> None:
    """Allow reviewed dependencies/tests; protect commands that own their execution."""
    for path in MANIFEST_FILES:
        def invocation(source: str):
            raw = git("show", f"{source}:{path}")
            if path.endswith(".toml"):
                return tomllib.loads(raw.decode()).get("tool", {}).get("pytest", {})
            return json.loads(raw).get("scripts", {})
        require(invocation(candidate) == invocation(authority),
                "UAT test invocation differs from reviewed Main authority")


def verify_git_authority(candidate: str, base: str, authority: str, *, current: bool = True) -> str:
    require(
        all(SHA.fullmatch(value) for value in (candidate, base, authority)),
        "Full immutable SHAs are required",
    )
    if current:
        git("fetch", "--no-tags", "origin", "main", "uat")
        require(git("rev-parse", "origin/uat").decode().strip() == candidate,
                "UAT tip changed; qualify the current protected candidate")
    git("merge-base", "--is-ancestor", authority, "origin/main")
    git("merge-base", "--is-ancestor", base, candidate)
    for source in (candidate, authority):
        git("cat-file", "-e", f"{source}^{{commit}}")
    expected = git("ls-tree", "-r", "--full-tree", authority, "--", *AUTHORITY_PATHS)
    observed = git("ls-tree", "-r", "--full-tree", candidate, "--", *AUTHORITY_PATHS)
    require(
        bool(expected) and observed == expected,
        "UAT CI authority differs from reviewed Main",
    )
    verify_invocation_authority(candidate, authority)
    tree = git("rev-parse", f"{candidate}^{{tree}}").decode().strip()
    require(SHA.fullmatch(tree), "UAT application tree is invalid")
    return tree


def verify_serving_bases(
    base: str, scope: str, backend: str, frontend: str
) -> dict[str, str]:
    """Require the tested base to match every selected, independently observed service.

    The caller must obtain these values from authenticated 100%-traffic serving
    revisions and re-read them under the release lock; caller input alone is not
    proof of a live service.
    """
    require(SHA.fullmatch(base), "Full UAT serving-base SHA is required")
    require(
        scope in {"backend", "frontend", "all"}, "Resolved service scope is required"
    )
    observed = {"backend": backend, "frontend": frontend}
    selected = ("backend", "frontend") if scope == "all" else (scope,)
    result = {name: observed[name] for name in selected}
    require(
        all(SHA.fullmatch(value or "") and value == base for value in result.values()),
        "Selected UAT services do not share the qualified serving base",
    )
    return result


def require_protected_tip(api: GitHub, candidate: str) -> None:
    branch = api.read(f"repos/{REPOSITORY}/branches/uat")
    require(branch.get("protected") is True and branch.get("commit", {}).get("sha") == candidate,
            "The protected UAT candidate changed during admission")


def live_serving_bases(scope: str) -> dict[str, dict[str, str]]:
    """Read actual 100%-traffic revisions with the admitted UAT workload identity."""
    require(scope in {"all", "backend", "frontend"}, "Resolved UAT scope is required")
    resolve = runpy.run_path(str(Path(__file__).with_name("resolve-cloud-run-serving-state.py")))["resolve_serving_state"]
    result = {}
    for name, service in {"backend": "consent-protocol", "frontend": "hushh-webapp"}.items():
        if scope not in {"all", name}:
            continue
        command = ["gcloud", "run", "services", "describe", service,
                   "--project=hushh-pda-uat", "--region=us-central1", "--format=json(status)"]
        observed = json.loads(bounded_stdout(command, max_bytes=65536, timeout=30))
        revision = resolve(observed).revision
        require(re.fullmatch(re.escape(service) + r"-[a-z0-9-]{1,63}", revision), "UAT revision identity is invalid")
        command = ["gcloud", "run", "revisions", "describe", revision,
                   "--project=hushh-pda-uat", "--region=us-central1", "--format=value(metadata.labels.deploy-sha)"]
        sha = bounded_stdout(command, max_bytes=128, timeout=30).decode().strip()
        require(SHA.fullmatch(sha), "Serving UAT source identity is unavailable")
        result[name] = {"sha": sha, "revision": revision}
    return result


def _started(run: dict) -> tuple[datetime, int]:
    try:
        started = datetime.fromisoformat(run["run_started_at"].replace("Z", "+00:00"))
        updated = datetime.fromisoformat(run["updated_at"].replace("Z", "+00:00"))
        require(
            started.tzinfo is not None
            and updated.tzinfo is not None
            and updated >= started
            and type(run["id"]) is int,
            "CI chronology is invalid",
        )
        return started, run["id"]
    except (KeyError, TypeError, ValueError):
        raise Refused("CI chronology is unavailable") from None


def _exact_candidate_job(jobs, base):
    legacy_name = f"Exact UAT Candidate ({base})"
    matches = [
        job for job in jobs if job.get("name") in {"Exact UAT Candidate", legacy_name}
    ]
    require(
        len(matches) == 1,
        "UAT CI did not complete its exact-source and aggregate gates",
    )
    return matches[0]



def _verify_run_jobs(api, run, candidate, base, run_id, attempt):
    prefix = f"repos/{REPOSITORY}/actions"
    inventory = api.read(f"{prefix}/runs/{run_id}/attempts/{attempt}/jobs?per_page=100")
    jobs = inventory.get("jobs")
    require(
        isinstance(jobs, list)
        and type(inventory.get("total_count")) is int
        and inventory["total_count"] == len(jobs) <= 100,
        "UAT CI job inventory is incomplete",
    )
    exact_job = _exact_candidate_job(jobs, base)
    for name in REQUIRED_JOBS:
        matches = [job for job in jobs if job.get("name") == name]
        require(
            len(matches) == 1
            and matches[0].get("run_id") == run_id
            and matches[0].get("head_sha") == candidate
            and matches[0].get("status") == "completed"
            and matches[0].get("conclusion") == "success",
            "UAT CI did not complete its exact-source and aggregate gates",
        )
        required_step = None
        if name.startswith("Web Targeted Contracts ("):
            required_step = "Run targeted web contract checks"
        elif name.startswith("Protocol Database ("):
            required_step = "Run serial database contracts"
        elif name == "Integration":
            required_step = "Resolve change-aware verification plan"
        if required_step:
            steps = matches[0].get("steps", [])
            verified = [step for step in steps if step.get("name") == required_step]
            require(
                len(verified) == 1 and verified[0].get("conclusion") == "success",
                "A required UAT CI step was not verified",
            )
    require(
        exact_job.get("run_id") == run_id
        and exact_job.get("head_sha") == candidate
        and exact_job.get("status") == "completed"
        and exact_job.get("conclusion") == "success",
        "UAT CI did not complete its exact-source and aggregate gates",
    )
    exact_steps = [
        step
        for step in exact_job.get("steps", [])
        if step.get("name") == "Verify the exact UAT checkout"
    ]
    require(
        len(exact_steps) == 1 and exact_steps[0].get("conclusion") == "success",
        "A required UAT CI step was not verified",
    )
    gate = next(job for job in jobs if job["name"] == "Branch Validation Gate")
    check_url = gate.get("check_run_url", "")
    match = re.fullmatch(
        rf"https://api\.github\.com/repos/{re.escape(REPOSITORY)}/check-runs/([1-9][0-9]*)",
        check_url,
    )
    require(match is not None, "UAT aggregate check identity is unavailable")
    check = api.read(f"repos/{REPOSITORY}/check-runs/{match[1]}")
    require(
        check.get("name") == "Branch Validation Gate"
        and check.get("head_sha") == candidate
        and check.get("status") == "completed"
        and check.get("conclusion") == "success"
        and check.get("app", {}).get("id") == 15368
        and check.get("app", {}).get("slug") == "github-actions"
        and type(run.get("check_suite_id")) is int
        and run["check_suite_id"] > 0
        and check.get("check_suite", {}).get("id") == run["check_suite_id"],
        "UAT aggregate check producer is invalid",
    )



def _latest_attempt_inventory(api, candidate, run_id):
    prefix = f"repos/{REPOSITORY}/actions"
    inventory_path = f"{prefix}/workflows/ci.yml/runs?branch=uat&event=workflow_dispatch&head_sha={candidate}&per_page=100"
    rows = api.read(inventory_path)
    runs = rows.get("workflow_runs")
    require(
        isinstance(runs, list)
        and type(rows.get("total_count")) is int
        and rows["total_count"] == len(runs) <= 100,
        "UAT CI run inventory is incomplete",
    )
    relevant = [
        item
        for item in runs
        if item.get("head_sha") == candidate and item.get("head_branch") == "uat"
    ]
    attempts = []
    for item in relevant:
        identifier, current_attempt = item.get("id"), item.get("run_attempt")
        require(
            type(identifier) is int and identifier > 0
            and type(current_attempt) is int and current_attempt > 0,
            "UAT CI attempt identity is unavailable",
        )
        observed = api.read(f"{prefix}/runs/{identifier}/attempts/{current_attempt}")
        require(
            observed.get("id") == identifier and observed.get("run_attempt") == current_attempt
            and observed.get("head_sha") == candidate and observed.get("head_branch") == "uat",
            "UAT CI attempt chronology belongs to another source",
        )
        attempts.append(observed)
    require(
        attempts and max(attempts, key=_started).get("id") == run_id,
        "A newer UAT CI attempt superseded this evidence",
    )
    return inventory_path, rows


def verify_attempt(
    api: GitHub, candidate: str, base: str, run_id: int, attempt: int
) -> dict:
    require(SHA.fullmatch(candidate), "Full application SHA is required")
    require(SHA.fullmatch(base), "Full UAT serving-base SHA is required")
    require(
        type(run_id) is int and run_id > 0 and type(attempt) is int and attempt > 0,
        "CI pin is invalid",
    )
    source = verify_source(
        api.read,
        REPOSITORY,
        {"run_id": run_id, "attempt": attempt, "head_sha": candidate},
    )
    prefix = f"repos/{REPOSITORY}/actions"
    run = api.read(f"{prefix}/runs/{run_id}")
    require(
        run.get("event") == "workflow_dispatch"
        and run.get("head_branch") == "uat"
        and run.get("head_repository", {}).get("id") == source["repository_id"]
        and run.get("head_repository", {}).get("full_name") == REPOSITORY
        and run.get("status") == "completed"
        and run.get("conclusion") == "success",
        "UAT CI is not a successful exact-branch dispatch",
    )
    _verify_run_jobs(api, run, candidate, base, run_id, attempt)
    inventory_path, rows = _latest_attempt_inventory(api, candidate, run_id)
    current = verify_source(
        api.read,
        REPOSITORY,
        {"run_id": run_id, "attempt": attempt, "head_sha": candidate},
    )
    require(
        current == source
        and api.read(f"{prefix}/runs/{run_id}") == run
        and api.read(inventory_path) == rows,
        "UAT CI changed during verification",
    )
    return {"run_id": run_id, "run_attempt": attempt}



def verify_predecessor(prior: dict, *, current: bool) -> None:
    candidate = prior["sha"]
    tree = verify_git_authority(candidate, prior["base_sha"], prior["authority_sha"], current=current)
    require(tree == prior["tree"], "UAT predecessor tree changed")
    api = GitHub(REPOSITORY, os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN", ""))
    if current:
        require_protected_tip(api, candidate)
    verify_attempt(api, candidate, prior["base_sha"], prior["run_id"], prior["run_attempt"])
    if current:
        require_protected_tip(api, candidate)


def issue_predecessor(args) -> dict:
    require(args.environment == "uat", "Direct CI admission is UAT-only")
    require(args.scope in {"all", "backend", "frontend"}, "Resolved UAT scope is required")
    services = {"backend", "frontend"} if args.scope == "all" else {args.scope}
    verify_serving_bases(args.base_sha, args.scope, args.backend_base_sha, args.frontend_base_sha)
    serving = live_serving_bases(args.scope)
    require(all(value["sha"] == args.base_sha for value in serving.values()),
            "Actual UAT serving baseline changed before mutation")
    record = {"schema_version": 1, "kind": "uat-exact-ci", "status": "accepted", "environment": "uat",
              "repository": REPOSITORY, "sha": args.sha, "base_sha": args.base_sha,
              "authority_sha": args.authority_sha, "services": sorted(services), "serving": serving,
              "run_id": args.ci_run_id, "run_attempt": args.ci_attempt,
              "tree": verify_git_authority(args.sha, args.base_sha, args.authority_sha)}
    verify_predecessor(record, current=True)
    if args.predecessor is not None:
        require(record == json.loads(args.predecessor.read_text()), "Direct UAT admission changed before mutation")
    return record
