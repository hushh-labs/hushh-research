#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Qualify an exact UAT CI attempt using Main-owned release authority.

This read-only verifier grants no deployment authority by itself. The caller
must recheck the selected source and release state under the mutation lock.
Ordinary UAT application, tests and tooling use the protected-branch trust model.
Release orchestration and credential clearance remain Main-owned. This
verifier does not claim to sandbox malicious reviewed application code.
"""

from __future__ import annotations

import copy
import json
import os
import re
import runpy
import sys
import tomllib
from datetime import datetime
from pathlib import Path

from github_security_authority import GitHub, Refused, verify_source
from process_group import BoundedReadError, bounded_stdout

REPOSITORY = "hushh-labs/hushh-research"
SOURCE_BRANCHES = ("uat", "uat-isolated")
SHA = re.compile(r"[0-9a-f]{40}")
MAX_TREE_BYTES = 4 * 1024 * 1024
BACKEND_TEST_MANIFEST = "consent-protocol/scripts/test-ci.manifest.txt"

# Historical full CI parity remains readable for isolated/sandbox receipts.
# Ordinary UAT CD trusts protected-branch review without Main-content parity.
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
# Only these paths are taken from Main in a disposable CI checkout.
# Runtime build and migration inputs are never replaced in the candidate.
ISOLATED_CI_PATHS = (
    ".agents", ".github", "bin", "scripts/ci", "scripts/git", "scripts/ops",
    "consent-protocol/.github", "consent-protocol/scripts/ci",
    "consent-protocol/ops/monorepo/pre-push.sh",
    "consent-protocol/scripts/run-test-ci.sh",
    "consent-protocol/scripts/generate_capability_graph.py",
    "hushh-webapp/scripts", "hushh-webapp/playwright.config.ts",
    "hushh-webapp/vitest.config.ts", "hushh-webapp/__tests__/setup.ts",
    "packages/hushh-mcp/scripts", "deploy/mail-api/test", "config/ci-governance.json",
    "consent-protocol/config/database_connection_limits.json",
    "consent-protocol/tests/test_ci_status_gate_fails_closed.py",
    "consent-protocol/tests/test_deployment_security.py",
    "consent-protocol/tests/test_direct_uat_acceptance.py",
    "consent-protocol/tests/test_production_restoration_operation.py",
    "consent-protocol/tests/test_uat_deploy_no_traffic_contract.py",
    "consent-protocol/tests/test_uat_deploy_parallelism.py",
    "consent-protocol/tests/test_uat_application_selection.py",
    "consent-protocol/tests/test_uat_paused_drive_maintenance.py",
    "consent-protocol/tests/test_protected_document_release_contract.py",
    "consent-protocol/tests/test_account_deletion_release_workflow.py",
    "consent-protocol/tests/test_ci_path_filters_cover_lane_scripts.py",
    "consent-protocol/tests/test_ios_lane_path_filter_covers_native_test_surfaces.py",
    # The isolated checkout receives Main's portable .agents manifests.
    "consent-protocol/tests/test_memory_judge.py",
    "consent-protocol/tests/test_testflight_backend_provenance_runs_before_macos.py",
    "consent-protocol/tests/helpers/drive_worker_gcloud.py",
    "consent-protocol/tests/helpers/document_delivery_ci.py",
    "consent-protocol/tests/helpers/predecessor_acceptance.py",
    "consent-protocol/tests/helpers/plg_qualification.py",
    "consent-protocol/tests/helpers/plg_runtime.py",
    "deploy/iam/setup_nonproduction_github_wif.py",
)
ISOLATED_RELEASE_AUTHORITY_PATHS = (
    "deploy", ":(exclude)deploy/README.md", ":(exclude)deploy/iam/README.md",
    ":(exclude)deploy/iam/setup_nonproduction_github_wif.py",
    ":(exclude)deploy/personal-backend-image.cloudbuild.yaml",
    ":(exclude)deploy/mail-api/test",
    "scripts/deploy", "consent-protocol/db/migrate.py",
    "consent-protocol/db/migration_authority.py", "consent-protocol/db/dev_migration_manifest.py",
    "consent-protocol/db/connection.py",
    "consent-protocol/hushh_mcp/services/hushh_tech_uat_database_attestation.py",
    "consent-protocol/scripts/adopt_drive_permission_file_claims.py",
    "consent-protocol/scripts/ops/reconcile_google_drive_uat_connector.py",
    "scripts/ops/db_migration_release_guard.py",
    "scripts/ops/email_auth_uat_release.py",
)
# Privileged-input comparison retained for explicit Dev and legacy consumers.
# Ordinary UAT CD no longer calls this comparison; isolated policy remains separate.
UAT_PRIVILEGED_PATHS = (
    "deploy/backend.cloudbuild.yaml", "deploy/backend-image.cloudbuild.yaml",
    "deploy/frontend.cloudbuild.yaml", "deploy/frontend-image.cloudbuild.yaml",
    "deploy/drive", "deploy/email-auth", "deploy/sso", "deploy/plg/bind_secrets.sh",
    "scripts/deploy", "consent-protocol/db/migrate.py", "consent-protocol/db/migration_authority.py",
    "consent-protocol/db/dev_migration_manifest.py", "consent-protocol/db/connection.py",
    "consent-protocol/hushh_mcp/services/hushh_tech_uat_database_attestation.py",
    "consent-protocol/scripts/adopt_drive_permission_file_claims.py",
    "consent-protocol/scripts/ops/reconcile_google_drive_uat_connector.py",
    "scripts/ops/db_migration_release_guard.py", "scripts/ops/email_auth_uat_release.py",
    "consent-protocol/db/private_agent_adoption.py",
    "consent-protocol/db/hosted_custody_adoption.py",
    "consent-protocol/db/attempt_email_adoption.py",
    "consent-protocol/db/hosted_custody_qualification.py",
    "consent-protocol/db/hosted_custody_acl.py",
    "consent-protocol/db/private_agent_adoption_successors.py",
    "consent-protocol/db/firebase_erasure_adoption.py",
    "consent-protocol/db/legacy_cloud_removal_adoption.py",
    "consent-protocol/db/referral_prize_activation.py",
    "scripts/ops/validate_receipt_logo_template.py",
)

MANIFEST_FILES = (
    "hushh-webapp/package.json", "packages/hushh-mcp/package.json",
    "deploy/mail-api/package.json", "consent-protocol/pyproject.toml",
)

LEGACY_REQUIRED_JOBS = {
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
UNIT_JOB = "Web Unit Contracts"
UNIT_SHARDS = ("1/1", "1/3", "2/3", "3/3")
REQUIRED_JOBS = {
    name for name in LEGACY_REQUIRED_JOBS
    if name != "Web Editor Performance (macOS)"
    and not name.startswith("Web Full Suite (Vitest)")
    and not name.startswith("Web Targeted Contracts (browser-")
} | {UNIT_JOB}
PRE_BROWSER_REMOVAL_JOBS = REQUIRED_JOBS | {"Web Targeted Contracts (browser)", "Protected Document WebKit (macOS)"}
OPTIONAL_NATIVE = {"iOS Native (Xcode)", "Android Native (Gradle)"}
AGGREGATE_JOBS = {"Preflight Gate", "Branch Validation Gate"}



def require(value: object, message: str) -> None:
    if not value:
        raise Refused(message)


def git(*arguments: str) -> bytes:
    try:
        return bounded_stdout(["git", *arguments], max_bytes=MAX_TREE_BYTES, timeout=30)
    except (BoundedReadError, OSError):
        raise Refused("Git authority lookup failed") from None


def backend_test_inventory(source: str) -> set[str]:
    """Validate tracked test identities without treating them as shell/options."""
    entry = git("ls-tree", source, "--", BACKEND_TEST_MANIFEST)
    require(re.fullmatch(rb"100(?:644|755) blob [0-9a-f]{40}\t" + BACKEND_TEST_MANIFEST.encode() + rb"\n?", entry),
            "UAT backend test manifest must be a regular tracked file")
    return _backend_test_identities(git("show", f"{source}:{BACKEND_TEST_MANIFEST}"))


def _backend_test_identities(raw: bytes) -> set[str]:
    parser = runpy.run_path(str(Path(__file__).with_name("verify-protected-pipeline-edits.py")))["backend_test_identities"]
    try:
        return parser(raw.decode("utf-8"))
    except (ValueError, UnicodeError):
        raise Refused("UAT backend test manifest contains invalid test identities") from None


def verify_invocation_authority(candidate: str, authority: str) -> None:
    """Retain parity for legacy isolated UAT and explicit sandbox qualification."""
    for path in MANIFEST_FILES:
        def invocation(source: str):
            raw = git("show", f"{source}:{path}")
            if path.endswith(".toml"):
                return tomllib.loads(raw.decode()).get("tool", {}).get("pytest", {})
            return json.loads(raw).get("scripts", {})
        require(invocation(candidate) == invocation(authority),
                "UAT test invocation differs from reviewed Main authority")
    selected = backend_test_inventory(candidate)
    required = _backend_test_identities(git("show", f"{authority}:{BACKEND_TEST_MANIFEST}"))
    require(required <= selected, "UAT backend manifest omits required Main test identities")


def verify_git_authority(candidate: str, base: str, authority: str, *, current: bool = True, branch: str = "uat") -> str:
    require(
        all(SHA.fullmatch(value) for value in (candidate, base, authority)),
        "Full immutable SHAs are required",
    )
    require(branch in SOURCE_BRANCHES, "Unrecognized protected UAT branch")
    if current:
        git(
            "fetch", "--no-tags", "origin",
            "+refs/heads/main:refs/remotes/origin/main",
            f"+refs/heads/{branch}:refs/remotes/origin/{branch}",
        )
        if branch == "uat-isolated":
            require(git("rev-parse", f"origin/{branch}").decode().strip() == candidate,
                    "Isolated UAT tip changed; qualify the current protected candidate")
        else:
            git("merge-base", "--is-ancestor", candidate, f"origin/{branch}")
    git("merge-base", "--is-ancestor", authority, "origin/main")
    for source in (candidate, base, authority):
        git("cat-file", "-e", f"{source}^{{commit}}")
    # Ordinary protected UAT can replace an accepted release from another
    # history. The observed base selects affected verification; ancestry does
    # not authorize the candidate. Preserve the legacy isolated-history gate.
    if branch == "uat-isolated":
        try:
            git("merge-base", "--is-ancestor", base, candidate)
        except Refused:
            raise Refused("Isolated UAT serving base is not an ancestor of its candidate; reconcile the reviewed source transition") from None
        verify_isolated_release_authority(candidate, authority)
        return application_tree(candidate)
    # Ordinary CD trusts changes reviewed into protected UAT, including its
    # build/migration inputs. Main still owns orchestration and clearance.
    # Isolated CI and the explicit Dev recipe verifier retain their policies.
    backend_test_inventory(candidate)
    return application_tree(candidate)


def verify_privileged_release_inputs(candidate: str, authority: str) -> None:
    """Application histories vary; credentialed release recipes belong to Main."""
    changed = git("diff", "--name-only", candidate, authority, "--", *UAT_PRIVILEGED_PATHS)
    require(not changed,
            "Privileged build or migration authority differs from Main: "
            + ", ".join(changed.decode("utf-8").splitlines())
            + ". Sync reviewed Main release tooling into the selected branch and qualify the new revision.")


def application_tree(candidate: str) -> str:
    tree = git("rev-parse", f"{candidate}^{{tree}}").decode().strip()
    require(SHA.fullmatch(tree), "UAT application tree is invalid")
    return tree


def verify_isolated_release_authority(candidate: str, authority: str) -> None:
    require(not git("diff", "--name-only", candidate, authority, "--",
                    *ISOLATED_RELEASE_AUTHORITY_PATHS),
            "Isolated UAT build or migration authority differs from Main")
    verify_invocation_authority(candidate, authority)


def prepare_isolated_checkout(candidate: str, base: str, authority: str, tree: str) -> None:
    from repo_governance_plan import RELEASE_CONTROLLER_TESTS

    require(os.environ.get("GITHUB_REF") == "refs/heads/main"
            and os.environ.get("GITHUB_EVENT_NAME") == "workflow_dispatch"
            and os.environ.get("GITHUB_SHA") == authority,
            "Isolated UAT qualification requires a Main dispatch")
    require(all(SHA.fullmatch(value) for value in (candidate, base, authority)),
            "Full candidate, serving base and Main SHAs are required")
    require(git("rev-parse", "HEAD").decode().strip() == authority,
            "Qualification must begin on its authenticated Main checkout")
    require(verify_git_authority(candidate, base, authority, current=False, branch="uat-isolated") == tree,
            "Requested isolated application tree differs from Git")
    require_protected_tip(GitHub(REPOSITORY, os.environ.get("GH_TOKEN", "")), candidate, "uat-isolated")
    require(git("rev-parse", "origin/uat-isolated").decode().strip() == candidate,
            "Isolated UAT qualification candidate is no longer the protected tip")
    git("checkout", "--detach", candidate)
    # HEAD stays at the exact application commit; the staged test overlay
    # is disposable and never becomes a deployment commit.
    # The release contracts test the Main workflows overlaid above. Keep those
    # tests with their controller while product tests stay at the candidate SHA.
    control_paths = (*ISOLATED_CI_PATHS, *RELEASE_CONTROLLER_TESTS)
    git("restore", f"--source={authority}", "--staged", "--worktree", "--", *control_paths)
    require(not git("diff", "--cached", "--name-only", authority, "--", *control_paths),
            "CI working copy differs from reviewed Main authority")


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


def require_protected_tip(api: GitHub, candidate: str, branch: str = "uat") -> None:
    require(branch in SOURCE_BRANCHES, "Unrecognized protected UAT branch")
    # Retain the historical helper name for deployed readers. Ordinary UAT
    # freezes an explicit merged SHA; unrelated new merges do not replace it.
    ref = api.read(f"repos/{REPOSITORY}/branches/{branch}")
    tip = ref.get("commit", {}).get("sha", "")
    require(ref.get("protected") is True and SHA.fullmatch(candidate or "")
            and SHA.fullmatch(tip), "Protected UAT source is unavailable")
    if tip == candidate:
        return
    require(branch == "uat", "The protected isolated UAT candidate changed during admission")
    try:
        git("cat-file", "-e", f"{tip}^{{commit}}")
    except Refused:
        # The branch may have advanced since the checkout's full-history fetch.
        git("fetch", "--no-tags", "origin", tip)
    git("merge-base", "--is-ancestor", candidate, tip)


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


def _static_candidate_base_is_bound(job, base):
    steps = job.get("steps")
    if not isinstance(steps, list):
        return False
    bound = [
        index
        for index, step in enumerate(steps)
        if isinstance(step, dict)
        and step.get("name") == f"Verify exact serving base ({base})"
        and step.get("conclusion") == "success"
    ]
    source = [
        index
        for index, step in enumerate(steps)
        if isinstance(step, dict) and step.get("name") == "Verify the exact UAT checkout"
    ]
    return len(bound) == 1 and len(source) == 1 and bound[0] < source[0]


def _exact_candidate_job(jobs, base, *, allow_legacy_static=False):
    base_name = f"Exact UAT Candidate ({base})"
    matches = [
        job for job in jobs if job.get("name") in {"Exact UAT Candidate", base_name}
    ]
    require(
        len(matches) == 1,
        "UAT CI requires a unique successful qualification labelled with its exact serving base",
    )
    exact_job = matches[0]
    if exact_job.get("name") == "Exact UAT Candidate" and not allow_legacy_static:
        require(
            _static_candidate_base_is_bound(exact_job, base),
            "Static UAT CI qualification did not verify its exact serving base before source validation",
        )
    return exact_job



def _verify_unit_jobs(matches, candidate, run_id, *, current, isolated_candidate):
    require(len(matches) in (1, 3), "UAT unit shard inventory is incomplete")
    allowed = {f"Verify unit shard ({shard})": shard for shard in UNIT_SHARDS}
    shards = []
    for job in matches:
        require(job.get("run_id") == run_id and job.get("head_sha") == candidate
                and job.get("status") == "completed" and job.get("conclusion") == "success",
                "UAT unit shard did not complete on the exact source")
        steps = job.get("steps", [])
        if isolated_candidate:
            require(sum(step.get("name") == "Prepare isolated UAT source"
                        and step.get("conclusion") == "success" for step in steps) == 1,
                    "A required CI lane did not prepare the isolated application")
        markers = [step for step in steps
                   if step.get("name", "").startswith("Verify unit shard")]
        # Preserve immutable predecessor evidence under its original policy.
        # Current release qualification always requires typed coverage proof.
        label = job.get("name")
        if not current and len(matches) == 1 and label == UNIT_JOB and not markers:
            try:
                workflow = git("show", f"{candidate}:.github/workflows/ci.yml").decode("utf-8")
            except UnicodeDecodeError:
                raise Refused("Historical UAT workflow is not valid UTF-8") from None
            owner = re.search(r"(?ms)^  web-full-suite-check:\n(.*?)(?=^  [a-z][a-z0-9-]*:\n|\Z)", workflow)
            require(owner is not None
                    and 'name: "Web Unit Contracts"' in owner[1]
                    and 'WEB_FULL_SUITE_SHARD: ""' in owner[1]
                    and "strategy:" not in owner[1],
                    "Unstamped UAT unit evidence is not from the historical singleton workflow")
            return
        execution = [step for step in steps if step.get("name") == "Run affected unit contracts"]
        require(len(execution) == 1 and execution[0].get("conclusion") == "success",
                "A required UAT unit execution was not verified")
        require(len({step.get("name") for step in markers}) == len(markers)
                and all(step.get("name") in allowed
                        and step.get("conclusion") in ("success", "skipped") for step in markers),
                "UAT unit shard markers are invalid")
        verified = [step for step in markers if step.get("conclusion") == "success"]
        require(len(verified) == 1, "UAT unit shard coverage proof is missing or ambiguous")
        shard = allowed[verified[0]["name"]]
        require(label == f"{UNIT_JOB} ({shard})"
                or (label == UNIT_JOB and len(matches) == 1 and shard == "1/1"),
                "UAT unit job name does not match its shard marker")
        shards.append(shard)
    require(sorted(shards) in (["1/1"], ["1/3", "2/3", "3/3"]),
            "UAT unit shard coverage is incomplete or duplicated")


def _verify_run_jobs(api, run, candidate, base, run_id, attempt, *, current=True, isolated_candidate=""):
    prefix = f"repos/{REPOSITORY}/actions"
    inventory = api.read(f"{prefix}/runs/{run_id}/attempts/{attempt}/jobs?per_page=100")
    jobs = inventory.get("jobs")
    require(
        isinstance(jobs, list)
        and type(inventory.get("total_count")) is int
        and inventory["total_count"] == len(jobs) <= 100,
        "UAT CI job inventory is incomplete",
    )
    # Only historical serving receipts may use the prior immutable workflow's
    # inventory. Current qualification requires the new release-core policy.
    legacy = not current and any(job.get("name") == "Web Full Suite (Vitest) 1/3" for job in jobs)
    exact_job = _exact_candidate_job(jobs, base, allow_legacy_static=legacy)
    historical_browser = not current and any(job.get("name") == "Web Targeted Contracts (browser)" for job in jobs)
    required_jobs = LEGACY_REQUIRED_JOBS if legacy else PRE_BROWSER_REMOVAL_JOBS if historical_browser else REQUIRED_JOBS
    for name in required_jobs:
        if name == UNIT_JOB:
            unit_jobs = [job for job in jobs if job.get("name") == UNIT_JOB
                         or (job.get("name") or "").startswith(f"{UNIT_JOB} (")]
            _verify_unit_jobs(unit_jobs, candidate, run_id, current=current,
                              isolated_candidate=isolated_candidate)
            continue
        matches = [job for job in jobs if job.get("name") == name]
        require(
            len(matches) == 1
            and matches[0].get("run_id") == run_id
            and matches[0].get("head_sha") == candidate
            and matches[0].get("status") == "completed"
            and (matches[0].get("conclusion") == "success"
                 or (not legacy and name in OPTIONAL_NATIVE and matches[0].get("conclusion") == "skipped")),
            "UAT CI did not complete its exact-source and aggregate gates",
        )
        if isolated_candidate and name not in AGGREGATE_JOBS:
            require(any(step.get("name") == "Prepare isolated UAT source"
                        and step.get("conclusion") == "success"
                        for step in matches[0].get("steps", []))
                    or matches[0].get("conclusion") == "skipped",
                    "A required CI lane did not prepare the isolated application")
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
    if not legacy:
        policy_steps = [step for step in exact_job.get("steps", [])
                        if step.get("name") == "Verify release-level core selection"]
        require(len(policy_steps) == 1 and policy_steps[0].get("conclusion") == "success",
                "Focused CI cannot establish release-level qualification")
    exact_steps = [
        step
        for step in exact_job.get("steps", [])
        if step.get("name") == "Verify the exact UAT checkout"
    ]
    require(
        len(exact_steps) == 1 and exact_steps[0].get("conclusion") == "success",
        "A required UAT CI step was not verified",
    )
    if isolated_candidate:
        identity = f"Verify isolated source ({isolated_candidate} {application_tree(isolated_candidate)})"
        bound = [step for step in exact_job.get("steps", []) if step.get("name") == identity]
        require(len(bound) == 1 and bound[0].get("conclusion") == "success",
                "Main CI attempt did not attest the exact isolated application tree")
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



def _latest_attempt_inventory(api, candidate, run_id, attempt, *, current=True, branch="uat", title=""):
    prefix = f"repos/{REPOSITORY}/actions"
    inventory_path = f"{prefix}/workflows/ci.yml/runs?branch={branch}&event=workflow_dispatch&head_sha={candidate}&per_page=100"
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
        if item.get("head_sha") == candidate and item.get("head_branch") == branch
        and (not title or item.get("display_title") == title)
    ]
    if not current:
        # Historical serving acceptance binds one immutable successful run. A
        # different CI run cannot revoke it, but a rerun of this very run must
        # still corroborate the pinned attempt even if /runs/{id} is stale.
        pinned = [item for item in relevant if item.get("id") == run_id]
        require(
            len(pinned) == 1
            and type(pinned[0].get("id")) is int
            and type(pinned[0].get("run_attempt")) is int
            and pinned[0]["run_attempt"] == attempt,
            "Historical UAT CI pinned attempt is missing or superseded",
        )
        return inventory_path, {
            key: pinned[0].get(key)
            for key in ("id", "run_attempt", "head_sha", "head_branch")
        }
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
            and observed.get("head_sha") == candidate and observed.get("head_branch") == branch,
            "UAT CI attempt chronology belongs to another source",
        )
        attempts.append(observed)
    # A complete inventory with one current run needs no timestamp ordering.
    # Competing runs still require trustworthy chronology, including older-ID reruns.
    latest = attempts[0] if len(attempts) == 1 else max(attempts, key=_started, default={})
    require(
        latest.get("id") == run_id and latest.get("run_attempt") == attempt,
        "A newer UAT CI attempt superseded this evidence",
    )
    return inventory_path, rows


def verify_attempt(
    api: GitHub, candidate: str, base: str, run_id: int, attempt: int, *, current=True, branch="uat", authority=""
) -> dict:
    require(branch in SOURCE_BRANCHES, "Unrecognized protected UAT branch")
    require(SHA.fullmatch(candidate), "Full application SHA is required")
    require(SHA.fullmatch(base), "Full UAT serving-base SHA is required")
    require(
        type(run_id) is int and run_id > 0 and type(attempt) is int and attempt > 0,
        "CI pin is invalid",
    )
    run_head, run_branch, title = candidate, branch, ""
    if branch == "uat-isolated":
        require(SHA.fullmatch(authority or ""), "Isolated qualification requires the Main authority SHA")
        run_head, run_branch, title = authority, "main", f"Isolated UAT {candidate}"
    prefix = f"repos/{REPOSITORY}/actions"
    run_path = f"{prefix}/runs/{run_id}"
    # Reuse the run response within each source-validation pass. Repository,
    # workflow and run authority are all read afresh after evidence inspection;
    # no live authorization or inventory read is cached between the passes.
    source_documents = {}

    def read_source(path):
        document = copy.deepcopy(api.read(path))
        if path == run_path:
            source_documents[path] = document
        return document

    source = verify_source(
        read_source,
        REPOSITORY,
        {"run_id": run_id, "attempt": attempt, "head_sha": run_head},
    )
    run = source_documents[run_path]
    require(
        run.get("event") == "workflow_dispatch"
        and run.get("head_branch") == run_branch
        and (not title or run.get("display_title") == title)
        and run.get("head_repository", {}).get("id") == source["repository_id"]
        and run.get("head_repository", {}).get("full_name") == REPOSITORY
        and run.get("status") == "completed"
        and run.get("conclusion") == "success",
        "UAT CI is not a successful exact-branch dispatch",
    )
    _verify_run_jobs(api, run, run_head, base, run_id, attempt, current=current,
                     isolated_candidate=candidate if title else "")
    inventory_path, rows = _latest_attempt_inventory(
        api, run_head, run_id, attempt, current=current, branch=run_branch, title=title
    )
    rechecked_source = verify_source(
        read_source,
        REPOSITORY,
        {"run_id": run_id, "attempt": attempt, "head_sha": run_head},
    )
    require(
        rechecked_source == source
        and source_documents[run_path] == run
        and (
            api.read(inventory_path) == rows
            if current
            else _latest_attempt_inventory(
                api,
                run_head,
                run_id,
                attempt,
                current=False,
                branch=run_branch,
                title=title,
            )[1]
            == rows
        ),
        "UAT CI changed during verification",
    )
    return {"run_id": run_id, "run_attempt": attempt}



def verify_predecessor(prior: dict, *, current: bool) -> None:
    candidate = prior["sha"]
    branch = prior.get("source_branch", "uat")
    tree = verify_git_authority(candidate, prior["base_sha"], prior["authority_sha"], current=current, branch=branch)
    require(tree == prior["tree"], "UAT predecessor tree changed")
    _verify_predecessor_attempt(prior, current=current)


def _verify_predecessor_attempt(prior: dict, *, current: bool) -> None:
    candidate = prior["sha"]
    branch = prior.get("source_branch", "uat")
    api = GitHub(REPOSITORY, os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN", ""))
    if current:
        require_protected_tip(api, candidate, branch)
    verify_attempt(
        api, candidate, prior["base_sha"], prior["run_id"], prior["run_attempt"],
        current=current, branch=branch, authority=prior["authority_sha"],
    )
    if current:
        require_protected_tip(api, candidate, branch)


def issue_predecessor(args) -> dict:
    require(args.environment == "uat", "Direct CI admission is UAT-only")
    require(args.scope in {"all", "backend", "frontend"}, "Resolved UAT scope is required")
    services = {"backend", "frontend"} if args.scope == "all" else {args.scope}
    branch = getattr(args, "source_branch", "uat")
    require(branch in SOURCE_BRANCHES, "Unrecognized protected UAT branch")
    if branch == "uat-isolated":
        verify_serving_bases(args.base_sha, args.scope, args.backend_base_sha, args.frontend_base_sha)
        serving = live_serving_bases(args.scope)
        require(all(value["sha"] == args.base_sha for value in serving.values()),
                "Actual UAT serving baseline changed before mutation")
    else:
        # Snapshot both services even for a partial release. Different accepted
        # frontend/backend SHAs are legitimate; changed revisions are not.
        expected = {
            "backend": {"sha": args.backend_base_sha, "revision": getattr(args, "backend_base_revision", "")},
            "frontend": {"sha": args.frontend_base_sha, "revision": getattr(args, "frontend_base_revision", "")},
        }
        require(all(SHA.fullmatch(value["sha"] or "") and re.fullmatch(r"[a-z][a-z0-9-]{1,127}", value["revision"])
                    for value in expected.values())
                and args.base_sha in {value["sha"] for value in expected.values()},
                "UAT qualification base must identify captured service SHAs and revisions")
        serving = live_serving_bases("all")
        require(serving == expected, "Actual UAT serving baseline changed before mutation")
    record = {"schema_version": 1, "kind": "uat-exact-ci", "status": "accepted", "environment": "uat",
              "repository": REPOSITORY, "sha": args.sha, "base_sha": args.base_sha,
              "authority_sha": args.authority_sha, "services": sorted(services), "serving": serving,
              "run_id": args.ci_run_id, "run_attempt": args.ci_attempt,
              "tree": verify_git_authority(args.sha, args.base_sha, args.authority_sha, branch=branch)}
    if branch != "uat":
        record["source_branch"] = branch
    # Git/tree authority was established while constructing this record.
    # Recheck live CI and branch state without repeating immutable Git proof.
    _verify_predecessor_attempt(record, current=True)
    if args.predecessor is not None:
        require(record == json.loads(args.predecessor.read_text()), "Direct UAT admission changed before mutation")
    return record


if __name__ == "__main__":
    try:
        require(len(sys.argv) == 5, "Provide candidate, serving base, authority and tree SHAs")
        prepare_isolated_checkout(*sys.argv[1:])
    except Refused as error:
        sys.exit(str(error))
