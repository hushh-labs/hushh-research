# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""An activated production continuation qualifies only its original runtime."""

import copy
import importlib
import json
import os
import re
import subprocess
import sys
import textwrap
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock
from unittest.mock import Mock

import pytest
import yaml

pytestmark = pytest.mark.feature_auth_reliability
ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def historical_status_case(monkeypatch):
    monkeypatch.syspath_prepend(str(ROOT / "scripts/ci"))
    owners = importlib.import_module("test_release_artifact_receipts")
    case = owners.ReplayedProductionReleaseArtifactTest(
        "test_legacy_production_status_is_bound_to_current_upload_and_digest"
    )
    case.setUp()
    try:
        yield case
    finally:
        case.doCleanups()


@pytest.mark.parametrize(
    "context",
    [
        "deployment",
        "cleanup",
        "clock",
        "Verify due production source",
        "Prepare operational reference intent",
    ],
)
def test_trusted_production_callers_authenticate_legacy_status_layout(
    context,
    historical_status_case,
    tmp_path,
):
    case = historical_status_case
    maintenance = case.maintenance
    workflows = ROOT / ".github/workflows"
    deploy = yaml.safe_load((workflows / "deploy-production.yml").read_text())
    cleanup = yaml.safe_load((workflows / "capacity-maintenance.yml").read_text())
    clock = yaml.safe_load((workflows / "capacity-maintenance-clock.yml").read_text())
    contexts = {
        "deployment": deploy["env"],
        "cleanup": cleanup["jobs"]["cleanup"]["env"],
        "clock": next(
            step.get("env") or {}
            for step in clock["jobs"]["check"]["steps"]
            if step["name"] == "Check production"
        ),
        **{
            step["name"]: step["env"]
            for step in cleanup["jobs"]["select-release"]["steps"]
            if step["name"]
            in {"Verify due production source", "Prepare operational reference intent"}
        },
    }
    assert len(contexts) == 5
    payload = case.archive("legacy")
    case.inventory = {"total_count": 1, "artifacts": [case.artifact]}
    flag = maintenance.release_artifact_receipts.PRODUCTION_EVIDENCE_REPAIR_FLAG
    with (
        mock.patch.dict(os.environ, {flag: contexts[context].get(flag, "false")}),
        mock.patch.object(maintenance, "api", side_effect=case.api),
        mock.patch.object(
            maintenance,
            "download",
            side_effect=AssertionError("extracted status is not authority"),
        ),
        mock.patch.object(
            maintenance.retention,
            "run_command",
            return_value=subprocess.CompletedProcess([], 0, payload, b""),
        ),
    ):
        result = maintenance.load_release(case.repo, 300, tmp_path, "production")
        assert result == {"status": "healthy", "marker": "attempt-two"}
        case.artifact["digest"] = "sha256:" + "0" * 64
        with pytest.raises(maintenance.retention.UnsafeState):
            maintenance.load_release(case.repo, 300, tmp_path, "production")


def _healthy_tag(case, reference, *, run_id="500", source=None, revision=None):
    source = source or case.release["sha"]
    fields = {
        "sha": source,
        "backend_revision": revision or case.release["final"]["backend_revision"],
        "backend_url": "https://api.example.test",
        "frontend_revision": case.release["final"]["frontend_revision"],
        "frontend_url": "https://app.example.test",
        "run": f"https://github.com/hushh-labs/hushh-research/actions/runs/{run_id}",
        "actor": "governed-maintainer",
        "tagged_at": "20261027T010000Z",
    }
    message = "Last known good — production\n" + "".join(
        f"{key}: {value}\n" for key, value in fields.items()
    )
    return reference.tag_identity(
        f"object {source}\ntype commit\ntag deployed/production-latest\n"
        "tagger Fixture <fixture@example.test> 1793001000 +0000\n\n" + message
    )


