#!/usr/bin/env python3
"""Short hosted maintenance passes using verified release and drain artifacts."""

from __future__ import annotations

import argparse
from collections.abc import Iterator
from contextvars import ContextVar
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import hashlib
import importlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Literal

import release_artifact_receipts
import production_phone_receipt
import production_phone_lease
import production_phone_nonproducer
import production_retention_context

retention = importlib.import_module("cloudrun-retention")
capacity_bridge = importlib.import_module("production-capacity-bridge")
REGION = "us-central1"
LANES = {
    "uat": {
        "project": "hushh-pda-uat",
        "workflow": "deploy-uat.yml",
        "prefix": "uat",
        "deploy_job": "Deploy UAT Scope",
        "upload_step": "Upload UAT deploy artifacts",
        "state_artifact": "uat-retention-state",
        "services": {
            "consent-protocol": 2,
            "hushh-webapp": 10,
            "consent-protocol-drive-worker": 2,
        },
    },
    "production": {
        "project": "hushh-pda",
        "workflow": "deploy-production.yml",
        "prefix": "prod",
        "deploy_job": "Deploy Production Scope",
        "deploy_job_aliases": tuple(
            sorted(production_phone_nonproducer.PRODUCTION_JOB_NAME_ALIASES)
        ),
        "upload_step": "Upload production deploy artifacts",
        "state_artifact": "production-retention-state",
        "services": {"consent-protocol": 2, "hushh-webapp": 10, "consent-protocol-drive-worker": 1},
    },
}
STATE_ARTIFACT = LANES["uat"]["state_artifact"]
ONE_CHAT_WORKFLOW = "deploy-uat-one-chat.yml"
ONE_CHAT_ARTIFACT = "uat-one-chat-backend-release"
MANAGED_AI_PROFILE = (
    Path(__file__).resolve().parents[2] / "consent-protocol/config/managed-ai-runtime.json"
)
# UAT probed this Vertex project until 2026-10-15; receipts minted then still name it.
RETIRED_UAT_VERTEX_PROJECTS = frozenset({"hussh-511311"})
POST_RELEASE_CLEANUP_STEP = "Retire unused production tags after a healthy release"
UAT_POST_RELEASE_CLEANUP_STEP = "Retire old UAT revision tags after a healthy release"
REQUIRED_UAT_HYGIENE_STEPS = (
    "Validate deployment SHA against main",
    "Enforce UAT database connection budget before deployment",
    "Verify backend candidate readiness and exact-SHA provenance",
    "Verify governed analytics transport on zero-traffic UAT candidate",
    "Promote deployed revisions to UAT traffic",
    "Verify backend deployment provenance",
    "Verify frontend deployment provenance",
    "Verify UAT native passkey domain associations",
    "Post-deploy UAT schema contract gate",
    "Classify UAT release outcome",
    "Activate tombstone-aware account deletion",
    "Deploy and attest private Drive worker",
    "Resolve final Cloud Run state",
    "Write UAT release status artifact",
    "Upload UAT deploy artifacts",
    "Fail workflow when UAT release did not end healthy",
)
REQUIRED_PRODUCTION_STEPS = (
    "Validate deployment SHA against main",
    "Enforce production database connection budget before deployment",
    "Verify production candidate runtime env parity",
    "Verify production Connected Systems Omni Gateway",
    "Verify production backend deployment provenance",
    "Verify production frontend deployment provenance",
    "Post-deploy backend runtime health gate",
    "Post-deploy frontend runtime health gate",
    "Verify production account-session contract",
    "Verify production native passkey domain associations",
    "Classify production release outcome",
    "Activate tombstone-aware account deletion",
    "Resolve final Cloud Run state",
    "Write production release status artifact",
    "Upload production deploy artifacts",
    "Tag this release as last known good",
    "Fail workflow when production release did not end healthy",
)


GITHUB_LOOKUP_SECONDS = 90
PASS_SECONDS = 300
_LOOKUP_DEADLINE: ContextVar[float | None] = ContextVar("lookup_deadline", default=None)
_API_CACHE: ContextVar[dict | None] = ContextVar("api_cache", default=None)


def command(*args: str) -> str:
    timeout = 180.0
    deadline = _LOOKUP_DEADLINE.get()
    if args[0] == "gh" and deadline is not None:
        timeout = min(timeout, deadline - time.monotonic())
        if timeout <= 0:
            raise retention.UnsafeState(
                "GitHub authority lookup exceeded its bounded budget"
            )
    return retention.run_command(args, timeout=timeout).stdout


def run_retention(arguments: list[str]) -> None:
    # Keep the authored CLI and one deadline; do not fork another unbounded runner.
    previous = sys.argv
    try:
        sys.argv = arguments[1:]
        result = retention.main()
        if result:
            raise retention.UnsafeState("retention did not complete its pass")
    finally:
        sys.argv = previous


def api(repository: str, endpoint: str):
    cache = _API_CACHE.get()
    key = (repository, endpoint)
    if cache is not None and key in cache:
        return deepcopy(cache[key])
    result = json.loads(command("gh", "api", f"repos/{repository}/actions/{endpoint}"))
    if cache is not None:
        cache[key] = deepcopy(result)
    return result


def uncached_api(repository: str, endpoint: str):
    """Re-read authority even when the surrounding maintenance pass caches lookups."""
    token = _API_CACHE.set(None)
    try:
        return api(repository, endpoint)
    finally:
        _API_CACHE.reset(token)


def trusted_run(run: dict, repository: str, workflow: str) -> bool:
    return (
        trusted_origin(run, repository, workflow) and run.get("conclusion") == "success"
    )


def trusted_origin(run: dict, repository: str, workflow: str) -> bool:
    return (
        run.get("path") == f".github/workflows/{workflow}"
        and run.get("head_branch") == "main"
        and run.get("status") == "completed"
        and (run.get("repository") or {}).get("full_name") == repository
        and (run.get("head_repository") or {}).get("full_name") == repository
    )


def verify_post_release_failure(repository: str, run: dict, release: dict) -> None:
    """A failed hygiene step never substitutes for successful release gates."""
    result = api(repository, f"runs/{run['id']}/jobs?filter=latest&per_page=100")
    jobs = result.get("jobs") or []
    if result.get("total_count") != 1 or len(jobs) != 1:
        raise retention.UnsafeState("production deployment job inventory is incomplete")
    job = jobs[0]
    steps = job.get("steps") or []
    by_name = {step.get("name"): step for step in steps}
    failed = [step.get("name") for step in steps if step.get("conclusion") == "failure"]
    if (
        job.get("name") != "Deploy Production Scope"
        or job.get("status") != "completed"
        or job.get("conclusion") != "failure"
        or len(by_name) != len(steps)
        or failed != [POST_RELEASE_CLEANUP_STEP]
        or any(
            step.get("status") != "completed"
            or step.get("conclusion") not in {"success", "skipped", "failure"}
            for step in steps
        )
        or any(
            by_name.get(name, {}).get("conclusion") != "success"
            for name in REQUIRED_PRODUCTION_STEPS
        )
    ):
        raise retention.UnsafeState(
            "production failure is not isolated to post-release cleanup"
        )
    verification = release.get("verification") or {}
    classification = release.get("classification") or {}
    if (
        release.get("scope") != "all"
        or not re.fullmatch(r"[a-f0-9]{40}", str(release.get("sha", "")))
        or any(
            verification.get(name) != "success"
            for name in (
                "runtime_parity",
                "connected_systems",
                "backend_provenance",
                "frontend_provenance",
                "backend_health",
                "frontend_health",
                "passkey_domain_associations",
                "account_deletion_activation",
            )
        )
        or verification.get("account_deletion_activated") != "true"
        or any(
            classification.get(name) != "false"
            for name in (
                "release_failed",
                "promote_failed",
                "backend_provenance_failed",
                "frontend_provenance_failed",
            )
        )
        or release.get("rollback")
        != {"backend": "skipped", "frontend": "skipped", "drive_jobs": "skipped"}
    ):
        raise retention.UnsafeState(
            "production artifact does not prove complete release health"
        )


