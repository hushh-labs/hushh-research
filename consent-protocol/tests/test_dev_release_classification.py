"""Execute the deploy classifier against semantic failure receipts."""

import json
from pathlib import Path

import pytest
import yaml


@pytest.mark.parametrize(
    ("failure", "backend", "frontend", "blocked"),
    [
        ("voice_relay_session", True, False, True),
        ("frontend_login", False, True, True),
        ("signed_in_routes:/one", False, False, False),
    ],
)
def test_semantic_failure_selects_rollback(
    tmp_path, monkeypatch, failure, backend, frontend, blocked
):
    root = Path(__file__).resolve().parents[2]
    workflow = yaml.safe_load((root / ".github/workflows/deploy-dev.yml").read_text())
    step = next(
        step
        for job in workflow["jobs"].values()
        for step in job.get("steps", [])
        if step.get("id") == "classify-dev-release"
    )
    source = step["run"].split("python3 - <<'PY'\n", 1)[1].rsplit("\nPY", 1)[0]
    # Keep the actual classifier intact; redirect its artifact directory only.
    source = source.replace("/tmp/", str(tmp_path) + "/")  # noqa: S108 - redirects to pytest isolation
    (tmp_path / "dev-release-verify-attempt-2.json").write_text(
        json.dumps({"status": "blocked", "failures": [failure]})
    )
    for key, value in {
        "DEPLOY_BACKEND": "true",
        "DEPLOY_FRONTEND": "true",
        "PARITY_ATTEMPT_1": "success",
        "PARITY_ATTEMPT_2": "skipped",
        "BACKEND_PROVENANCE_OUTCOME": "success",
        "FRONTEND_PROVENANCE_OUTCOME": "success",
        "DB_OUTCOME": "success",
        "SEMANTIC_ATTEMPT_1": "failure",
        "SEMANTIC_ATTEMPT_2": "failure",
        "GITHUB_OUTPUT": str(tmp_path / "outputs"),
    }.items():
        monkeypatch.setenv(key, value)
    exec(compile(source, str(root / ".github/workflows/deploy-dev.yml"), "exec"), {})  # noqa: S102 - trusted repository workflow
    result = json.loads((tmp_path / "dev-release-classification.json").read_text())
    assert result["release_failed"] is blocked
    assert result["backend_failure"] is backend
    assert result["frontend_failure"] is frontend
