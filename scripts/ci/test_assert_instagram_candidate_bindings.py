from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


SCRIPT = Path(__file__).with_name("assert-instagram-candidate-bindings.py")


def _revision() -> dict:
    names = (
        "INSTAGRAM_APP_ID",
        "INSTAGRAM_APP_SECRET",
        "EXTERNAL_CONNECTOR_CREDENTIAL_KEY",
        "RATE_LIMIT_STORAGE_URI",
    )
    return {
        "metadata": {"name": "candidate"},
        "spec": {
            "containers": [
                {
                    "env": [
                        {
                            "name": name,
                            "valueFrom": {
                                "secretKeyRef": {"name": name, "key": "latest"}
                            },
                        }
                        for name in names
                    ]
                }
            ]
        },
    }


def _run(tmp_path: Path, revision: dict) -> subprocess.CompletedProcess[str]:
    source = tmp_path / "candidate.json"
    source.write_text(json.dumps(revision), encoding="utf-8")
    return subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "--revision-json",
            str(source),
            "--expected-revision",
            "candidate",
            "--environment",
            "uat",
        ],
        capture_output=True,
        check=False,
        text=True,
    )


def test_accepts_secret_backed_instagram_candidate(tmp_path: Path) -> None:
    result = _run(tmp_path, _revision())
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)["status"] == "ready"


def test_rejects_literal_secret_and_redacts_value(tmp_path: Path) -> None:
    revision = _revision()
    revision["spec"]["containers"][0]["env"][1] = {
        "name": "INSTAGRAM_APP_SECRET",
        "value": "should-never-be-printed",
    }
    result = _run(tmp_path, revision)
    assert result.returncode == 1
    assert "INSTAGRAM_APP_SECRET" in result.stderr
    assert "should-never-be-printed" not in result.stderr


def test_rejects_wrong_candidate_revision(tmp_path: Path) -> None:
    revision = _revision()
    revision["metadata"]["name"] = "other"
    result = _run(tmp_path, revision)
    assert result.returncode == 1
    assert json.loads(result.stderr)["code"] == "instagram_candidate_invalid"