def verify_post_uat_hygiene_failure(repository: str, run: dict, release: dict) -> None:
    """A failed UAT tag pass is safe only after a complete healthy dual release."""
    result = api(repository, f"runs/{run['id']}/jobs?filter=latest&per_page=100")
    jobs = result.get("jobs") or []
    by_job = {job.get("name"): job for job in jobs}
    historical_jobs = {"Select UAT target", "Deploy UAT Scope"}
    current_jobs = historical_jobs | {"Wait for UAT capacity outside the mutation lock"}
    if (
        set(by_job) not in (historical_jobs, current_jobs)
        or result.get("total_count") != len(by_job)
        or len(jobs) != len(by_job)
        or any(
            by_job[name].get("status") != "completed"
            or by_job[name].get("conclusion") != "success"
            for name in set(by_job) - {"Deploy UAT Scope"}
        )
    ):
        raise retention.UnsafeState("UAT deployment job inventory is incomplete")
    job = by_job["Deploy UAT Scope"]
    steps = job.get("steps") or []
    by_name = {step.get("name"): step for step in steps}
    failed = [step.get("name") for step in steps if step.get("conclusion") == "failure"]
    if (
        job.get("status") != "completed"
        or job.get("conclusion") != "failure"
        or len(by_name) != len(steps)
        or failed != [UAT_POST_RELEASE_CLEANUP_STEP]
        or any(
            step.get("status") != "completed"
            or step.get("conclusion") not in {"success", "skipped", "failure"}
            for step in steps
        )
        or any(
            by_name.get(name, {}).get("conclusion") != "success"
            for name in REQUIRED_UAT_HYGIENE_STEPS
        )
        or any(
            by_name.get(name, {}).get("conclusion") != "skipped"
            for name in (
                "Roll back backend revision",
                "Roll back frontend revision",
                "Restore backend after Drive worker failure",
                "Restore frontend after Drive worker failure",
                "Verify Drive scheduler after worker failure",
            )
        )
    ):
        raise retention.UnsafeState("UAT failure is not isolated to post-release tag cleanup")
    verification = release.get("verification") or {}
    current = release.get("current") or {}
    final = release.get("final") or {}
    predeploy = release.get("predeploy") or {}
    targets = release.get("rollback_targets") or {}
    sha = release.get("sha")
    if (
        release.get("status") != "healthy"
        or release.get("scope") != "all"
        or not isinstance(sha, str)
        or not re.fullmatch(r"[a-f0-9]{40}", sha)
        or not all(
            isinstance(part, dict)
            for part in (verification, current, final, predeploy, targets)
        )
        or verification.get("blocking_classifications") != ""
        or any(
            verification.get(name) != "success"
            for name in (
                "backend_provenance",
                "frontend_provenance",
                "db_contract",
                "account_deletion_activation",
                "drive_worker",
            )
        )
        or any(
            verification.get(name) != "true"
            for name in (
                "parity_success",
                "provenance_success",
                "semantic_success",
                "account_deletion_activated",
            )
        )
        or any(
            verification.get(name) != "skipped"
            for name in (
                "drive_worker_backend_rollback",
                "drive_worker_frontend_rollback",
                "drive_worker_scheduler_rollback",
            )
        )
        or targets.get("drive_worker_failure_rollback_complete") is not True
        or any(
            final.get(f"{lane}_sha") != sha
            or final.get(f"{lane}_revision") != current.get(f"{lane}_revision")
            or final.get(f"{lane}_revision") != current.get(f"{lane}_candidate_revision")
            or targets.get(f"{lane}_revision") != predeploy.get(f"{lane}_revision")
            for lane in ("backend", "frontend")
        )
    ):
        raise retention.UnsafeState("UAT artifact does not prove complete release health")


def artifact_exists(repository: str, run_id: int, name: str) -> bool:
    return release_artifact_receipts.artifact_exists(repository, run_id, name, api=api)


def replayed_release_artifact(
    repository: str, run_id: int, name: str, environment: str = "uat"
) -> dict:
    """Resolve a duplicate release name only from its exact current upload step."""
    if environment not in LANES:
        raise retention.UnsafeState("release environment is invalid")
    return release_artifact_receipts.resolve_replayed_artifact(
        repository, run_id, name, LANES[environment], environment,
        api=api, governed_dispatch=governed_dispatch, timestamp=_github_timestamp,
    )


def download_replayed_release(
    repository: str, artifact: dict, directory: Path, environment: str = "uat"
) -> None:
    """Read only the release status from an immutable, digest-verified archive."""
    if environment not in LANES:
        raise retention.UnsafeState("release environment is invalid")
    deadline = _LOOKUP_DEADLINE.get()
    timeout = min(180.0, deadline - time.monotonic()) if deadline is not None else 180.0
    release_artifact_receipts.download_replayed_artifact(
        repository, artifact, directory, f"{LANES[environment]['prefix']}-release-status.json",
        run_command=retention.run_command, timeout=timeout,
        allow_legacy_production=environment == "production"
        and release_artifact_receipts.production_evidence_repair_enabled(),
    )

# Preserve existing UAT-only imports while both lanes share the strict reader.
replayed_uat_release_artifact = replayed_release_artifact
download_replayed_uat_release = download_replayed_release


def download(repository: str, run_id: int, name: str, directory: Path) -> None:
    release_artifact_receipts.download(repository, run_id, name, directory, command=command)


def governed_dispatch(
    run: dict, repository: str, environment: str, *, workflow: str | None = None
) -> bool:
    policy = json.loads(
        (Path(__file__).resolve().parents[2] / "config/ci-governance.json").read_text()
    )
    if (
        environment == "production"
        and trusted_origin(run, repository, workflow or LANES[environment]["workflow"])
        and run.get("event") == "workflow_dispatch"
        and (run.get("actor") or {}).get("login") == "github-actions[bot]"
    ):
        from release_cadence import UnsafeRelease
        from release_cadence_github import recorded_authority
        try:
            _, lane = recorded_authority(repository, run)
            return lane == "deploy"
        except UnsafeRelease:
            return False
    return (
        trusted_origin(run, repository, workflow or LANES[environment]["workflow"])
        and run.get("event") == "workflow_dispatch"
        and (run.get("actor") or {}).get("login")
        in policy[environment]["manual_dispatch_users"]
    )


def _same_production_run(expected: dict, observed: dict) -> bool:
    keys = (
        "id", "head_sha", "head_branch", "path", "event", "run_attempt",
        "status", "conclusion",
    )
    return (
        isinstance(observed, dict)
        and all(observed.get(key) == expected.get(key) for key in keys)
        and all(
            (observed.get(key) or {}).get(field) == (expected.get(key) or {}).get(field)
            for key, field in (
                ("repository", "id"), ("repository", "full_name"),
                ("head_repository", "id"), ("head_repository", "full_name"),
                ("actor", "login"), ("triggering_actor", "login"),
            )
        )
    )


def _assert_production_release_snapshot(repository: str, run: dict, inventory: dict) -> None:
    run_id = run["id"]
    refreshed = uncached_api(repository, f"runs/{run_id}")
    current_inventory = uncached_api(repository, f"runs/{run_id}/artifacts?per_page=100")
    if not _same_production_run(run, refreshed) or current_inventory != inventory:
        raise retention.UnsafeState("production release attempt changed during lookup")


def load_release(repository: str, run_id: int, directory: Path, environment: str) -> dict | None:
    prefix = LANES[environment]["prefix"]
    name = f"{prefix}-release-{run_id}"
    if environment == "production" and release_artifact_receipts.production_evidence_repair_enabled():
        # Production status is authority-bearing: never trust an extracted or
        # pre-existing filesystem cache, including a symlinked parent. Select
        # the current upload and decode its digest-verified archive in memory.
        run = uncached_api(repository, f"runs/{run_id}")
        if (
            not isinstance(run, dict)
            or run.get("id") != run_id
            or run.get("status") != "completed"
            or run.get("conclusion") not in {"success", "failure"}
            or not governed_dispatch(run, repository, "production")
        ):
            raise retention.UnsafeState("production release origin is invalid")
        inventory = uncached_api(repository, f"runs/{run_id}/artifacts?per_page=100")
        entries = inventory.get("artifacts") if isinstance(inventory, dict) else None
        if (
            not isinstance(entries, list)
            or type(inventory.get("total_count")) is not int
            or inventory["total_count"] != len(entries)
            or len(entries) > 100
            or any(not isinstance(item, dict) for item in entries)
        ):
            raise retention.UnsafeState("release artifact inventory is incomplete")
        if not any(item.get("name") == name for item in entries):
            _assert_production_release_snapshot(repository, run, inventory)
            return None
        selected, _ = release_artifact_receipts.current_attempt_artifact(
            repository, run, LANES["production"], api=uncached_api, timestamp=_github_timestamp
        )
        deadline = _LOOKUP_DEADLINE.get()
        timeout = min(180.0, deadline - time.monotonic()) if deadline is not None else 180.0
        archive = release_artifact_receipts.immutable_archive(
            repository, selected, run_command=retention.run_command, timeout=timeout
        )
        try:
            release = json.loads(
                release_artifact_receipts._status_bytes(
                    archive, "prod-release-status.json", allow_legacy_production=True
                ),
                object_pairs_hook=production_phone_receipt._unique_object,
            )
        except (ValueError, TypeError) as error:
            raise retention.UnsafeState("production release artifact is invalid") from error
        _assert_production_release_snapshot(repository, run, inventory)
        if not isinstance(release, dict):
            raise retention.UnsafeState("source release artifact is invalid")
        if any(key.startswith("_maintenance_") for key in release):
            raise retention.UnsafeState("source artifact contains internal maintenance authority")
        return release
    artifact = None
    try:
        if not artifact_exists(repository, run_id, name):
            return None
    except retention.UnsafeState:
        artifact = replayed_release_artifact(repository, run_id, name, environment)
    release_directory = directory / (
        f"{run_id}-artifact-{artifact['id']}" if artifact else str(run_id)
    )
    status_file = release_directory / f"{prefix}-release-status.json"
    if not status_file.exists():
        if artifact:
            download_replayed_release(repository, artifact, release_directory, environment)
        else:
            download(repository, run_id, name, release_directory)
    if status_file.is_symlink():
        raise retention.UnsafeState("source release artifact is a symlink")
    release = json.loads(status_file.read_text())
    if not isinstance(release, dict):
        raise retention.UnsafeState("source release artifact is invalid")
    if any(name.startswith("_maintenance_") for name in release):
        raise retention.UnsafeState("source artifact contains internal maintenance authority")
    return release


