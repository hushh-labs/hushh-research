"""Release discovery cannot fabricate compatibility or cross environment authority."""

from __future__ import annotations

import base64
import hashlib
import importlib.util
import io
import json
import os
import subprocess
import sys
from copy import deepcopy
from pathlib import Path

import pytest

from hushh_mcp.services.pod_release import (
    approved_release,
    configured_release,
    installed_release_presentation,
    upgrade_is_supported,
    validate_release,
)

FIXTURE = Path(__file__).parent / "fixtures/pod_release.v1.json"


def _reuse_helper():
    path = Path(__file__).resolve().parents[2] / "scripts/deploy/reuse-pod-release.py"
    spec = importlib.util.spec_from_file_location("pod_release_reuse", path)
    module = importlib.util.module_from_spec(spec)
    assert spec is not None and spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _dev_reuse_fixture(release):
    source = deepcopy(release)
    source["image"] = "gcr.io/hushh-pda-dev/consent-protocol-pod@sha256:" + "b" * 64
    raw = json.dumps(source).encode()
    pin = {
        "image": source["image"],
        "sourceRevision": source["sourceRevision"],
        "runId": source["publisher"]["runId"],
        "archiveSha256": hashlib.sha256(raw).hexdigest(),
    }
    return source, raw, pin


def test_dev_reuse_preserves_the_archived_image_and_source(release):
    helper = _reuse_helper()
    source, raw, pin = _dev_reuse_fixture(release)
    assert helper.validate_archive(pin, raw, project="hushh-pda-dev") == source
    assert (
        helper.NoRedirect().redirect_request(None, None, 302, "", {}, "https://other.invalid")
        is None
    )


@pytest.mark.parametrize("tampered", [False, True])
def test_dev_reuse_writes_provenance_only_after_manifest_verification(
    release, tmp_path, monkeypatch, tampered
):
    helper = _reuse_helper()
    manifest = json.dumps(
        {
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.manifest.v1+json",
            "config": {
                "mediaType": "application/vnd.oci.image.config.v1+json",
                "digest": "sha256:" + "a" * 64,
                "size": 1,
            },
            "layers": [],
        }
    ).encode()
    source = deepcopy(release)
    source["image"] = (
        "gcr.io/hushh-pda-dev/consent-protocol-pod@sha256:" + hashlib.sha256(manifest).hexdigest()
    )
    raw = json.dumps(source).encode()
    pin = {
        "image": source["image"],
        "sourceRevision": source["sourceRevision"],
        "runId": source["publisher"]["runId"],
        "archiveSha256": hashlib.sha256(raw).hexdigest(),
    }
    config = tmp_path / "pin.json"
    config.write_text(json.dumps(pin))
    output = tmp_path / "output"
    descriptor_sha = "d" * 40

    def cloud(*args):
        if args[:2] == ("storage", "cat"):
            assert args[2] == (
                "gs://hushh-pda-dev_cloudbuild/pod-releases/"
                f"{pin['sourceRevision']}/{pin['runId']}/release.json"
            )
            return raw
        assert args == ("auth", "print-access-token")
        return b"synthetic-registry-token"

    class Registry:
        def open(self, request, *, timeout):
            assert request.full_url == (
                "https://gcr.io/v2/hushh-pda-dev/consent-protocol-pod/manifests/"
                + source["image"].rsplit("@", 1)[1]
            )
            assert timeout == 30
            return io.BytesIO(manifest + b"tampered" if tampered else manifest)

    monkeypatch.setattr(helper, "gcloud", cloud)
    monkeypatch.setattr(helper.urllib.request, "build_opener", lambda handler: Registry())
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "reuse-pod-release.py",
            "--config",
            str(config),
            "--project",
            "hushh-pda-dev",
            "--descriptor-sha",
            descriptor_sha,
            "--workspace",
            str(output),
        ],
    )
    assert helper.main() == (1 if tampered else 0)
    if tampered:
        assert not output.exists()
        return
    assert (output / "pod-image-reference").read_text().strip() == source["image"]
    assert (output / "pod-image-source-sha").read_text().strip() == source["sourceRevision"]
    provenance = json.loads((output / "pod-image-provenance.json").read_text())
    assert provenance["sha"] == source["sourceRevision"]
    assert provenance["descriptorSourceRevision"] == descriptor_sha


