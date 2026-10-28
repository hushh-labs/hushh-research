"""Prepare fixed frontend build inputs; this grants no deployment authority.

The executable archive mixes the exact recorded application with two current,
Main-owned build helpers. Their identities and contents are recorded separately.
No Cloud Build, Cloud Run, email, or production mutation occurs in this module.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from dataclasses import dataclass

import frontend_validation
import qualification_acceptance

import yaml

WORKFLOWS = {env: f".github/workflows/plg-frontend-{env}.yml" for env in ("dev", "uat")}

source = frontend_validation.source
require = source.require
Refused = source.Refused
ROOT = Path(__file__).resolve().parents[2]
SOURCE = source.SOURCE_SHA
SOURCE_TREE = source.SOURCE_TREE
OVERLAYS = (
    "scripts/deploy/frontend-google-native-config.sh",
    "scripts/deploy/resolve-google-sign-in-client.sh",
)
ARCHIVE_PATHS = (
    "hushh-webapp",
    "scripts/ops/validate_receipt_logo_template.py",
)
AUTHORITY_PATHS = tuple(
    dict.fromkeys(
        (
            "deploy/plg/frontend_release.py",
            "deploy/plg/frontend_native_build.py",
            "deploy/plg/frontend_archive.py",
            "deploy/plg/frontend_pinned_recipe.py",
            "deploy/plg/frontend_secret_pins.py",
            "deploy/plg/frontend_secret_inventory.py",
            "deploy/plg/frontend_build_evidence.py",
            "deploy/plg/frontend_hosted_caller.py",
            "deploy/plg/frontend_hosted_preflight.py",
            "deploy/plg/frontend_backend_pair.py",
            "deploy/plg/frontend_backend_target_recipe.py",
            "deploy/plg/frontend_fixture_runtime.py",
            "deploy/plg/frontend_fixture_producer.py",
            "deploy/plg/frontend_fixture_github.py",
            "deploy/plg/frontend_fixture_io.py",
            "deploy/plg/frontend_fixture_build.py",
            "deploy/plg/frontend_fixture_release.py",
            "deploy/plg/frontend_fixture_recovery.py",
            "deploy/plg/frontend_fixture_request_state.py",
            "deploy/plg/frontend_fixture_candidate.py",
            "deploy/plg/frontend_fixture_cloud.py",
            "deploy/plg/frontend_fixture_probes.py",
            "deploy/plg/frontend_fixture_acceptance.py",
            "deploy/plg/frontend_fixture_history.py",
            "deploy/plg/frontend_fixture_iam.py",
            "deploy/plg/frontend_fixture_retained.py",
            ".github/workflows/deploy-dev.yml",
            ".github/workflows/deploy-uat.yml",
            "scripts/ci/repo-governance-check.sh",
            "consent-protocol/scripts/test-ci.manifest.txt",
            "consent-protocol/.github/actions/setup-python-uv/action.yml",
            "deploy/frontend-image.cloudbuild.yaml",
            "scripts/ci/resolve-cloud-run-image.py",
            "scripts/ci/plg_fixture_fetch.cjs",
            "scripts/ci/plg_fixture_provider.cjs",
            "scripts/ci/plg_fixture_preload.cjs",
            "scripts/ci/test_plg_fixture_fetch.cjs",
            "scripts/ci/test_plg_fixture_w4_route.mjs",
            *OVERLAYS,
            *frontend_validation.AUTHORITY_PATHS,
            *qualification_acceptance.AUTHORITY_PATHS,
        )
    )
)
TARGETS = {"dev": "hushh-pda-dev", "uat": "hushh-pda-uat"}
SHA = re.compile(r"[0-9a-f]{40}")
NUMBER = re.compile(r"[1-9][0-9]{0,18}")
MAX_HELPER = 256 * 1024
MAX_ARCHIVE = 1024 * 1024 * 1024
MAX_ENTRIES = 30_000
RECORDER = """import json, os, pathlib, re
env = os.environ.get("PLG_FRONTEND_DEPLOY_ENV", "")
app = os.environ.get("PLG_FRONTEND_APP_ENV", "")
project = os.environ.get("PLG_FRONTEND_PROJECT", "")
tag = os.environ.get("PLG_FRONTEND_IMAGE_TAG", "")
if os.environ.get("PLG_FRONTEND_PUBLISH_MODE") != "plg-w2-isolated" or (env, app, project) not in {
    ("dev", "dev", "hushh-pda-dev"), ("uat", "uat", "hushh-pda-uat")
} or not re.fullmatch(r"plg-w2-" + env + r"-[1-9][0-9]{0,18}-[1-9][0-9]{0,18}", tag):
    raise ValueError("invalid isolated frontend image identity")
