"""CI Status Gate must fail closed on every run it cannot vouch for.

`CI Status Gate` is the one required check, and GitHub counts a skipped or
neutral required check as passing. So the gate is the only place a lane that
should have run, but did not, is caught. This executes the gate's real bash,
taken from .github/workflows/ci.yml, against synthetic `needs` results:

- every lane a path filter (or dispatch scope) selects must report `success`;
- the authority checks that have no path filter must succeed on every event;
- a pull request also needs PR Base Policy and, into main or
  integration/pr-train, Base Freshness Gate;
- a dispatched run fails for a partial scope, for a commit that heads an open
  pull request into those bases (its gate would replace that pull request's),
  and when that lookup errors. `gh` is a stub that answers each endpoint the
  way GitHub does, including commits/{sha}/pulls, which omits open pull
  requests once the commit is on the default branch, and applies the gate's
  own `--jq` filter with jq, so the lookup and its filter are both tested.

Every failing case is one mutation of a green run, and the negative control
requires the green runs (with legitimately skipped lanes) to pass, so each
failure is the mutation's and not the harness's.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from dataclasses import dataclass, field, replace
from functools import cache
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW_PATH = ROOT / ".github" / "workflows" / "ci.yml"
HEAD_SHA = "c0ffee" * 6 + "c0ff"
OTHER_SHA = "fade" * 10
REPOSITORY = "hushh-labs/hushh-research"
# The bases whose branch protection requires CI Status Gate (config/ci-governance.json).
PROTECTED_BASES = ("main", "integration/pr-train")

# The lanes each path-filter output selects, as the gate must require them.
LANES = {
    "frontend": (
        "web-core-check",
        "web-targeted-check",
        "web-full-suite-check",
        "integration-check",
    ),
    "backend": ("protocol-check", "mcp-package-check", "integration-check"),
    "ios": ("ios-native-check",),
    "android": ("android-native-check",),
    "editor": ("web-editor-performance-check",),
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
PULL_REQUEST_ONLY = ("pr-base-policy", "main-freshness-gate")
ALL_JOBS = sorted(
    {*AUTHORITY, *PULL_REQUEST_ONLY, *(lane for lanes in LANES.values() for lane in lanes)}
)

EXPRESSION_RE = re.compile(r"\$\{\{\s*(.*?)\s*\}\}")
NEEDS_RESULT_RE = re.compile(r"needs(?:\['([\w-]+)'\]|\.([\w-]+))\.result")
PATHS_OUTPUT_RE = re.compile(r"needs\.paths\.outputs\.(\w+)")
STUB_GH = """#!/usr/bin/env bash
# `gh api --paginate <endpoint> --jq <expr>`: answers each endpoint with the
# pages GitHub would return for the scenario, filtered by the caller's jq.
set -euo pipefail
printf '%s\\n' "$*" >> "$GH_STUB_LOG"
[ "${1:-}" = "api" ] || { echo "gh stub: only 'gh api' is modelled" >&2; exit 1; }
shift
endpoint=""
expr=""
paginate=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --jq) expr="$2"; shift 2 ;;
    --paginate) paginate=1; shift ;;
    -*) echo "gh stub: flag $1 is not modelled" >&2; exit 1 ;;
    *) endpoint="$1"; shift ;;
  esac
done
if [ "$endpoint" = "${GH_STUB_FAIL:-}" ]; then
  echo "HTTP 502: stubbed lookup failure" >&2
  exit 1
fi
# 1430 pull requests were open into integration/pr-train on 2026-10-15 and a
# page holds 100, so a lookup that reads only the first page proves nothing.
if [ "$paginate" != "1" ]; then
  echo "gh stub: $endpoint read without --paginate" >&2
  exit 1
fi
if ! jq -e --arg endpoint "$endpoint" 'has($endpoint)' "$GH_STUB_PAGES" >/dev/null; then
  echo "gh stub: no page modelled for $endpoint" >&2
  exit 1
