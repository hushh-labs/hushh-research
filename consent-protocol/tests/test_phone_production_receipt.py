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
        f"object {source}\ntype commit\ntag deployed/production/{source[:8]}-20261027T010000Z\n"
        "tagger Fixture <fixture@example.test> 1793001000 +0000\n\n" + message,
        ref=f"refs/tags/deployed/production/{source[:8]}-20261027T010000Z",
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
    try:
        with cases._continuation_case(fixture) as case:
            case.original.run["run_started_at"] = "2026-10-21T03:00:00Z"
            tag = _healthy_tag(case, proof.reference)
            reads = Mock(side_effect=lambda *args, **kwargs: copy.deepcopy(tag))
            monkeypatch.setattr(
                proof,
                "read_original",
                Mock(side_effect=AssertionError("moving latest is not historical authority")),
            )
            monkeypatch.setattr(proof, "read_tag", reads)
            monkeypatch.setattr(cases.continuation, "publication_tag", reads)
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
    finally:
        fixture.doCleanups()


def _original_port(case):
    def command(arguments):
        if arguments[:3] == ["gh", "run", "download"]:
            raise AssertionError("extracted status is not immutable receipt authority")
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
        production_case.tag.update(
            production_case.proof.reference.tag_identity(
                raw,
                ref=production_case.proof.reference.REF.removesuffix("production-latest")
                + "production/"
                + production_case.case.release["sha"][:8]
                + "-20261027T010000Z",
            )
        )
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


def test_final_rollback_qualifies_original_mixed_root_receipt(production_case):
    from production_phone_receipt_fixtures import mixed_root_archive

    case = production_case.case
    case.original.payload = mixed_root_archive(case.original, case.original.documents)
    case.origin = case.load()
    case.documents["prod-activation-origin.json"] = case.origin
    case.payload = mixed_root_archive(case, case.documents)
    result = production_case.qualify()
    assert result["artifact_id"] == case.original.artifact["id"]
    assert result["activation_continuation"]["context"]["backend"]["run_id"] == 400
    case.original.artifact["digest"] = "sha256:" + "0" * 64
    with pytest.raises(case.fixture.maintenance.retention.UnsafeState):
        production_case.qualify()


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
    production_case.case.original.pack()
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


def test_published_activation_failure_preserves_original_native_authority(
    production_case, monkeypatch
):
    case = production_case.case
    production_case.tag.update(case.published_failure())
    result = production_case.qualify()
    assert result["run_id"] == "400"
    assert (
        result["activation_continuation"]["context"]["publication_reconciliation"]["run_id"] == 500
    )
    case.jobs["jobs"][-1]["conclusion"] = "failure"
    with pytest.raises(case.fixture.maintenance.retention.UnsafeState):
        production_case.qualify()


def test_production_tag_reader_ignores_stale_local_inspection_ref(tmp_path, monkeypatch):
    import subprocess

    monkeypatch.syspath_prepend(str(ROOT / "scripts/ci"))
    proof = importlib.import_module("production_backend_successor_proof")
    origin, checkout = tmp_path / "origin.git", tmp_path / "checkout"
    subprocess.run(["git", "init", "--bare", str(origin)], check=True, capture_output=True)  # noqa: S603 - exact Git fixture command
    subprocess.run(["git", "init", str(checkout)], check=True, capture_output=True)  # noqa: S603 - exact Git fixture command

    def git(*args, data=None):
        return subprocess.run(  # noqa: S603 - test-authored arguments, no shell
            ["git", "-C", str(checkout), *args],
            input=data,
            text=True,
            check=True,
            capture_output=True,
        ).stdout.strip()

    git("config", "user.name", "Fixture")
    git("config", "user.email", "fixture@example.test")
    git("remote", "add", "origin", str(origin))
    git("commit", "--allow-empty", "-m", "fixture")
    git("tag", "-a", "old", "-m", "old")
    old = git("rev-parse", "old")
    local = "refs/codex/phone-operational-healthy"
    git("update-ref", local, old)
    source = git("rev-parse", "HEAD")
    message = "Last known good — production\n" + "".join(
        f"{key}: {value}\n"
        for key, value in {
            "sha": source,
            "backend_revision": "consent-protocol-fixture",
            "backend_url": "https://api.example.test",
            "frontend_revision": "hushh-webapp-fixture",
            "frontend_url": "https://app.example.test",
            "run": "https://github.com/hushh-labs/hushh-research/actions/runs/500",
            "actor": "fixture",
            "tagged_at": "20261027T010000Z",
        }.items()
    )
    git("tag", "-a", "deployed/production-latest", "-m", message)
    git("push", "origin", "refs/tags/deployed/production-latest")
    monkeypatch.chdir(checkout)
    result = proof.read_original()
    assert result["tag_oid"] == git("rev-parse", "deployed/production-latest")
    assert git("rev-parse", local) == old
    immutable = f"refs/tags/deployed/production/{source[:8]}-20261027T010000Z"
    git("tag", "-a", immutable.removeprefix("refs/tags/"), "-m", message)
    git("push", "origin", immutable)
    assert proof.read_tag(immutable)["commit"] == source
    assert git("rev-parse", local) == old
    with pytest.raises(ValueError, match="original_tag_invalid"):
        proof.reference.tag_identity(proof.read_tag(immutable)["tag_object"])
    actual_remote = proof.reference.remote_oid
    values = iter([actual_remote(), "0" * 40])
    monkeypatch.setattr(proof.reference, "remote_oid", lambda: next(values))
    with pytest.raises(ValueError, match="original_tag_changed"):
        proof.read_original()