metadata = pathlib.Path("/workspace/frontend-image-metadata.json")
if metadata.stat().st_size > 1048576:
    raise ValueError("frontend image metadata oversized")
digest = json.loads(metadata.read_bytes()).get("containerimage.digest", "")
if not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
    raise ValueError("frontend image digest missing")
destination = pathlib.Path(os.environ["BUILDER_OUTPUT"])
if not destination.is_absolute():
    raise ValueError("native build output unavailable")
report = {"kind": "plg-frontend-image-build-output-v1", "imageTag": tag,
          "indexDigest": digest, "platform": "linux/amd64"}
(destination / "output").write_bytes(json.dumps(report, sort_keys=True).encode())
"""


@dataclass(frozen=True)
class Attempt:
    environment: str
    workflow_sha: str
    run_id: str
    run_attempt: str

    def __post_init__(self) -> None:
        require(
            self.environment in TARGETS, "Frontend qualification environment invalid"
        )
        require(
            SHA.fullmatch(self.workflow_sha) is not None,
            "Frontend workflow SHA invalid",
        )
        require(
            all(
                NUMBER.fullmatch(value) is not None
                for value in (self.run_id, self.run_attempt)
            ),
            "Frontend run identity invalid",
        )

    @property
    def project(self) -> str:
        return TARGETS[self.environment]

    @property
    def tag(self) -> str:
        return f"plg-w2-{self.environment}-{self.run_id}-{self.run_attempt}"

    def substitutions(self) -> dict[str, str]:
        # No caller-provided shell or environment substitutions are admitted.
        return {
            "_APP_ENV": self.environment,
            "_DEPLOY_ENV": self.environment,
            "_IMAGE_TAG": self.tag,
            "_IMAGE_PUBLISH_MODE": "plg-w2-isolated",
            "_SECRET_PREFIX": "",
            "_OBSERVABILITY_ENABLED": "true",
            "_ONE_WALLET_CARD_ENABLED": "true"
            if self.environment == "uat"
            else "false",
            "_ONE_WALLET_ENABLED": "false",
            "_ONE_LOCATION_NEARBY_CHECK_IN": "true"
            if self.environment == "uat"
            else "false",
            "_LOCATION_MAP_DEMO": "false",
            "_WORKOS_SSO_ENABLED": "false",
        }


def reviewed_inputs(attempt: Attempt) -> dict[str, str]:
    """Bind executable recipe and overlay to the same reviewed Main authority."""
    # This authorizes local input preparation only. The hosted submission gate
    # independently authenticates the current published intent and fixture history.
    git = source.backend._git
    git("merge-base", "--is-ancestor", attempt.workflow_sha, "origin/main")
    hashes = {}
    for name in (*AUTHORITY_PATHS, WORKFLOWS[attempt.environment]):
        committed = git("show", f"{attempt.workflow_sha}:{name}")
        current = git("show", f"origin/main:{name}")
        checked_out = (ROOT / name).read_bytes().replace(b"\r\n", b"\n")
        require(
            len(committed) <= 2 * 1024 * 1024 and committed == current == checked_out,
            "Frontend qualification authority changed",
        )
        hashes[name] = hashlib.sha256(committed).hexdigest()
    return hashes


def isolated_recipe(recipe: bytes, reviewed_sha256: str) -> bytes:
    """Add provenance only to the isolated recipe, leaving normal builds intact."""
    require(
        re.fullmatch(r"[0-9a-f]{64}", reviewed_sha256) is not None
        and hashlib.sha256(recipe).hexdigest() == reviewed_sha256,
        "Frontend build recipe changed",
    )
    config = yaml.safe_load(recipe)
    require(
        isinstance(config, dict) and isinstance(config.get("steps"), list),
        "Frontend build recipe invalid",
    )
    require(
        [step.get("id") for step in config["steps"]]
        == ["resolve-google-contacts-client-config", "build-frontend-image"]
        and isinstance(config.get("options"), dict)
        and "sourceProvenanceHash" not in config["options"],
        "Frontend build recipe structure changed",
    )
    require(
        config.get("substitutions", {}).get("_IMAGE_PUBLISH_MODE") == "standard"
        and "--metadata-file=/workspace/frontend-image-metadata.json"
        in config["steps"][1].get("args", ["", ""])[1],
        "Frontend isolated build boundary missing",
    )
    config["options"]["sourceProvenanceHash"] = ["SHA256"]
    config["steps"].append(
        {
            "name": "python:3.13-slim",
            "entrypoint": "python3",
            "args": ["-I", "-c", RECORDER],
            "env": [
                "PLG_FRONTEND_DEPLOY_ENV=${_DEPLOY_ENV}",
                "PLG_FRONTEND_APP_ENV=${_APP_ENV}",
                "PLG_FRONTEND_IMAGE_TAG=${_IMAGE_TAG}",
                "PLG_FRONTEND_PUBLISH_MODE=${_IMAGE_PUBLISH_MODE}",
                "PLG_FRONTEND_PROJECT=$PROJECT_ID",
            ],
            "id": "record-plg-frontend-image",
            "waitFor": ["build-frontend-image"],
        }
    )
    return yaml.safe_dump(config, sort_keys=False).encode()


def _expanded(*args, **kwargs):
    import frontend_native_build

    return frontend_native_build._expanded(*args, **kwargs)


def check_build(*args, **kwargs):
    import frontend_native_build

    return frontend_native_build.check_build(*args, **kwargs)


def verify_image_manifests(*args, **kwargs):
    import frontend_native_build

    return frontend_native_build.verify_image_manifests(*args, **kwargs)


def _member_allowed(*args, **kwargs):
    import frontend_archive

    return frontend_archive._member_allowed(*args, **kwargs)


def archive_source(*args, **kwargs):
    import frontend_archive

    return frontend_archive.archive_source(*args, **kwargs)


def prepare(attempt: Attempt, validation_run: int, destination: Path) -> dict:
    """Recheck hosted source validation around construction of the archive."""
    require(
        type(validation_run) is int and validation_run > 0,
        "Frontend validation run required",
    )
    authority = reviewed_inputs(attempt)
    validated = frontend_validation.verify(validation_run, SOURCE)
    canonical_recipe = source.backend._git(
        "show", f"{attempt.workflow_sha}:deploy/frontend-image.cloudbuild.yaml"
    )
    derived_recipe = isolated_recipe(
        canonical_recipe, authority["deploy/frontend-image.cloudbuild.yaml"]
    )
    overlays = {
        name: source.backend._git("show", f"{attempt.workflow_sha}:{name}")
        for name in OVERLAYS
    }
    require(
        all(
            hashlib.sha256(overlays[name]).hexdigest() == authority[name]
            for name in OVERLAYS
        ),
        "Frontend build helper changed",
    )
    archive = archive_source(destination, overlays)
    require(
        frontend_validation.verify(validation_run, SOURCE) == validated,
        "Frontend source validation changed",
    )
    require(
        reviewed_inputs(attempt) == authority,
        "Frontend qualification authority changed",
    )
    return {
        "schemaVersion": 1,
        "kind": "plg-frontend-build-input-v1",
        "environment": attempt.environment,
        "project": attempt.project,
        "workflowSha": attempt.workflow_sha,
        "runId": attempt.run_id,
        "runAttempt": attempt.run_attempt,
        "sourceValidation": validated,
        "authorityFiles": authority,
        "isolatedRecipeSha256": hashlib.sha256(derived_recipe).hexdigest(),
        "substitutions": attempt.substitutions(),
        **archive,
    }


def _publish_inputs(attempt, folder, evidence):
    require(
        evidence.get("sourceSha") == SOURCE
        and evidence.get("sourceTree") == SOURCE_TREE
        and evidence.get("environment") == attempt.environment
        and evidence.get("runId") == attempt.run_id
        and evidence.get("runAttempt") == attempt.run_attempt
        and evidence.get("workflowSha") == attempt.workflow_sha
        and evidence.get("environmentAccepted") is False
        and evidence.get("productionTrafficAuthorized") is False,
        "Frontend preparation identity changed",
    )
    archive = folder / "source.tar.gz"
    require(
        archive.is_file()
        and not archive.is_symlink()
        and 0 < archive.stat().st_size <= MAX_ARCHIVE,
        "Frontend prepared archive invalid",
    )
    digest = hashlib.sha256()
    with archive.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    require(
        digest.hexdigest() == evidence.get("archiveSha256"),
        "Frontend prepared archive changed",
    )
    recipe = source.backend._git(
        "show", f"{attempt.workflow_sha}:deploy/frontend-image.cloudbuild.yaml"
    )
    derived = isolated_recipe(
        recipe, evidence["authorityFiles"]["deploy/frontend-image.cloudbuild.yaml"]
    )
    require(
        hashlib.sha256(derived).hexdigest() == evidence["isolatedRecipeSha256"],
        "Frontend derived recipe changed",
    )
    with (folder / "build.yaml").open("xb") as output:
        output.write(derived)
    with (folder / "input.json").open("xb") as output:
        output.write(
            json.dumps(evidence, sort_keys=True, separators=(",", ":")).encode() + b"\n"
        )
    print(
        json.dumps(
            {
                "status": "prepared",
                "directory": str(folder),
                "sourceSha": SOURCE,
                "environmentAccepted": False,
                "productionTrafficAuthorized": False,
            }
        )
    )


def main(argv: list[str] | None = None) -> int:
    """Prepare local build inputs only; there is no cloud or traffic operation."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--environment", choices=("dev", "uat"), required=True)
    parser.add_argument("--validation-run", type=int, required=True)
    args = parser.parse_args(argv)
    try:
        require(
            os.environ.get("GITHUB_ACTIONS") == "true"
            and os.environ.get("GITHUB_REPOSITORY") == "hushh-labs/hushh-research"
            and os.environ.get("GITHUB_EVENT_NAME") == "workflow_dispatch"
            and os.environ.get("GITHUB_REF") == "refs/heads/main",
            "Frontend runner context invalid",
        )
        attempt = Attempt(
            args.environment,
            os.environ.get("GITHUB_SHA", ""),
            os.environ.get("GITHUB_RUN_ID", ""),
            os.environ.get("GITHUB_RUN_ATTEMPT", ""),
        )
        runner_temp = os.environ.get("RUNNER_TEMP", "")
        require(
            bool(runner_temp) and Path(runner_temp).is_absolute(),
            "Frontend runner directory invalid",
        )
        root = Path(runner_temp).resolve(strict=True)
        require(
            root.is_dir() and root != root.parent, "Frontend runner directory invalid"
        )
        folder = (
            root
            / f"plg-frontend-{attempt.environment}-{attempt.run_id}-{attempt.run_attempt}"
        )
        folder.mkdir(mode=0o700)
        evidence = prepare(attempt, args.validation_run, folder / "source.tar.gz")
        _publish_inputs(attempt, folder, evidence)
        return 0
    except (Refused, OSError, ValueError, KeyError, subprocess.SubprocessError):
        print(
            "Frontend input preparation refused; no cloud action taken.",
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
