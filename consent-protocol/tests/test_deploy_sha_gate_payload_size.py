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


def _run_gate(tmp_path: Path, payload: dict, *, reachable: bool = True):
    """Execute the real gate with `git` and `curl` stubbed onto PATH.

    `python3` is deliberately NOT stubbed — the defect was in how python3 was
    spawned, so the real interpreter has to be the one that runs.
    """
    payload_file = tmp_path / "payload.json"
    payload_file.write_text(json.dumps(payload), encoding="utf-8")

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
        'cp "$FIXTURE" "$out"\n',
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
            "REQUIRED_CHECK_NAME": ACCEPTED,
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
    assert "$PAYLOAD_FILE" in spawn
    assert "$PAYLOAD" not in spawn.replace("$PAYLOAD_FILE", "")
