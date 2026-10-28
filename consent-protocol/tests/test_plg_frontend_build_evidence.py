"""Synthetic build evidence is never hosted or deployment acceptance."""

import base64
import copy
import hashlib
import json
import sys
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "deploy/plg"))
sys.path.insert(0, str(ROOT / "consent-protocol/tests"))
import frontend_build_evidence as evidence  # noqa: E402
import test_plg_frontend_secret_pins as fixtures  # noqa: E402


def fixture(monkeypatch):
    attempt = evidence.release.Attempt("uat", "a" * 40, "123", "2")
    original_recipe = (
        (ROOT / "deploy/frontend-image.cloudbuild.yaml").read_bytes().replace(b"\r\n", b"\n")
    )
    original_overlays = {
        name: (ROOT / name).read_bytes().replace(b"\r\n", b"\n")
        for name in evidence.release.OVERLAYS
    }
    originals = {"deploy/frontend-image.cloudbuild.yaml": original_recipe, **original_overlays}
    authority = {name: "f" * 64 for name in evidence.release.AUTHORITY_PATHS}
    authority[evidence.release.WORKFLOWS["uat"]] = "f" * 64
    authority.update({name: hashlib.sha256(value).hexdigest() for name, value in originals.items()})
    inventory = fixtures.inventory("uat")
    recipe, _overlays, pins = evidence.pinned_recipe.derive(
        "uat",
        original_recipe,
        original_overlays,
        inventory,
        {name: authority[name] for name in originals},
    )
    prepared = {
        "kind": "proposed-frontend-pinned-build-input-v1",
        "workflowSha": attempt.workflow_sha,
        "runId": attempt.run_id,
        "runAttempt": attempt.run_attempt,
        "substitutions": attempt.substitutions(),
        "pins": pins,
        "sourceValidation": {
            "status": "validated",
            "scope": "plg-frontend-source",
            "sourceSha": evidence.release.SOURCE,
            "runId": 42,
            "runAttempt": 1,
            "artifactId": 21,
            "artifactDigest": "sha256:" + "a" * 64,
            "trafficAuthorized": False,
            "environmentAccepted": False,
            "customerSendingAuthorized": False,
        },
        "authorityFiles": authority,
        "providerVerified": False,
        "consumptionVerified": False,
        "environmentAccepted": False,
        "productionTrafficAuthorized": False,
        "archive": {
            "sourceSha": evidence.release.SOURCE,
            "sourceTree": evidence.release.SOURCE_TREE,
            "archiveSha256": "b" * 64,
            "overlays": pins["overlaysSha256"],
        },
    }
    monkeypatch.setattr(
        evidence.release,
        "check_build",
        lambda *_args: {"buildId": "fixed-build", "indexDigest": "sha256:" + "d" * 64},
    )
    monkeypatch.setattr(
        evidence.release,
        "verify_image_manifests",
        lambda *_args: {
            "indexDigest": "sha256:" + "d" * 64,
            "executableDigest": "sha256:" + "e" * 64,
            "platform": "linux/amd64",
        },
    )
    return (
        attempt,
        prepared,
        recipe,
        {},
        "fixed-build",
        {"bucket": "test"},
        "service-account",
        b"index",
        b"child",
        original_recipe,
        original_overlays,
    )


def bind_fixture(args):
    args = list(args)
    attempt, prepared, recipe = args[:3]
    inventory = fixtures.inventory("uat", fixture_backend=True)
    pair = {
        "kind": "proposed-private-plg-backend-pair-v1",
        "environment": "uat",
        "project": attempt.project,
        "candidateUrl": "https://tag---s.example.run.app",
        "providerVerified": False,
        "durableFenceVerified": False,
        "frontendPairAccepted": False,
        "productionTrafficAuthorized": False,
    }
    names = ("deploy/frontend-image.cloudbuild.yaml", *evidence.release.OVERLAYS)
    hashes = {name: prepared["authorityFiles"][name] for name in names}
    recipe, overlays, manifest = evidence.pinned_recipe.derive(
        "uat", args[-2], args[-1], inventory, hashes, fixture_backend=True
    )
    prepared["pins"] = manifest
    prepared["archive"]["overlays"] = {
        name: hashlib.sha256(value).hexdigest() for name, value in overlays.items()
    }
    bound, binding = evidence.backend_target.bind(
        recipe,
        pair,
        "uat",
        inventory=inventory,
        original_recipe=args[-2],
        original_overlays=args[-1],
        expected_hashes=hashes,
    )
    prepared["backendPair"] = pair
    prepared["backendBinding"] = binding
    args[2] = bound
    return args


def test_producer_and_consumer_bind_evidence_but_never_authorize(monkeypatch):
    args = fixture(monkeypatch)
    document = evidence.build_document(*args)
    checked = evidence.consume_document(document, *args)
    assert checked["documentValidated"] is True
    assert not any(
        checked[key]
        for key in (
            "hostedVerified",
            "providerVerified",
            "environmentAccepted",
            "productionTrafficAuthorized",
        )
    )
    assert document["imageReference"].startswith("gcr.io/hushh-pda-uat/hushh-webapp@sha256:")
    changed = copy.deepcopy(document)
    changed["hostedVerified"] = True
    with pytest.raises(evidence.release.Refused, match="evidence changed"):
        evidence.consume_document(changed, *args)


