from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


SCRIPT = Path(__file__).with_name("resolve-cloud-run-deploy-revision.py")


def run(tmp_path: Path, revisions: list[dict]) -> subprocess.CompletedProcess[str]:
    source = tmp_path / "revisions.json"
    source.write_text(json.dumps(revisions), encoding="utf-8")
    return subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "--revisions-json",
            str(source),
            "--deploy-env",
            "uat",
            "--deploy-source",
            "deploy-uat",
            "--deploy-sha",
            "abc123",
            "--github-run-id",
            "42",
            "--github-run-attempt",
            "2",
        ],
        check=False,
        capture_output=True,
        text=True,
    )


def revision(name: str, *, sha: str = "abc123", run_id: str = "42", run_attempt: str = "2") -> dict:
    return {
        "metadata": {
            "name": name,
            "labels": {
                "deploy-env": "uat",
                "deploy-source": "deploy-uat",
                "deploy-sha": sha,
                "github-run-id": run_id,
                "github-run-attempt": run_attempt,
            },
        }
    }


def test_selects_exact_governed_revision(tmp_path: Path) -> None:
    result = run(tmp_path, [revision("old", sha="older"), revision("candidate")])
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "candidate"


def test_fails_closed_when_no_exact_revision_exists(tmp_path: Path) -> None:
    result = run(tmp_path, [revision("wrong-run", run_id="41")])
    assert result.returncode != 0
    assert "found 0" in result.stderr


def test_fails_closed_when_labels_are_ambiguous(tmp_path: Path) -> None:
    result = run(tmp_path, [revision("candidate-a"), revision("candidate-b")])
    assert result.returncode != 0
    assert "found 2" in result.stderr


def test_selects_only_the_current_run_attempt(tmp_path: Path) -> None:
    result = run(
        tmp_path,
        [revision("first-attempt", run_attempt="1"), revision("current-attempt")],
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "current-attempt"


def test_text_recovery_cannot_run_against_unverified_or_production_service():
    import copy
    import importlib.util
    import pytest

    path = Path(__file__).parents[1] / "ops/run_uat_text_recovery_job.py"
    spec = importlib.util.spec_from_file_location("uat_text_recovery", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    sha = "a" * 40
    service = {
        "status": {
            "latestReadyRevisionName": "serving",
            "traffic": [{"percent": 100, "revisionName": "serving"}],
        },
        "spec": {
            "template": {
                "metadata": {"annotations": {"run.googleapis.com/cloudsql-instances": "uat-sql"}},
                "spec": {
                    "serviceAccountName": "consent-protocol-runtime@hushh-pda-uat.iam.gserviceaccount.com",
                    "containers": [
                        {
                            "image": "gcr.io/hushh-pda-uat/consent-protocol@sha256:" + "b" * 64,
                            "env": [
                                {"name": "ENVIRONMENT", "value": "uat"},
                                {"name": "HUSHH_DEPLOY_SHA", "value": sha},
                            ],
                        }
                    ],
                },
            }
        },
    }
    job = module.job_spec(service, sha=sha, run_id="123")
    task = job["spec"]["template"]["spec"]["template"]["spec"]
    assert task["maxRetries"] == 0
    assert task["containers"][0]["args"][-1] == "--limit=20"
    for mutate in (
        lambda value: value["status"]["traffic"][0].update(percent=50),
        lambda value: value["spec"]["template"]["spec"]["containers"][0]["env"][0].update(
            value="production"
        ),
        lambda value: value["spec"]["template"]["spec"].update(
            serviceAccountName="other@example.invalid"
        ),
    ):
        denied = copy.deepcopy(service)
        mutate(denied)
        with pytest.raises(ValueError):
            module.job_spec(denied, sha=sha, run_id="123")
