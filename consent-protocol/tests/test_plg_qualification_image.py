"""Real provenance joins and immutable-copy boundaries, with inert cloud ports."""

import base64
import copy
import hashlib
import importlib
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
BUILD_ID = "12345678-1234-1234-1234-123456789abc"


def raw_json(value):
    return json.dumps(value, sort_keys=True).encode()


def digest(raw):
    return "sha256:" + hashlib.sha256(raw).hexdigest()


@pytest.fixture
def image(monkeypatch):
    monkeypatch.syspath_prepend(str(ROOT / "deploy/plg"))
    return importlib.import_module("qualification_image")


def manifest_pair():
    child = raw_json(
        {
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.manifest.v1+json",
            "config": {
                "mediaType": "application/vnd.oci.image.config.v1+json",
                "size": 2,
                "digest": "sha256:" + "b" * 64,
            },
            "layers": [
                {
                    "mediaType": "application/vnd.oci.image.layer.v1.tar+gzip",
                    "size": 2,
                    "digest": "sha256:" + "c" * 64,
                }
            ],
        }
    )
    parent = raw_json(
        {
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.index.v1+json",
            "manifests": [
                {
                    "mediaType": "application/vnd.oci.image.manifest.v1+json",
                    "size": len(child),
                    "digest": digest(child),
                    "platform": {"os": "linux", "architecture": "amd64"},
                }
            ],
        }
    )
    return child, parent


class InertCloud:
    def __init__(self, archive, recipe, build, manifests, child):
        self.archive, self.recipe, self.build, self.manifests = archive, recipe, build, manifests
        self.commands, self.reads = [], []
        self.copy_digest = digest(child)

    def command(self, *args, **kwargs):
        self.commands.append((args, kwargs))
        if args[:2] == ("builds", "submit"):
            assert Path(args[2]).read_bytes() == self.archive
            assert Path(args[4].split("=", 1)[1]).read_bytes() == self.recipe
            return BUILD_ID.encode()
        return b""

    def read(self, *args):
        self.reads.append(args)
        if args[:2] == ("builds", "describe"):
            return self.build
        return {"image_summary": {"digest": self.copy_digest}}

    def manifest(self, project, sha):
        assert project in {"hushh-pda-dev", "hushh-pda-uat"}
        return self.manifests[sha]


@pytest.fixture
def evidence(image, monkeypatch):
    attempt = image.Attempt("a" * 40, "123", "2")
    recipe = (ROOT / image.RECIPE).read_bytes()
    child, parent = manifest_pair()
    archive = b"synthetic exact archive bytes"
    storage = {
        "bucket": "hushh-pda-dev_cloudbuild",
        "object": "source/fixed.tgz",
        "generation": "7",
    }
    build = {
        "id": BUILD_ID,
        "projectId": "hushh-pda-dev",
        "status": "SUCCESS",
        "substitutions": {"_BUILD_TARGET": "backend", "_IMAGE_TAG": attempt.tag},
        "source": {"storageSource": storage},
        "sourceProvenance": {
            "resolvedStorageSource": copy.deepcopy(storage),
            "fileHashes": {
                "gs://hushh-pda-dev_cloudbuild/source/fixed.tgz": {
                    "fileHash": [
                        {
                            "type": "SHA256",
                            "value": base64.b64encode(hashlib.sha256(archive).digest()).decode(),
                        }
                    ]
                },
            },
        },
        **yaml.safe_load(recipe),
    }
    build["substitutions"] = {"_BUILD_TARGET": "backend", "_IMAGE_TAG": attempt.tag}
    for step in build["steps"]:
        step["status"] = "SUCCESS"
    record = {
        "kind": "backend-image-build-output-v1",
        "imageTag": attempt.tag,
        "indexDigest": digest(parent),
        "platform": "linux/amd64",
    }
    build["results"] = {"buildStepOutputs": ["", base64.b64encode(raw_json(record)).decode()]}
    manifests = {digest(parent): parent, digest(child): child}

    def source(path):
        path.write_bytes(archive)
        return "d" * 40, hashlib.sha256(archive).hexdigest()

    monkeypatch.setattr(image, "archive_source", source)
    monkeypatch.setattr(
        image, "reviewed_recipe", lambda *_: (recipe, hashlib.sha256(recipe).hexdigest())
    )
    monkeypatch.setattr(
        image.validation, "verify", lambda *_: {"status": "validated", "runAttempt": 1}
    )
    return {
        "attempt": attempt,
        "recipe": recipe,
        "build": build,
        "record": record,
        "parent": parent,
        "child": child,
        "cloud": InertCloud(archive, recipe, build, manifests, child),
        "manifests": manifests,
    }


