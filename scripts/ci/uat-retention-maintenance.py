#!/usr/bin/env python3
"""Short UAT maintenance passes using verified release and drain artifacts."""

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
from pathlib import Path

retention = importlib.import_module("cloudrun-retention")
PROJECT = "hushh-pda-uat"
REGION = "us-central1"
STATE_ARTIFACT = "uat-retention-state"
SERVICES = {
    "consent-protocol": 2,
    "hushh-webapp": 10,
    "consent-protocol-drive-worker": 2,
}


def command(*args: str) -> str:
    return subprocess.run(
        args, check=True, capture_output=True, text=True, timeout=180
    ).stdout


def api(repository: str, endpoint: str):
    return json.loads(command("gh", "api", f"repos/{repository}/actions/{endpoint}"))


def trusted_run(run: dict, repository: str, workflow: str) -> bool:
    return (
        run.get("path") == f".github/workflows/{workflow}"
        and run.get("head_branch") == "main"
        and run.get("status") == "completed"
        and run.get("conclusion") == "success"
        and (run.get("repository") or {}).get("full_name") == repository
        and (run.get("head_repository") or {}).get("full_name") == repository
    )


def artifact_exists(repository: str, run_id: int, name: str) -> bool:
    artifacts = api(repository, f"runs/{run_id}/artifacts?per_page=100")["artifacts"]
    return any(item["name"] == name and not item["expired"] for item in artifacts)


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


def find_release(
    repository: str, requested: str, directory: Path, *, require_live: bool = True
) -> tuple[int, dict] | None:
    if requested:
        runs = [api(repository, f"runs/{requested}")]
    else:
        runs = api(
            repository,
            "workflows/deploy-uat.yml/runs?branch=main&status=success&per_page=50",
        )["workflow_runs"]
    for run in runs:
        if (
            not trusted_run(run, repository, "deploy-uat.yml")
            or run.get("event") != "workflow_dispatch"
        ):
            if requested:
                raise retention.UnsafeState(
                    "source is not a successful main UAT deployment"
                )
            continue
        actor = (run.get("actor") or {}).get("login")
        policy = json.loads(
            (
                Path(__file__).resolve().parents[2] / "config/ci-governance.json"
            ).read_text()
        )
        if actor not in policy["uat"]["manual_dispatch_users"]:
            raise retention.UnsafeState(
                "source deployment actor is not governed for UAT"
            )
        run_id = run["id"]
        name = f"uat-release-{run_id}"
        if not artifact_exists(repository, run_id, name):
            # Successful NO_OP runs deliberately have no release artifact.
            continue
        release_directory = directory / str(run_id)
        download(repository, run_id, name, release_directory)
        release = json.loads(
            (release_directory / "uat-release-status.json").read_text()
        )
        if release.get("status") != "healthy":
            raise retention.UnsafeState("source release artifact is not healthy")
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
        if requested or not require_live or live_release_matches(release):
            return run_id, release
    return None


def restore_state(repository: str, directory: Path) -> None:
    runs = api(
        repository,
        "workflows/capacity-maintenance.yml/runs?branch=main&status=success&per_page=100",
    )["workflow_runs"]
    for run in runs:
        if not trusted_run(run, repository, "capacity-maintenance.yml"):
            continue
        if not artifact_exists(repository, run["id"], STATE_ARTIFACT):
            continue
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            download(repository, run["id"], STATE_ARTIFACT, source)
            for service in SERVICES:
                state = source / f"{service}.json"
                if state.is_file() and not state.is_symlink():
                    shutil.copyfile(state, directory / state.name)
        return


def live_release_matches(release: dict) -> bool:
    for service, lane in (
        ("consent-protocol", "backend"),
        ("hushh-webapp", "frontend"),
    ):
        state = retention.service_state(service, PROJECT, REGION)
        ready = any(
            c.get("type") == "Ready" and c.get("status") == "True"
            for c in state.get("status", {}).get("conditions", [])
        )
        serving = {
            name for name, percent, _ in retention.traffic_state(state) if percent
        }
        if not ready or serving != {release["final"][f"{lane}_revision"]}:
            return False
    state = retention.service_state("consent-protocol-drive-worker", PROJECT, REGION)
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


def release_protection_flags(service: str, lane: str, release: dict) -> list[str]:
    current = release["final"][f"{lane}_revision"]
    rollback = release.get("predeploy", {}).get(f"{lane}_revision", "")
    known_good = command(
        "bash", "scripts/ci/resolve-rollback-target.sh", "uat", lane
    ).strip()
    if rollback:
        if not retention.REVISION_RE.fullmatch(rollback):
            raise retention.UnsafeState("source predeploy revision is invalid")
        revisions = retention.revision_state(service, PROJECT, REGION)
        present = {item["metadata"]["name"] for item in revisions}
        if rollback not in present:
            # After rollback, an older release artifact can name a predeploy
            # revision that a later healthy release already retired.
            print(f"Source predeploy revision {rollback} is already absent.")
            rollback = ""
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
    args = parser.parse_args()
    if args.verify_source_only and args.apply:
        parser.error("source verification cannot apply cleanup")
    if args.release_run_id and not args.release_run_id.isdigit():
        parser.error("release run ID must be numeric")
    repository = os.environ["GITHUB_REPOSITORY"]
    args.state_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as temporary:
        found = find_release(
            repository,
            args.release_run_id,
            Path(temporary),
            require_live=not args.verify_source_only,
        )
    if args.verify_source_only:
        output = os.environ.get("GITHUB_OUTPUT")
        if output:
            with Path(output).open("a") as stream:
                stream.write(f"cleanup_ready={str(found is not None).lower()}\n")
        return 0
    if found is None:
        print("No healthy release artifact (or NO_OP source); no cleanup authorized.")
        return 0
    run_id, release = found
    if not live_release_matches(release):
        print(
            f"Release {run_id} no longer matches live traffic; skipping stale maintenance."
        )
        return 0
    # An empty marker makes a completed pass supersede stale earlier artifacts.
    (args.state_dir / "README.txt").write_text(
        "UAT drain evidence; never deployment authority.\n"
    )
    if args.apply:
        restore_state(repository, args.state_dir)
    for service, keep in SERVICES.items():
        # The workflow holds the deploy-uat mutation lock for this short pass.
        # Recheck the release before each service as defense against external changes.
        if not live_release_matches(release):
            raise retention.UnsafeState("live release changed during maintenance")
        flags = []
        lane = {"consent-protocol": "backend", "hushh-webapp": "frontend"}.get(service)
        if lane:
            flags += release_protection_flags(service, lane, release)
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
                PROJECT,
            ],
            check=True,
            timeout=600,
        )
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with Path(summary).open("a") as output:
            output.write(
                f"## UAT revision maintenance\n\nSource healthy release: {run_id}. "
                "This pass completes without waiting for requests to drain. "
                "Pending deletions are retried by scheduled maintenance; release health is separate.\n"
            )
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
        print(f"UAT maintenance stopped: {exc}", file=sys.stderr)
        sys.exit(1)
