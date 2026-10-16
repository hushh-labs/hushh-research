"""The deploy-SHA gate must survive a large check-runs response.

`scripts/ci/require-deploy-sha-on-main.sh` is the single correctness gate in front
of every release lane — dev, uat, production, and both iOS lanes all call it. On
2026-08-07 it refused a dev deploy (run 31145632745) for a reason that had nothing
to do with the deploy: it passed the GitHub check-runs JSON to `python3` as one
argv string, and Linux caps a single argument at MAX_ARG_STRLEN (32 * PAGE_SIZE =
128 KiB on a 4 KiB-page host). The response is every check run on the commit, up to
100 per page, each carrying the full `app` object — roughly 4 KiB apiece, so a
commit with ~30 checks sits inside 10% of the ceiling and one that crosses it kills
the interpreter with "Argument list too long" (exit 126) *before* a single check is
read. A gate that dies on payload size is not stricter than one that reads the
payload; it is differently broken, and it fails identically for a green commit and
a red one.

These tests execute the real script with `git` and `curl` stubbed, because the
defect lives in how the process is spawned. A test that asserted on the script's
text would have passed against the broken version — the text and the behaviour were
wrong together, which is the failure mode this repo has already paid for.
"""

from __future__ import annotations

import copy
import json
import os
import resource
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
GATE = REPO_ROOT / "scripts/ci/require-deploy-sha-on-main.sh"

TARGET_SHA = "b6e1e98b814e160663196efbbb0acfb6e9d9a562"
BRANCH = "claude/hushh-infrastructure-analysis-7o991c"
ACCEPTED = "CI Status Gate,Queue Validation,Main Post-Merge Smoke Gate"

# The kernel limit this gate has to clear, computed rather than hardcoded so the
# test stays true on hosts with a page size other than 4 KiB.
MAX_ARG_STRLEN = 32 * resource.getpagesize()


def _check_run(name: str, conclusion: str, index: int) -> dict:
    """One check run shaped like the API's, including the `app` block that dominates size."""
    return {
        "id": 92762597000 + index,
        "name": name,
        "node_id": f"CR_kwDOQkAAOM8AAAAVmS{index}",
        "head_sha": TARGET_SHA,
        "external_id": f"f7c1a2b3-{index:04d}-4c5d-9e0f-1a2b3c4d5e6f",
        "url": f"https://api.github.com/repos/o/r/check-runs/{index}",
        "html_url": f"https://github.com/o/r/runs/{index}",
        "details_url": f"https://github.com/o/r/actions/runs/31145032368/job/{index}",
        "status": "completed",
        "conclusion": conclusion,
        "started_at": "2026-08-07T03:40:55Z",
        "completed_at": "2026-08-07T03:43:51Z",
        "output": {
            "title": None,
            "summary": None,
            "text": None,
            "annotations_count": 0,
            "annotations_url": f"https://api.github.com/repos/o/r/check-runs/{index}/annotations",
        },
        "check_suite": {"id": 84515114279 + index},
        "app": {
            "id": 15368,
            "slug": "github-actions",
            "name": "GitHub Actions",
            "description": "Automate your workflow from idea to production",
            "external_url": "https://help.github.com/en/actions",
            "html_url": "https://github.com/apps/github-actions",
            "permissions": {
                key: "write"
                for key in (
                    "actions",
                    "administration",
                    "checks",
                    "contents",
                    "deployments",
                    "discussions",
                    "issues",
                    "merge_queue",
                    "metadata",
                    "packages",
                    "pages",
                    "pull_requests",
                    "repository_hooks",
                    "security_events",
                    "statuses",
                    "vulnerability_alerts",
                )
            },
            "events": [
                "check_run",
                "check_suite",
                "create",
                "delete",
                "deployment",
                "issues",
                "merge_group",
                "pull_request",
                "push",
                "release",
                "status",
                "workflow_dispatch",
                "workflow_run",
            ],
        },
        "pull_requests": [
            {
                "url": "https://api.github.com/repos/o/r/pulls/4675",
                "id": 2914857000,
                "number": 4675,
                "head": {"ref": BRANCH, "sha": TARGET_SHA},
                "base": {"ref": "main", "sha": "62365c405e8ad97de7944cb129fe51e64c6d0439"},
            }
        ],
    }


