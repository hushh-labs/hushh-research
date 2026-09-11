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


def _run_classifier(tmp_path, monkeypatch, report: dict, **env: str) -> dict:
    """Execute the real workflow classifier against one verifier report."""
    root = Path(__file__).resolve().parents[2]
    workflow = yaml.safe_load((root / ".github/workflows/deploy-dev.yml").read_text())
    step = next(
        step
        for job in workflow["jobs"].values()
        for step in job.get("steps", [])
        if step.get("id") == "classify-dev-release"
    )
    source = step["run"].split("python3 - <<'PY'\n", 1)[1].rsplit("\nPY", 1)[0]
    source = source.replace("/tmp/", str(tmp_path) + "/")  # noqa: S108 - pytest isolation
    (tmp_path / "dev-release-verify-attempt-2.json").write_text(json.dumps(report))
    base = {
        "DEPLOY_BACKEND": "true",
        "DEPLOY_FRONTEND": "true",
        "PARITY_ATTEMPT_1": "success",
        "PARITY_ATTEMPT_2": "skipped",
        "BACKEND_PROVENANCE_OUTCOME": "success",
        "FRONTEND_PROVENANCE_OUTCOME": "success",
        "DB_OUTCOME": "success",
        "SEMANTIC_ATTEMPT_1": "success",
        "SEMANTIC_ATTEMPT_2": "skipped",
        "GITHUB_OUTPUT": str(tmp_path / "outputs"),
    }
    base.update(env)
    for key, value in base.items():
        monkeypatch.setenv(key, value)
    exec(  # noqa: S102 - trusted repository workflow
        compile(source, str(root / ".github/workflows/deploy-dev.yml"), "exec"), {}
    )
    return json.loads((tmp_path / "dev-release-classification.json").read_text())


def test_a_degraded_capability_is_recorded_rather_than_dropped(tmp_path, monkeypatch):
    """The dev lane read `failures` and nothing else, so a capability the
    verifier deliberately marked degraded left no trace anywhere.

    That is not a cosmetic gap here. Private voice is degraded on EVERY dev
    release, because the shared smoke account has no provisioned pod, so the
    one signal saying "deployed correctly, this capability is unavailable" had
    nowhere to appear. An amber nobody can see is the same as green.
    """
    result = _run_classifier(
        tmp_path,
        monkeypatch,
        {"status": "degraded", "failures": [], "degraded": ["voice_relay_session"]},
    )

    assert result["release_failed"] is False, "degraded must not block a dev release"
    assert result["dependency_health"]["degraded"] is True
    assert result["dependency_health"]["degraded_capabilities"] == ["voice_relay_session"]


def test_a_healthy_release_reports_no_degradation(tmp_path, monkeypatch):
    result = _run_classifier(
        tmp_path, monkeypatch, {"status": "healthy", "failures": [], "degraded": []}
    )
    assert result["release_failed"] is False
    assert result["dependency_health"]["degraded"] is False
    assert result["dependency_health"]["degraded_capabilities"] == []


def test_a_blocking_failure_still_blocks_even_beside_a_degradation(tmp_path, monkeypatch):
    """Otherwise the new field would be a way to launder a real regression."""
    result = _run_classifier(
        tmp_path,
        monkeypatch,
        {
            "status": "blocked",
            "failures": ["frontend_login"],
            "degraded": ["voice_relay_session"],
        },
        SEMANTIC_ATTEMPT_1="failure",
        SEMANTIC_ATTEMPT_2="failure",
    )
    assert result["release_failed"] is True
    assert result["frontend_failure"] is True
    assert result["dependency_health"]["degraded_capabilities"] == ["voice_relay_session"]
