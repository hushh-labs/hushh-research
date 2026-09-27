"""The TestFlight UAT backend provenance check must fail before macOS starts.

"Verify matching UAT backend revision" is the step that fails most often in
Ship iOS to TestFlight. It needs only gcloud, so it runs in the ubuntu
`preflight` job; in the macOS `ship` job it burned Xcode, Node and Python
setup before it could fail. The macOS job must also depend on the preflight
so no build starts until the check passes.
"""

from __future__ import annotations

from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github" / "workflows" / "ship-ios-testflight.yml"
CHECK = "Verify matching UAT backend revision"


def _jobs() -> dict:
    return yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))["jobs"]


def _names(job: dict) -> list[str]:
    return [str(step.get("name") or step.get("uses") or "") for step in job["steps"]]


def test_provenance_check_runs_in_the_ubuntu_preflight_after_the_sha_resolves() -> None:
    preflight = _jobs()["preflight"]
    assert str(preflight["runs-on"]).startswith("ubuntu"), preflight["runs-on"]
    assert preflight.get("environment") == "uat"
    names = _names(preflight)
    assert CHECK in names, f"{CHECK!r} left the preflight job"
    check_at = names.index(CHECK)
    assert names.index("Resolve exact green release SHA") < check_at
    assert names.index("Authenticate to Google Cloud with workload identity") < check_at

    step = preflight["steps"][check_at]
    assert step["env"]["EXPECTED_SHA"] == "${{ steps.resolve.outputs.sha }}"
    run = step["run"]
    # The resolver comes from the release SHA, as it did in the ship job.
    assert 'git show "$EXPECTED_SHA:scripts/ci/resolve-cloud-run-serving-state.py"' in run
    assert 'gcloud run services describe "$BACKEND_SERVICE"' in run
    assert "metadata.labels.deploy-sha" in run
    assert 'test "$actual_sha" = "$EXPECTED_SHA"' in run


def test_macos_ship_job_waits_for_the_preflight_and_no_longer_repeats_the_check() -> None:
    ship = _jobs()["ship"]
    assert str(ship["runs-on"]).startswith("macos")
    assert "preflight" in ship["needs"]
    assert "needs.preflight.result == 'success'" in ship["if"]
    assert CHECK not in _names(ship)