def bounded_uat_runs(repository: str, workflow: str, status: str) -> list[dict]:
    """Scan at most 1,000 recent runs for an earlier release owner."""
    runs: list[dict] = []
    for page in range(1, 11):
        batch = api(
            repository,
            f"workflows/{workflow}/runs?branch=main&status={status}&per_page=100&page={page}",
        )["workflow_runs"]
        if not isinstance(batch, list) or any(not isinstance(run, dict) for run in batch):
            raise retention.UnsafeState("UAT deployment history is invalid")
        runs.extend(batch)
        if len(batch) < 100:
            break
    return runs


def successful_uat_runs(repository: str, workflow: str) -> list[dict]:
    return bounded_uat_runs(repository, workflow, "success")


def prior_healthy_uat_release(
    repository: str,
    failed_run: dict,
    directory: Path,
    *,
    frontend_owner: bool = False,
) -> tuple[int, dict]:
    """Find the prior UAT artifact that proves the currently inherited frontend."""
    runs = bounded_uat_runs(repository, LANES["uat"]["workflow"], "completed")
    for run in sorted(runs, key=lambda item: int(item.get("id") or 0), reverse=True):
        if int(run.get("id") or 0) >= failed_run["id"]:
            continue
        if run.get("conclusion") not in {"success", "failure"}:
            continue
        failed = run.get("conclusion") == "failure"
        if failed and not governed_dispatch(run, repository, "uat"):
            continue
        if not failed and (
            run.get("conclusion") != "success"
            or not governed_dispatch(run, repository, "uat")
        ):
            raise retention.UnsafeState("prior UAT source is not a governed main deployment")
        release = load_release(repository, run["id"], directory, "uat")
        if release is None:
            # Successful NO_OP runs have no release artifact.
            continue
        if failed:
            if release.get("status") != "healthy":
                continue
            try:
                verify_post_uat_hygiene_failure(repository, run, release)
            except retention.UnsafeState:
                continue
        if frontend_owner and release.get("status") == "healthy" and release.get("scope") == "backend":
            # A backend-only deploy carries the frontend forward but did not
            # create it. Keep looking for the run that did.
            continue
        verification = release.get("verification") or {}
        if (
            release.get("status") != "healthy"
            or release.get("scope") not in {"all", "frontend"}
            or not re.fullmatch(r"[a-f0-9]{40}", str(release.get("sha", "")))
            or not isinstance(release.get("final"), dict)
            or release["final"].get("frontend_sha") != release["sha"]
            or not isinstance(verification, dict)
            or verification.get("frontend_provenance") != "success"
            or verification.get("parity_success") != "true"
            or verification.get("semantic_success") != "true"
            or verification.get("blocking_classifications") != ""
        ):
            raise retention.UnsafeState("prior UAT release does not prove frontend health")
        return run["id"], release
    raise retention.UnsafeState("no prior healthy UAT release artifact")


def prior_healthy_uat_backend_release(
    repository: str,
    failed_run: dict,
    directory: Path,
    *,
    candidate_runs: list[dict] | None = None,
    depth: int = 0,
) -> tuple[int, dict]:
    """Find a backend owner, recursively proving any prior passkey partial."""
    if depth >= 100:
        raise retention.UnsafeState("UAT partial backend lineage exceeds safe depth")
    standard = LANES["uat"]["workflow"]
    runs = candidate_runs
    if runs is None:
        runs = bounded_uat_runs(repository, standard, "completed")
        runs += successful_uat_runs(repository, ONE_CHAT_WORKFLOW)
    for run in sorted(
        {run.get("id"): run for run in runs}.values(),
        key=lambda item: int(item.get("id") or 0),
        reverse=True,
    ):
        if int(run.get("id") or 0) >= failed_run["id"]:
            continue
        one_chat = trusted_origin(run, repository, ONE_CHAT_WORKFLOW)
        workflow = ONE_CHAT_WORKFLOW if one_chat else standard
        if run.get("conclusion") == "failure":
            if one_chat or not governed_dispatch(run, repository, "uat", workflow=standard):
                continue
            release = load_release(repository, run["id"], directory, "uat")
            if release is None:
                continue
            if release.get("status") == "healthy":
                try:
                    verify_post_uat_hygiene_failure(repository, run, release)
                except retention.UnsafeState:
                    continue
                backend_revision = release["final"]["backend_revision"]
                if not isinstance(backend_revision, str) or not re.fullmatch(
                    r"consent-protocol-[a-z0-9-]+", backend_revision
                ):
                    raise retention.UnsafeState(
                        "prior UAT hygiene source has invalid backend revision"
                    )
                return run["id"], release
            if release.get("status") != "rolled_back":
                continue
            try:
                verify_uat_partial_failure(
                    repository,
                    run,
                    release,
                    directory,
                    candidate_runs=runs,
                    depth=depth + 1,
                )
            except retention.UnsafeState:
                continue
            return run["id"], release
        if run.get("conclusion") != "success":
            continue
        if not governed_dispatch(run, repository, "uat", workflow=workflow):
            raise retention.UnsafeState("prior UAT backend source is not governed")
        if one_chat:
            release = load_one_chat_release(repository, run, directory)
            if release is None:
                raise retention.UnsafeState("prior One chat backend release lacks a receipt")
        else:
            release = load_release(repository, run["id"], directory, "uat")
            if release is None:
                # Successful NO_OP runs have no release artifact.
                continue
            if release.get("status") == "healthy" and release.get("scope") == "frontend":
                # A frontend-only release inherits the earlier backend owner.
                continue
        final = release.get("final")
        verification = release.get("verification") or {}
        if (
            release.get("status") != "healthy"
            or release.get("scope") not in {"all", "backend"}
            or not re.fullmatch(r"[a-f0-9]{40}", str(release.get("sha", "")))
            or not isinstance(final, dict)
            or not re.fullmatch(
                r"consent-protocol-[a-z0-9-]+", str(final.get("backend_revision", ""))
            )
            or final.get("backend_sha") != release["sha"]
            or (
                not one_chat
                and (
                    not isinstance(verification, dict)
                    or verification.get("backend_provenance") != "success"
                    or verification.get("parity_success") != "true"
                    or verification.get("semantic_success") != "true"
                    or verification.get("blocking_classifications") != ""
                )
            )
        ):
            raise retention.UnsafeState("prior UAT release does not prove backend health")
        return run["id"], release
    raise retention.UnsafeState("no prior healthy UAT backend release artifact")


def one_chat_vertex_projects() -> frozenset[str]:
    """Vertex projects a One chat receipt may name: the UAT profile's and retired ones."""
    profile = json.loads(MANAGED_AI_PROFILE.read_text())
    return RETIRED_UAT_VERTEX_PROJECTS | {profile["environments"]["uat"]["project"]}


def load_one_chat_release(
    repository: str, run: dict, directory: Path
) -> dict | None:
    """Compose a trusted backend-only receipt with its earlier frontend owner."""
    run_id = run["id"]
    if not artifact_exists(repository, run_id, ONE_CHAT_ARTIFACT):
        return None
    source = directory / f"one-chat-{run_id}"
    receipt = source / "uat-one-chat-release.json"
    if not receipt.exists():
        download(repository, run_id, ONE_CHAT_ARTIFACT, source)
    if not receipt.is_file() or receipt.is_symlink():
        raise retention.UnsafeState("One chat release receipt is missing or unsafe")
    report = json.loads(receipt.read_text())
    if not isinstance(report, dict):
        raise retention.UnsafeState("One chat release receipt is invalid")
    candidate = report.get("candidate_revision")
    old = report.get("old_revision")
    sha = report.get("target_sha")
    probe = report.get("probe")
    if (
        report.get("status") != "success"
        or report.get("project") != LANES["uat"]["project"]
        or report.get("region") != REGION
        or report.get("service") != "consent-protocol"
        or report.get("run_id") != str(run_id)
        or not re.fullmatch(r"[a-f0-9]{40}", str(sha))
        or not re.fullmatch(r"consent-protocol-[a-z0-9-]+", str(candidate))
        or not re.fullmatch(r"consent-protocol-[a-z0-9-]+", str(old))
        or old == candidate
        or report.get("final_serving_revision") != candidate
        or report.get("final_traffic") != {candidate: 100}
        or report.get("temporary_probe_job_deleted") is not True
        or not isinstance(probe, dict)
        or probe.get("one_chat_probe_ok") is not True
        or probe.get("one_chat_project") not in one_chat_vertex_projects()
    ):
        raise retention.UnsafeState("One chat receipt does not prove a healthy backend promotion")
    owner_run_id, owner = prior_healthy_uat_release(
        repository, run, directory, frontend_owner=True
    )
    frontend = owner["final"]["frontend_revision"]
    if not re.fullmatch(r"hushh-webapp-[a-z0-9-]+", str(frontend)):
        raise retention.UnsafeState("prior UAT source lacks a valid frontend revision")
    return {
        "status": "healthy",
        "scope": "backend",
        "sha": sha,
        "final": {
            "backend_revision": candidate,
            "backend_sha": sha,
            "frontend_revision": frontend,
            "frontend_sha": owner["sha"],
        },
        "predeploy": {"backend_revision": old, "frontend_revision": frontend},
        "_maintenance_lane_provenance": {
            "backend": {
                "run_id": run_id,
                "sha": sha,
                "source": "deploy-uat-one-chat",
            },
            "frontend": {"run_id": owner_run_id, "sha": owner["sha"]},
        },
    }