@pytest.fixture
def production_case(monkeypatch):
    monkeypatch.syspath_prepend(str(ROOT / "deploy/phone"))
    monkeypatch.syspath_prepend(str(ROOT / "scripts/ci"))
    receipt = importlib.import_module("production_receipt")
    owners = importlib.import_module("test_release_artifact_receipts")
    cases = importlib.import_module("production_activation_continuation_cases")
    proof = importlib.import_module("production_backend_successor_proof")
    fixture_type = type(
        "ProductionFixture",
        (owners.ReplayedReleaseFixture, unittest.TestCase),
        {"environment": "production", "maintenance": owners.MAINTENANCE},
    )
    fixture = fixture_type()
    fixture.setUp()
    with cases._continuation_case(fixture) as case:
        case.original.run["run_started_at"] = "2026-10-21T03:00:00Z"
        tag = _healthy_tag(case, proof.reference)
        reads = Mock(side_effect=lambda: copy.deepcopy(tag))
        monkeypatch.setattr(proof, "read_original", reads)
        monkeypatch.setattr(fixture.maintenance, "api", case.api)
        monkeypatch.setattr(fixture.maintenance.retention, "run_command", case.download)
        monkeypatch.setattr(receipt, "run", _original_port(case))
        yield SimpleNamespace(
            receipt=receipt,
            case=case,
            proof=proof,
            tag=tag,
            reads=reads,
            qualify=lambda **kwargs: receipt.qualify_release(
                run_id=kwargs.get("run_id", "400"),
                sha=kwargs.get("sha", case.release["sha"]),
                revision=kwargs.get("revision", case.release["final"]["backend_revision"]),
            ),
        )


def _original_port(case):
    def command(arguments):
        if arguments[:3] == ["gh", "run", "download"]:
            directory = Path(arguments[arguments.index("--dir") + 1])
            (directory / "prod-release-status.json").write_text(json.dumps(case.original.release))
            return b""
        endpoint = arguments[-1].removeprefix("repos/hushh-labs/hushh-research/actions/")
        if re.fullmatch(r"runs/[1-9][0-9]*", endpoint):
            return json.dumps(case.original.run).encode()
        return json.dumps(case.original.api(case.fixture.repo, endpoint)).encode()

    return command


@pytest.mark.parametrize("empty_url", [False, True])
def test_completed_continuation_retains_original_runtime_provenance(production_case, empty_url):
    if empty_url:
        raw = production_case.tag["tag_object"].replace(
            "frontend_url: https://app.example.test\n", "frontend_url:\n"
        )
        production_case.tag.update(production_case.proof.reference.tag_identity(raw))
    before = copy.deepcopy(production_case.case.original.documents)
    result = production_case.qualify()
    assert result["run_id"] == "400"
    assert result["run_attempt"] == 3
    assert result["artifact_id"] == 500
    activated = result["activation_continuation"]
    assert activated["run_id"] == "500"
    assert activated["artifact_id"] == 600
    assert activated["context"]["backend"]["run_id"] == 400
    assert activated["context"]["backend"]["uid"] == "primary-uid"
    assert activated["context"]["cold_rollback"]["runtime_run_id"] == "300"
    assert production_case.case.original.documents == before
    assert "runs/400/artifacts?per_page=100" in production_case.case.original.calls
    assert production_case.reads.call_count == 2


@pytest.mark.parametrize("defect", ["uid", "source", "run", "malformed", "absent"])
def test_pending_receipt_requires_actual_strict_activation_archive(production_case, defect):
    case = production_case.case
    if defect == "uid":
        case.activation["candidate_uid"] = "recreated-primary"
    elif defect == "source":
        case.activation["sha"] = "0" * 40
    elif defect == "run":
        case.activation["run_id"] = "500"
    elif defect == "malformed":
        case.documents["prod-activation-origin.json"] = {"schema_version": 1}
    else:
        case.documents.pop("prod-activation-origin.json")
    case.pack()
    with pytest.raises((ValueError, case.fixture.maintenance.retention.UnsafeState)):
        production_case.qualify()


@pytest.mark.parametrize("field", ["sha", "revision", "run_id"])
def test_requested_original_identity_cannot_be_replaced(production_case, field):
    replacement = {
        "sha": "0" * 40,
        "revision": "consent-protocol-other",
        "run_id": "500",
    }
    with pytest.raises(ValueError):
        production_case.qualify(**{field: replacement[field]})