@pytest.mark.parametrize("mismatch", ["checksum", "image", "source", "run", "environment"])
def test_dev_reuse_refuses_archive_or_provenance_mismatch(release, mismatch):
    helper = _reuse_helper()
    source, raw, pin = _dev_reuse_fixture(release)
    if mismatch == "checksum":
        raw += b" "
    else:
        if mismatch == "image":
            source["image"] = "gcr.io/hushh-pda-dev/consent-protocol-pod@sha256:" + "d" * 64
        elif mismatch == "source":
            source["sourceRevision"] = "d" * 40
        elif mismatch == "run":
            source["publisher"]["runId"] = "987654"
        else:
            source["publisher"]["environment"] = "production"
        raw = json.dumps(source).encode()
        pin["archiveSha256"] = hashlib.sha256(raw).hexdigest()
    with pytest.raises(ValueError):
        helper.validate_archive(pin, raw, project="hushh-pda-dev")


@pytest.fixture
def release():
    return json.loads(FIXTURE.read_text())


def test_release_requires_verified_installed_digest(release):
    checked = validate_release(release, target_image=release["image"], environment="dev")
    assert upgrade_is_supported(checked, "other/registry/pod@sha256:" + "a" * 64)
    assert not upgrade_is_supported(checked, "other/registry/pod:old")
    assert not upgrade_is_supported(checked, "sha256:" + "d" * 64)
    assert not upgrade_is_supported(None, "sha256:" + "a" * 64)
    checked["descriptor"]["supportedUpgradeDigests"] = []
    assert not upgrade_is_supported(checked, "sha256:" + "a" * 64)


def test_installed_notes_require_the_exact_retained_image_and_environment(release, monkeypatch):
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    digest = release["image"].rsplit("@", 1)[1]
    metadata = {"installedRelease": release, "privateContent": "must-not-leave"}
    presentation = installed_release_presentation(metadata, digest)
    assert presentation["notes"] == release["descriptor"]["notes"]
    assert "privateContent" not in presentation
    assert installed_release_presentation(metadata, "sha256:" + "a" * 64) == {}
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "production")
    assert installed_release_presentation(metadata, digest) == {}


@pytest.mark.parametrize("environment", ["uat", "production", "", "development"])
def test_dev_release_is_never_a_stable_or_other_environment_offer(release, environment):
    with pytest.raises(ValueError):
        validate_release(release, target_image=release["image"], environment=environment)


@pytest.mark.parametrize(
    "field,value",
    [
        ("image", "gcr.io/hushh/pod:latest"),
        ("image", "gcr.io/hushh/pod@sha256:" + "d" * 64),
        ("sourceRevision", "short-sha"),
        ("releasedAt", "2020-01-01T00:00:00"),
        ("releasedAt", "2999-01-01T00:00:00+00:00"),
        ("schemaVersion", True),
        ("publisher", {"environment": "dev", "workflow": "deploy-dev", "runId": ""}),
    ],
)
def test_release_rejects_unbound_or_invalid_metadata(release, field, value):
    target = release["image"]
    release[field] = value
    with pytest.raises(ValueError):
        validate_release(release, target_image=target, environment="dev")


@pytest.mark.parametrize(
    "field,value",
    [
        ("notes", {"unreviewed": ["Unexpected category"]}),
        ("summary", ""),
        ("summary", "x" * 401),
        ("supportedUpgradeDigests", ["pod:latest"]),
        ("channel", "stable"),
    ],
)
def test_reviewed_descriptor_has_bounded_notes_and_explicit_compatibility(release, field, value):
    release["descriptor"][field] = value
    with pytest.raises(ValueError):
        validate_release(release, target_image=release["image"], environment="dev")


