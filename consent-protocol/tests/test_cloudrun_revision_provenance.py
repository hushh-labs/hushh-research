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