@pytest.mark.parametrize("defect", ["failed", "rerun", "tag", "tag-source", "pending-only"])
def test_only_current_stable_healthy_reference_can_qualify(production_case, defect):
    case = production_case.case
    if defect == "failed":
        case.run["conclusion"] = "failure"
    elif defect == "rerun":

        def rerun_after_initial_read():
            if case.calls.count("runs/500") > 1:
                case.run.update(run_attempt=2)

        case.on_refresh = rerun_after_initial_read
    elif defect == "tag":
        production_case.reads.side_effect = [
            production_case.tag,
            {**production_case.tag, "tag_oid": "0" * 40},
        ]
    else:
        production_case.reads.side_effect = None
        production_case.reads.return_value = _healthy_tag(
            case,
            production_case.proof.reference,
            **({"source": "0" * 40} if defect == "tag-source" else {"run_id": "400"}),
        )
    with pytest.raises((ValueError, case.fixture.maintenance.retention.UnsafeState)):
        production_case.qualify()


def test_ordinary_healthy_receipt_does_not_consult_continuation_authority(production_case):
    production_case.case.original.release["status"] = "healthy"
    production_case.reads.side_effect = AssertionError("ordinary healthy must stay local")
    result = production_case.qualify()
    assert result == {
        "run_id": "400",
        "run_attempt": 3,
        "artifact_id": 500,
        "source": production_case.case.release["sha"],
        "revision": production_case.case.release["final"]["backend_revision"],
    }


@pytest.mark.parametrize("defect", [None, "run_id", "source", "revision", "uid", "service_uid"])
def test_frontend_status_emits_only_actual_backend_selector(tmp_path, monkeypatch, defect):
    workflow = yaml.safe_load((ROOT / ".github/workflows/deploy-production.yml").read_text())
    step = next(
        item for item in workflow["jobs"]["deploy"]["steps"] if item.get("id") == "release-status"
    )
    script = step["run"].split("python3 - <<'PY'\n", 1)[1].rsplit("\nPY", 1)[0]
    values = {
        "steps.scope.outputs.deploy_backend": "false",
        "steps.scope.outputs.scope": "frontend",
        "steps.final-state.outputs.backend_serving": "consent-protocol-bound",
    }
    script = re.sub(r"\$\{\{\s*(.*?)\s*\}\}", lambda match: values.get(match[1], ""), script)
    script = script.replace("/tmp/", str(tmp_path) + "/")  # noqa: S108 - redirect workflow paths into pytest isolation
    expected = {
        "run_id": "500",
        "source": "a" * 40,
        "revision": "consent-protocol-bound",
        "uid": "revision-uid",
        "service_uid": "service-uid",
    }
    actual = dict(expected)
    if defect is not None:
        actual[defect] = "" if defect != "revision" else "consent-protocol-other"
    revision = {
        "metadata": {
            "name": actual["revision"],
            "uid": actual["uid"],
            "labels": {"github-run-id": actual["run_id"], "deploy-sha": actual["source"]},
        }
    }
    service = {"metadata": {"uid": actual["service_uid"]}}
    (tmp_path / "prod-backend-origin-revision.json").write_text(json.dumps(revision))
    (tmp_path / "prod-backend-final-service.json").write_text(json.dumps(service))
    monkeypatch.setenv("STATUS", "healthy")
    source = tmp_path / "actual_production_status_writer.py"
    source.write_text(textwrap.dedent(script))
    result = subprocess.run(  # noqa: S603 - execute only the repository-owned workflow in pytest isolation
        [sys.executable, str(source)], capture_output=True, text=True, check=False
    )
    if defect is not None:
        assert result.returncode != 0
        assert "no exact inherited backend selector" in result.stderr
        assert not (tmp_path / "prod-release-status.json").exists()
    else:
        assert result.returncode == 0
        report = json.loads((tmp_path / "prod-release-status.json").read_text())
        assert report["backend_origin"] == expected
        assert "phone_rollback" not in report
        assert report["status"] == "healthy"