def test_configured_offer_and_pinned_approval_remain_distinct(release, monkeypatch):
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    approval = {"releaseMetadata": deepcopy(release)}
    later = deepcopy(release)
    later["image"] = "gcr.io/hushh/pod@sha256:" + "d" * 64
    later["descriptor"]["version"] = "2.0-test"
    monkeypatch.setenv(
        "HUSSH_ONE_POD_RELEASE_B64", base64.b64encode(json.dumps(later).encode()).decode()
    )
    assert configured_release(later["image"])["descriptor"]["version"] == "2.0-test"
    assert configured_release(release["image"]) is None
    assert approved_release(approval, release["image"])["descriptor"]["version"] == "1.0-test"
    monkeypatch.setenv("HUSSH_ONE_POD_RELEASE_B64", "invalid base64")
    assert configured_release(release["image"]) is None


@pytest.mark.parametrize("with_browser", [False, True])
def test_build_assembles_exact_source_image_and_reviewed_notes(release, tmp_path, with_browser):
    descriptor = tmp_path / "descriptor.json"
    descriptor.write_text(json.dumps(release["descriptor"]))
    image = tmp_path / "image.txt"
    image.write_text(release["image"])
    output = tmp_path / "release.json"
    script = Path(__file__).resolve().parents[2] / "scripts/deploy/assemble-pod-release.py"
    command = [
        sys.executable,
        str(script),
        "--descriptor",
        str(descriptor),
        "--image-reference-file",
        str(image),
        "--source-sha",
        release["sourceRevision"],
        "--environment",
        "dev",
        "--run-id",
        "12345",
        "--output",
        str(output),
        "--browser-qualifications",
        str(tmp_path / "browser-pins.json"),
    ]
    if with_browser:
        statement = _browser_statement(release)
        raw = json.dumps({"qualification": statement}).encode()
        receipt = tmp_path / "browser-receipt.json"
        receipt.write_bytes(raw)
        pins = tmp_path / "browser-pins.json"
        pins.write_text(
            json.dumps([{"receipt": receipt.name, "sha256": hashlib.sha256(raw).hexdigest()}])
        )
    result = subprocess.run(command, env={**os.environ}, capture_output=True, text=True, timeout=30)  # noqa: S603 - fixed build helper and temporary fixture paths.
    assert result.returncode == 0, result.stderr
    built = json.loads(output.read_text())
    assert built["image"] == release["image"]
    assert built["sourceRevision"] == release["sourceRevision"]
    assert built["descriptor"]["version"] == "1.0-test+cccccccccccc.bbbbbbbb"
    assert built["descriptor"]["notes"] == release["descriptor"]["notes"]
    assert json.loads(base64.b64decode(output.with_suffix(".b64").read_text())) == built
    if with_browser:
        qualified = built["browserQualifications"][0]
        assert qualified == {**statement, "evidence_sha256": hashlib.sha256(raw).hexdigest()}
        assert "pod_id" not in qualified and "incarnation" not in qualified
    else:
        assert "browserQualifications" not in built


def _browser_statement(release):
    from tests.helpers.pod_browser import readiness

    return {
        "version": 1,
        "host_kind": "gcp_cloud_run",
        "source_revision": release["sourceRevision"],
        "image_tag": "source",
        "public_policy_sha256": "e" * 64,
        "readiness": readiness(component_digest=release["image"].rsplit("@", 1)[1]).model_dump(),
    }