def verify_uat_partial_failure(
    repository: str,
    run: dict,
    release: dict,
    directory: Path,
    *,
    candidate_runs: list[dict] | None = None,
    depth: int = 0,
) -> None:
    """Only a passkey-only frontend rollback with a proven backend may maintain UAT."""
    previous_run_id, previous = prior_healthy_uat_release(
        repository, run, directory, frontend_owner=True
    )
    previous_backend_run_id, previous_backend = prior_healthy_uat_backend_release(
        repository, run, directory, candidate_runs=candidate_runs, depth=depth
    )
    if any(
        not isinstance(release.get(name), dict)
        for name in ("final", "current", "predeploy", "rollback_targets", "verification")
    ):
        raise retention.UnsafeState("UAT partial artifact is incomplete")
    final = release.get("final") or {}
    current = release.get("current") or {}
    predeploy = release.get("predeploy") or {}
    targets = release.get("rollback_targets") or {}
    verification = release.get("verification") or {}
    if (
        release.get("status") != "rolled_back"
        or release.get("scope") != "all"
        or not re.fullmatch(r"[a-f0-9]{40}", str(release.get("sha", "")))
        or verification.get("blocking_classifications") != "passkey_domain_association_failed"
        or any(
            verification.get(name) != "success"
            for name in ("backend_provenance", "frontend_provenance", "db_contract")
        )
        or any(
            verification.get(name) != "true"
            for name in ("parity_success", "provenance_success", "semantic_success")
        )
        or final.get("backend_revision") != current.get("backend_candidate_revision")
        or final.get("backend_revision") != current.get("backend_revision")
        or final.get("backend_revision") == predeploy.get("backend_revision")
        or predeploy.get("backend_revision") != previous_backend["final"].get("backend_revision")
        or not re.fullmatch(
            r"consent-protocol-[a-z0-9-]+", str(predeploy.get("backend_revision", ""))
        )
        or final.get("backend_sha") != release["sha"]
        or final.get("frontend_revision") != predeploy.get("frontend_revision")
        or final.get("frontend_revision") != previous["final"]["frontend_revision"]
        or final.get("frontend_sha") != previous["sha"]
        or final.get("frontend_sha") != previous["final"]["frontend_sha"]
        or current.get("frontend_candidate_revision") == final.get("frontend_revision")
        or not re.fullmatch(
            r"hushh-webapp-[a-z0-9-]+",
            str(current.get("frontend_candidate_revision", "")),
        )
        or targets.get("backend_revision") != predeploy.get("backend_revision")
        or targets.get("frontend_revision") != final.get("frontend_revision")
    ):
        raise retention.UnsafeState("UAT failure is not the verified passkey-only partial rollback")
    # This context is computed from two trusted runs; artifacts cannot supply it.
    release["_maintenance_lane_provenance"] = {
        "backend": {"run_id": run["id"], "sha": release["sha"]},
        "frontend": {"run_id": previous_run_id, "sha": previous["sha"]},
    }
    if previous_backend["status"] == "rolled_back":
        release["_maintenance_prior_backend_provenance"] = {
            "revision": previous_backend["final"]["backend_revision"],
            "run_id": previous_backend_run_id,
            "sha": previous_backend["sha"],
        }


def prove_frontend_inherited_backend(
    repository: str, run: dict, release: dict, directory: Path
) -> None:
    """Bind an unchanged backend and its rollback anchor to its prior owner."""
    owner_run_id, owner = prior_healthy_uat_backend_release(
        repository, run, directory
    )
    final = release.get("final")
    current = release.get("current")
    predeploy = release.get("predeploy")
    verification = release.get("verification")
    owner_final = owner.get("final")
    owner_predeploy = owner.get("predeploy")
    if not all(
        isinstance(part, dict)
        for part in (final, current, predeploy, verification, owner_final, owner_predeploy)
    ):
        raise retention.UnsafeState("frontend-only UAT backend lineage is incomplete")
    inherited = owner_final.get("backend_revision")
    rollback = owner_predeploy.get("backend_revision")
    if (
        release.get("status") != "healthy"
        or release.get("scope") != "frontend"
        or not re.fullmatch(r"[a-f0-9]{40}", str(release.get("sha")))
        or owner.get("status") not in {"healthy", "rolled_back"}
        or owner.get("scope") not in {"all", "backend"}
        or not re.fullmatch(r"consent-protocol-[a-z0-9-]+", str(inherited))
        or not re.fullmatch(r"consent-protocol-[a-z0-9-]+", str(rollback))
        or rollback == inherited
        or any(
            state.get("backend_revision") != inherited
            for state in (predeploy, current, final)
        )
        or current.get("backend_candidate_revision") not in (None, "")
        or final.get("backend_sha") != owner_final.get("backend_sha")
        or final.get("backend_sha") != owner.get("sha")
        or final.get("frontend_sha") != release.get("sha")
        or verification.get("frontend_provenance") != "success"
        or verification.get("parity_success") != "true"
        or verification.get("semantic_success") != "true"
        or verification.get("blocking_classifications") != ""
    ):
        raise retention.UnsafeState(
            "frontend-only UAT release lacks a verified inherited backend owner"
        )
    provenance = (owner.get("_maintenance_lane_provenance") or {}).get("backend")
    if provenance is None:
        provenance = {"run_id": owner_run_id, "sha": owner["sha"]}
    if (
        not isinstance(provenance, dict)
        or provenance.get("run_id") != owner_run_id
        or provenance.get("sha") != owner["sha"]
    ):
        raise retention.UnsafeState("inherited backend provenance is invalid")
    # Internal context comes from independently governed release history.
    # The frontend artifact cannot nominate its own backend rollback target.
    release["_maintenance_lane_provenance"] = {
        "backend": provenance,
        "frontend": {"run_id": run["id"], "sha": release["sha"]},
    }
    release["_maintenance_backend_rollback_revision"] = rollback


def find_release(
    repository: str,
    requested: str,
    directory: Path,
    *,
    require_live: bool = True,
    environment: str = "uat",
    on_phone_rollback=None,
    operational_anchor=None,
) -> tuple[int, dict] | None:
    lane_config = LANES[environment]
    if requested:
        runs = [api(repository, f"runs/{requested}")]
    else:
        if environment == "uat":
            runs = bounded_uat_runs(repository, lane_config["workflow"], "completed")
            runs += bounded_uat_runs(repository, ONE_CHAT_WORKFLOW, "completed")
            runs = list({run["id"]: run for run in runs}.values())
            runs.sort(key=lambda run: int(run["id"]), reverse=True)
        else:
            runs = api(
                repository,
                f"workflows/{lane_config['workflow']}/runs?branch=main&status=completed&per_page=50",
            )["workflow_runs"]
    for run in runs:
        one_chat = environment == "uat" and trusted_origin(
            run, repository, ONE_CHAT_WORKFLOW
        )
        if one_chat:
            if run.get("conclusion") != "success" or run.get("event") != "workflow_dispatch":
                if requested:
                    raise retention.UnsafeState("One chat source is not a successful main deployment")
                continue
            if not governed_dispatch(
                run, repository, environment, workflow=ONE_CHAT_WORKFLOW
            ):
                if requested:
                    raise retention.UnsafeState("One chat source actor is not governed")
                continue
            release = load_one_chat_release(repository, run, directory)
            if release is None:
                if requested:
                    raise retention.UnsafeState("One chat source has no release receipt")
                continue
            if requested or not require_live or live_release_matches(release):
                return run["id"], release
            continue
        cleanup_failed = environment == "production" and run.get("conclusion") == "failure"
        partial_failed = environment == "uat" and run.get("conclusion") == "failure"
        if (
            not trusted_origin(run, repository, lane_config["workflow"])
            or (run.get("conclusion") != "success" and not cleanup_failed and not partial_failed)
            or run.get("event") != "workflow_dispatch"
        ):
            if requested:
                raise retention.UnsafeState(
                    f"source is not an eligible main {environment} deployment"
                )
            continue
        if not governed_dispatch(run, repository, environment):
            if environment == "uat" and not requested:
                # An unauthorized dispatch can fail before it writes a release
                # artifact. It must not prevent a later scan from finding the
                # current, independently verified UAT release.
                continue
            raise retention.UnsafeState(
                f"source deployment actor is not governed for {environment}"
            )
        run_id = run["id"]
        release = load_release(repository, run_id, directory, environment)
        if environment == "production" and release_artifact_receipts.production_evidence_repair_enabled() and not _same_production_run(
            run, uncached_api(repository, f"runs/{run_id}")
        ):
            raise retention.UnsafeState("production source changed during lookup")
        if release is None:
            # Successful NO_OP runs deliberately have no release artifact.
            continue
        if partial_failed:
            try:
                if release.get("status") == "healthy":
                    verify_post_uat_hygiene_failure(repository, run, release)
                    # Local verified context only; artifacts cannot claim it.
                    release["_maintenance_source_run"] = run_id
                else:
                    verify_uat_partial_failure(repository, run, release, directory)
            except retention.UnsafeState:
                if requested:
                    raise
                continue
        elif environment == "production" and release.get("status") == "pending_activation":
            release["_maintenance_pending_retirement"] = production_retention_context.pending(
                sys.modules[__name__], repository, run, release, operational_anchor)
        elif release.get("status") != "healthy":
            if requested:
                raise retention.UnsafeState("source release artifact is not healthy")
            continue
        release_artifact_receipts.validate_revision_names(release)
        if environment == "uat" and release.get("scope") == "frontend":
            prove_frontend_inherited_backend(repository, run, release, directory)
        if cleanup_failed:
            verify_post_release_failure(repository, run, release)
            # Local verified context only; never accepted from an artifact.
            release["_maintenance_source_run"] = run_id
        restoration_continuation = environment == "production" and "restoration_activation" in release
        if restoration_continuation:
            # This verifier did not deploy the serving pair. Derive its original
            # runtime-run identities from the receipt before matching live labels.
            production_retention_context.healthy_phone(
                sys.modules[__name__], repository, run, release, lane_config, on_phone_rollback)
        if requested or not require_live or live_release_matches(release, environment=environment):
            if not restoration_continuation:
                production_retention_context.healthy_phone(
                    sys.modules[__name__], repository, run, release, lane_config, on_phone_rollback)
            return run_id, release
    return None


