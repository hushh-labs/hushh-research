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
            f"workflows/{lane_config['workflow']}/runs?branch=main&status=success&per_page=50",
        )["workflow_runs"]
    for run in runs:
        if (
            not trusted_run(run, repository, lane_config["workflow"])
            or run.get("event") != "workflow_dispatch"
        ):
            if requested:
                raise retention.UnsafeState(
                    f"source is not a successful main {environment} deployment"
                )
            continue
        actor = (run.get("actor") or {}).get("login")
        policy = json.loads(
            (
                Path(__file__).resolve().parents[2] / "config/ci-governance.json"
            ).read_text()
        )
        if actor not in policy[environment]["manual_dispatch_users"]:
            raise retention.UnsafeState(
                f"source deployment actor is not governed for {environment}"
            )
        run_id = run["id"]
        name = f"{lane_config['prefix']}-release-{run_id}"
        if not artifact_exists(repository, run_id, name):
            # Successful NO_OP runs deliberately have no release artifact.
            continue
        release_directory = directory / str(run_id)
        download(repository, run_id, name, release_directory)
        release = json.loads(
            (
                release_directory / f"{lane_config['prefix']}-release-status.json"
            ).read_text()
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
                    shutil.copyfile(state, directory / state.name)
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
    known_good = command(
        "bash", "scripts/ci/resolve-rollback-target.sh", environment, lane
    ).strip()
    if rollback:
        if not retention.REVISION_RE.fullmatch(rollback):
            raise retention.UnsafeState("source predeploy revision is invalid")
        revisions = retention.revision_state(
            service, LANES[environment]["project"], REGION
        )
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
        print("No healthy release artifact (or NO_OP source); no cleanup authorized.")
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
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with Path(summary).open("a") as output:
            output.write(
                f"## {args.environment} revision maintenance\n\nSource healthy release: {run_id}. "
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
        print(f"Hosted maintenance stopped: {exc}", file=sys.stderr)
        sys.exit(1)