def _payload_over_the_arg_limit() -> dict:
    """A check-runs response whose JSON exceeds what a single argv string can hold."""
    names = [
        "CI Status Gate",
        "Preflight Gate",
        "Scope Resolution",
        "Protocol (Python)",
        "Web Core (Next.js)",
        "Web Targeted Contracts",
        "MCP Package",
        "Integration",
        "Governance",
        "Path filters",
        "Secret Scan",
        "Upstream Sync",
        "PR Base Policy",
        "DCO",
        "Base Freshness Gate",
    ]
    runs: list[dict] = []
    # A branch with an open PR carries two runs per commit: the push run (green)
    # and the pull_request run (red on DCO for an unsigned branch). That doubling
    # is what put run 31145632745 over the ceiling.
    for index, name in enumerate(names):
        runs.append(_check_run(name, "success", index))
    for offset, name in enumerate(names):
        red = name in ("CI Status Gate", "Preflight Gate", "DCO")
        runs.append(_check_run(name, "failure" if red else "skipped", len(names) + offset))

    while len(json.dumps({"total_count": len(runs), "check_runs": runs})) <= MAX_ARG_STRLEN:
        grown = copy.deepcopy(runs[0])
        grown["id"] += len(runs)
        runs.append(grown)

    return {"total_count": len(runs), "check_runs": runs}


def _run_gate(
    tmp_path: Path,
    payload: dict,
    *,
    reachable: bool = True,
    accepted: str = ACCEPTED,
    workflow_runs: list[dict] | None = None,
    provenance_failure: bool = False,
):
    """Execute the real gate with `git` and `curl` stubbed onto PATH.

    `python3` is deliberately NOT stubbed — the defect was in how python3 was
    spawned, so the real interpreter has to be the one that runs.
    """
    payload_file = tmp_path / "payload.json"
    payload_file.write_text(json.dumps(payload), encoding="utf-8")

    provenance_file = tmp_path / "provenance.json"
    provenance_file.write_text(json.dumps({"workflow_runs": workflow_runs or []}), encoding="utf-8")
    stub_dir = tmp_path / "stub"
    stub_dir.mkdir()

    merge_base_exit = 0 if reachable else 1
    (stub_dir / "git").write_text(
        "#!/usr/bin/env bash\n"
        'for arg in "$@"; do\n'
        '  if [ "$arg" = "--is-ancestor" ]; then exit %d; fi\n'
        "done\n"
        "exit 0\n" % merge_base_exit,
        encoding="utf-8",
    )
    (stub_dir / "curl").write_text(
        "#!/usr/bin/env bash\n"
        'out=""; prev=""\n'
        'for arg in "$@"; do [ "$prev" = "-o" ] && out="$arg"; prev="$arg"; done\n'
        'case "$*" in\n'
        "  *actions/workflows/ci.yml/runs*)\n"
        '    [ "$PROVENANCE_FAILURE" = "0" ] || exit 22\n'
        '    cp "$PROVENANCE_FIXTURE" "$out" ;;\n'
        '  *) cp "$FIXTURE" "$out" ;;\n'
        "esac\n",
        encoding="utf-8",
    )
    for stub in ("git", "curl"):
        (stub_dir / stub).chmod(0o755)

    env = dict(os.environ)
    env.update(
        {
            "PATH": f"{stub_dir}{os.pathsep}{env['PATH']}",
            "FIXTURE": str(payload_file),
            "REQUIRED_BRANCH": BRANCH,
            "REQUIRE_CI_SUCCESS": "1",
            "REQUIRED_CHECK_NAME": accepted,
            "PROVENANCE_FIXTURE": str(provenance_file),
            "PROVENANCE_FAILURE": "1" if provenance_failure else "0",
            "GITHUB_REPOSITORY": "hushh-labs/hushh-research",
            "GITHUB_TOKEN": "stub-token",
        }
    )
    return subprocess.run(  # noqa: S603 - fixed argv, no shell=True, hermetic stub PATH
        ["bash", str(GATE), TARGET_SHA],
        capture_output=True,
        text=True,
        env=env,
        cwd=str(REPO_ROOT),
    )


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