def bounded_artifacts(repository: str, artifact: str) -> Iterator[dict]:
    """Bound history traversal without hiding older completed drain evidence."""
    for page in range(1, 11):
        result = api(repository, f"artifacts?name={artifact}&per_page=100&page={page}")
        rows = result.get("artifacts")
        if not isinstance(rows, list):
            raise retention.UnsafeState("invalid retention artifact inventory")
        yield from rows
        if len(rows) < 100:
            return
    raise retention.UnsafeState("retention artifact history exceeds bounded lookup")


def _github_timestamp(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        timestamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return timestamp if timestamp.tzinfo is not None else None


def trusted_pending_uat_state(repository: str, run: dict, artifact: dict) -> bool:
    """Trust a completed UAT first pass while its workflow waits for drainage."""
    if (
        run.get("path") != ".github/workflows/capacity-maintenance.yml"
        or run.get("head_branch") != "main"
        # GitHub can mark the workflow queued again after the drain wait
        # finishes and before its recheck job gets a runner. The successful
        # first-pass jobs and immutable artifact still prove this receipt.
        or run.get("status") not in {"in_progress", "queued", "pending"}
        or run.get("conclusion") is not None
        or run.get("event") not in {"workflow_run", "workflow_dispatch", "schedule"}
        or (run.get("repository") or {}).get("full_name") != repository
        or (run.get("head_repository") or {}).get("full_name") != repository
        or type(run.get("id")) is not int
        or run.get("id") != (artifact.get("workflow_run") or {}).get("id")
        or type(run.get("run_attempt")) is not int
        or run["run_attempt"] < 1
        or type(artifact.get("id")) is not int
        or artifact["id"] < 1
        or type(artifact.get("size_in_bytes")) is not int
        or not 0 < artifact["size_in_bytes"] <= 10 * 1024 * 1024
        or not re.fullmatch(r"sha256:[0-9a-f]{64}", str(artifact.get("digest", "")))
    ):
        return False
    result = api(repository, f"runs/{run['id']}/jobs?filter=latest&per_page=100")
    jobs = result.get("jobs")
    if (
        not isinstance(jobs, list)
        or result.get("total_count") != len(jobs)
        or len(jobs) > 100
        or any(not isinstance(job, dict) for job in jobs)
    ):
        return False
    authority = [job for job in jobs if job.get("name") == "Verify cleanup authority and release evidence"]
    first_pass = [job for job in jobs if job.get("name") == "UAT revision maintenance (no drain wait)"]
    if len(authority) != 1 or len(first_pass) != 1:
        return False
    if any(
        job.get("status") != "completed"
        or job.get("conclusion") != "success"
        or job.get("run_attempt") != run["run_attempt"]
        for job in (authority[0], first_pass[0])
    ):
        return False
    steps = first_pass[0].get("steps")
    if not isinstance(steps, list) or any(not isinstance(step, dict) for step in steps):
        return False
    by_name = {step.get("name"): step for step in steps}
    if len(by_name) != len(steps):
        return False
    for name in (
        "Prepare or finish eligible UAT revision cleanup",
        "Save UAT drain evidence for a later maintenance pass",
    ):
        step = by_name.get(name)
        if not step or step.get("status") != "completed" or step.get("conclusion") != "success":
            return False
    saved = by_name["Save UAT drain evidence for a later maintenance pass"]
    created = _github_timestamp(artifact.get("created_at"))
    started = _github_timestamp(saved.get("started_at"))
    completed = _github_timestamp(saved.get("completed_at"))
    return bool(
        created and started and completed
        and started - timedelta(seconds=5) <= created <= completed + timedelta(seconds=30)
    )


def download_pending_uat_state(
    repository: str, artifact: dict, directory: Path, *, environment: str = "uat",
    source_kind: Literal["pending_drain", "saved_checkpoint"] = "pending_drain",
) -> None:
    """Fetch the checked immutable artifact ID, rejecting overwrite and ZIP races.

    A proven saved checkpoint may precede the post-preflight README writer.
    Legacy pending-drain evidence must still contain its README.
    """
    if source_kind not in {"pending_drain", "saved_checkpoint"}:
        raise retention.UnsafeState("checkpoint artifact source kind is invalid")
    if (
        type(artifact.get("id")) is not int
        or artifact["id"] < 1
        or type(artifact.get("size_in_bytes")) is not int
        or not 0 < artifact["size_in_bytes"] <= 10 * 1024 * 1024
        or not re.fullmatch(r"sha256:[0-9a-f]{64}", str(artifact.get("digest", "")))
    ):
        raise retention.UnsafeState("pending checkpoint artifact envelope is invalid")
    response = retention.run_command(
        ["gh", "api", f"repos/{repository}/actions/artifacts/{artifact['id']}/zip"],
        timeout=180,
        text=False,
    )
    archive = response.stdout
    if len(archive) != artifact["size_in_bytes"] or hashlib.sha256(
        archive
    ).hexdigest() != artifact["digest"].removeprefix("sha256:"):
        raise retention.UnsafeState("pending UAT drain artifact digest changed")
    files = release_artifact_receipts.checkpoint_archive(
        archive, LANES[environment]["services"],
        allow_missing_readme=source_kind == "saved_checkpoint",
    )
    for name, content in files.items():
        (directory / name).write_bytes(content)


def carry_earlier_uat_clock(current: Path, older: Path) -> bool:
    """Carry only a clock that covers the same service identity and deletions."""
    latest = json.loads(current.read_text())
    prior = json.loads(older.read_text())
    if not isinstance(latest, dict) or not isinstance(prior, dict):
        raise retention.UnsafeState("invalid UAT drain state history")
    if "clocks" in latest or "clocks" in prior:
        # Only the helper carries a per-revision clock, by proving the revision
        # unchanged in live Cloud Run since the newest receipt. Skipping an
        # older receipt only restarts a revision's drain.
        return False
    identity = (
        "schema_version", "service", "project", "region",
        "fingerprint", "protected",
    )
    if any(latest.get(key) != prior.get(key) for key in identity):
        return False
    for state in (latest, prior):
        run_id = state.get("release_run_id")
        if not isinstance(run_id, str) or not run_id.isdigit() or int(run_id) < 1:
            return False
    newer_revisions = latest.get("revisions")
    older_revisions = prior.get("revisions")
    newer_clock = latest.get("observed_at")
    older_clock = prior.get("observed_at")
    newer_deadline = latest.get("not_before")
    older_deadline = prior.get("not_before")
    if (
        not isinstance(newer_revisions, list)
        or not isinstance(older_revisions, list)
        or any(not isinstance(name, str) for name in newer_revisions + older_revisions)
        or not set(newer_revisions).issubset(older_revisions)
        or any(type(value) is not int or value <= 0 for value in (
            newer_clock, older_clock, newer_deadline, older_deadline
        ))
        or newer_deadline < newer_clock
        or older_deadline < older_clock
    ):
        return False
    if older_clock < newer_clock:
        latest["observed_at"] = older_clock
        # The helper recomputes the required timeout under the live service
        # fingerprint before deleting. An earlier due receipt only wakes it.
        latest["not_before"] = min(newer_deadline, older_deadline)
        current.write_text(json.dumps(latest, indent=2) + "\n")
    return True


def trusted_checkpoint_run(repository: str, run: dict, environment: str, artifact: dict | None = None) -> bool:
    if (
        run.get("path") != ".github/workflows/capacity-maintenance.yml"
        or run.get("head_branch") != "main"
        # repository_dispatch is the hourly clock's tick: the scheduled pass,
        # queued by the previous pass (capacity-maintenance.yml `next-pass`).
        or run.get("event") not in {"schedule", "repository_dispatch", "workflow_dispatch"}
        or (run.get("repository") or {}).get("full_name") != repository
        or (run.get("head_repository") or {}).get("full_name") != repository
    ):
        return False
    attempt = run.get("run_attempt", 1)
    if type(attempt) is not int or not 1 <= attempt <= 10:
        raise retention.UnsafeState("maintenance attempt inventory exceeds bounded lookup")
    name = ("UAT" if environment == "uat" else "Production") + " bounded revision cleanup"
    for number in range(attempt, 0, -1):
        endpoint = (f"runs/{run['id']}/jobs?filter=latest&per_page=100" if number == attempt
                    else f"runs/{run['id']}/attempts/{number}/jobs?per_page=100")
        result = api(repository, endpoint)
        jobs = result.get("jobs")
        if not isinstance(jobs, list) or result.get("total_count") != len(jobs):
            raise retention.UnsafeState("maintenance job inventory is incomplete")
        matched = [job for job in jobs if job.get("name") == name]
        if len(matched) != 1 or matched[0].get("status") != "completed":
            continue
        authored = matched[0].get("steps", [])
        steps = {step.get("name"): step for step in authored}
        if len(steps) != len(authored) or not all(steps.get(n, {}).get("conclusion") == "success" for n in (
            "Checkout mutation tooling and rollback history", "Recheck due source under the deployment lock",
            f"Authenticate to {environment}", f"Save {environment} cleanup checkpoint",
        )):
            continue
        if artifact is not None:
            saved = steps[f"Save {environment} cleanup checkpoint"]
            created = _github_timestamp(artifact.get("created_at"))
            started = _github_timestamp(saved.get("started_at"))
            finished = _github_timestamp(saved.get("completed_at"))
            if not (created and started and finished and started - timedelta(seconds=5) <= created <= finished + timedelta(seconds=30)):
                continue
        return True
    return False


def restore_state(
    repository: str, directory: Path, *, environment: str = "uat"
) -> None:
    lane = LANES[environment]
    artifact = lane["state_artifact"]
    artifacts = list(bounded_artifacts(repository, artifact))
    # API listing order is not creation order in either environment.
    if any(_github_timestamp(item.get("created_at")) is None
           for item in artifacts if item.get("name") == artifact and item.get("expired") is False):
        raise retention.UnsafeState("drain artifact has no valid creation time")
    artifacts.sort(key=lambda item: _github_timestamp(item.get("created_at"))
                   or datetime.min.replace(tzinfo=timezone.utc), reverse=True)
    selected = False
    active = {
        service
        for service in lane["services"]
        if (directory / f"{service}.json").exists()
    }
    for item in artifacts:
        if item.get("name") != artifact or item.get("expired") is not False:
            continue
        run_id = (item.get("workflow_run") or {}).get("id")
        if type(run_id) is not int or run_id < 1:
            raise retention.UnsafeState("state artifact lacks a valid source run")
        run = api(repository, f"runs/{run_id}")
        completed = trusted_run(run, repository, "capacity-maintenance.yml")
        needs_attempt_proof = not completed or run.get("run_attempt", 1) > 1
        checkpoint_source = needs_attempt_proof and trusted_checkpoint_run(
            repository, run, environment, item
        )
        if run.get("run_attempt", 1) > 1 and not checkpoint_source:
            raise retention.UnsafeState(
                "Rerun checkpoint cannot be verified; operator reconciliation required"
            )
        completed = (completed and not needs_attempt_proof) or checkpoint_source
        pending_uat = environment == "uat" and trusted_pending_uat_state(
            repository, run, item
        )
        if not completed and not pending_uat:
            continue
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            if pending_uat or checkpoint_source:
                download_pending_uat_state(repository, item, source, environment=environment,
                    source_kind="saved_checkpoint" if checkpoint_source else "pending_drain",
                )
            else:
                download(repository, run["id"], artifact, source)
            if not selected and environment == "uat":
                receipt = source / "completed.json"
                if not receipt.is_file() or receipt.is_symlink():
                    raise retention.UnsafeState(
                        "UAT drain artifact lacks a regular completion receipt"
                    )
                source_states = {
                    service
                    for service in lane["services"]
                    if (source / f"{service}.json").is_file()
                    and not (source / f"{service}.json").is_symlink()
                }
                if (
                    not source_states
                    and json.loads(receipt.read_text()).get("pass_status", "complete")
                    == "complete"
                ):
                    # A newer successful empty pass supersedes even preseeded
                    # state from this workflow's earlier first pass.
                    for service in lane["services"]:
                        destination = directory / f"{service}.json"
                        if destination.is_symlink():
                            raise retention.UnsafeState(
                                "preseeded retention state is a symlink"
                            )
                        destination.unlink(missing_ok=True)
                    destination = directory / "completed.json"
                    if destination.is_symlink():
                        raise retention.UnsafeState(
                            "preseeded retention state is a symlink"
                        )
                    shutil.copyfile(receipt, destination)
                    return
            if selected:
                for service in tuple(active):
                    earlier = source / f"{service}.json"
                    if (
                        not earlier.is_file()
                        or earlier.is_symlink()
                        or not carry_earlier_uat_clock(
                            directory / earlier.name, earlier
                        )
                    ):
                        active.remove(service)
                if not active:
                    return
                continue
            for name in [
                *(f"{service}.json" for service in lane["services"]),
                "completed.json",
            ]:
                state = source / name
                if state.is_file() and not state.is_symlink():
                    destination = directory / state.name
                    if destination.is_symlink():
                        raise retention.UnsafeState(
                            "preseeded retention state is a symlink"
                        )
                    # The final job in this workflow can preseed the state it
                    # just uploaded. An older completed run cannot replace its
                    # observed drain clock; the retention helper checks the
                    # preseeded state against live service identity before use.
                    if not destination.exists():
                        shutil.copyfile(state, destination)
            selected = True
            if environment == "production":
                return
            active = {
                service
                for service in lane["services"]
                if (directory / f"{service}.json").exists()
            }
            if not active:
                # A newer empty pass must supersede older pending receipts.
                return


def latest_deploy_observation(repository: str, environment: str) -> int:
    """A completed run triggers inspection, never grants deletion authority."""
    workflow = LANES[environment]["workflow"]
    workflows = {workflow}
    if environment == "uat":
        workflows.add(ONE_CHAT_WORKFLOW)
    runs = []
    for name in sorted(workflows):
        result = api(
            repository,
            f"workflows/{name}/runs?branch=main&status=completed&per_page=50",
        )
        batch = result.get("workflow_runs")
        if not isinstance(batch, list) or any(not isinstance(run, dict) for run in batch):
            raise retention.UnsafeState("deployment observation inventory is invalid")
        runs.extend(batch)
    runs.sort(key=lambda run: int(run["id"]), reverse=True)
    for run in runs:
        if (
            run.get("path") in {f".github/workflows/{name}" for name in workflows}
            and run.get("head_branch") == "main"
            and run.get("status") == "completed"
            and run.get("event") == "workflow_dispatch"
            and (run.get("repository") or {}).get("full_name") == repository
            and (run.get("head_repository") or {}).get("full_name") == repository
        ):
            return int(run["id"])
    raise retention.UnsafeState("no completed deployment observation")


def completion_receipt(directory: Path, environment: str) -> dict | None:
    return importlib.import_module("retention_publication").completion_receipt(sys.modules[__name__], directory, environment)


def maintenance_due(
    repository: str,
    directory: Path,
    *,
    environment: str,
    release_run_id: int | None = None,
    restore: bool = True,
) -> bool:
    """Inspect only changed, unfinished or due retention receipts."""
    if restore:
        restore_state(repository, directory, environment=environment)
    completed = completion_receipt(directory, environment)
    if completed is None or completed.get("pass_status", "complete") != "complete":
        return True
    observed = latest_deploy_observation(repository, environment)
    if (
        release_run_id is not None and completed["release_run_id"] != release_run_id
    ) or completed["observed_run_id"] != observed:
        return True
    for service in LANES[environment]["services"]:
        path = directory / f"{service}.json"
        if not path.exists():
            continue
        state = json.loads(path.read_text())
        if (
            not isinstance(state, dict)
            or state.get("project") != completed["project"]
            or state.get("service") != service
            or state.get("region") != REGION
            or state.get("release_run_id") != str(completed["release_run_id"])
            or type(state.get("not_before")) is not int
        ):
            raise retention.UnsafeState(f"invalid {environment} drain receipt")
        if state["not_before"] <= time.time():
            return True
    return False


def production_maintenance_due(repository: str, directory: Path) -> bool:
    """Compatibility entrypoint for production source-only checks."""
    return maintenance_due(repository, directory, environment="production")


def live_release_matches(release: dict, *, environment: str = "uat") -> bool:
    if environment == "production" and "_maintenance_backend_identity" in release:
        production_retention_context.backend_identity(sys.modules[__name__], release["_maintenance_backend_identity"])
    if environment == "production" and "_maintenance_pending_retirement" in release:
        production_retention_context.pending_live(sys.modules[__name__], release, release["_maintenance_pending_retirement"])
    project = LANES[environment]["project"]
    for service, lane in (
        ("consent-protocol", "backend"),
        ("hushh-webapp", "frontend"),
    ):
        state = retention.service_state(service, project, REGION)
        serving = production_retention_context.serving(sys.modules[__name__], state)
        if serving != {release["final"][f"{lane}_revision"]}:
            return False
        provenance = (release.get("_maintenance_lane_provenance") or {}).get(lane)
        if "_maintenance_source_run" in release:
            provenance = {
                "run_id": release["_maintenance_source_run"],
                "sha": release["sha"],
            }
        if provenance:
            traffic = [
                (name, percent)
                for name, percent, _ in retention.traffic_state(state)
                if percent
            ]
            if traffic != [(release["final"][f"{lane}_revision"], 100)]:
                return False
            revisions = retention.revision_state(service, project, REGION)
            matches = [
                item
                for item in revisions
                if item.get("metadata", {}).get("name") in serving
            ]
            if len(matches) != 1:
                return False
            identity = (release.get("_maintenance_restoration_runtime") or {}).get(lane)
            if not production_retention_context.selected_revision_matches(
                state, matches[0], provenance, identity=identity
            ):
                return False
    if environment == "production":
        return True
    prior_backend = release.get("_maintenance_prior_backend_provenance")
    if prior_backend is not None:
        if (
            not isinstance(prior_backend, dict)
            or prior_backend.get("revision")
            != release.get("predeploy", {}).get("backend_revision")
            or not re.fullmatch(
                r"consent-protocol-[a-z0-9-]+", str(prior_backend.get("revision", ""))
            )
            or type(prior_backend.get("run_id")) is not int
            or prior_backend["run_id"] < 1
            or not re.fullmatch(r"[a-f0-9]{40}", str(prior_backend.get("sha", "")))
        ):
            return False
        revisions = retention.revision_state("consent-protocol", project, REGION)
        matches = [
            item
            for item in revisions
            if item.get("metadata", {}).get("name") == prior_backend["revision"]
        ]
        if len(matches) > 1:
            return False
        if matches:
            revision = matches[0]
            labels = revision.get("metadata", {}).get("labels") or {}
            containers = revision.get("spec", {}).get("containers") or []
            if len(containers) != 1:
                return False
            container = containers[0]
            env = container.get("env") or []
            deploy_sha = [entry.get("value") for entry in env if entry.get("name") == "HUSHH_DEPLOY_SHA"]
            deploy_source = [
                entry.get("value") for entry in env if entry.get("name") == "HUSHH_DEPLOY_SOURCE"
            ]
            if (
                labels.get("deploy-sha") != prior_backend["sha"]
                or labels.get("github-run-id") != str(prior_backend["run_id"])
                or labels.get("deploy-source") != "deploy-uat"
                or deploy_sha != [prior_backend["sha"]]
                or deploy_source != ["deploy-uat"]
                or not re.fullmatch(
                    r"[^\s]+@sha256:[a-f0-9]{64}", container.get("image", "")
                )
                or not any(
                    condition.get("type") == "Ready" and condition.get("status") == "True"
                    for condition in revision.get("status", {}).get("conditions", [])
                )
            ):
                return False
    state = retention.service_state("consent-protocol-drive-worker", project, REGION)
    if not any(
        c.get("type") == "Ready" and c.get("status") == "True"
        for c in state.get("status", {}).get("conditions", [])
    ):
        raise retention.UnsafeState("Drive worker is not ready")
    if (
        len([name for name, percent, _ in retention.traffic_state(state) if percent])
        != 1
    ):
        raise retention.UnsafeState("Drive worker serving state is ambiguous")
    return True


def release_protection_flags(
    service: str, lane: str, release: dict, *, environment: str = "uat", phone_anchor=None,
    operational_anchor=None,
) -> list[str]:
    return production_retention_context.protection(
        sys.modules[__name__], service, lane, release, environment=environment,
        phone_anchor=phone_anchor, operational_anchor=operational_anchor,
    )


def main() -> int:
    started = time.monotonic()
    deadline = _LOOKUP_DEADLINE.set(started + GITHUB_LOOKUP_SECONDS)
    pass_deadline = started + PASS_SECONDS - 5
    inherited = os.environ.get("HUSSH_RETENTION_DEADLINE_MONOTONIC")
    if inherited is not None:
        inherited_deadline = float(inherited)
        if not math.isfinite(inherited_deadline):
            raise retention.UnsafeState("invalid inherited cleanup deadline")
        pass_deadline = min(pass_deadline, inherited_deadline)
    budget = retention.PASS_DEADLINE.set(pass_deadline)
    cache = _API_CACHE.set({})
    try:
        try:
            return maintenance_pass()
        except retention.BudgetExpired:
            if "--apply" not in sys.argv:
                raise
            output = os.environ.get("GITHUB_OUTPUT")
            if output:
                with Path(output).open("a") as stream:
                    stream.write("cleanup_outcome=deferred\n")
            print(
                "Cleanup budget exhausted before a new mutation; existing checkpoint retained."
            )
            return 0
    finally:
        _API_CACHE.reset(cache)
        retention.PASS_DEADLINE.reset(budget)
        _LOOKUP_DEADLINE.reset(deadline)


def checkpoint(args, run_id, observed, pending, status):
    receipt_file = args.state_dir / "completed.json"
    prior = json.loads(receipt_file.read_text()) if receipt_file.exists() else {}
    bridge = capacity_bridge.receipt_state(prior.get("capacity_bridge"))
    retention.atomic_state(
        receipt_file,
        {
            "schema_version": 1,
            "checkpoint_version": 3 if status == "preparing" else 2,
            "environment": args.environment,
            "project": LANES[args.environment]["project"],
            "release_run_id": run_id,
            "observed_run_id": observed,
            "pass_status": status,
            "pending_services": list(pending),
            **({"capacity_bridge": bridge} if bridge is not None else {}),
            **({"phone_rollback_qualification": args.phone_anchor} if getattr(args, "phone_anchor", None) else {}),
            **({"operational_backend": args.operational_anchor} if isinstance(getattr(args, "operational_anchor", None), dict) else {}),
            **({"pending_retirement": args.pending_context} if isinstance(getattr(args, "pending_context", None), dict) else {}),
            **({"staged_worker_qualification": args.worker_anchor["context"]} if isinstance(getattr(args, "worker_anchor", None), dict) else {}),
        },
    )
    checkpoint_ready()


def checkpoint_ready() -> None:
    output = os.environ.get("GITHUB_OUTPUT")
    if output:
        with Path(output).open("a") as stream:
            stream.write("checkpoint_ready=true\n")


# Capacity Maintenance's run-name for a tick scoped to one environment. Such a
# pass never runs the other environment's verify step, so it cannot attempt
# that environment's cleanup, and the other environment's guard skips it without
# fetching its jobs. Without this, UAT-only clock passes (about 13 a day) would
# lengthen production's walk between production deploys past its 90 s budget.
SCOPED_TICK_TITLES = {
    "uat": "Capacity Maintenance tick (uat)",
    "production": "Capacity Maintenance tick (production)",
}


def guard_only_preflight_proof(repository: str, environment: str, run: dict, job: dict) -> dict | None:
    """Compatibility facade; only the existing pure evidence owner qualifies a proof."""
    try:
        return importlib.import_module("retention_publication").qualify(
            sys.modules[__name__], repository, environment, run, job
        )
    except (retention.UnsafeState, OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        return None


def preflight_release(args: argparse.Namespace, repository: str) -> tuple[int, dict] | None:
    return importlib.import_module("retention_publication").preflight(sys.modules[__name__], args, repository)


def assert_checkpoint_publication(repository: str, environment: str) -> None:
    if environment == "production":
        production_phone_lease.assert_reconciled(repository, api=api, governed=governed_dispatch, timestamp=_github_timestamp, deadline=_LOOKUP_DEADLINE.get())
    publication = importlib.import_module("retention_publication")
    try:
        publication.assert_published(sys.modules[__name__], repository, environment)
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        raise retention.UnsafeState("Maintenance publication proof is unavailable or invalid") from error


def assert_no_pending_mutations(repository, directory, environment):
    assert_checkpoint_publication(repository, environment)
    restore_state(repository, directory, environment=environment)
    receipt = directory / "completed.json"
    if receipt.exists():
        state = json.loads(receipt.read_text())
        bridge = capacity_bridge.receipt_state(state.get("capacity_bridge"))
        if bridge is not None and bridge["status"] != "verified":
            raise retention.UnsafeState("Capacity bridge provider outcome requires maintenance reconciliation")
        if state.get("pass_status", "complete") == "unresolved":
            raise retention.UnsafeState(
                "Cleanup provider outcome is unresolved; reconcile maintenance before deployment"
            )
    for service in LANES[environment]["services"]:
        path = directory / f"{service}.json"
        if (
            path.exists()
            and json.loads(path.read_text()).get("pending_mutation") is not None
        ):
            raise retention.UnsafeState(
                "Cleanup provider outcome is unresolved; reconcile maintenance before deployment"
            )


def record_uat_cleanup_outcome(args: argparse.Namespace, outcome: str) -> None:
    """Expose a recheck result without treating a stale source as an error."""
    if not args.apply:
        return
    output = os.environ.get("GITHUB_OUTPUT")
    if output:
        with Path(output).open("a") as stream:
            stream.write(f"cleanup_outcome={outcome}\n")


def maintenance_cli():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release-run-id", default="")
    parser.add_argument("--state-dir", type=Path, required=True)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--production-capacity-bridge", action="store_true")
    parser.add_argument("--verify-source-only", action="store_true")
    parser.add_argument("--check-mutations", action="store_true")
    parser.add_argument(
        "--force-inspection",
        action="store_true",
        help="Inspect a new requested release or an explicit out-of-band change",
    )
    parser.add_argument("--environment", choices=tuple(LANES), default="uat")
    parser.add_argument("--qualified-cold-checkpoint-run-id", default="")
    parser.add_argument("--operational-backend-proof-run-id", default="")
    parser.add_argument("--operational-backend-proof-attempt", type=production_retention_context.optional_attempt)
    parser.add_argument("--staged-worker-run-id", default="")
    args = parser.parse_args()
    if args.production_capacity_bridge and (args.environment != "production" or not args.apply
            or args.verify_source_only or args.check_mutations or not args.force_inspection
            or os.getenv("GITHUB_EVENT_NAME") != "workflow_dispatch" or os.getenv("GITHUB_REF_NAME") != "main"):
        parser.error("capacity bridge requires explicit manual production apply with forced inspection")
    if (args.verify_source_only or args.check_mutations) and args.apply:
        parser.error("source verification cannot apply cleanup")
    if args.release_run_id and not args.release_run_id.isdigit():
        parser.error("release run ID must be numeric")
    if args.qualified_cold_checkpoint_run_id and (
        args.environment != "production" or not re.fullmatch(r"[1-9][0-9]*", args.qualified_cold_checkpoint_run_id)
        or not args.release_run_id or args.production_capacity_bridge
        or os.getenv("GITHUB_EVENT_NAME") != "workflow_dispatch" or os.getenv("GITHUB_REF_NAME") != "main"
    ):
        parser.error("cold checkpoint requires explicit manual main production with a healthy serving release")
    production_phone_receipt.refuse_advance_checkpoint(args.qualified_cold_checkpoint_run_id)
    production_retention_context.check_inputs(args, parser)
    return args


def maintenance_pass() -> int:
    args = maintenance_cli()
    repository = os.environ["GITHUB_REPOSITORY"]
    lane_config = LANES[args.environment]
    args.state_dir.mkdir(parents=True, exist_ok=True)
    if args.check_mutations:
        assert_no_pending_mutations(repository, args.state_dir, args.environment)
        return 0
    if args.apply:
        assert_checkpoint_publication(repository, args.environment)
        restore_state(repository, args.state_dir, environment=args.environment)
        importlib.import_module("retention_publication").preserve(sys.modules[__name__], args)
    args.operational_anchor = production_retention_context.load_operational(sys.modules[__name__], args)
    args.worker_anchor = production_retention_context.worker(sys.modules[__name__], args, repository)
    if (
        (args.verify_source_only or args.apply)
        and not args.force_inspection
        and not maintenance_due(
            repository,
            args.state_dir,
            environment=args.environment,
            release_run_id=int(args.release_run_id) if args.release_run_id else None,
            restore=not args.apply,
        )
    ):
        output = os.environ.get("GITHUB_OUTPUT")
        if output:
            with Path(output).open("a") as stream:
                stream.write("cleanup_ready=false\n")
        return 0
    found = preflight_release(args, repository)
    if found is None:
        return 0
    run_id, release = found
    observation, service_settings, pending = args.preflight
    # An empty marker makes a completed pass supersede stale earlier artifacts.
    (args.state_dir / "README.txt").write_text(
        f"{args.environment} drain evidence; never deployment authority.\n"
    )
    for service in list(pending):
        if not args.apply:
            break
        try:
            retention.reconcile_mutation(
                args.state_dir / f"{service}.json",
                service,
                lane_config["project"],
                REGION,
            )
        except (retention.BudgetExpired, retention.MutationUncertain) as exc:
            outcome = (
                "unresolved"
                if isinstance(exc, retention.MutationUncertain)
                else "deferred"
            )
            checkpoint(args, run_id, observation, pending, outcome)
            record_uat_cleanup_outcome(args, outcome)
            return 0
    if args.apply and args.environment == "production":
        try:
            capacity_bridge.maintain(release, args.state_dir / "completed.json", create=args.production_capacity_bridge)
        except (retention.BudgetExpired, retention.MutationUncertain) as exc:
            bridge = capacity_bridge.receipt_state(json.loads((args.state_dir / "completed.json").read_text()).get("capacity_bridge"))
            outcome = "unresolved" if isinstance(exc, retention.MutationUncertain) or (bridge is not None and bridge["status"] == "intent" and bridge["requested"]) else "deferred"
            checkpoint(args, run_id, observation, pending, outcome)
            record_uat_cleanup_outcome(args, outcome)
            return 0
    for service, keep in service_settings.items():
        try:
            # The workflow holds the environment's deployment lock for this short pass.
            # Recheck the release before each service as defense against external changes.
            if not live_release_matches(release, environment=args.environment):
                raise retention.UnsafeState("live release changed during maintenance")
            flags = []
            lane = {"consent-protocol": "backend", "hushh-webapp": "frontend"}.get(
                service
            )
            if service == "consent-protocol-drive-worker" and args.environment == "production":
                flags += production_retention_context.worker_flags(sys.modules[__name__], args.worker_anchor)
            if lane:
                flags += release_protection_flags(
                    service, lane, release, environment=args.environment,
                    phone_anchor=args.phone_anchor if lane == "backend" else None,
                    **({"operational_anchor": args.operational_anchor} if args.operational_anchor else {}),
                )
            if args.apply:
                flags += [
                    "--apply",
                    "--defer-state",
                    str(args.state_dir / f"{service}.json"),
                    "--release-run-id",
                    str(run_id),
                ]
                flags += production_retention_context.pending_flags(args.pending_context, args.state_dir) if args.pending_context else ["--healthy"]
                if args.environment == "uat":
                    flags.append("--carry-uat-clock")
            else:
                flags += ["--dry-run"]
            run_retention(
                [
                    sys.executable,
                    "scripts/ci/cloudrun-retention.py",
                    service,
                    REGION,
                    str(keep),
                    *flags,
                    "--project",
                    lane_config["project"],
                ],
            )
        except (retention.BudgetExpired, retention.MutationUncertain) as exc:
            if not args.apply:
                raise
            outcome = (
                "unresolved"
                if isinstance(exc, retention.MutationUncertain)
                else "deferred"
            )
            checkpoint(args, run_id, observation, pending, outcome)
            record_uat_cleanup_outcome(args, outcome)
            print(f"Cleanup {outcome}; checkpoint retained, no completion claimed.")
            return 0
        pending.remove(service)
        if args.apply:
            checkpoint(args, run_id, observation, pending, "in_progress")
    if args.apply and args.environment == "uat":
        deadlines: list[int] = []
        for service in lane_config["services"]:
            state_file = args.state_dir / f"{service}.json"
            if not state_file.exists():
                continue
            if state_file.is_symlink():
                raise retention.UnsafeState("deferred UAT retention state is a symlink")
            state = json.loads(state_file.read_text())
            now = int(time.time())
            # Revisions keep separate deadlines, so the next one can fall due
            # while later services run. Judge a per-revision receipt at its
            # helper's own check, which deleted every revision due by then.
            checked = (
                state.get("checked_at")
                if isinstance(state, dict) and "clocks" in state
                else now
            )
            if (
                not isinstance(state, dict)
                or state.get("schema_version") != 1
                or state.get("service") != service
                or state.get("project") != lane_config["project"]
                or state.get("region") != REGION
                or state.get("release_run_id") != str(run_id)
                or type(checked) is not int
                or checked > now
                or type(state.get("not_before")) is not int
                or state["not_before"] <= checked
                or not isinstance(state.get("revisions"), list)
                or not state["revisions"]
            ):
                raise retention.UnsafeState("invalid pending UAT retention state")
            deadlines.append(state["not_before"])
        output = os.environ.get("GITHUB_OUTPUT")
        if output:
            with Path(output).open("a") as stream:
                stream.write(f"verified_source_run_id={run_id}\n")
                stream.write(
                    f"drain_not_before={max(deadlines) if deadlines else ''}\n"
                )
    if args.apply:
        checkpoint(args, run_id, observation, [], "complete")
        record_uat_cleanup_outcome(args, "applied")
    elif os.environ.get("GITHUB_OUTPUT"):
        with Path(os.environ["GITHUB_OUTPUT"]).open("a") as output:
            output.write("cleanup_outcome=dry_run\n")
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        retry_path = (
            "Pending deletions are retried by hourly scheduled maintenance passes. "
        )
        with Path(summary).open("a") as output:
            output.write(
                f"## {args.environment} revision maintenance\n\nVerified source release: {run_id}. "
                "This pass completes without waiting for requests to drain. "
                f"{retry_path}"
                "Release health is separate.\n"
            )
            if args.apply:
                for service in lane_config["services"]:
                    state_file = args.state_dir / f"{service}.json"
                    if not state_file.exists():
                        continue
                    state = json.loads(state_file.read_text())
                    deadline = state.get("not_before")
                    if not isinstance(deadline, int) or isinstance(deadline, bool):
                        continue
                    due = datetime.fromtimestamp(deadline, timezone.utc).isoformat()
                    output.write(
                        f"- {service}: deletion eligible no earlier than {due}.\n"
                    )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (
        retention.UnsafeState,
        retention.BudgetExpired,
        subprocess.CalledProcessError,
        subprocess.TimeoutExpired,
        ValueError,
        OSError,
        KeyError,
    ) as exc:
        print(f"Hosted maintenance stopped: {exc}", file=sys.stderr)
        sys.exit(1)
