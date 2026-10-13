#!/usr/bin/env python3
"""Short hosted maintenance passes using verified release and drain artifacts."""

from __future__ import annotations

import argparse
import importlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

retention = importlib.import_module("cloudrun-retention")
REGION = "us-central1"
LANES = {
    "uat": {
        "project": "hushh-pda-uat",
        "workflow": "deploy-uat.yml",
        "prefix": "uat",
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
        "state_artifact": "production-retention-state",
        "services": {"consent-protocol": 2, "hushh-webapp": 10},
    },
}
STATE_ARTIFACT = LANES["uat"]["state_artifact"]
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


def command(*args: str) -> str:
    return subprocess.run(
        args, check=True, capture_output=True, text=True, timeout=180
    ).stdout


def api(repository: str, endpoint: str):
    return json.loads(command("gh", "api", f"repos/{repository}/actions/{endpoint}"))


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
    if (
        result.get("total_count") != 2
        or len(jobs) != 2
        or len(by_job) != 2
        or set(by_job) != {"Select UAT target", "Deploy UAT Scope"}
        or by_job["Select UAT target"].get("status") != "completed"
        or by_job["Select UAT target"].get("conclusion") != "success"
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
    result = api(repository, f"runs/{run_id}/artifacts?per_page=100")
    artifacts = result["artifacts"]
    if result.get("total_count", len(artifacts)) != len(artifacts):
        raise retention.UnsafeState("release artifact inventory is incomplete")
    matches = [item for item in artifacts if item.get("name") == name]
    if not matches:
        return False
    if len(matches) != 1 or matches[0].get("expired") is not False:
        raise retention.UnsafeState("release artifact is expired or ambiguous")
    return True


def download(repository: str, run_id: int, name: str, directory: Path) -> None:
    command(
        "gh",
        "run",
        "download",
        str(run_id),
        "--repo",
        repository,
        "--name",
        name,
        "--dir",
        str(directory),
    )


def governed_dispatch(run: dict, repository: str, environment: str) -> bool:
    policy = json.loads(
        (Path(__file__).resolve().parents[2] / "config/ci-governance.json").read_text()
    )
    return (
        trusted_origin(run, repository, LANES[environment]["workflow"])
        and run.get("event") == "workflow_dispatch"
        and (run.get("actor") or {}).get("login")
        in policy[environment]["manual_dispatch_users"]
    )


def load_release(repository: str, run_id: int, directory: Path, environment: str) -> dict | None:
    prefix = LANES[environment]["prefix"]
    name = f"{prefix}-release-{run_id}"
    if not artifact_exists(repository, run_id, name):
        return None
    release_directory = directory / str(run_id)
    status_file = release_directory / f"{prefix}-release-status.json"
    if not status_file.exists():
        download(repository, run_id, name, release_directory)
    if status_file.is_symlink():
        raise retention.UnsafeState("source release artifact is a symlink")
    release = json.loads(status_file.read_text())
    if not isinstance(release, dict):
        raise retention.UnsafeState("source release artifact is invalid")
    if "_maintenance_source_run" in release or "_maintenance_lane_provenance" in release:
        raise retention.UnsafeState("source artifact contains internal maintenance authority")
    return release


def prior_healthy_uat_release(repository: str, failed_run: dict, directory: Path) -> tuple[int, dict]:
    """Find the immediately preceding artifact-backed healthy UAT deployment."""
    runs = api(
        repository,
        "workflows/deploy-uat.yml/runs?branch=main&status=success&per_page=50",
    )["workflow_runs"]
    for run in sorted(runs, key=lambda item: int(item.get("id") or 0), reverse=True):
        if int(run.get("id") or 0) >= failed_run["id"]:
            continue
        if run.get("conclusion") != "success" or not governed_dispatch(run, repository, "uat"):
            raise retention.UnsafeState("prior UAT source is not a governed main deployment")
        release = load_release(repository, run["id"], directory, "uat")
        if release is None:
            # Successful NO_OP runs have no release artifact.
            continue
        if (
            release.get("status") != "healthy"
            or release.get("scope") != "all"
            or not re.fullmatch(r"[a-f0-9]{40}", str(run.get("head_sha", "")))
            or release.get("sha") != run["head_sha"]
            or not isinstance(release.get("final"), dict)
            or release["final"].get("frontend_sha") != release["sha"]
            or release["final"].get("backend_sha") != release["sha"]
        ):
            raise retention.UnsafeState("prior UAT release does not prove frontend health")
        return run["id"], release
    raise retention.UnsafeState("no prior healthy UAT release artifact")


def verify_uat_partial_failure(
    repository: str, run: dict, release: dict, directory: Path
) -> None:
    """Only a passkey-only frontend rollback with a proven backend may maintain UAT."""
    previous_run_id, previous = prior_healthy_uat_release(repository, run, directory)
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
        or not re.fullmatch(r"[a-f0-9]{40}", str(run.get("head_sha", "")))
        or release.get("sha") != run["head_sha"]
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
        or predeploy.get("backend_revision") != previous["final"].get("backend_revision")
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


def find_release(
    repository: str,
    requested: str,
    directory: Path,
    *,
    require_live: bool = True,
    environment: str = "uat",
) -> tuple[int, dict] | None:
    lane_config = LANES[environment]
    if requested:
        runs = [api(repository, f"runs/{requested}")]
    else:
        runs = api(
            repository,
            f"workflows/{lane_config['workflow']}/runs?branch=main&status=completed&per_page=50",
        )["workflow_runs"]
    for run in runs:
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
        elif release.get("status") != "healthy":
            if requested:
                raise retention.UnsafeState("source release artifact is not healthy")
            continue
        for lane, service in (
            ("backend", "consent-protocol"),
            ("frontend", "hushh-webapp"),
        ):
            revision = release.get("final", {}).get(f"{lane}_revision", "")
            pattern = rf"{service}-[a-z0-9-]+"
            if not isinstance(revision, str) or not re.fullmatch(pattern, revision):
                raise retention.UnsafeState(
                    f"source release lacks a valid {lane} revision"
                )
            rollback = release.get("predeploy", {}).get(f"{lane}_revision") or ""
            if rollback and (
                not isinstance(rollback, str) or not re.fullmatch(pattern, rollback)
            ):
                raise retention.UnsafeState(
                    f"source release has invalid {lane} rollback"
                )
        if cleanup_failed:
            verify_post_release_failure(repository, run, release)
            # Local verified context only; never accepted from an artifact.
            release["_maintenance_source_run"] = run_id
        if (
            requested
            or not require_live
            or live_release_matches(release, environment=environment)
        ):
            return run_id, release
    return None


def restore_state(
    repository: str, directory: Path, *, environment: str = "uat"
) -> None:
    lane = LANES[environment]
    artifact = lane["state_artifact"]
    artifacts = api(repository, f"artifacts?name={artifact}&per_page=100")["artifacts"]
    for item in artifacts:
        if item.get("name") != artifact or item.get("expired") is not False:
            continue
        run_id = (item.get("workflow_run") or {}).get("id")
        if type(run_id) is not int or run_id < 1:
            raise retention.UnsafeState("state artifact lacks a valid source run")
        run = api(repository, f"runs/{run_id}")
        if not trusted_run(run, repository, "capacity-maintenance.yml"):
            continue
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            download(repository, run["id"], artifact, source)
            for name in [
                *(f"{service}.json" for service in lane["services"]),
                "completed.json",
            ]:
                state = source / name
                if state.is_file() and not state.is_symlink():
                    destination = directory / state.name
                    if destination.is_symlink():
                        raise retention.UnsafeState("preseeded retention state is a symlink")
                    # The final job in this workflow can preseed the state it
                    # just uploaded. An older completed run cannot replace its
                    # observed drain clock; the retention helper checks the
                    # preseeded state against live service identity before use.
                    if not destination.exists():
                        shutil.copyfile(state, destination)
        return


def latest_deploy_observation(repository: str, environment: str) -> int:
    """A completed run triggers inspection, never grants deletion authority."""
    workflow = LANES[environment]["workflow"]
    runs = api(
        repository,
        f"workflows/{workflow}/runs?branch=main&status=completed&per_page=50",
    )["workflow_runs"]
    for run in runs:
        if (
            run.get("path") == f".github/workflows/{workflow}"
            and run.get("head_branch") == "main"
            and run.get("status") == "completed"
            and run.get("event") == "workflow_dispatch"
            and (run.get("repository") or {}).get("full_name") == repository
            and (run.get("head_repository") or {}).get("full_name") == repository
        ):
            return int(run["id"])
    raise retention.UnsafeState("no completed deployment observation")


def production_maintenance_due(repository: str, directory: Path) -> bool:
    """Avoid cron cloud work after a settled pass; failed first passes retry."""
    observed = latest_deploy_observation(repository, "production")
    restore_state(repository, directory, environment="production")
    receipt = directory / "completed.json"
    if not receipt.exists():
        return True
    completed = json.loads(receipt.read_text())
    if (
        not isinstance(completed, dict)
        or completed.get("schema_version") != 1
        or completed.get("environment") != "production"
        or completed.get("project") != LANES["production"]["project"]
        or type(completed.get("observed_run_id")) is not int
        or type(completed.get("release_run_id")) is not int
        or completed["observed_run_id"] < 1
        or completed["release_run_id"] < 1
    ):
        raise retention.UnsafeState("invalid production completion receipt")
    if completed["observed_run_id"] != observed:
        return True
    for service in LANES["production"]["services"]:
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
            raise retention.UnsafeState("invalid production drain receipt")
        if state["not_before"] <= time.time():
            return True
    return False


def live_release_matches(release: dict, *, environment: str = "uat") -> bool:
    project = LANES[environment]["project"]
    for service, lane in (
        ("consent-protocol", "backend"),
        ("hushh-webapp", "frontend"),
    ):
        state = retention.service_state(service, project, REGION)
        ready = any(
            c.get("type") == "Ready" and c.get("status") == "True"
            for c in state.get("status", {}).get("conditions", [])
        )
        serving = {
            name for name, percent, _ in retention.traffic_state(state) if percent
        }
        if not ready or serving != {release["final"][f"{lane}_revision"]}:
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
            revision = matches[0]
            labels = revision.get("metadata", {}).get("labels") or {}
            containers = revision.get("spec", {}).get("containers") or []
            if len(containers) != 1:
                return False
            container = containers[0]
            deploy_sha = [
                entry.get("value")
                for entry in container.get("env", [])
                if entry.get("name") == "HUSHH_DEPLOY_SHA"
            ]
            if (
                labels.get("deploy-sha") != provenance["sha"]
                or labels.get("github-run-id") != str(provenance["run_id"])
                or deploy_sha != [provenance["sha"]]
                or not re.fullmatch(
                    r"[^\s]+@sha256:[a-f0-9]{64}", container.get("image", "")
                )
                or not any(
                    c.get("type") == "Ready" and c.get("status") == "True"
                    for c in revision.get("status", {}).get("conditions", [])
                )
            ):
                return False
    if environment == "production":
        return True
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
    service: str, lane: str, release: dict, *, environment: str = "uat"
) -> list[str]:
    current = release["final"][f"{lane}_revision"]
    rollback = release.get("predeploy", {}).get(f"{lane}_revision", "")
    known_good = ""
    if environment == "uat":
        tag = subprocess.run(
            ["git", "show-ref", "--verify", "--quiet", "refs/tags/deployed/uat-latest"],
            check=False,
            capture_output=True,
            timeout=30,
        )
        if tag.returncode not in {0, 1}:
            raise retention.UnsafeState("UAT last-known-good tag lookup failed")
    if environment != "uat" or tag.returncode == 0:
        known_good = command(
            "bash", "scripts/ci/resolve-rollback-target.sh", environment, lane
        ).strip()
    present: set[str] = set()
    if rollback or environment == "uat":
        revisions = retention.revision_state(
            service, LANES[environment]["project"], REGION
        )
        present = {item["metadata"]["name"] for item in revisions}
    if rollback:
        if not retention.REVISION_RE.fullmatch(rollback):
            raise retention.UnsafeState("source predeploy revision is invalid")
        if rollback not in present:
            # After rollback, an older release artifact can name a predeploy
            # revision that a later healthy release already retired.
            print(f"Source predeploy revision {rollback} is already absent.")
            rollback = ""
    if known_good not in present and environment == "uat":
        # A tag records a historical revision and can outlive Cloud Run
        # retention. It cannot protect a revision that no longer exists.
        # Preserve an artifact-backed rollback anchor, or the verified live
        # revision when the historical predeploy revision is already absent.
        replacement = rollback or current
        if replacement not in present:
            raise retention.UnsafeState("UAT recovery anchor is absent")
        print(
            f"Tagged last-known-good revision {known_good} is absent; "
            f"protecting verified UAT revision {replacement} instead."
        )
        known_good = replacement
    return [
        current,
        "--rollback-revision",
        rollback,
        "--last-known-good-revision",
        known_good,
    ]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release-run-id", default="")
    parser.add_argument("--state-dir", type=Path, required=True)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--verify-source-only", action="store_true")
    parser.add_argument("--environment", choices=tuple(LANES), default="uat")
    args = parser.parse_args()
    if args.verify_source_only and args.apply:
        parser.error("source verification cannot apply cleanup")
    if args.release_run_id and not args.release_run_id.isdigit():
        parser.error("release run ID must be numeric")
    repository = os.environ["GITHUB_REPOSITORY"]
    lane_config = LANES[args.environment]
    args.state_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as temporary:
        found = find_release(
            repository,
            args.release_run_id,
            Path(temporary),
            require_live=not args.verify_source_only,
            environment=args.environment,
        )
    if args.verify_source_only:
        ready = found is not None
        if ready and args.environment == "production" and not args.release_run_id:
            ready = production_maintenance_due(repository, args.state_dir)
        output = os.environ.get("GITHUB_OUTPUT")
        if output:
            with Path(output).open("a") as stream:
                stream.write(f"cleanup_ready={str(ready).lower()}\n")
        return 0
    if found is None:
        print("No eligible release artifact (or NO_OP source); no cleanup authorized.")
        return 0
    run_id, release = found
    if not live_release_matches(release, environment=args.environment):
        print(
            f"Release {run_id} no longer matches live traffic; skipping stale maintenance."
        )
        return 0
    # An empty marker makes a completed pass supersede stale earlier artifacts.
    (args.state_dir / "README.txt").write_text(
        f"{args.environment} drain evidence; never deployment authority.\n"
    )
    if args.apply:
        restore_state(repository, args.state_dir, environment=args.environment)
    for service, keep in lane_config["services"].items():
        # The workflow holds the environment's deployment lock for this short pass.
        # Recheck the release before each service as defense against external changes.
        if not live_release_matches(release, environment=args.environment):
            raise retention.UnsafeState("live release changed during maintenance")
        flags = []
        lane = {"consent-protocol": "backend", "hushh-webapp": "frontend"}.get(service)
        if lane:
            flags += release_protection_flags(
                service, lane, release, environment=args.environment
            )
        if args.apply:
            flags += [
                "--apply",
                "--healthy",
                "--defer-state",
                str(args.state_dir / f"{service}.json"),
                "--release-run-id",
                str(run_id),
            ]
        else:
            flags += ["--dry-run"]
        subprocess.run(
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
            check=True,
            timeout=600,
        )
    if args.apply and args.environment == "production":
        (args.state_dir / "completed.json").write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "environment": args.environment,
                    "project": lane_config["project"],
                    "release_run_id": run_id,
                    "observed_run_id": latest_deploy_observation(
                        repository, args.environment
                    ),
                }
            )
            + "\n"
        )
    if args.apply and args.environment == "uat":
        deadlines: list[int] = []
        for service in lane_config["services"]:
            state_file = args.state_dir / f"{service}.json"
            if not state_file.exists():
                continue
            if state_file.is_symlink():
                raise retention.UnsafeState("deferred UAT retention state is a symlink")
            state = json.loads(state_file.read_text())
            if (
                not isinstance(state, dict)
                or state.get("schema_version") != 1
                or state.get("service") != service
                or state.get("project") != lane_config["project"]
                or state.get("region") != REGION
                or state.get("release_run_id") != str(run_id)
                or type(state.get("not_before")) is not int
                or state["not_before"] <= int(time.time())
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
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with Path(summary).open("a") as output:
            output.write(
                f"## {args.environment} revision maintenance\n\nVerified source release: {run_id}. "
                "This pass completes without waiting for requests to drain. "
                "Pending UAT deletions receive a timed follow-up and scheduled maintenance remains a backup. "
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
                    output.write(f"- {service}: deletion eligible no earlier than {due}.\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (
        retention.UnsafeState,
        subprocess.CalledProcessError,
        subprocess.TimeoutExpired,
        ValueError,
        OSError,
        KeyError,
    ) as exc:
        print(f"Hosted maintenance stopped: {exc}", file=sys.stderr)
        sys.exit(1)