def test_dev_collects_build_source_generation_and_native_digest(image, evidence):
    checkpoints = []
    proof = image.build_dev(
        evidence["attempt"], 42, cloud=evidence["cloud"], checkpoint=checkpoints.append
    )
    assert proof["build"]["buildId"] == BUILD_ID
    assert proof["build"]["storageSource"]["generation"] == "7"
    assert proof["build"]["indexReference"].endswith("@" + digest(evidence["parent"]))
    assert proof["reference"].endswith("@" + digest(evidence["child"]))
    assert "sourceArchiveSha256" in checkpoints[0] and checkpoints[1] == {"buildId": BUILD_ID}
    args = evidence["cloud"].commands[0][0]
    assert (
        "--async" in args
        and "--substitutions=_BUILD_TARGET=backend,_IMAGE_TAG=" + evidence["attempt"].tag in args
    )
    assert len(evidence["cloud"].commands) == 1  # No mutable-tag lookup supplies the Dev digest.


@pytest.mark.parametrize("mutation", ["id", "archive", "generation", "recipe", "step", "output"])
def test_dev_refuses_disconnected_build_proofs(image, evidence, mutation):
    build = evidence["build"]
    if mutation == "id":
        build["id"] = "87654321-1234-1234-1234-123456789abc"
    elif mutation == "archive":
        next(iter(build["sourceProvenance"]["fileHashes"].values()))["fileHash"][0]["value"] = (
            base64.b64encode(b"x" * 32).decode()
        )
    elif mutation == "generation":
        build["sourceProvenance"]["resolvedStorageSource"]["generation"] = "8"
    elif mutation == "recipe":
        build["steps"][0]["args"][1] += "\necho unreviewed"
    elif mutation == "step":
        build["steps"][1]["allowFailure"] = True
    else:
        build["results"]["buildStepOutputs"].reverse()
    with pytest.raises(image.QualificationError):
        image.build_dev(evidence["attempt"], 42, cloud=evidence["cloud"])
    assert len(evidence["cloud"].commands) == 1


def test_native_output_rejects_unbound_tag_and_bad_encoding(image, evidence):
    build = evidence["build"]
    for encoded in (
        "not base64!",
        base64.b64encode(raw_json({**evidence["record"], "imageTag": "other"})).decode(),
    ):
        build["results"]["buildStepOutputs"][1] = encoded
        with pytest.raises((image.QualificationError, ValueError)):
            image.native_digest(build, 1, evidence["attempt"])


@pytest.mark.parametrize("kind", ["wrong-platform", "direct", "bytes"])
def test_executable_requires_actual_amd64_descriptor_and_digest(image, evidence, kind):
    cloud, parent = evidence["cloud"], evidence["parent"]
    if kind == "wrong-platform":
        changed = json.loads(parent)
        changed["manifests"][0]["platform"]["architecture"] = "arm64"
        parent = raw_json(changed)
        evidence["manifests"][digest(parent)] = parent
    elif kind == "direct":
        parent = evidence["child"]
    else:
        evidence["manifests"][digest(parent)] += b"unbound"
    with pytest.raises((image.QualificationError, ValueError)):
        image.resolve_image(cloud, image.Target("dev"), digest(parent), index_required=True)


def test_uat_only_copies_genuine_isolated_dev_and_rechecks_it(image, evidence, monkeypatch):
    reference = "gcr.io/hushh-pda-dev/consent-protocol@" + digest(evidence["child"])
    accepted = image.acceptance.IsolatedAcceptance(
        "dev", 10, 2, 11, "sha256:" + "a" * 64, "f" * 40, reference
    )
    calls = []
    monkeypatch.setattr(image.acceptance, "verify", lambda *args: calls.append(args) or accepted)
    proof = image.promote_uat(evidence["attempt"], 10, cloud=evidence["cloud"])
    assert proof["mode"] == "promoted-dev" and proof["promotedFrom"] == reference
    assert proof["reference"] == reference.replace("hushh-pda-dev", "hushh-pda-uat")
    assert calls == [("dev", 10), ("dev", 10)]
    assert evidence["cloud"].commands[0][0][:5] == (
        "container",
        "images",
        "add-tag",
        "--quiet",
        reference,
    )
    assert len(evidence["cloud"].commands) == 1
    monkeypatch.setattr(image.acceptance, "verify", lambda *_: {"image_reference": reference})
    with pytest.raises(image.QualificationError, match="isolated_dev_required"):
        image.promote_uat(evidence["attempt"], 10, cloud=evidence["cloud"])
    assert len(evidence["cloud"].commands) == 1


def test_source_and_recipe_are_committed_authority_not_caller_claims(image, monkeypatch):
    attempt = image.Attempt("a" * 40, "123", "2")
    monkeypatch.setattr(
        image.acceptance, "reviewed_definitions", lambda *_: {image.RECIPE: "0" * 64}
    )
    with pytest.raises(image.QualificationError, match="authority_unregistered"):
        image.reviewed_recipe(attempt, "dev")
    monkeypatch.setattr(
        image.acceptance,
        "reviewed_definitions",
        lambda *_: {image.MODULE: "b" * 64, image.RECIPE: "0" * 64},
    )
    monkeypatch.setattr(image.validation.authority, "_git", lambda *_: b"changed recipe")
    with pytest.raises(image.QualificationError, match="recipe_changed"):
        image.reviewed_recipe(attempt, "dev")


