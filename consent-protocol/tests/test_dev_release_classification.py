"""Execute the deploy classifier against semantic failure receipts."""

import json
from pathlib import Path

import pytest
import yaml


@pytest.mark.parametrize(
    ("failure", "backend", "frontend", "blocked"),
    [
        ("location_command_recovery", True, False, True),
        ("frontend_login", False, True, True),
        ("calendar_secret", True, False, True),
        ("calendar_runtime", True, False, True),
        ("signed_in_routes:/one", False, False, False),
        ("preview_app", True, True, True),
        ("preview_mounts", True, True, True),
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
    if failure.startswith("calendar_"):
        parity = {"classifications": ["runtime_mount_missing"]}
        if failure == "calendar_secret":
            parity.update(
                required={"calendar": ["CALENDAR_SECRET"]}, missing_secrets=["CALENDAR_SECRET"]
            )
        else:
            parity["runtime_contract"] = {
                "backend_calendar": [{"key": "CALENDAR_KEY", "status": "missing"}]
            }
        (tmp_path / "dev-runtime-parity-attempt-2.json").write_text(json.dumps(parity))
        monkeypatch.setenv("PARITY_ATTEMPT_1", "failure")
        monkeypatch.setenv("PARITY_ATTEMPT_2", "failure")
        monkeypatch.setenv("SEMANTIC_ATTEMPT_1", "success")
        monkeypatch.setenv("SEMANTIC_ATTEMPT_2", "skipped")
    if failure.startswith("preview_"):
        monkeypatch.setenv("DEV_TARGET", "scope-commerce-sandbox")
        for filename in ("dev-release-verify-attempt-2.json", "dev-runtime-parity-attempt-2.json"):
            (tmp_path / filename).write_text(
                json.dumps(
                    {
                        "status": "failed",
                        "classifications": ["commerce_preview_unverified"],
                        "required": {},
                        "runtime_contract": {},
                    }
                )
            )
        if failure == "preview_mounts":
            monkeypatch.setenv("PARITY_ATTEMPT_1", "failure")
            monkeypatch.setenv("PARITY_ATTEMPT_2", "failure")
            monkeypatch.setenv("SEMANTIC_ATTEMPT_1", "success")
    else:
        monkeypatch.setenv("DEV_TARGET", "shared-dev")
    exec(compile(source, str(root / ".github/workflows/deploy-dev.yml"), "exec"), {})  # noqa: S102 - trusted repository workflow
    result = json.loads((tmp_path / "dev-release-classification.json").read_text())
    assert result["release_failed"] is blocked
    assert result["backend_failure"] is backend
    assert result["frontend_failure"] is frontend


@pytest.mark.parametrize("semantic", ["success", "failure"])
@pytest.mark.parametrize(
    ("required", "outcome", "blocked"),
    [
        (True, "failure", True),
        (True, "skipped", True),
        (True, "success", False),
        (False, "skipped", False),
    ],
)
def test_selected_owner_navigation_requires_a_successful_receipt(
    tmp_path, monkeypatch, required, outcome, blocked, semantic
):
    root = Path(__file__).resolve().parents[2]
    workflow = yaml.safe_load((root / ".github/workflows/deploy-dev.yml").read_text())
    step = next(
        step
        for step in workflow["jobs"]["deploy"]["steps"]
        if step.get("id") == "classify-dev-release"
    )
    source = step["run"].split("python3 - <<'PY'\n", 1)[1].rsplit("\nPY", 1)[0]
    source = source.replace("/tmp/", str(tmp_path) + "/")  # noqa: S108 - redirect to pytest isolation.
    if semantic == "failure":
        (tmp_path / "dev-release-verify-attempt-1.json").write_text(
            json.dumps({"status": "blocked", "failures": ["signed_in_routes:/one"]})
        )
    for key, value in {
        "DEV_TARGET": "shared-dev",
        "DEPLOY_BACKEND": "false",
        "DEPLOY_FRONTEND": "true",
        "PARITY_ATTEMPT_1": "success",
        "PARITY_ATTEMPT_2": "skipped",
        "FRONTEND_PROVENANCE_OUTCOME": "success",
        "DB_OUTCOME": "skipped",
        "SEMANTIC_ATTEMPT_1": semantic,
        "SEMANTIC_ATTEMPT_2": "skipped",
        "REVIEWER_BYOK_REQUIRED": str(required).lower(),
        "REVIEWER_BYOK_OUTCOME": outcome,
        "GITHUB_OUTPUT": str(tmp_path / "outputs"),
    }.items():
        monkeypatch.setenv(key, value)
    exec(compile(source, "dev-classifier", "exec"), {})  # noqa: S102 - authored workflow classifier
    result = json.loads((tmp_path / "dev-release-classification.json").read_text())
    assert result["release_failed"] is blocked
    assert result["frontend_failure"] is blocked
    assert result["backend_failure"] is False
    assert ("reviewer_byok_unverified" in result["blocking_classifications"]) is blocked