fi
jq --arg endpoint "$endpoint" '.[$endpoint]' "$GH_STUB_PAGES" | jq -r "$expr"
"""


@dataclass(frozen=True)
class Run:
    event: str
    base_ref: str = ""
    scope: str = ""
    outputs: dict[str, str] = field(default_factory=dict)
    results: dict[str, str] = field(default_factory=dict)
    # Pull requests that contain HEAD_SHA, open or closed, into any base.
    pulls: tuple[dict, ...] = ()
    # HEAD_SHA is already on the default branch.
    head_on_main: bool = False
    # The one endpoint whose lookup errors, if any.
    lookup_fails: str = ""

    def with_result(self, job: str, result: str) -> Run:
        return replace(self, results={**self.results, job: result})


def _pull(
    number: int, head_sha: str, base: str, state: str = "open", *, merged: bool = False
) -> dict:
    return {
        "number": number,
        "state": state,
        "merged_at": "2026-07-02T14:34:16Z" if merged else None,
        "head": {"sha": head_sha, "ref": f"b{number}"},
        "base": {"ref": base},
    }


def _listing(base: str) -> str:
    return f"repos/{REPOSITORY}/pulls?state=open&base={base}&per_page=100"


def _api_pages(run: Run) -> dict[str, list[dict]]:
    """Each endpoint the gate may ask, answered the way GitHub answers it."""
    pages = {
        _listing(base): [
            pull for pull in run.pulls if pull["state"] == "open" and pull["base"]["ref"] == base
        ]
        for base in PROTECTED_BASES
    }
    # Once the commit is on the default branch this lists only the merged pull
    # request that introduced it: for a6bb87e88e it returned merged #4270 and
    # not open #4268, which that commit heads. Modelled so that a gate going
    # back to it fails the case built on that shape, not the harness.
    pages[f"repos/{REPOSITORY}/commits/{HEAD_SHA}/pulls?per_page=100"] = [
        pull for pull in run.pulls if pull["merged_at"] or not run.head_on_main
    ]
    return pages


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
        outputs={name: "true" if on else "false" for name, on in selected.items()},
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
# A dispatch on a commit already on main: `auto` diffs main...sha, finds no
# change and selects no lane, and the merged pull request that introduced the
# commit is the only one GitHub associates with it.
ON_MAIN = replace(
    _dispatch(_selected()),
    head_on_main=True,
    pulls=(_pull(4270, HEAD_SHA, "main", "closed", merged=True),),
)


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
            "github.base_ref": run.base_ref,
            "github.repository": "hushh-labs/hushh-research",
            "github.sha": HEAD_SHA,
            "github.token": "stub-token",
            "inputs.scope": run.scope,
        }
        assert expression in contexts, (
            f"CI Status Gate reads ${{{{ {expression} }}}}, which this harness does not "
            "model; teach it here before trusting a green"
        )
        return contexts[expression]

    return EXPRESSION_RE.sub(value, text)


def _run_step(step: dict, run: Run, tmp_path: Path) -> subprocess.CompletedProcess[str]:
    stub_dir = tmp_path / "bin"
    stub_dir.mkdir(exist_ok=True)
    gh = stub_dir / "gh"
    gh.write_text(STUB_GH, encoding="utf-8")
    gh.chmod(0o755)
    pages = tmp_path / "pages.json"
    pages.write_text(json.dumps(_api_pages(run)), encoding="utf-8")
    script = tmp_path / "step.sh"
    script.write_text(_resolve(step["run"], run), encoding="utf-8")
    env = {key: _resolve(str(value), run) for key, value in (step.get("env") or {}).items()}
    env.update(
        {
            "PATH": f"{stub_dir}{os.pathsep}{os.environ['PATH']}",
            "GH_STUB_LOG": str(tmp_path / "gh.log"),
            "GH_STUB_PAGES": str(pages),
            "GH_STUB_FAIL": run.lookup_fails,
        }
    )
    # GitHub runs `shell: bash` as `bash --noprofile --norc -eo pipefail {0}`.
    return subprocess.run(  # noqa: S603 - executes the repository's own gate script
        ["bash", "--noprofile", "--norc", "-eo", "pipefail", str(script)],  # noqa: S607
        env={**os.environ, **env},
        capture_output=True,
        text=True,
        check=False,
    )


def _verdict(run: Run, tmp_path: Path) -> tuple[bool, str]:
    """Run the gate's steps the way the runner does: in order, stopping at a failure."""
    assert set(run.results) >= set(ALL_JOBS), "the scenario must give every needed job a result"
    output = ""
    for step in _gate()["steps"]:
        condition = step.get("if")
        if condition is not None:
            assert condition == "github.event_name == 'workflow_dispatch'", (
                f"unmodelled step condition: {condition}"
            )
            if run.event != "workflow_dispatch":
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
            for result in ("skipped", "cancelled"):
                runs.append(
                    (
                        f"{name}-selects-{lane}-{result}",
                        _selected(**{name: True}).with_result(lane, result),
                    )
                )
    for job in AUTHORITY:
        runs.append((f"pull-request-{job}-skipped", EVERYTHING.with_result(job, "skipped")))
        runs.append((f"dispatch-{job}-skipped", DISPATCH.with_result(job, "skipped")))
    runs += [
        ("pr-base-policy-skipped", EVERYTHING.with_result("pr-base-policy", "skipped")),
        ("freshness-skipped-into-main", EVERYTHING.with_result("main-freshness-gate", "skipped")),
        (
            "freshness-skipped-into-train",
            replace(EVERYTHING, base_ref="integration/pr-train").with_result(
                "main-freshness-gate", "skipped"
            ),
        ),
        (
            "editor-output-undecided",
            replace(EVERYTHING, outputs={**EVERYTHING.outputs, "editor": ""}),
        ),
        ("unknown-event", replace(EVERYTHING, event="push")),
        ("dispatch-frontend-scope", replace(DISPATCH, scope="frontend")),
        ("dispatch-backend-scope", replace(DISPATCH, scope="backend")),
        (
            "dispatch-heads-open-pr-into-main",
            replace(DISPATCH, pulls=(_pull(7555, HEAD_SHA, "main"),)),
        ),
        (
            "dispatch-heads-open-pr-into-train",
            replace(
                DISPATCH,
                pulls=(_pull(42, OTHER_SHA, "main"), _pull(43, HEAD_SHA, "integration/pr-train")),
            ),
        ),
        # Open #4268 into integration/pr-train, whose head was already on main.
        (
            "dispatch-on-main-heads-open-pr-into-train",
            replace(ON_MAIN, pulls=(*ON_MAIN.pulls, _pull(4268, HEAD_SHA, "integration/pr-train"))),
        ),
        ("dispatch-main-lookup-fails", replace(DISPATCH, lookup_fails=_listing("main"))),
        (
            "dispatch-train-lookup-fails",
            replace(DISPATCH, lookup_fails=_listing("integration/pr-train")),
        ),
    ]
    return runs


