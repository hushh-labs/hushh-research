"""The fixed frontend build input never grants environment or traffic authority."""

from __future__ import annotations

import base64
import copy
import hashlib
import json
import os
import subprocess
import sys
import tarfile
from pathlib import Path
from unittest.mock import Mock

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "deploy/plg"))
import frontend_release as release  # noqa: E402


@pytest.mark.parametrize(
    "environment,project", [("dev", "hushh-pda-dev"), ("uat", "hushh-pda-uat")]
)
def test_attempt_binds_fixed_environment_and_run_scoped_substitutions(environment, project):
    attempt = release.Attempt(environment, "a" * 40, "123", "2")
    assert attempt.project == project
    assert attempt.substitutions() == {
        "_APP_ENV": environment,
        "_DEPLOY_ENV": environment,
        "_IMAGE_TAG": f"plg-w2-{environment}-123-2",
        "_IMAGE_PUBLISH_MODE": "plg-w2-isolated",
        "_SECRET_PREFIX": "",
        "_OBSERVABILITY_ENABLED": "true",
        "_ONE_WALLET_CARD_ENABLED": "true" if environment == "uat" else "false",
        "_ONE_WALLET_ENABLED": "false",
        "_ONE_LOCATION_NEARBY_CHECK_IN": "true" if environment == "uat" else "false",
        "_LOCATION_MAP_DEMO": "false",
        "_WORKOS_SSO_ENABLED": "false",
    }


@pytest.mark.parametrize(
    "environment,sha,run,attempt",
    [
        ("production", "a" * 40, "1", "1"),
        ("dev", "main", "1", "1"),
        ("uat", "a" * 40, "0", "1"),
        ("dev", "a" * 40, "$(touch bad)", "1"),
        ("dev", "a" * 40, "1", "2" * 20),
    ],
)
def test_attempt_rejects_untrusted_target_or_identity(environment, sha, run, attempt):
    with pytest.raises(release.Refused):
        release.Attempt(environment, sha, run, attempt)


def test_archive_contains_exact_w2_dockerfile_and_explicit_overlay(tmp_path):
    destination = tmp_path / "source.tar.gz"
    overlays = {name: ("# reviewed " + name + "\n").encode() for name in release.OVERLAYS}
    result = release.archive_source(destination, overlays)
    assert result["sourceSha"] == release.SOURCE
    assert result["sourceTree"] == release.SOURCE_TREE
    assert result["overlays"] == {
        name: hashlib.sha256(value).hexdigest() for name, value in overlays.items()
    }
    assert result["archiveSha256"] == hashlib.sha256(destination.read_bytes()).hexdigest()
    assert result["environmentAccepted"] is False
    assert result["productionTrafficAuthorized"] is False
    with tarfile.open(destination, "r:gz") as archive:
        members = archive.getmembers()
        names = [member.name for member in members]
        assert len(names) == len(set(names))
        inventory = hashlib.sha256()
        for member in members:
            content = archive.extractfile(member).read() if member.isfile() else b""
            row = [
                member.name.rstrip("/"),
                member.mode,
                member.size,
                hashlib.sha256(content).hexdigest(),
            ]
            inventory.update(json.dumps(row, separators=(",", ":")).encode() + b"\n")
        assert result["inventorySha256"] == inventory.hexdigest()
        for name, value in overlays.items():
            assert archive.extractfile(name).read() == value
        assert archive.extractfile("hushh-webapp/Dockerfile").read() == release.source.backend._git(
            "show", f"{release.SOURCE}:hushh-webapp/Dockerfile"
        )
        assert not any(name.startswith("consent-protocol/") for name in names)
        assert not any(
            part.startswith(".env") or part == "__tests__"
            for name in names
            for part in Path(name).parts
        )
        assert not any(
            name.endswith((".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx")) for name in names
        )
    with pytest.raises(release.Refused):
        release.archive_source(destination, overlays)


