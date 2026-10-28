"""Fixed private fixture io capability; no independent release authority."""

from __future__ import annotations

import hashlib
import json
import os
import sys
import subprocess
from datetime import datetime, timezone
from pathlib import Path
import frontend_fixture_runtime as runtime
import frontend_hosted_caller as caller
import frontend_release as release
import frontend_secret_inventory as secrets

LIMIT = 4 * 1024 * 1024


def write(folder, name, value):
    with (folder / (name + ".json")).open("x", encoding="utf-8") as stream:
        json.dump(value, stream, sort_keys=True)
        stream.write("\n")


def load(folder, name):
    path = folder / (name + ".json")
    release.require(
        path.is_file() and path.stat().st_size <= LIMIT, "Fixture checkpoint invalid"
    )
    value = json.loads(
        path.read_bytes(), object_pairs_hook=release.source.backend._json_pairs
    )
    release.require(isinstance(value, dict), "Fixture checkpoint invalid")
    return value


def folder_for(attempt):
    root = Path(os.environ.get("RUNNER_TEMP", "")).resolve(strict=True)
    release.require(
        root.is_absolute() and str(root) == os.environ.get("RUNNER_TEMP"),
        "Fixture runner directory invalid",
    )
    return (
        root
        / f"plg-frontend-preflight-{attempt.environment}-{attempt.run_id}-{attempt.run_attempt}"
    )


def originals(attempt):
    git = release.source.backend._git
    return (
        git("show", f"{attempt.workflow_sha}:deploy/frontend-image.cloudbuild.yaml"),
        {
            name: git("show", f"{attempt.workflow_sha}:{name}")
            for name in release.OVERLAYS
        },
    )


def inspect_inputs(attempt, folder):
    prepared = load(folder, "prepared")
    recipe = (folder / "build.yaml").read_bytes()
    snapshot = secrets.snapshot(attempt.environment, fixture_backend=True)
    original_recipe, original_overlays = originals(attempt)
    release.require(
        prepared.get("authorityFiles") == release.reviewed_inputs(attempt)
        and isinstance(prepared.get("fixtureRuntime"), dict)
        and release.frontend_validation.verify(
            prepared.get("sourceValidation", {}).get("runId"), release.SOURCE
        )
        == prepared.get("sourceValidation"),
        "Fixture source or runtime changed",
    )
    intent = caller.proposed_build_intent(
        attempt, prepared, snapshot, recipe, original_recipe, original_overlays
    )
    release.require(intent == load(folder, "intent"), "Fixture build intent changed")
    digest = hashlib.sha256()
    with (folder / "source.tar.gz").open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    release.require(
        digest.hexdigest() == prepared["archive"]["archiveSha256"],
        "Fixture archive changed",
    )
    return prepared, recipe, snapshot, original_recipe, original_overlays


def fingerprint(service):
    from frontend_fixture_candidate import stable

    return (
        None
        if service is None
        else stable(service)
        | {
            "templateSha256": runtime.digest(
                runtime.encode(service["spec"]["template"])
            ),
        }
    )


def capacity(attempt):
    result = subprocess.run(
        [
            sys.executable,
            str(release.ROOT / "scripts/ci/runtime-capacity-budget.py"),
            "--environment",
            attempt.environment,
            "--candidate-service",
            runtime.SERVICE,
            "--output",
            "json",
        ],
        capture_output=True,
        check=False,
        timeout=300,
        cwd=release.ROOT,
    )
    release.require(
        result.returncode == 0 and 0 < len(result.stdout) <= LIMIT,
        "Fixture capacity not admitted",
    )
    json.loads(result.stdout)
    return {
        "status": "admitted",
        "reportSha256": runtime.digest(result.stdout),
        "observedAt": datetime.now(timezone.utc).isoformat(),
    }