@pytest.mark.parametrize(
    "defect",
    [
        None,
        "open_flag",
        "secret_flag",
        "wrong_service_uid",
        "error_status",
        "wrong_log",
        "later_request",
        "duplicate_generation",
        "contrary_preserved",
    ],
)
def test_retired_post_restoration_revision_requires_authenticated_service_completion(
    monkeypatch, defect
):
    monkeypatch.syspath_prepend(str(ROOT / "deploy/phone"))
    monkeypatch.syspath_prepend(str(ROOT / "scripts/ci"))
    closed = importlib.import_module("workos_rollout")
    bridge = importlib.import_module("workos_recovery_bridge")
    restoration = importlib.import_module("restoration_workos_observation")
    operational = importlib.import_module("operational_workos_observation")
    authority = bridge.contract()
    retired_sha = "4" * 40
    restoration_sha = authority["BACKEND_SOURCE"]
    request_event = {
        "timestamp": "2026-10-29T14:33:30Z"
        if defect != "later_request"
        else "2026-10-29T14:34:00Z",
        "resource": {"labels": {"service_name": "consent-protocol"}},
        "logName": "projects/hushh-pda/logs/cloudaudit.googleapis.com%2Factivity",
        "protoPayload": {
            "serviceName": "run.googleapis.com",
            "methodName": "/Services.ReplaceService",
            "request": {
                "service": {
                    "spec": {
                        "template": {
                            "metadata": {
                                "name": "consent-protocol-00312-fig",
                                "labels": {"deploy-sha": retired_sha},
                            },
                            "spec": {"containers": [{"env": []}]},
                        }
                    }
                }
            },
        },
    }
    flag = {"name": "WORKOS_SSO_ENABLED", "value": "true" if defect == "open_flag" else "false"}
    if defect == "secret_flag":
        flag = {"name": "WORKOS_SSO_ENABLED", "valueFrom": {"secretKeyRef": {"name": "flag"}}}

    def completion_row(insert_id, generation, name, sha, env_flag, ts="2026-10-29T14:33:31Z"):
        return {
            "insertId": insert_id,
            "timestamp": ts,
            "logName": (
                "projects/hushh-pda/logs/cloudaudit.googleapis.com%2Factivity"
                if defect == "wrong_log"
                else bridge.COMPLETION_LOG
            ),
            "resource": {
                "labels": {
                    "project_id": "hushh-pda",
                    "location": "us-central1",
                    "service_name": "consent-protocol",
                }
            },
            "protoPayload": {
                "serviceName": "run.googleapis.com",
                "methodName": "/Services.ReplaceService",
                "resourceName": "namespaces/hushh-pda/services/consent-protocol",
                **({"status": {"code": 13}} if defect == "error_status" else {}),
                "response": {
                    "kind": "Service",
                    "metadata": {
                        "name": "consent-protocol",
                        "uid": (
                            "wrong-uid"
                            if defect == "wrong_service_uid"
                            else authority["BACKEND_SERVICE_UID"]
                        ),
                        "generation": generation,
                    },
                    "status": {"latestCreatedRevisionName": name},
                    "spec": {
                        "template": {
                            "metadata": {"name": name, "labels": {"deploy-sha": sha}},
                            "spec": {"containers": [{"name": "app", "env": [env_flag]}]},
                        }
                    },
                },
            },
        }

    completions = [completion_row("comp-312", 312, "consent-protocol-00312-fig", retired_sha, flag)]
    if defect == "duplicate_generation":
        completions.append(
            completion_row("comp-312b", 312, "consent-protocol-00312-fig", retired_sha, flag)
        )
    preserved_event = copy.deepcopy(request_event)
    preserved_event["timestamp"] = "2026-10-27T01:36:00Z"
    preserved_event["protoPayload"]["request"]["service"]["spec"]["template"]["metadata"] = {
        "name": restoration.REVISION,
        "labels": {"deploy-sha": restoration_sha},
    }
    completions.append(
        completion_row(
            "comp-305",
            305,
            restoration.REVISION,
            restoration_sha,
            {
                "name": "WORKOS_SSO_ENABLED",
                "value": "true" if defect == "contrary_preserved" else "false",
            },
            ts="2026-10-27T01:36:32Z",
        )
    )
    observation = {
        "row": {
            "revision": restoration.REVISION,
            "source": restoration_sha,
            "created_at": restoration.CREATED,
            "capable": True,
            "direct_sso_false": True,
        },
        "history_start": closed.HISTORY_START,
        "history_until": "2026-10-27T08:54:23Z",
        "source_anchor": closed.SOURCE_ANCHOR,
        "provenance": {"run_id": restoration.RUN, "run_attempt": restoration.ATTEMPT},
    }
    operational_event = copy.deepcopy(request_event)
    operational_event["timestamp"] = "2026-10-27T04:00:00Z"
    operational_event["protoPayload"]["request"]["service"]["spec"]["template"]["metadata"] = {
        "name": operational.REVISION,
        "labels": {"deploy-sha": restoration_sha},
    }
    operational_obs = {
        "row": {
            "revision": operational.REVISION,
            "source": restoration_sha,
            "created_at": operational.CREATED,
            "capable": True,
            "direct_sso_false": True,
        },
        "history_start": closed.HISTORY_START,
        "history_until": "2026-10-29T06:00:10Z",
        "source_anchor": closed.SOURCE_ANCHOR,
        "revision_uid": "operational-uid",
        "provenance": {"origin": {"run_id": "40884680280", "run_attempt": 1}},
    }
    events = [preserved_event, operational_event, request_event]
    monkeypatch.setattr(closed, "_capable", lambda *_: True)
    monkeypatch.setattr(closed, "_revisions", lambda *_: {})
    monkeypatch.setattr(
        closed,
        "_document",
        lambda cmd: completions if "system_event" in cmd[3] else events,
    )
    monkeypatch.setattr(
        closed,
        "database_evidence",
        lambda _project: {"memberships_empty": True, "sso_receipts_empty": True},
    )
    loader = Mock(return_value=copy.deepcopy(observation))
    op_loader = Mock(return_value=copy.deepcopy(operational_obs))
    monkeypatch.setattr(restoration, "load", loader)
    monkeypatch.setattr(operational, "load", op_loader)
    if defect:
        expected = (
            "workos_service_completion_unqualified"
            if defect in {"wrong_service_uid", "error_status", "wrong_log", "duplicate_generation"}
            else "workos_historical_issuer_not_proven_closed"
        )
        with pytest.raises(ValueError, match=expected):
            closed.qualify("hushh-pda", restoration_sha)
    else:
        with pytest.raises(ValueError, match="workos_historical_issuer_not_proven_closed"):
            closed.review_history(
                events,
                {},
                project="hushh-pda",
                until="2026-10-30T00:00:00Z",
                restoration_sha=restoration_sha,
                check=lambda *_: True,
                historical_observation=observation,
                operational_observation=operational_obs,
            )
        receipt = closed.qualify("hushh-pda", restoration_sha)
        assert receipt["qualification"] == "passed"
        assert receipt["audit_event_count"] == 3
        assert receipt["operational_observation"]["origin"] == {
            "run_id": "40884680280",
            "run_attempt": 1,
        }
        loader.assert_called_once_with(restoration_sha)
        op_loader.assert_called_once_with(restoration_sha)