def _passing_runs() -> list[tuple[str, Run]]:
    runs: list[tuple[str, Run]] = [
        (f"only-{name}-selected", _selected(**{name: True})) for name in LANES
    ]
    runs += [
        ("everything-selected", EVERYTHING),
        ("nothing-selected", _selected()),
        (
            "freshness-skip-is-legitimate-into-a-stacked-base",
            replace(EVERYTHING, base_ref="feature/stack-base").with_result(
                "main-freshness-gate", "skipped"
            ),
        ),
        ("dispatch-auto", DISPATCH),
        ("dispatch-all", replace(DISPATCH, scope="all")),
        ("dispatch-on-main-commit", ON_MAIN),
        # Only an open pull request the commit heads may block, and only into a
        # base that requires this gate.
        (
            "dispatch-commit-inside-open-pr",
            replace(DISPATCH, pulls=(_pull(7555, OTHER_SHA, "main"),)),
        ),
        (
            "dispatch-heads-closed-pr",
            replace(DISPATCH, pulls=(_pull(7555, HEAD_SHA, "main", "closed"),)),
        ),
        (
            "dispatch-heads-stacked-pr",
            replace(DISPATCH, pulls=(_pull(7680, HEAD_SHA, "feature/stack-base"),)),
        ),
    ]
    return runs


def test_the_gate_always_runs_and_waits_for_every_lane() -> None:
    gate = _gate()
    # `!cancelled()` would leave the check skipped on a cancelled run, and
    # GitHub reads a skipped required check as a pass.
    assert gate["if"] == "always()"
    assert set(gate["needs"]) == set(ALL_JOBS)
    assert shutil.which("jq"), "the gh stub applies the gate's --jq filter with the jq binary"


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
    if run.event == "workflow_dispatch":
        lookups = (tmp_path / "gh.log").read_text(encoding="utf-8")
        for base in PROTECTED_BASES:
            assert _listing(base) in lookups, f"{name}: no lookup of open pull requests into {base}"