def test_actual_recipe_emitter_works_without_s_helper_and_skips_commerce(tmp_path):
    recipe = yaml.safe_load((ROOT / "deploy/backend-image.cloudbuild.yaml").read_bytes())
    step = recipe["steps"][1]
    metadata = tmp_path / "metadata.json"
    metadata.write_text(json.dumps({"containerimage.digest": "sha256:" + "f" * 64}))
    code = step["args"][4].replace("/workspace/backend-image-metadata.json", metadata.as_posix())
    environment = {**os.environ, "BUILDER_OUTPUT": str(tmp_path)}
    result = subprocess.run(  # noqa: S603 -- actual committed recipe code, inert temporary metadata only.
        [sys.executable, *step["args"][:4], code, "backend", "tag"],
        capture_output=True,
        env=environment,
        timeout=10,
        check=False,
    )
    assert result.returncode == 0, result.stderr.decode()
    assert json.loads((tmp_path / "output").read_bytes())["indexDigest"] == "sha256:" + "f" * 64
    metadata.unlink()
    (tmp_path / "output").unlink()
    skipped = subprocess.run(  # noqa: S603 -- same inert recipe probe, no cloud or source build.
        [sys.executable, *step["args"][:4], code, "commerce-preview-bootstrap", "tag"],
        capture_output=True,
        env=environment,
        timeout=10,
        check=False,
    )
    assert skipped.returncode == 0 and not (tmp_path / "output").exists()


def test_archive_uses_exact_s_tracked_context_and_hashes_actual_bytes(image, monkeypatch, tmp_path):
    path, calls = tmp_path / "source.tar.gz", []
    monkeypatch.setattr(image.validation.authority, "_git", lambda *_: ("d" * 40).encode())

    def archive(*args):
        calls.append(args)
        path.write_bytes(b"actual archived bytes")
        return subprocess.CompletedProcess([], 0)

    monkeypatch.setattr(image.validation.authority, "_run_git", archive)
    tree, sha = image.archive_source(path)
    assert tree == "d" * 40 and sha == hashlib.sha256(path.read_bytes()).hexdigest()
    assert calls == [
        (
            "archive",
            "--format=tar.gz",
            "--output=" + str(path),
            image.SOURCE,
            "consent-protocol",
            "contracts",
        )
    ]


def test_cli_keeps_uncertain_intent_and_does_not_repeat_submit(
    image, monkeypatch, tmp_path, capsys
):
    output, calls = tmp_path / "proof.json", []
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "qualification_image",
            "dev",
            "--workflow-sha",
            "a" * 40,
            "--run-id",
            "123",
            "--run-attempt",
            "2",
            "--validation-run",
            "42",
            "--output",
            str(output),
        ],
    )

    def uncertain(*_args, checkpoint, **_kwargs):
        calls.append("one submit")
        checkpoint({"buildId": BUILD_ID})
        raise RuntimeError("synthetic secret must stay private")

    monkeypatch.setattr(image, "build_dev", uncertain)
    assert image.main() == 1
    assert json.loads(output.read_bytes())["buildId"] == BUILD_ID
    assert json.loads(output.read_bytes())["status"] == "needs-reconciliation"
    assert "synthetic secret" not in capsys.readouterr().err
    with pytest.raises(FileExistsError):
        image.main()
    assert calls == ["one submit"]


def test_uat_copy_mismatch_cannot_fall_back_to_build(image, evidence, monkeypatch):
    parent_reference = "gcr.io/hushh-pda-dev/consent-protocol@sha256:" + "e" * 64
    accepted = image.acceptance.IsolatedAcceptance(
        "dev", 10, 2, 11, "sha256:" + "a" * 64, "f" * 40, parent_reference
    )
    monkeypatch.setattr(image.acceptance, "verify", lambda *_: accepted)
    with pytest.raises(image.QualificationError, match="accepted_dev_changed"):
        image.promote_uat(evidence["attempt"], 10, cloud=evidence["cloud"])
    assert len(evidence["cloud"].commands) == 1
    assert evidence["cloud"].commands[0][0][:3] == ("container", "images", "add-tag")


def test_import_performs_no_git_cloud_or_process_reads(image, monkeypatch):
    def forbidden(*_args, **_kwargs):
        raise AssertionError("import crossed an external boundary")

    monkeypatch.setattr(subprocess, "run", forbidden)
    monkeypatch.setattr(image.validation.authority, "_git", forbidden)
    monkeypatch.setattr(image.urllib.request, "build_opener", forbidden)
    assert importlib.reload(image).SOURCE == "5de6ee29abe3b00642bd6b745c608279091810b3"
