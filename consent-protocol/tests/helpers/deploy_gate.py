"""Hermetic GitHub/git transport fixtures for the real release SHA gate."""

from __future__ import annotations

import copy
import json
import os
import resource
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]

GATE = REPO_ROOT / "scripts/ci/require-deploy-sha-on-main.sh"

TARGET_SHA = "b6e1e98b814e160663196efbbb0acfb6e9d9a562"

BRANCH = "claude/hushh-infrastructure-analysis-7o991c"

ACCEPTED = "CI Status Gate,Queue Validation,Main Post-Merge Smoke Gate"

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
            "description_padding": "synthetic API metadata " * 200,
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
    later_workflow_runs: list[dict] | None = None,
    provenance_failure: bool = False,
):
    """Execute the real gate with `git` and `curl` stubbed onto PATH.

    `python3` is deliberately NOT stubbed — the defect was in how python3 was
    spawned, so the real interpreter has to be the one that runs.
    """
    payload_file = tmp_path / "payload.json"
    payload_file.write_text(json.dumps(payload), encoding="utf-8")

    if workflow_runs is None:
        workflow_runs = [
            _workflow_for(run)
            for run in payload.get("check_runs", [])
            if run.get("conclusion") == "success" and run.get("name") in PRODUCERS
        ]
        workflow_runs = workflow_runs[:1]
    provenance_file = tmp_path / "provenance.json"
    provenance_file.write_text(
        json.dumps({"workflow_runs": workflow_runs, "later_workflow_runs": later_workflow_runs}),
        encoding="utf-8",
    )
    stub_dir = tmp_path / "stub"
    stub_dir.mkdir()
    (stub_dir / "git").write_text(
        "#!/usr/bin/env bash\n"
        'for arg in "$@"; do\n'
        '  if [ "$arg" = "--is-ancestor" ]; then exit %d; fi\n'
        "done\nexit 0\n" % (0 if reachable else 1),
        encoding="utf-8",
    )
    (stub_dir / "curl").write_text(_GITHUB_CURL, encoding="utf-8")
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


PRODUCERS = {
    "CI Status Gate": ("ci.yml", "pull_request"),
    "Branch Validation Gate": ("ci.yml", "workflow_dispatch"),
    "Main Post-Merge Smoke Gate": ("main-post-merge-smoke.yml", "push"),
    "Queue Validation": ("queue-validation.yml", "merge_group"),
}


def _workflow_for(check):
    workflow, event = PRODUCERS[check["name"]]
    return {
        "id": check["id"],
        "head_sha": TARGET_SHA,
        "head_branch": "main",
        "check_suite_id": check["check_suite"]["id"],
        "run_attempt": 1,
        "run_started_at": "2026-10-26T10:00:00Z",
        "updated_at": "2026-10-26T10:05:00Z",
        "path": f".github/workflows/{workflow}",
        "event": event,
        "status": "completed",
        "conclusion": "success",
        "jobs": [
            {
                "name": check["name"],
                "status": "completed",
                "conclusion": "success",
                "check_run_url": f"https://api.github.com/repos/hushh-labs/hushh-research/check-runs/{check['id']}",
                "steps": [{"name": "Verify smoke source identity", "conclusion": "success"}],
            }
        ],
    }


_GITHUB_CURL = r"""#!/usr/bin/env python3
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
if "/actions/" in url:
    if os.environ.get("PROVENANCE_FAILURE") == "1": sys.exit(22)
    fixture_path = os.environ["PROVENANCE_FIXTURE"]
    with open(fixture_path) as stream:
        fixture = json.load(stream)
    runs = fixture["workflow_runs"]
    if "/attempts/" in url:
        run = next((r for r in runs if f"/runs/{r['id']}/attempts/{r['run_attempt']}/" in url), {})
        jobs = run.get("jobs", [])
        result = {"total_count": run.get("job_count", len(jobs)), "jobs": jobs}
    elif "/actions/runs/" in url:
        run = next((r for r in runs if url.endswith("/runs/" + str(r["id"]))), {})
        result = run.get("reread", run)
    else:
        if fixture.get("later_workflow_runs") is not None:
            count_path = fixture_path + ".workflow-reads"
            try:
                with open(count_path) as stream: counts = json.load(stream)
            except FileNotFoundError:
                counts = {}
            count = counts.get(url, 0)
            counts[url] = count + 1
            with open(count_path, "w") as stream: json.dump(counts, stream)
            if count:
                runs = fixture["later_workflow_runs"]
        runs = [r for r in runs if "/" + r["path"].split("/")[-1] + "/runs?" in url
                and r.get("event") == params.get("event")]
        result = {"workflow_runs": runs, "total_count": max([len(runs)] + [r.get("inventory_count", 0) for r in runs])}
else:
    runs = json.load(open(os.environ["FIXTURE"]))["check_runs"]
    if os.environ.get("GITHUB_FILTER") == "1" and "check_name" in params:
        runs = [run for run in runs if run["name"] == params["check_name"]]
    per_page, page = int(params.get("per_page", 30)), int(params.get("page", 1))
    # The payload-size fixture deliberately returns the entire oversized response.
    result = {"total_count": len(runs), "check_runs": runs if os.environ.get("GITHUB_FILTER") != "1"
              else runs[(page - 1) * per_page : page * per_page]}
with open(out, "w") as stream:
    json.dump(result, stream)
"""


def _run_gate_against_github(tmp_path: Path, check_runs: list[dict], accepted: str):
    os.environ["GITHUB_FILTER"] = "1"
    try:
        return _run_gate(tmp_path, {"check_runs": check_runs}, accepted=accepted)
    finally:
        os.environ.pop("GITHUB_FILTER", None)


def _branch_receipt(verdict="Branch Validation Gate") -> tuple[dict, dict]:
    check = _check_run(verdict, "success", 1)
    workflow = _workflow_for(check)
    return check, workflow