def test_browser_receipt_and_saved_release_cannot_change_image_host_or_source(release, monkeypatch):
    from hushh_mcp.services.pod_release import (
        approved_browser_qualification,
        qualification_from_receipt,
    )

    statement = _browser_statement(release)
    raw = json.dumps({"qualification": statement}).encode()
    arguments = {
        "expected_sha256": hashlib.sha256(raw).hexdigest(),
        "image_digest": release["image"].rsplit("@", 1)[1],
        "source_revision": release["sourceRevision"],
    }
    qualified = qualification_from_receipt(raw, **arguments)
    released = {**release, "browserQualifications": [qualified]}
    assert validate_release(released, target_image=release["image"], environment="dev")
    with pytest.raises(ValueError, match="receipt changed"):
        qualification_from_receipt(raw + b" ", **arguments)
    for changed in (
        {**qualified, "source_revision": "d" * 40},
        {**qualified, "host_kind": "azure_container_apps"},
        {**qualified, "readiness": {**qualified["readiness"], "isolated": False}},
        {
            **qualified,
            "readiness": {**qualified["readiness"], "component_digest": "sha256:" + "e" * 64},
        },
    ):
        with pytest.raises(ValueError):
            validate_release(
                {**released, "browserQualifications": [changed]},
                target_image=release["image"],
                environment="dev",
            )
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    # Newer mutable hub offers cannot replace the exact captured evidence.
    monkeypatch.setenv("HUSSH_ONE_POD_RELEASE_B64", "unrelated-new-offer")
    approval = {"releaseMetadata": released}
    assert (
        approved_browser_qualification(approval, release["image"], host_kind="gcp_cloud_run")
        == qualified
    )
    assert approved_browser_qualification(approval, release["image"], host_kind="azure_vm") is None
    assert (
        approved_browser_qualification(
            approval, "pod@sha256:" + "f" * 64, host_kind="gcp_cloud_run"
        )
        is None
    )


def test_initial_installed_label_survives_a_new_offer(release, monkeypatch):
    from api.routes.one.personal_agent import describe_pod_update
    from hushh_mcp.services.pod_release import record_installed_release

    metadata = record_installed_release({"image": release["image"]}, release)
    later = deepcopy(release)
    later["image"] = "gcr.io/hushh/pod@sha256:" + "d" * 64
    later["descriptor"]["version"] = "2.0-test"
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    monkeypatch.setenv(
        "HUSSH_ONE_POD_RELEASE_B64", base64.b64encode(json.dumps(later).encode()).decode()
    )
    out = describe_pod_update({"backend_metadata": metadata}, target_image=later["image"])
    assert out["installedRelease"]["version"] == "1.0-test"
    assert out["availableRelease"]["version"] == "2.0-test"
    assert out["updateAvailable"] is True
    assert out["updateOfferable"] is False
    assert not out.get("installedReleaseVerified")
    assert "installedRelease" not in record_installed_release({"image": later["image"]}, release)


def test_verified_install_remains_verified_when_the_offer_advances(release, monkeypatch):
    from api.routes.one.personal_agent import describe_pod_update
    from hushh_mcp.services.personal_agent_provisioning_service import upgrade_release_id
    from hushh_mcp.services.pod_release import record_installed_release

    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    metadata = record_installed_release({"image": release["image"], "serviceUid": "pod-1"}, release)
    row = {"hushh_id": "ha1_test", "backend_metadata": metadata}
    release_id = upgrade_release_id(row, release["image"])
    metadata["upgradeApproval"] = {
        "status": "succeeded",
        "releaseId": release_id,
        "targetImage": release["image"],
        "operationId": "operation-1",
        "verifiedAt": "2020-01-02T00:00:00+00:00",
    }
    metadata["upgradeAcknowledgement"] = {
        "outcome": "ready",
        "serviceUid": "pod-1",
        "podIncarnation": "pod-1",
        "image": release["image"],
        "targetDigest": "sha256:" + "b" * 64,
        "releaseId": release_id,
        "operationId": "operation-1",
    }
    before = describe_pod_update(row, target_image=release["image"])
    after = describe_pod_update(row, target_image="gcr.io/hushh/pod@sha256:" + "d" * 64)
    assert before["updateVerified"] is True
    assert after["installedReleaseVerified"] is True
    assert after["installedReleaseVerifiedAt"] == metadata["upgradeApproval"]["verifiedAt"]
    assert after["updateAvailable"] is True
    assert "updateVerified" not in after
