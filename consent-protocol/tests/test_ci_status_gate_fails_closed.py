"""CI Status Gate fails closed on any run it cannot prove green.

GitHub treats skipped required checks as passing, so exercise the real gate
against selected, blocked, skipped, failed, dispatch, and retry cases. Negative
controls require legitimately green runs to pass.
"""

from __future__ import annotations

import os
import re
import shlex
import subprocess
from dataclasses import dataclass, field, replace
from functools import cache
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW_PATH = ROOT / ".github" / "workflows" / "ci.yml"


@pytest.mark.parametrize(
    "job,package",
    [
        ("web-full-suite-check", "zsh"),
        ("protocol-check", "postgresql-16-pgvector=0.6.0-1"),
        ("protocol-database-check", "postgresql-16-pgvector=0.6.0-1"),
    ],
)
@pytest.mark.parametrize("fail_at", ["", "update", "install"])
def test_native_prerequisites_keep_signed_fallbacks_and_install_failures_blocking(
    tmp_path, job, package, fail_at
):
    """Run the real installer against the failed runner's mirror arrangement."""
    workflow = yaml.safe_load(WORKFLOW_PATH.read_text(encoding="utf-8"))
    step = next(
        step
        for step in workflow["jobs"][job]["steps"]
        if "sudo apt-get install" in step.get("run", "")
    )
    assert step.get("continue-on-error", False) is False
    mirrors = tmp_path / "apt-mirrors.txt"
    mirrors.write_text(
        "http://azure.archive.ubuntu.com/ubuntu/ 10\n"
        "http://archive.ubuntu.com/ubuntu/ 20\n"
        "http://security.ubuntu.com/ubuntu/ 30\n",
        encoding="utf-8",
    )
    calls = tmp_path / "calls"
    script = step["run"].replace("/etc/apt/apt-mirrors.txt", shlex.quote(mirrors.as_posix()))
    stubs = r"""
sudo() {
  if [ "$1 $2" = 'sed -i' ]; then
    sed "$3" "$4" > "$4.filtered" && mv "$4.filtered" "$4"
  elif [ "$1" = apt-get ]; then
    printf '%s\n' "${*:2}" >> "$CALLS"
    # Reproduce the reported DNS failure until the unhealthy preference is removed.
    if grep -q azure.archive.ubuntu.com "$MIRRORS"; then return 100; fi
    if [ "$2" = "$FAIL_AT" ]; then return 100; fi
    if [ "$2" = install ]; then PG_INSTALLED=1; fi
  else
    return 64
  fi
}
test() {
  case "$2" in
    /usr/lib/postgresql/16/bin/initdb|/usr/share/postgresql/16/extension/vector.control)
      [ "${PG_INSTALLED:-0}" = 1 ] ;;
    *) builtin test "$@" ;;
  esac
}
"""
    result = subprocess.run(  # noqa: S603 - actual workflow script, synthetic apt/sudo.
        ["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", stubs + script],  # noqa: S607
        env={
            **os.environ,
            "MIRRORS": mirrors.as_posix(),
            "CALLS": calls.as_posix(),
            "FAIL_AT": fail_at,
            "GITHUB_ENV": (tmp_path / "github-env").as_posix(),
        },
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    assert result.returncode == (100 if fail_at else 0), result.stdout + result.stderr
    assert mirrors.read_text(encoding="utf-8").splitlines() == [
        "http://archive.ubuntu.com/ubuntu/ 20",
        "http://security.ubuntu.com/ubuntu/ 30",
    ]
    assert calls.read_text(encoding="utf-8").splitlines() == (
        ["update"]
        if fail_at == "update"
        else ["update", f"install --no-install-recommends -y {package}"]
    )


HEAD_SHA = "c0ffee" * 6 + "c0ff"
# The lanes each path-filter output selects, as the gate must require them.
LANES = {
    "frontend": (
        "web-core-check",
        "web-targeted-check",
        "web-full-suite-check",
        "integration-check",
    ),
    "backend": (
        "protocol-check",
        "protocol-database-check",
        "protocol-database-check-two",
        "mcp-package-check",
        "integration-check",
    ),
    "ios": ("ios-native-check",),
    "android": ("android-native-check",),
    "editor": (),
    "document": ("integration-check",),
}
# No path filter: these must succeed on every event.
AUTHORITY = (
    "ui-contracts",
    "secret-scan",
    "repo-governance",
    "paths",
    "preflight-gate",
    "dco-check",
)
PULL_REQUEST_ONLY = ("pr-base-policy",)
ALL_JOBS = sorted(
    {*AUTHORITY, *PULL_REQUEST_ONLY, *(lane for lanes in LANES.values() for lane in lanes)}
)

EXPRESSION_RE = re.compile(r"\$\{\{\s*(.*?)\s*\}\}")
NEEDS_RESULT_RE = re.compile(r"needs(?:\['([\w-]+)'\]|\.([\w-]+))\.result")
PATHS_OUTPUT_RE = re.compile(r"needs(?:\.paths|\['preflight-gate'\])\.outputs\.(\w+)")


@dataclass(frozen=True)
class Run:
    event: str
    attempt: int = 1
    base_ref: str = ""
    ref: str = ""
    scope: str = ""
    inputs: dict[str, str] = field(default_factory=dict)
    outputs: dict[str, str] = field(default_factory=dict)
    results: dict[str, str] = field(default_factory=dict)

    def with_result(self, job: str, result: str) -> Run:
        return replace(self, results={**self.results, job: result})


def _selected(**outputs: bool) -> Run:
    """A green pull request into main that selects exactly `outputs`."""
    selected = {name: bool(outputs.get(name)) for name in LANES}
    required = {lane for name, on in selected.items() if on for lane in LANES[name]}
    results = {job: "success" for job in (*AUTHORITY, *PULL_REQUEST_ONLY)}
    for lanes in LANES.values():
        for lane in lanes:
            results[lane] = "success" if lane in required else "skipped"
    return Run(
        event="pull_request",
        base_ref="main",
        outputs={
            **{name: "true" if on else "false" for name, on in selected.items()},
            "auth_health_only": "false",
        },
        results=results,
    )


def _dispatch(run: Run) -> Run:
    """The same lanes, dispatched with scope `auto`: no pull request job runs."""
    return replace(
        run,
        event="workflow_dispatch",
        base_ref="",
        scope="auto",
        results={**run.results, "pr-base-policy": "skipped", "main-freshness-gate": "skipped"},
    )


EVERYTHING = _selected(**{name: True for name in LANES})
DISPATCH = _dispatch(EVERYTHING)


@cache
def _gate() -> dict:
    return yaml.safe_load(WORKFLOW_PATH.read_text(encoding="utf-8"))["jobs"]["ci-status"]


def _resolve(text: str, run: Run) -> str:
    def value(match: re.Match[str]) -> str:
        expression = match.group(1)
        if needs := NEEDS_RESULT_RE.fullmatch(expression):
            return run.results[needs.group(1) or needs.group(2)]
        if output := PATHS_OUTPUT_RE.fullmatch(expression):
            return run.outputs.get(output.group(1), "")
        contexts = {
            "github.event_name": run.event,
            "github.run_attempt": str(run.attempt),
            "github.base_ref": run.base_ref,
            "github.repository": "hushh-labs/hushh-research",
            "github.sha": HEAD_SHA,
            "github.token": "stub-token",
            "inputs.scope": run.scope,
            **{
                f"inputs.{name}": run.inputs.get(name, "")
                for name in (
                    "uat_base_sha",
                    "uat_candidate_sha",
                    "uat_candidate_tree",
                    "production_recovery_sha",
                )
            },
        }
        assert expression in contexts, (
            f"CI Status Gate reads ${{{{ {expression} }}}}, which this harness does not "
            "model; teach it here before trusting a green"
        )
        return contexts[expression]

    return EXPRESSION_RE.sub(value, text)


def _run_step(step: dict, run: Run, tmp_path: Path) -> subprocess.CompletedProcess[str]:
    script = tmp_path / "step.sh"
    script.write_text(_resolve(step["run"], run), encoding="utf-8")
    env = {key: _resolve(str(value), run) for key, value in (step.get("env") or {}).items()}
    summary = tmp_path / f"step-summary-{len(list(tmp_path.glob('step-summary-*.md')))}.md"
    env["GITHUB_STEP_SUMMARY"] = str(summary)
    # GitHub runs `shell: bash` as `bash --noprofile --norc -eo pipefail {0}`.
    completed = subprocess.run(  # noqa: S603 - executes the repository's own gate script
        ["bash", "--noprofile", "--norc", "-eo", "pipefail", str(script)],  # noqa: S607
        env={**os.environ, **env},
        capture_output=True,
        text=True,
        check=False,
    )
    if summary.exists():
        completed.stdout += "\n" + summary.read_text(encoding="utf-8")
    return completed


def _verdict(run: Run, tmp_path: Path) -> tuple[bool, str]:
    """Run the gate's steps the way the runner does: in order, stopping at a failure."""
    assert set(run.results) >= set(ALL_JOBS), "the scenario must give every needed job a result"
    output = ""
    for step in _gate()["steps"]:
        # Artifact production is tested by the queue receipt owner. This harness
        # executes the actual verdict scripts, not checkout/upload actions.
        if "uses" in step or step.get("name") == "Record tested merge inputs":
            continue
        condition = step.get("if")
        if condition is not None:
            conditions = {
                "github.event_name == 'workflow_dispatch'": run.event == "workflow_dispatch",
                "github.run_attempt > 1": run.attempt > 1,
                "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/New_memory_architecutre'": (
                    run.event == "workflow_dispatch"
                    and run.ref == "refs/heads/New_memory_architecutre"
                ),
            }
            assert condition in conditions, f"unmodelled step condition: {condition}"
            if not conditions[condition]:
                continue
        completed = _run_step(step, run, tmp_path)
        output += completed.stdout + completed.stderr
        if completed.returncode != 0:
            return False, output
    return True, output


def _failing_runs() -> list[tuple[str, Run]]:
    runs: list[tuple[str, Run]] = []
    for name, lanes in LANES.items():
        for lane in lanes:
            for result in ("skipped", "cancelled", "failure"):
                runs.append(
                    (
                        f"{name}-selects-{lane}-{result}",
                        _selected(**{name: True}).with_result(lane, result),
                    )
                )
                runs.append(
                    (
                        f"dispatch-{name}-selects-{lane}-{result}",
                        _dispatch(_selected(**{name: True})).with_result(lane, result),
                    )
                )
    for job in AUTHORITY:
        runs.append((f"pull-request-{job}-skipped", EVERYTHING.with_result(job, "skipped")))
        runs.append((f"dispatch-{job}-skipped", DISPATCH.with_result(job, "skipped")))
    runs += [
        ("pr-base-policy-skipped", EVERYTHING.with_result("pr-base-policy", "skipped")),
        (
            "editor-output-undecided",
            replace(EVERYTHING, outputs={**EVERYTHING.outputs, "editor": ""}),
        ),
        ("unknown-event", replace(EVERYTHING, event="push")),
        ("dispatch-frontend-scope", replace(DISPATCH, scope="frontend")),
        ("dispatch-backend-scope", replace(DISPATCH, scope="backend")),
        ("dispatch-unknown-scope", replace(DISPATCH, scope="unknown")),
    ]
    return runs


def _passing_runs() -> list[tuple[str, Run]]:
    runs: list[tuple[str, Run]] = [
        (f"only-{name}-selected", _selected(**{name: True})) for name in LANES
    ]
    runs += [
        ("everything-selected", EVERYTHING),
        ("combined-merge-result", replace(DISPATCH, event="merge_group")),
        (
            "failed-drift-guidance-is-advisory",
            EVERYTHING.with_result("main-freshness-gate", "failure"),
        ),
        ("dev-freshness-passed", replace(EVERYTHING, base_ref="dev")),
        ("uat-freshness-passed", replace(EVERYTHING, base_ref="uat")),
        ("nothing-selected", _selected()),
        (
            "freshness-skip-is-legitimate-into-a-stacked-base",
            replace(EVERYTHING, base_ref="feature/stack-base").with_result(
                "main-freshness-gate", "skipped"
            ),
        ),
        ("dispatch-auto", DISPATCH),
        ("dispatch-all", replace(DISPATCH, scope="all")),
        (
            "release-without-native-impact",
            replace(_dispatch(_selected(frontend=True, backend=True, document=True)), scope="all"),
        ),
    ]
    return runs


@pytest.mark.parametrize(
    "job", ["secret-scan", "dco-check", "paths", "pr-base-policy", "ui-contracts"]
)
def test_abandoned_prerequisite_stops_expensive_work_and_reports_infrastructure(tmp_path, job):
    run = _selected(frontend=True).with_result(job, "abandoned")
    steps = yaml.safe_load(WORKFLOW_PATH.read_text())["jobs"]["preflight-gate"]["steps"]
    result = _run_step(steps[0], run, tmp_path)
    assert result.returncode != 0
    assert "GitHub infrastructure interruption" in result.stdout
    passed, output = _verdict(run, tmp_path)
    assert not passed and "GitHub infrastructure interruption" in output


def test_protocol_partitions_use_independent_database_jobs_without_omitting_a_phase() -> None:
    jobs = yaml.safe_load(WORKFLOW_PATH.read_text(encoding="utf-8"))["jobs"]
    phases = {"protocol-check": "parallel", "protocol-database-check": "database"}
    for name, phase in phases.items():
        job = jobs[name]
        assert job["needs"] == ["preflight-gate"]
        selected = [
            step for step in job["steps"] if "PROTOCOL_TEST_PARTITION" in step.get("env", {})
        ]
        assert len(selected) == 1
        assert selected[0]["env"]["PROTOCOL_TEST_PARTITION"] == phase
        assert "@127.0.0.1:5432/command_test" in selected[0]["env"]["ONE_COMMAND_TEST_DATABASE_URL"]
    assert jobs["protocol-check"]["services"] == jobs["protocol-database-check"]["services"]
    for name, index in (("protocol-database-check", "1"), ("protocol-database-check-two", "2")):
        assert jobs[name]["env"]["CI_DATABASE_SHARD"] == index
        assert jobs[name]["services"] == jobs["protocol-check"]["services"]
        assert jobs[name]["runs-on"] == "ubuntu-24.04"

    database = jobs["protocol-database-check"]["steps"][-1]
    assert database["working-directory"] == "consent-protocol"
    assert database["run"] == "bash scripts/run-test-ci.sh"
    assert database["env"]["PROTOCOL_DATABASE_SHARD_COUNT"] == "2"
    assert database["env"]["PROTOCOL_DATABASE_SHARD_INDEX"] == "${{ env.CI_DATABASE_SHARD }}"


def test_the_gate_always_runs_and_waits_for_every_lane() -> None:
    gate = _gate()
    # `!cancelled()` would leave the check skipped on a cancelled run, and
    # GitHub reads a skipped required check as a pass.
    assert gate["if"] == "always()"
    assert set(gate["needs"]) == set(ALL_JOBS)


@pytest.mark.parametrize(
    ("name", "run"), _failing_runs(), ids=[name for name, _ in _failing_runs()]
)
def test_the_gate_fails_closed(name: str, run: Run, tmp_path: Path) -> None:
    passed, output = _verdict(run, tmp_path)
    assert not passed, f"{name}: CI Status Gate passed a run it cannot vouch for:\n{output}"


@pytest.mark.parametrize(
    ("name", "run"), _passing_runs(), ids=[name for name, _ in _passing_runs()]
)
def test_negative_control_a_green_run_passes(name: str, run: Run, tmp_path: Path) -> None:
    passed, output = _verdict(run, tmp_path)
    assert passed, (
        f"{name}: CI Status Gate failed a green run, so the failures above prove nothing:\n{output}"
    )


def test_recovery_gate_uses_its_own_input_and_requires_the_historical_partition(
    tmp_path, monkeypatch
):
    # In the failed qualification, Governance's real recovery context leaked
    # into its simulated ordinary runs, making their green controls fail.
    monkeypatch.setenv("PRODUCTION_RECOVERY_SHA", "a" * 40)
    ordinary = replace(
        _dispatch(_selected(frontend=True, backend=True, document=True)), scope="all"
    )
    passed, output = _verdict(ordinary, tmp_path)
    assert passed, output

    recovery = replace(ordinary, inputs={"production_recovery_sha": HEAD_SHA}).with_result(
        "protocol-database-check-two", "skipped"
    )
    passed, output = _verdict(recovery, tmp_path)
    assert passed, output
    assert not _verdict(recovery.with_result("protocol-database-check", "skipped"), tmp_path)[0]
    assert not _verdict(replace(recovery, scope="auto"), tmp_path)[0]


@pytest.mark.parametrize("override", ["uat_base_sha", "uat_candidate_sha", "uat_candidate_tree"])
def test_sandbox_branch_gate_rejects_overrides_to_its_actual_source(tmp_path: Path, override: str):
    sandbox = replace(DISPATCH, ref="refs/heads/New_memory_architecutre")
    assert _verdict(sandbox, tmp_path)[0]

    passed, output = _verdict(replace(sandbox, inputs={override: HEAD_SHA}), tmp_path)
    assert not passed
    assert "without UAT source overrides" in output


def test_summary_reports_selected_unselected_blocked_and_first_failure(
    tmp_path: Path,
) -> None:
    run = _selected(frontend=True).with_result("web-targeted-check", "skipped")
    passed, output = _verdict(run, tmp_path)
    assert not passed
    assert "| Frontend | selected |" in output
    assert "| Backend | unselected |" in output
    assert "| Auth-health focus | unselected |" in output
    assert "First failure: **Web Targeted (skipped)**." in output

    blocked = replace(_selected(), outputs={**_selected().outputs, "editor": ""})
    passed, output = _verdict(blocked, tmp_path)
    assert not passed
    assert "Path selection editor" in output

    for scope, expected in (
        ("frontend", "diagnostic-only dispatch scope 'frontend'"),
        ("unknown", "unknown dispatch scope 'unknown'"),
    ):
        dispatch = replace(_dispatch(_selected(frontend=True)), scope=scope)
        passed, output = _verdict(dispatch, tmp_path)
        assert not passed
        assert f"First failure: **{expected}**." in output
        assert "none; all required checks passed" not in output


def test_retry_preserves_job_outcomes_without_a_standalone_worker(tmp_path: Path) -> None:
    assert all("github_security_receipt.py" not in step.get("run", "") for step in _gate()["steps"])
    retry = replace(EVERYTHING, attempt=2)
    passed, output = _verdict(retry, tmp_path)
    assert passed, output
    passed, _ = _verdict(retry.with_result("protocol-check", "cancelled"), tmp_path)
    assert not passed


def test_manual_branch_verdict_cannot_satisfy_pr_protection() -> None:
    # This is a branch-protection identity boundary, not an outcome shortcut.
    # The guarded branch names are deliberately absent from the dispatch name.
    assert _gate()["name"] == (
        "${{ github.event_name == 'merge_group' && 'Combined Result Gate' || github.event_name == 'workflow_dispatch' && 'Branch Validation Gate' || (github.event.pull_request.draft && 'Draft Safety Gate' || 'CI Status Gate') }}"
    )


@pytest.mark.parametrize(
    "fault",
    [None, "pending", "cancelled", "head", "missing", "neutral", "newer_failure", "run_attempt"],
)
def test_operator_preflight_refuses_unproven_exact_head(fault):
    import copy
    import importlib.util

    path = ROOT / ".agents/skills/repo-operations/scripts/ci_preflight.py"
    spec = importlib.util.spec_from_file_location("operator_ci_monitor", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    check = {
        "name": "CI Status Gate",
        "workflowName": "PR Validation",
        "status": "COMPLETED",
        "conclusion": "SUCCESS",
        "startedAt": "2026-10-23T01:00:00Z",
        "detailsUrl": "https://github.com/hushh-labs/hushh-research/actions/runs/100/job/200",
    }
    pr = {
        "headRefOid": HEAD_SHA,
        "state": "OPEN",
        "isDraft": False,
        "mergeable": "MERGEABLE",
        "statusCheckRollup": [check],
    }
    run = {
        "headSha": HEAD_SHA,
        "name": "PR Validation",
        "status": "completed",
        "conclusion": "success",
        "databaseId": 100,
    }
    if fault == "pending":
        check["status"] = "IN_PROGRESS"
    elif fault == "cancelled":
        check["conclusion"] = "CANCELLED"
    elif fault == "head":
        pr["headRefOid"] = "f" * 40
    elif fault == "missing":
        pr["statusCheckRollup"] = []
    elif fault == "neutral":
        check["conclusion"] = "NEUTRAL"
    elif fault == "newer_failure":
        failed = copy.deepcopy(check)
        failed.update(startedAt="2026-10-23T02:00:00Z", conclusion="FAILURE")
        pr["statusCheckRollup"].append(failed)
    elif fault == "run_attempt":
        run["conclusion"] = "failure"
    if fault is None:
        module.require_successful_head(
            pr, expected_sha=HEAD_SHA, required_contexts={"CI Status Gate"}, run=run
        )
    else:
        with pytest.raises(RuntimeError):
            module.require_successful_head(
                pr, expected_sha=HEAD_SHA, required_contexts={"CI Status Gate"}, run=run
            )


@pytest.mark.parametrize("fault", [None, "old_attempt", "changed_attempt", "wrong_workflow"])
def test_operator_preflight_binds_gate_to_current_canonical_attempt(monkeypatch, fault):
    import copy
    import importlib

    monkeypatch.syspath_prepend(str(ROOT / ".agents/skills/repo-operations/scripts"))
    module = importlib.import_module("ci_preflight")
    prefix = "repos/hushh-labs/hushh-research"
    pr = {
        "number": 1,
        "baseRefName": "main",
        "headRefOid": HEAD_SHA,
        "state": "OPEN",
        "isDraft": False,
        "mergeable": "MERGEABLE",
        "statusCheckRollup": [
            {
                "name": "CI Status Gate",
                "workflowName": "PR Validation",
                "status": "COMPLETED",
                "conclusion": "SUCCESS",
                "startedAt": "2026-10-23T01:00:00Z",
                "detailsUrl": "https://github.com/hushh-labs/hushh-research/actions/runs/100/job/200",
            }
        ],
    }
    source = {
        "id": 100,
        "run_attempt": 2,
        "head_sha": HEAD_SHA,
        "workflow_id": 10,
        "repository": {"id": 1, "full_name": "hushh-labs/hushh-research"},
        "path": ".github/workflows/ci.yml",
        "event": "pull_request",
        "status": "completed",
        "conclusion": "success",
    }
    job = {
        "id": 200,
        "run_id": 100,
        "head_sha": HEAD_SHA,
        "name": "CI Status Gate",
        "status": "completed",
        "conclusion": "success",
    }
    source_reads = 0

    def gh_json(args):
        nonlocal source_reads
        if args[:2] == ["run", "view"]:
            return {
                "databaseId": 100,
                "headSha": HEAD_SHA,
                "name": "PR Validation",
                "status": "completed",
                "conclusion": "success",
                "attempt": 2,
            }
        path = args[1]
        if path.endswith("/protection"):
            return {"required_status_checks": {"contexts": ["CI Status Gate"]}}
        if path == prefix:
            return source["repository"]
        if path.endswith("/workflows/ci.yml"):
            return {"id": 10, "path": ".github/workflows/ci.yml"}
        if path.endswith("/runs/100"):
            source_reads += 1
            observed = copy.deepcopy(source)
            if fault == "wrong_workflow":
                observed["path"] = ".github/workflows/untrusted.yml"
            if fault == "changed_attempt" and source_reads > 1:
                observed["run_attempt"] = 3
                observed["status"] = "in_progress"
            return observed
        if path.endswith("/attempts/2/jobs?per_page=100"):
            return (
                {"total_count": 0, "jobs": []}
                if fault == "old_attempt"
                else {"total_count": 1, "jobs": [job]}
            )
        if path.endswith("/jobs/200"):
            return job
        raise AssertionError(f"Unexpected authority read: {path}")

    def run():
        return module.preflight(1, None, HEAD_SHA, resolve_pr=lambda *_: pr, gh_json=gh_json)

    if fault:
        with pytest.raises((RuntimeError, ValueError)):
            run()
    else:
        assert run()["attempt"] == 2
