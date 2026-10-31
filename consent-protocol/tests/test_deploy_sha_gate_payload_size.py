"""Execute the real release gate against hermetic GitHub responses.

Protect both large-payload transport and trusted producer/current-attempt
boundaries. No test talks to GitHub or deploys a service.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from tests.helpers.deploy_gate import (
    ACCEPTED,
    GATE,
    MAX_ARG_STRLEN,
    PRODUCERS,
    REPO_ROOT,
    _branch_receipt,
    _check_run,
    _payload_over_the_arg_limit,
    _run_gate,
    _run_gate_against_github,
)

# The kernel limit this gate has to clear, computed rather than hardcoded so the
# test stays true on hosts with a page size other than 4 KiB.


def test_the_fixture_actually_exceeds_the_single_argument_limit() -> None:
    """Guard the guard: if this ever stops being over the limit the tests below prove nothing."""
    encoded = json.dumps(_payload_over_the_arg_limit())
    assert len(encoded) > MAX_ARG_STRLEN, (
        f"fixture is {len(encoded)} bytes, at or under MAX_ARG_STRLEN={MAX_ARG_STRLEN}; "
        "it would pass through argv and the regression would go unnoticed"
    )


def test_gate_passes_a_green_sha_whose_check_payload_exceeds_argv(tmp_path: Path) -> None:
    result = _run_gate(tmp_path, _payload_over_the_arg_limit())

    # Exit 126 with this message is the exact signature of the 2026-08-07 failure.
    assert "Argument list too long" not in (result.stderr + result.stdout)
    assert result.returncode == 0, f"stdout={result.stdout!r} stderr={result.stderr!r}"
    assert "Deploy SHA preflight passed" in result.stdout
    assert "CI Status Gate" in result.stdout


@pytest.mark.parametrize(
    ("mutate", "expected"),
    [
        pytest.param(
            lambda runs: [
                {**run, "conclusion": "failure"} if run["name"] == "CI Status Gate" else run
                for run in runs
            ],
            "is successful",
            id="every-gate-run-red",
        ),
        pytest.param(
            lambda runs: [run for run in runs if run["name"] != "CI Status Gate"],
            "found for",
            id="no-gate-run-present",
        ),
    ],
)
def test_gate_still_refuses_over_the_same_oversized_payload(
    tmp_path: Path, mutate, expected: str
) -> None:
    """Size handling must not become a way past the check — refusal is the point of the gate."""
    payload = _payload_over_the_arg_limit()
    payload["check_runs"] = mutate(payload["check_runs"])

    result = _run_gate(tmp_path, payload)

    assert result.returncode != 0
    assert "Refusing deploy" in result.stderr
    assert expected in result.stderr


def test_gate_refuses_a_sha_not_reachable_from_the_requested_ref(tmp_path: Path) -> None:
    result = _run_gate(tmp_path, _payload_over_the_arg_limit(), reachable=False)

    assert result.returncode != 0
    assert "is not reachable from origin/" in result.stderr


def test_payload_never_reaches_argv() -> None:
    """A response with no upper bound must not be spawned as an argument, whatever its size today."""
    source = GATE.read_text(encoding="utf-8")
    spawn = next(line for line in source.splitlines() if line.startswith("python3 -"))
    assert "$PAYLOAD_DIR" in spawn
    assert "$PAYLOAD" not in spawn.replace("$PAYLOAD_DIR", "")


@pytest.mark.parametrize(("conclusion", "passes"), [("success", True), ("failure", False)])
def test_gate_finds_the_smoke_gate_behind_more_than_a_page_of_newer_checks(
    tmp_path: Path, conclusion: str, passes: bool
) -> None:
    """An idle main head gathers Capacity Maintenance checks hourly, all newer than the push-time
    smoke gate. GitHub returns 100 per page, newest first, so an unfiltered first page loses it."""
    smoke = {**_check_run("Main Post-Merge Smoke Gate", conclusion, 0), "pull_requests": []}
    newer = [
        {**_check_run(name, "success", index), "pull_requests": []}
        for index in range(1, 151)
        for name in ("Verify due cleanup without cloud credentials",)
    ]
    runs = newer + [smoke]  # newest first, as GitHub lists them
    # Guard the guard: the first unfiltered page really does omit the smoke gate.
    assert all(run["name"] != smoke["name"] for run in runs[:100])
    result = _run_gate_against_github(tmp_path, runs, ACCEPTED)
    if passes:
        assert result.returncode == 0, f"stdout={result.stdout!r} stderr={result.stderr!r}"
        assert "Main Post-Merge Smoke Gate" in result.stdout
    else:
        assert result.returncode != 0
        assert "is successful" in result.stderr


def test_branch_verdict_is_not_an_ordinary_release_check(tmp_path: Path) -> None:
    check, workflow = _branch_receipt()
    result = _run_gate(tmp_path, {"check_runs": [check]}, workflow_runs=[workflow])
    assert result.returncode != 0
    assert "found for" in result.stderr


def test_dev_explicitly_accepts_authenticated_full_branch_verdict(tmp_path: Path) -> None:
    check, workflow = _branch_receipt()
    result = _run_gate(
        tmp_path,
        {"check_runs": [check]},
        accepted=ACCEPTED + ",Branch Validation Gate",
        workflow_runs=[workflow],
    )
    assert result.returncode == 0, result.stderr
    assert "Branch Validation Gate" in result.stdout


@pytest.mark.parametrize(
    "mutation",
    [
        "wrong-app",
        "wrong-slug",
        "wrong-check-sha",
        "unfinished-check",
        "missing-suite",
        "wrong-workflow",
        "wrong-event",
        "wrong-run-sha",
        "wrong-suite",
        "failed-run",
        "unfinished-run",
        "missing-run",
        "lookup-failed",
        "unreachable-sha",
        "wrong-job",
        "wrong-check-url",
        "missing-job",
        "incomplete-jobs",
        "stale-attempt-job",
        "reread-race",
        "newer-failed-run",
        "incomplete-runs",
    ],
)
@pytest.mark.parametrize("verdict", list(PRODUCERS))
def test_release_verdict_requires_exact_workflow_provenance(
    tmp_path: Path, mutation: str, verdict: str
) -> None:
    check, workflow = _branch_receipt(verdict)
    if mutation == "wrong-app":
        check["app"]["id"] = 42
    elif mutation == "wrong-slug":
        check["app"]["slug"] = "another-app"
    elif mutation == "wrong-check-sha":
        check["head_sha"] = "0" * 40
    elif mutation == "unfinished-check":
        check["status"] = "in_progress"
    elif mutation == "missing-suite":
        check["check_suite"] = {}
    elif mutation == "wrong-workflow":
        workflow["path"] = ".github/workflows/another.yml"
    elif mutation == "wrong-event":
        workflow["event"] = "unexpected_event"
    elif mutation == "wrong-run-sha":
        workflow["head_sha"] = "0" * 40
    elif mutation == "wrong-suite":
        workflow["check_suite_id"] = 42
    elif mutation == "failed-run":
        workflow["conclusion"] = "failure"
    elif mutation == "unfinished-run":
        workflow["status"] = "in_progress"
    elif mutation == "wrong-job":
        workflow["jobs"][0]["name"] = "Not the gate"
    elif mutation == "wrong-check-url":
        workflow["jobs"][0]["check_run_url"] += "1"
    elif mutation == "missing-job":
        workflow["jobs"] = []
    elif mutation == "incomplete-jobs":
        workflow["job_count"] = 101
    elif mutation == "stale-attempt-job":
        workflow["jobs"][0]["conclusion"] = "failure"
        workflow["run_attempt"] = 2
    elif mutation == "incomplete-runs":
        workflow["inventory_count"] = 101
    elif mutation == "reread-race":
        workflow["reread"] = {**workflow, "run_attempt": 2, "status": "in_progress"}
    workflows = [] if mutation == "missing-run" else [workflow]
    if mutation == "newer-failed-run":
        workflows.append({**workflow, "id": workflow["id"] + 1, "conclusion": "failure"})
    result = _run_gate(
        tmp_path,
        {"check_runs": [check]},
        accepted=ACCEPTED + ",Branch Validation Gate",
        workflow_runs=workflows,
        provenance_failure=mutation == "lookup-failed",
        reachable=mutation != "unreachable-sha",
    )
    assert result.returncode != 0, mutation


def test_branch_validation_is_limited_to_dev_and_explicit_curated_uat() -> None:
    # Cross-lane release authority has no runtime API: authored workflow inputs
    # are its contract. Exercise the actual SHA verifier above as well.
    import yaml

    consumers: dict[str, list[str]] = {}
    for path in (REPO_ROOT / ".github/workflows").glob("*.yml"):
        workflow = yaml.safe_load(path.read_text())
        for job in workflow.get("jobs", {}).values():
            for step in job.get("steps", []):
                accepted = str(step.get("env", {}).get("REQUIRED_CHECK_NAME", ""))
                if "Branch Validation Gate" in accepted:
                    consumers.setdefault(path.name, []).append(accepted)
    # Dev accepts a dispatched branch gate outright. Production accepts it only
    # for the explicit manual incident route, always paired with CI Status Gate.
    assert sorted(consumers) == ["deploy-dev.yml", "deploy-production.yml"]
    assert all(
        "Branch Validation Gate" in accepted.split(",") for accepted in consumers["deploy-dev.yml"]
    )
    for accepted in consumers["deploy-production.yml"]:
        assert "CI Status Gate,Branch Validation Gate" in accepted
    assert any(
        "steps.dispatch-authority.outputs.mode == 'manual-emergency'" in accepted
        for accepted in consumers["deploy-production.yml"]
    )
    assert all(
        "manual-emergency" in accepted or accepted == "CI Status Gate,Branch Validation Gate"
        for accepted in consumers["deploy-production.yml"]
    )
    uat = yaml.safe_load((REPO_ROOT / ".github/workflows/deploy-uat.yml").read_text())
    steps = uat["jobs"]["deploy"]["steps"]
    selector = next(step for step in steps if step.get("id") == "application-authority")
    assert "promotion_approval.py uat" in selector["run"]
    admission = next(
        step
        for step in steps
        if step.get("name") == "Validate deployment SHA in selected protected history"
    )
    assert (
        admission["env"]["REQUIRED_CHECK_NAME"]
        == "${{ steps.application-authority.outputs.checks || 'Main Post-Merge Smoke Gate' }}"
    )
    assert "scripts/ci/require-deploy-sha-on-main.sh" in admission["run"]
    policy = json.loads((REPO_ROOT / "config/ci-governance.json").read_text())
    assert "Branch Validation Gate" not in json.dumps(policy)


@pytest.mark.parametrize("verdict", list(PRODUCERS))
def test_each_canonical_producer_can_authorize_its_exact_check(tmp_path, verdict):
    check, workflow = _branch_receipt(verdict)
    result = _run_gate(
        tmp_path, {"check_runs": [check]}, accepted=verdict, workflow_runs=[workflow]
    )
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize("guarded", [True, False])
@pytest.mark.parametrize("head_branch", ["main", "untrusted-feature"])
def test_manual_smoke_recovery_requires_source_identity_proof(tmp_path, guarded, head_branch):
    check, workflow = _branch_receipt("Main Post-Merge Smoke Gate")
    workflow.update(event="workflow_dispatch", head_branch=head_branch)
    if not guarded:
        workflow["jobs"][0]["steps"] = []
    result = _run_gate(
        tmp_path, {"check_runs": [check]}, accepted=check["name"], workflow_runs=[workflow]
    )
    assert (result.returncode == 0) is (guarded and head_branch == "main"), result.stderr


def test_merge_queue_can_publish_ci_status_gate(tmp_path):
    check, workflow = _branch_receipt("CI Status Gate")
    workflow.update(path=".github/workflows/queue-validation.yml", event="merge_group")
    result = _run_gate(
        tmp_path, {"check_runs": [check]}, accepted=check["name"], workflow_runs=[workflow]
    )
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize("state", ["failure", "in_progress"])
def test_newer_smoke_recovery_invalidates_older_successful_push(tmp_path, state):
    check, push = _branch_receipt("Main Post-Merge Smoke Gate")
    recovery = {
        **push,
        "id": push["id"] + 1,
        "event": "workflow_dispatch",
        "status": "in_progress" if state == "in_progress" else "completed",
        "conclusion": None if state == "in_progress" else "failure",
    }
    result = _run_gate(
        tmp_path, {"check_runs": [check]}, accepted=check["name"], workflow_runs=[push, recovery]
    )
    assert result.returncode != 0, result.stdout


@pytest.mark.parametrize("kind", ["recovery", "unknown", "missing", "wrong-identity"])
def test_separate_restoration_does_not_replace_normal_smoke(tmp_path, kind):
    import copy

    check, push = _branch_receipt("Main Post-Merge Smoke Gate")
    recovery = copy.deepcopy(push)
    recovery.update(id=push["id"] + 1, event="workflow_dispatch", conclusion="failure")
    job = recovery["jobs"][0]
    job.update(
        name="Production Recovery Validation Gate",
        run_id=recovery["id"],
        head_sha=recovery["head_sha"],
        conclusion="failure",
    )
    if kind == "unknown":
        job["name"] = "Unrecognized gate"
    elif kind == "missing":
        recovery["jobs"] = []
    elif kind == "wrong-identity":
        job["run_id"] = push["id"]
    result = _run_gate(
        tmp_path, {"check_runs": [check]}, accepted=check["name"], workflow_runs=[push, recovery]
    )
    assert (result.returncode == 0) is (kind == "recovery"), result.stderr


@pytest.mark.parametrize("state", ["failure", "in_progress", "missing-time"])
def test_later_attempt_of_older_run_refuses_stale_green(tmp_path, state):
    check, green = _branch_receipt("Main Post-Merge Smoke Gate")
    older = {
        **green,
        "id": green["id"] - 1,
        "run_attempt": 2,
        "run_started_at": "2026-10-26T11:00:00Z",
        "updated_at": "2026-10-26T11:01:00Z",
        "status": "in_progress" if state == "in_progress" else "completed",
        "conclusion": None if state == "in_progress" else "failure",
    }
    if state == "missing-time":
        older.pop("run_started_at")
    result = _run_gate(
        tmp_path, {"check_runs": [check]}, accepted=check["name"], workflow_runs=[older, green]
    )
    assert result.returncode != 0, result.stdout


def test_late_completion_cannot_hide_a_newer_failed_release_attempt(tmp_path):
    check, green = _branch_receipt("Main Post-Merge Smoke Gate")
    green["updated_at"] = "2026-10-26T11:00:00Z"
    failure = {
        **green,
        "id": green["id"] + 1,
        "conclusion": "failure",
        "run_started_at": "2026-10-26T10:30:00Z",
        "updated_at": "2026-10-26T10:31:00Z",
    }
    result = _run_gate(
        tmp_path, {"check_runs": [check]}, accepted=check["name"], workflow_runs=[green, failure]
    )
    assert result.returncode != 0, result.stdout


def test_competing_release_attempt_appearing_during_admission_refuses(tmp_path):
    check, green = _branch_receipt("Main Post-Merge Smoke Gate")
    failure = {
        **green,
        "id": green["id"] + 1,
        "conclusion": "failure",
        "run_started_at": "2026-10-26T11:00:00Z",
        "updated_at": "2026-10-26T11:01:00Z",
    }
    result = _run_gate(
        tmp_path,
        {"check_runs": [check]},
        accepted=check["name"],
        workflow_runs=[green],
        later_workflow_runs=[green, failure],
    )
    assert result.returncode != 0, result.stdout