def test_prepare_refuses_changed_source_validation_after_archive(tmp_path, monkeypatch):
    attempt = release.Attempt("dev", "a" * 40, "123", "2")
    overlay = b"reviewed helper"
    authority = {name: hashlib.sha256(overlay).hexdigest() for name in release.OVERLAYS}
    authority["deploy/frontend-image.cloudbuild.yaml"] = hashlib.sha256(overlay).hexdigest()
    monkeypatch.setattr(release, "reviewed_inputs", lambda _attempt: authority)
    verify = Mock(
        side_effect=[
            {"status": "validated", "runAttempt": 1},
            {"status": "validated", "runAttempt": 2},
        ]
    )
    monkeypatch.setattr(release.frontend_validation, "verify", verify)
    monkeypatch.setattr(release.source.backend, "_git", lambda *_args: overlay)
    monkeypatch.setattr(release, "isolated_recipe", lambda _recipe, _digest: b"isolated recipe")
    monkeypatch.setattr(
        release, "archive_source", lambda *_args: {"productionTrafficAuthorized": False}
    )
    with pytest.raises(release.Refused, match="validation changed"):
        release.prepare(attempt, 42, tmp_path / "source.tar.gz")
    assert verify.call_count == 2


@pytest.mark.parametrize("environment", ["dev", "uat"])
def test_authority_requires_reviewed_main_and_unchanged_checkout(
    tmp_path, monkeypatch, environment
):
    attempt = release.Attempt(environment, "a" * 40, "123", "2")
    values = {
        path: ("trusted " + path + "\n").encode()
        for path in (*release.AUTHORITY_PATHS, release.WORKFLOWS[environment])
    }
    for path, value in values.items():
        file = tmp_path / path
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(value)
    monkeypatch.setattr(release, "ROOT", tmp_path)

    def git(*args):
        if args[0] == "merge-base":
            return b""
        return values[args[1].split(":", 1)[1]]

    monkeypatch.setattr(release.source.backend, "_git", git)
    hashes = release.reviewed_inputs(attempt)
    assert hashes[release.OVERLAYS[0]] == hashlib.sha256(values[release.OVERLAYS[0]]).hexdigest()
    (tmp_path / release.OVERLAYS[0]).write_bytes(b"changed")
    with pytest.raises(release.Refused, match="authority changed"):
        release.reviewed_inputs(attempt)


def test_archive_rejects_missing_reviewed_overlay(tmp_path):
    destination = tmp_path / "source.tar.gz"
    with pytest.raises(release.Refused, match="build helper invalid"):
        release.archive_source(destination, {release.OVERLAYS[0]: b"reviewed helper"})
    assert not destination.exists()


def test_unsafe_tar_paths_and_links_are_rejected():
    entry = tarfile.TarInfo("hushh-webapp/../../unexpected")
    assert not release._member_allowed(entry)
    entry = tarfile.TarInfo("hushh-webapp/link")
    entry.type = tarfile.SYMTYPE
    assert not release._member_allowed(entry)