@pytest.mark.parametrize("bound", [False, True])
def test_full_synthetic_build_metadata_and_registry_proof(monkeypatch, bound):
    check_build = evidence.release.check_build
    verify_manifests = evidence.release.verify_image_manifests
    args = list(fixture(monkeypatch))
    if bound:
        args = bind_fixture(args)
    monkeypatch.setattr(evidence.release, "check_build", check_build)
    monkeypatch.setattr(evidence.release, "verify_image_manifests", verify_manifests)
    attempt, prepared, recipe = args[:3]
    index, child, child_digest, index_digest = _native_manifests()
    storage = {"bucket": "test-source", "object": "build/source.tgz", "generation": "123"}
    build_id = "12345678-1234-1234-1234-123456789abc"
    service = "projects/hushh-pda-uat/serviceAccounts/build@example.test"
    config = yaml.safe_load(recipe)
    report = {
        "kind": "plg-frontend-image-build-output-v1",
        "imageTag": attempt.tag,
        "indexDigest": index_digest,
        "platform": "linux/amd64",
    }
    build = {
        "status": "SUCCESS",
        "projectId": attempt.project,
        "serviceAccount": service,
        "id": build_id,
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
                            "value": base64.b64encode(
                                bytes.fromhex(prepared["archive"]["archiveSha256"])
                            ).decode(),
                        }
                    ]
                }
            },
        },
        "results": {
            "buildStepOutputs": ["", "", base64.b64encode(json.dumps(report).encode()).decode()]
        },
    }
    args[3:9] = [build, build_id, storage, service, index, child]
    document = evidence.build_document(*args)
    assert document["imageReference"].endswith(child_digest)
    assert not document["providerVerified"]
    assert not document["backendTargetVerified"]
    build["sourceProvenance"]["resolvedStorageSource"] = dict(storage, generation="124")
    with pytest.raises(evidence.release.Refused):
        evidence.build_document(*args)


def test_changed_backend_target_is_not_accepted_as_bound_evidence(monkeypatch):
    args = bind_fixture(fixture(monkeypatch))
    evidence.build_document(*args)
    args[1]["backendPair"]["candidateUrl"] = "https://wrong.example.run.app"
    with pytest.raises(evidence.release.Refused):
        evidence.build_document(*args)


@pytest.mark.parametrize(
    "case",
    [
        "wrong_attempt",
        "wrong_environment",
        "wrong_recipe",
        "wrong_archive",
        "wrong_overlay",
        "latest_secret",
        "different_numeric_secret",
        "missing_validation",
        "missing_authority",
        "missing_workflow",
    ],
)
def test_changed_inputs_refused(monkeypatch, case):
    args = list(fixture(monkeypatch))
    if case == "wrong_attempt":
        args[1]["runAttempt"] = "3"
    elif case == "wrong_environment":
        args[1]["pins"]["project"] = "hushh-pda-dev"
    elif case == "wrong_recipe":
        args[2] = b"changed"
    elif case == "wrong_archive":
        args[1]["archive"]["sourceSha"] = "c" * 40
    elif case == "wrong_overlay":
        args[1]["archive"]["overlays"] = {"helper": "changed"}
    elif case == "latest_secret":
        args[1]["pins"]["versions"]["BACKEND_URL"] = (
            "projects/hushh-pda-uat/secrets/BACKEND_URL/versions/latest"
        )
    elif case == "different_numeric_secret":
        args[1]["pins"]["versions"]["BACKEND_URL"] = (
            "projects/hushh-pda-uat/secrets/BACKEND_URL/versions/4"
        )
    elif case == "missing_validation":
        del args[1]["sourceValidation"]
    elif case == "missing_authority":
        del args[1]["authorityFiles"]
    else:
        del args[1]["authorityFiles"][evidence.release.WORKFLOWS["uat"]]
    with pytest.raises(evidence.release.Refused):
        evidence.build_document(*args)


def _native_manifests():
    child = json.dumps(
        {
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.manifest.v1+json",
            "config": {
                "mediaType": "application/vnd.oci.image.config.v1+json",
                "digest": "sha256:" + "c" * 64,
                "size": 1,
            },
            "layers": [],
        }
    ).encode()
    child_digest = "sha256:" + hashlib.sha256(child).hexdigest()
    index = json.dumps(
        {
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.index.v1+json",
            "manifests": [
                {
                    "mediaType": "application/vnd.oci.image.manifest.v1+json",
                    "digest": child_digest,
                    "size": len(child),
                    "platform": {"os": "linux", "architecture": "amd64"},
                }
            ],
        }
    ).encode()
    index_digest = "sha256:" + hashlib.sha256(index).hexdigest()
    return index, child, child_digest, index_digest
