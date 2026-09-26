"""Release discovery cannot fabricate compatibility or cross environment authority."""

from __future__ import annotations

import base64
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
    upgrade_is_supported,
    validate_release,
)

FIXTURE = Path(__file__).parent / "fixtures/pod_release.v1.json"


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


def test_build_assembles_exact_source_image_and_reviewed_notes(release, tmp_path):
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
    ]
    result = subprocess.run(command, env={**os.environ}, capture_output=True, text=True, timeout=30)  # noqa: S603 - fixed build helper and temporary fixture paths.
    assert result.returncode == 0, result.stderr
    built = json.loads(output.read_text())
    assert built["image"] == release["image"]
    assert built["sourceRevision"] == release["sourceRevision"]
    assert built["descriptor"]["version"] == "1.0-test+cccccccccccc.bbbbbbbb"
    assert built["descriptor"]["notes"] == release["descriptor"]["notes"]
    assert json.loads(base64.b64decode(output.with_suffix(".b64").read_text())) == built


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