@pytest.mark.parametrize("case", ["valid", "missing", "invalid", "wrong_project", "standard"])
def test_isolated_recipe_records_only_real_buildx_metadata(tmp_path, case):
    original = (ROOT / "deploy/frontend-image.cloudbuild.yaml").read_bytes().replace(b"\r\n", b"\n")
    digest = hashlib.sha256(original).hexdigest()
    config = yaml.safe_load(release.isolated_recipe(original, digest))
    assert config["options"]["sourceProvenanceHash"] == ["SHA256"]
    assert "sourceProvenanceHash" not in yaml.safe_load(original)["options"]
    step = config["steps"][-1]
    assert step["id"] == "record-plg-frontend-image" and step["waitFor"] == ["build-frontend-image"]
    metadata = tmp_path / "metadata.json"
    if case != "missing":
        metadata.write_text(
            json.dumps(
                {"containerimage.digest": "sha256:" + ("a" * 64 if case != "invalid" else "bad")}
            ),
            encoding="utf-8",
        )
    output = tmp_path / "outputs"
    output.mkdir()
    script = step["args"][-1].replace(
        "/workspace/frontend-image-metadata.json", metadata.as_posix()
    )
    environment = os.environ.copy()
    environment.update(
        {
            "BUILDER_OUTPUT": str(output),
            "PLG_FRONTEND_PUBLISH_MODE": "standard" if case == "standard" else "plg-w2-isolated",
            "PLG_FRONTEND_DEPLOY_ENV": "dev",
            "PLG_FRONTEND_APP_ENV": "dev",
            "PLG_FRONTEND_PROJECT": "hushh-pda-uat" if case == "wrong_project" else "hushh-pda-dev",
            "PLG_FRONTEND_IMAGE_TAG": "plg-w2-dev-123-2",
        }
    )
    result = subprocess.run(  # noqa: S603
        [sys.executable, "-I", "-c", script],
        env=environment,
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    if case == "valid":
        assert result.returncode == 0, result.stderr
        assert json.loads((output / "output").read_text()) == {
            "kind": "plg-frontend-image-build-output-v1",
            "imageTag": "plg-w2-dev-123-2",
            "indexDigest": "sha256:" + "a" * 64,
            "platform": "linux/amd64",
        }
    else:
        assert result.returncode != 0 and not (output / "output").exists()
    with pytest.raises(release.Refused, match="recipe changed"):
        release.isolated_recipe(original, "b" * 64)


def test_cli_refuses_outside_governed_runner_context(monkeypatch, capsys):
    monkeypatch.delenv("GITHUB_ACTIONS", raising=False)
    assert release.main(["--environment", "uat", "--validation-run", "42"]) == 1
    assert "no cloud action" in capsys.readouterr().err


def test_cli_prepares_only_local_inputs_and_refuses_overwrite(tmp_path, monkeypatch, capsys):
    for key, value in {
        "GITHUB_ACTIONS": "true",
        "GITHUB_REPOSITORY": "hushh-labs/hushh-research",
        "GITHUB_EVENT_NAME": "workflow_dispatch",
        "GITHUB_REF": "refs/heads/main",
        "GITHUB_SHA": "a" * 40,
        "GITHUB_RUN_ID": "123",
        "GITHUB_RUN_ATTEMPT": "2",
        "RUNNER_TEMP": str(tmp_path),
    }.items():
        monkeypatch.setenv(key, value)
    derived, original = b"derived recipe", b"reviewed recipe"

    def prepare(attempt, validation_run, destination):
        assert validation_run == 42
        destination.write_bytes(b"archive")
        return {
            "sourceSha": release.SOURCE,
            "sourceTree": release.SOURCE_TREE,
            "environment": attempt.environment,
            "runId": attempt.run_id,
            "runAttempt": attempt.run_attempt,
            "workflowSha": attempt.workflow_sha,
            "environmentAccepted": False,
            "productionTrafficAuthorized": False,
            "archiveSha256": hashlib.sha256(b"archive").hexdigest(),
            "isolatedRecipeSha256": hashlib.sha256(derived).hexdigest(),
            "authorityFiles": {
                "deploy/frontend-image.cloudbuild.yaml": hashlib.sha256(original).hexdigest()
            },
        }

    monkeypatch.setattr(release, "prepare", prepare)
    monkeypatch.setattr(release.source.backend, "_git", lambda *_args: original)
    monkeypatch.setattr(release, "isolated_recipe", lambda *_args: derived)
    assert release.main(["--environment", "uat", "--validation-run", "42"]) == 0
    output = json.loads(capsys.readouterr().out)
    assert output["status"] == "prepared" and not output["productionTrafficAuthorized"]
    folder = tmp_path / "plg-frontend-uat-123-2"
    assert (folder / "build.yaml").read_bytes() == derived
    assert (folder / "source.tar.gz").read_bytes() == b"archive"
    assert json.loads((folder / "input.json").read_text())["sourceSha"] == release.SOURCE
    assert release.main(["--environment", "uat", "--validation-run", "42"]) == 1
    assert (folder / "source.tar.gz").read_bytes() == b"archive"


def _native_build_receipt():
    """Synthetic metadata exercises refusal; it is not evidence of a live build."""
    attempt = release.Attempt("dev", "a" * 40, "123", "2")
    original = (ROOT / "deploy/frontend-image.cloudbuild.yaml").read_bytes().replace(b"\r\n", b"\n")
    recipe = release.isolated_recipe(original, hashlib.sha256(original).hexdigest())
    config = yaml.safe_load(recipe)
    archive_hash = "12" * 32
    storage = {"bucket": "test-source", "object": "build/source.tgz", "generation": "123"}
    report = {
        "kind": "plg-frontend-image-build-output-v1",
        "imageTag": attempt.tag,
        "indexDigest": "sha256:" + "a" * 64,
        "platform": "linux/amd64",
    }
    build = {
        "status": "SUCCESS",
        "projectId": attempt.project,
        "serviceAccount": "projects/hushh-pda-dev/serviceAccounts/build@example.test",
        "id": "12345678-1234-1234-1234-123456789abc",
        "substitutions": attempt.substitutions(),
        "steps": [dict(step, status="SUCCESS") for step in config["steps"]],
        "options": config["options"],
        "availableSecrets": config.get("availableSecrets"),
        "timeout": config.get("timeout"),
        "source": {"storageSource": storage},
        "sourceProvenance": {
            "resolvedStorageSource": storage,
            "fileHashes": {
                "gs://test-source/build/source.tgz": {
                    "fileHash": [
                        {
                            "type": "SHA256",
                            "value": base64.b64encode(bytes.fromhex(archive_hash)).decode(),
                        }
                    ]
                }
            },
        },
        "results": {
            "buildStepOutputs": ["", "", base64.b64encode(json.dumps(report).encode()).decode()]
        },
    }
    args = (
        attempt,
        recipe,
        archive_hash,
        build["id"],
        hashlib.sha256(recipe).hexdigest(),
        storage,
        build["serviceAccount"],
    )
    return build, args, report


def test_provider_build_receipt_rejects_wrong_identity_or_tampering():
    build, args, report = _native_build_receipt()
    checked = release.check_build(build, *args)
    assert checked["indexDigest"] == report["indexDigest"]
    assert checked["platformVerified"] is False
    assert not checked["environmentAccepted"] and not checked["productionTrafficAuthorized"]

    mutations = [
        lambda b: b.update(projectId="hushh-pda-uat"),
        lambda b: b.update(
            serviceAccount="projects/hushh-pda-dev/serviceAccounts/other@example.test"
        ),
        lambda b: b["substitutions"].update(_IMAGE_TAG="plg-w2-dev-123-3"),
        lambda b: b["steps"][1].update(name="attacker/image"),
        lambda b: b["steps"][1].update(allowFailure=True),
        lambda b: b["steps"][2].update(secretEnv=["UNREVIEWED"]),
        lambda b: b["steps"][2].update(waitFor=["-"]),
        lambda b: b.update(artifacts={"objects": {"location": "gs://unexpected"}}),
        lambda b: b.update(id="87654321-4321-4321-4321-cba987654321"),
        lambda b: b["options"].update(env=["INJECTED=1"]),
        lambda b: b["options"].update(substitutionOption="ALLOW_LOOSE"),
        lambda b: b.update(sourceProvenance=None),
        lambda b: b["sourceProvenance"]["fileHashes"].update(
            {
                "gs://test-source/build/source.tgz": {
                    "fileHash": [{"type": "SHA256", "value": base64.b64encode(b"wrong").decode()}]
                }
            }
        ),
        lambda b: b["results"].update(buildStepOutputs=["", "", "invalid-base64"]),
        lambda b: b["results"].update(
            buildStepOutputs=[
                "",
                "",
                base64.b64encode(json.dumps(dict(report, imageTag="different")).encode()).decode(),
            ]
        ),
        lambda b: b["results"].update(
            buildStepOutputs=["", "", base64.b64encode(b'{"kind":"a","kind":"b"}').decode()]
        ),
    ]
    for mutate in mutations:
        changed = copy.deepcopy(build)
        mutate(changed)
        with pytest.raises(release.Refused):
            release.check_build(changed, *args)
    with pytest.raises(release.Refused, match="recipe changed"):
        release.check_build(
            build,
            *args[:4],
            "b" * 64,
            *args[5:],
        )


def test_image_manifests_require_pinned_amd64_index_and_child():
    image_type = "application/vnd.oci.image.manifest.v1+json"
    child = json.dumps(
        {
            "schemaVersion": 2,
            "mediaType": image_type,
            "config": {
                "mediaType": "application/vnd.oci.image.config.v1+json",
                "digest": "sha256:" + "c" * 64,
                "size": 1,
            },
            "layers": [],
        }
    ).encode()
    child_digest = "sha256:" + hashlib.sha256(child).hexdigest()
    descriptor = {
        "mediaType": image_type,
        "digest": child_digest,
        "size": len(child),
        "platform": {"os": "linux", "architecture": "amd64"},
    }
    index = json.dumps(
        {
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.index.v1+json",
            "manifests": [descriptor],
        }
    ).encode()
    index_digest = "sha256:" + hashlib.sha256(index).hexdigest()
    result = release.verify_image_manifests(index, child, index_digest)
    assert result["executableDigest"] == child_digest
    assert result["platform"] == "linux/amd64"
    assert not result["environmentAccepted"] and not result["productionTrafficAuthorized"]
    with pytest.raises(release.Refused):
        release.verify_image_manifests(index, child + b" ", index_digest)
    with pytest.raises(release.Refused):
        release.verify_image_manifests(index, child, "sha256:" + "0" * 64)
    descriptor["platform"]["architecture"] = "arm64"
    wrong = json.dumps(
        {
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.index.v1+json",
            "manifests": [descriptor],
        }
    ).encode()
    with pytest.raises(release.Refused):
        release.verify_image_manifests(wrong, child, "sha256:" + hashlib.sha256(wrong).hexdigest())