_GITHUB_CURL = r"""#!/usr/bin/env python3
# Serves check runs the way GitHub does: newest first, per_page/page windows,
# and an exact-match check_name filter.
import json, os, sys, urllib.parse
args, out, params, url, i = sys.argv[1:], None, {}, "", 0
while i < len(args):
    if args[i] == "-o":
        out = args[i + 1]; i += 2; continue
    if args[i] == "--data-urlencode":
        key, _, value = args[i + 1].partition("="); params[key] = value; i += 2; continue
    if args[i] == "-H":
        i += 2; continue
    if args[i].startswith("https://"):
        url = args[i]
    i += 1
params.update(dict(urllib.parse.parse_qsl(urllib.parse.urlparse(url).query)))
runs = json.loads(open(os.environ["CHECK_RUNS"]).read())
if "check_name" in params:
    runs = [run for run in runs if run["name"] == params["check_name"]]
per_page, page = int(params.get("per_page", 30)), int(params.get("page", 1))
with open(out, "w") as stream:
    json.dump({"total_count": len(runs), "check_runs": runs[(page - 1) * per_page : page * per_page]}, stream)
"""


def _run_gate_against_github(tmp_path: Path, check_runs: list[dict], accepted: str):
    """Execute the real gate against a curl stub that answers like GitHub's API."""
    runs_file = tmp_path / "check-runs.json"
    runs_file.write_text(json.dumps(check_runs), encoding="utf-8")
    stub_dir = tmp_path / "github-stub"
    stub_dir.mkdir()
    (stub_dir / "git").write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
    (stub_dir / "curl").write_text(_GITHUB_CURL, encoding="utf-8")
    for stub in ("git", "curl"):
        (stub_dir / stub).chmod(0o755)
    env = dict(os.environ)
    env.update(
        {
            "PATH": f"{stub_dir}{os.pathsep}{env['PATH']}",
            "CHECK_RUNS": str(runs_file),
            "REQUIRED_BRANCH": "main",
            "REQUIRE_CI_SUCCESS": "1",
            "REQUIRED_CHECK_NAME": accepted,
            "GITHUB_REPOSITORY": "hushh-labs/hushh-research",
            "GITHUB_TOKEN": "stub-token",
        }
    )
    return subprocess.run(  # noqa: S603 - fixed argv, no shell=True, hermetic stub PATH
        ["bash", str(GATE), TARGET_SHA], capture_output=True, text=True, env=env, cwd=str(REPO_ROOT)
    )


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


def _branch_receipt() -> tuple[dict, dict]:
    check = _check_run("Branch Validation Gate", "success", 1)
    workflow = {
        "head_sha": TARGET_SHA,
        "check_suite_id": check["check_suite"]["id"],
        "path": ".github/workflows/ci.yml",
        "event": "workflow_dispatch",
        "status": "completed",
        "conclusion": "success",
    }
    return check, workflow


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
    ],
)
def test_branch_verdict_requires_exact_workflow_provenance(tmp_path: Path, mutation: str) -> None:
    check, workflow = _branch_receipt()
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
        workflow["event"] = "pull_request"
    elif mutation == "wrong-run-sha":
        workflow["head_sha"] = "0" * 40
    elif mutation == "wrong-suite":
        workflow["check_suite_id"] = 42
    elif mutation == "failed-run":
        workflow["conclusion"] = "failure"
    elif mutation == "unfinished-run":
        workflow["status"] = "in_progress"
    result = _run_gate(
        tmp_path,
        {"check_runs": [check]},
        accepted=ACCEPTED + ",Branch Validation Gate",
        workflow_runs=[] if mutation == "missing-run" else [workflow],
        provenance_failure=mutation == "lookup-failed",
        reachable=mutation != "unreachable-sha",
    )
    assert result.returncode != 0, mutation


def test_only_dev_workflow_accepts_branch_validation_gate() -> None:
    # Cross-lane release authority has no runtime API: authored workflow inputs
    # are its contract. Exercise the actual SHA verifier above as well.
    import yaml

    consumers = []
    for path in (REPO_ROOT / ".github/workflows").glob("*.yml"):
        workflow = yaml.safe_load(path.read_text())
        for job in workflow.get("jobs", {}).values():
            for step in job.get("steps", []):
                accepted = str(step.get("env", {}).get("REQUIRED_CHECK_NAME", ""))
                if "Branch Validation Gate" in accepted.split(","):
                    consumers.append(path.name)
    assert consumers == ["deploy-dev.yml"]
    policy = json.loads((REPO_ROOT / "config/ci-governance.json").read_text())
    assert "Branch Validation Gate" not in json.dumps(policy)
