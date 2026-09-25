from __future__ import annotations

import importlib.util
import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts" / "ci" / "verify-cloudrun-revision-provenance.py"
SPEC = importlib.util.spec_from_file_location("verify_cloudrun_revision_provenance", SCRIPT_PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def _write_json(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload), encoding="utf-8")


def _service_payload(revision: str) -> dict:
    return {
        "status": {
            "latestReadyRevisionName": revision,
            "traffic": [{"revisionName": revision, "percent": 100}],
        }
    }


def _revision_payload(
    revision: str,
    *,
    deploy_env: str = "uat",
    deploy_source: str = "deploy-uat",
    deploy_sha: str = "abc123",
    deploy_run_id: str = "99",
) -> dict:
    return {
        "metadata": {
            "name": revision,
            "labels": {
                "managed-by": "hushh-github-actions",
                "deploy-env": deploy_env,
                "deploy-source": deploy_source,
                "deploy-sha": deploy_sha,
                "github-run-id": deploy_run_id,
            },
        },
        "spec": {
            "containers": [
                {
                    "env": [
                        {"name": "HUSHH_DEPLOY_ENV", "value": deploy_env},
                        {"name": "HUSHH_DEPLOY_SOURCE", "value": deploy_source},
                        {"name": "HUSHH_DEPLOY_SHA", "value": deploy_sha},
                        {"name": "HUSHH_DEPLOY_RUN_ID", "value": deploy_run_id},
                    ]
                }
            ]
        },
    }


def test_cloudrun_revision_provenance_accepts_exact_governed_revision(tmp_path: Path) -> None:
    service_path = tmp_path / "service.json"
    revision_path = tmp_path / "revision.json"
    report_path = tmp_path / "report.json"
    _write_json(service_path, _service_payload("consent-protocol-001"))
    _write_json(revision_path, _revision_payload("consent-protocol-001"))

    code = MODULE.main(
        [
            "--project",
            "hushh-pda-uat",
            "--region",
            "us-central1",
            "--service",
            "consent-protocol",
            "--expected-env",
            "uat",
            "--expected-source",
            "deploy-uat",
            "--expected-sha",
            "abc123",
            "--expected-run-id",
            "99",
            "--service-json",
            str(service_path),
            "--revision-json",
            str(revision_path),
            "--report-path",
            str(report_path),
        ]
    )

    assert code == 0
    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert report["status"] == "healthy"
    assert report["checked_revisions"][0]["ok"] is True


def test_cloudrun_revision_provenance_blocks_manual_or_stale_revision(tmp_path: Path) -> None:
    service_path = tmp_path / "service.json"
    revision_path = tmp_path / "revision.json"
    report_path = tmp_path / "report.json"
    _write_json(service_path, _service_payload("consent-protocol-001"))
    _write_json(
        revision_path,
        _revision_payload(
            "consent-protocol-001",
            deploy_source="manual",
            deploy_sha="old-sha",
            deploy_run_id="manual",
        ),
    )

    code = MODULE.main(
        [
            "--project",
            "hushh-pda-uat",
            "--region",
            "us-central1",
            "--service",
            "consent-protocol",
            "--expected-env",
            "uat",
            "--expected-source",
            "deploy-uat",
            "--expected-sha",
            "abc123",
            "--expected-run-id",
            "99",
            "--service-json",
            str(service_path),
            "--revision-json",
            str(revision_path),
            "--report-path",
            str(report_path),
        ]
    )

    assert code == 1
    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert report["status"] == "blocked"
    assert report["classifications"] == ["deploy_authority_drift"]
    assert report["failures"][0]["reason"] == "revision_provenance_mismatch"


def test_candidate_checks_image_readiness_identity_and_tag_before_promotion(tmp_path):
    from argparse import Namespace
    from copy import deepcopy

    name = "consent-protocol-002"
    digest = "sha256:" + "a" * 64
    service = _service_payload("consent-protocol-001")
    service["status"]["traffic"].append(
        {
            "revisionName": name,
            "tag": "dev-candidate-99",
            "percent": 0,
            "url": "https://dev-candidate-99---service.run.app",
        }
    )
    revision = _revision_payload(name)
    revision["metadata"]["labels"]["serving.knative.dev/service"] = "consent-protocol"
    revision["spec"]["containers"][0]["image"] = "registry/project/image:build-tag"
    revision["status"] = {
        "imageDigest": "registry/project/image@" + digest,
        "conditions": [{"type": "Ready", "status": "True"}],
    }
    service_path, revision_path = tmp_path / "service.json", tmp_path / "revision.json"
    args = Namespace(
        project="project",
        region="region",
        service="consent-protocol",
        expected_env="uat",
        expected_source="deploy-uat",
        expected_sha="abc123",
        expected_run_id="99",
        service_json=str(service_path),
        revision_json=[str(revision_path)],
        candidate_revision=name,
        expected_image_reference="registry/project/image@" + digest,
        candidate_tag="dev-candidate-99",
    )
    _write_json(service_path, service)
    _write_json(revision_path, revision)
    report = MODULE.verify(args)
    assert report["ok"] is True
    assert report["candidate_url"] == service["status"]["traffic"][1]["url"]
    assert report["checked_revisions"][0]["traffic_percent"] == 0

    for field, value in (
        ("imageDigest", "sha256:" + "b" * 64),
        ("imageDigest", ""),
        ("conditions", [{"type": "Ready", "status": "False"}]),
    ):
        broken = deepcopy(revision)
        broken["status"][field] = value
        _write_json(revision_path, broken)
        assert MODULE.verify(args)["ok"] is False
    for key in ("deploy-sha", "github-run-id", "serving.knative.dev/service"):
        broken = deepcopy(revision)
        broken["metadata"]["labels"][key] = "wrong"
        _write_json(revision_path, broken)
        assert MODULE.verify(args)["ok"] is False
    _write_json(revision_path, revision)
    for tag_entry in (
        {},
        {"tag": args.candidate_tag, "revisionName": "wrong", "url": "https://service.run.app"},
        {"tag": args.candidate_tag, "revisionName": name, "url": "http://service.run.app"},
    ):
        broken = deepcopy(service)
        broken["status"]["traffic"][1] = tag_entry
        _write_json(service_path, broken)
        assert MODULE.verify(args)["ok"] is False
