from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
OCI_INDEX = "application/vnd.oci.image.index.v1+json"
OCI_IMAGE = "application/vnd.oci.image.manifest.v1+json"
DOCKER_INDEX = "application/vnd.docker.distribution.manifest.list.v2+json"
DOCKER_IMAGE = "application/vnd.docker.distribution.manifest.v2+json"
CHILD_DIGEST = "sha256:" + "a" * 64


def _resolver():
    spec = importlib.util.spec_from_file_location(
        "resolve_cloud_run_image", ROOT / "scripts/ci/resolve-cloud-run-image.py"
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _descriptor(**overrides):
    return {
        "mediaType": OCI_IMAGE,
        "digest": CHILD_DIGEST,
        "size": 1234,
        "platform": {"os": "linux", "architecture": "amd64"},
        **overrides,
    }


def _index(entries, media_type=OCI_INDEX):
    return {"schemaVersion": 2, "mediaType": media_type, "manifests": entries}


def _encoded(payload):
    raw = json.dumps(payload).encode()
    return raw, "sha256:" + hashlib.sha256(raw).hexdigest()


def _direct(media_type=OCI_IMAGE, **overrides):
    config_type = (
        "application/vnd.oci.image.config.v1+json"
        if media_type == OCI_IMAGE
        else "application/vnd.docker.container.image.v1+json"
    )
    return {
        "schemaVersion": 2,
        "mediaType": media_type,
        "config": {"mediaType": config_type, "digest": CHILD_DIGEST, "size": 123},
        "layers": [],
        **overrides,
    }


@pytest.mark.parametrize("reverse", [False, True])
@pytest.mark.parametrize(
    "index_type,image_type", [(OCI_INDEX, OCI_IMAGE), (DOCKER_INDEX, DOCKER_IMAGE)]
)
def test_selects_amd64_not_attestation_or_array_position(reverse, index_type, image_type):
    entries = [
        _descriptor(mediaType=image_type),
        _descriptor(
            digest="sha256:" + "b" * 64,
            platform={"os": "unknown", "architecture": "unknown"},
            annotations={"vnd.docker.reference.type": "attestation-manifest"},
        ),
    ]
    if reverse:
        entries.reverse()
    raw, digest = _encoded(_index(entries, index_type))
    assert _resolver().resolve_manifest(raw, digest) == {
        "digest": CHILD_DIGEST,
        "selection": "linux/amd64",
    }


@pytest.mark.parametrize("media_type", [OCI_IMAGE, DOCKER_IMAGE])
def test_direct_manifest_keeps_original_digest(media_type):
    raw, digest = _encoded(_direct(media_type))
    assert _resolver().resolve_manifest(raw, digest) == {
        "digest": digest,
        "selection": "direct_manifest",
    }


@pytest.mark.parametrize(
    "payload",
    [
        _index([]),
        _index([_descriptor(platform={"os": "linux", "architecture": "arm64"})]),
        _index([_descriptor(), _descriptor()]),
        _index([_descriptor(digest="sha256:invalid")]),
        _index([_descriptor(digest="latest")]),
        _index([_descriptor(mediaType=OCI_INDEX)]),
        _index([_descriptor(mediaType="unsupported")]),
        _index([_descriptor(annotations={"vnd.docker.reference.type": "attestation-manifest"})]),
        _index([_descriptor(artifactType="application/vnd.in-toto+json")]),
        _index([_descriptor(platform="linux/amd64")]),
        _index([_descriptor(annotations=[])]),
        _index([_descriptor(platform=[])]),
        _index([None]),
        _index(None),
        {"schemaVersion": 1, "mediaType": OCI_INDEX},
        {"schemaVersion": 2, "mediaType": "unsupported"},
        {"schemaVersion": 2, "mediaType": {}},
        {"schemaVersion": 2, "mediaType": OCI_IMAGE},
        _direct(artifactType="application/vnd.in-toto+json"),
        _direct(annotations={"vnd.docker.reference.type": "attestation-manifest"}),
        _direct(annotations=[]),
        _direct(config=None),
        _direct(config={"mediaType": OCI_IMAGE, "digest": CHILD_DIGEST, "size": 123}),
        _direct(layers=None),
        _direct(layers=[None]),
        _direct(layers=[{"mediaType": "layer", "digest": "latest", "size": 123}]),
        _direct(layers=[{"mediaType": "layer", "digest": CHILD_DIGEST, "size": True}]),
        [],
    ],
)
def test_rejects_missing_ambiguous_or_malformed_executable(payload):
    raw, digest = _encoded(payload)
    with pytest.raises(ValueError):
        _resolver().resolve_manifest(raw, digest)


def test_rejects_bytes_not_bound_to_pinned_index():
    raw, digest = _encoded(_index([_descriptor()]))
    with pytest.raises(ValueError, match="do not match"):
        _resolver().resolve_manifest(raw + b" ", digest)
    with pytest.raises(ValueError, match="do not match"):
        _resolver().resolve_manifest(raw, "sha256:" + "c" * 64)
    with pytest.raises(ValueError, match="immutable"):
        _resolver().resolve_manifest(raw, "latest")
    assert _resolver().resolve_manifest(raw + b"\n", digest)["digest"] == CHILD_DIGEST


@pytest.mark.parametrize("matches", [True, False])
def test_actual_candidate_gate_keeps_exact_digest_equality(tmp_path: Path, matches: bool):
    workflow = yaml.safe_load((ROOT / ".github/workflows/deploy-uat.yml").read_text())
    step = next(
        step
        for step in workflow["jobs"]["deploy"]["steps"]
        if step.get("name") == "Verify backend candidate readiness and exact-SHA provenance"
    )
    script = step["run"].split("python3 - <<'PY'\n", 1)[1].split("\nPY", 1)[0]
    for name in ("uat-backend-candidate.json", "uat-backend-candidate-readiness.json"):
        script = script.replace(
            f"/tmp/{name}",  # noqa: S108 - redirect workflow fixtures to pytest isolation
            (tmp_path / name).as_posix(),
        )
    image = "gcr.io/hushh-pda-uat/consent-protocol@" + CHILD_DIGEST
    provenance = {
        "HUSHH_DEPLOY_SHA": "c" * 40,
        "HUSHH_DEPLOY_ENV": "uat",
        "HUSHH_DEPLOY_SOURCE": "deploy-uat",
        "HUSHH_DEPLOY_RUN_ID": "123",
    }
    revision = {
        "metadata": {
            "name": "candidate",
            "labels": {
                "deploy-sha": "c" * 40,
                "deploy-env": "uat",
                "deploy-source": "deploy-uat",
                "account-deletion-contract": "v201",
            },
        },
        "spec": {
            "containers": [
                {
                    "image": image,
                    "env": [{"name": name, "value": value} for name, value in provenance.items()],
                }
            ]
        },
        "status": {"conditions": [{"type": "Ready", "status": "True"}]},
    }
    (tmp_path / "uat-backend-candidate.json").write_text(json.dumps(revision))
    environment = {
        **os.environ,
        "BACKEND_REVISION": "candidate",
        "EXPECTED_SHA": "c" * 40,
        "GITHUB_RUN_ID": "123",
        "EXPECTED_IMAGE_REFERENCE": image
        if matches
        else "gcr.io/hushh-pda-uat/consent-protocol@sha256:" + "b" * 64,
    }
    result = subprocess.run(  # noqa: S603 - extracted trusted Python gate, inert fixed fixtures
        [sys.executable, "-c", script],
        env=environment,
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    report = json.loads((tmp_path / "uat-backend-candidate-readiness.json").read_text())
    assert (result.returncode == 0) is matches, result.stderr
    assert report["checks"]["immutable_image"] is matches
    assert all(value for key, value in report["checks"].items() if key != "immutable_image")
