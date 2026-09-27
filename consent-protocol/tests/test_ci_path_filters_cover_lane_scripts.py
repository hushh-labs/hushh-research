"""Every scripts/ci file a PR Validation lane runs must schedule that lane.

`scripts/ci/**` used to sit in both the `frontend:` and `backend:` path
filters, so a one-line change to a web pack ran the protocol, MCP and
integration lanes too. The filters now split that directory by the lane that
executes each script. A split is only safe while it stays true, so this guard
derives, from the workflow and the scripts themselves, which scripts/ci files
each path-filtered job runs, and fails when a job would not be scheduled by a
change to one of them:

- the scripts a job's steps name, with `orchestrate.sh <stage>` resolved to
  the scripts that stage runs;
- everything those scripts reference in turn;
- every scripts/ci file the lane's own code names (the protocol suite in
  consent-protocol/ exercises several deploy scripts directly).

The matcher follows dorny/paths-filter's `some-with-excludes` quantifier: a
file is in a filter when it matches one of its patterns and none of its `!`
patterns. `pathspec`'s gitignore rules and picomatch agree for every
slash-anchored pattern, which the iOS path-filter guard already requires.
"""

from __future__ import annotations

import re
import subprocess
from functools import cache
from pathlib import Path

import pathspec
import yaml

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW_PATH = ROOT / ".github" / "workflows" / "ci.yml"
ORCHESTRATOR = "scripts/ci/orchestrate.sh"
SCRIPTS_CI = "scripts/ci/"
THIS_FILE = Path(__file__).resolve().relative_to(ROOT).as_posix()

# Code each side's lanes execute, beyond the scripts/ci closure. The native
# shells are excluded from the web side: the web lanes read them as data, and
# a release-lane script named in a plist comment is not a web-lane dependency.
LANE_CODE_ROOTS = {
    "frontend": ("hushh-webapp/",),
    "backend": ("consent-protocol/", "packages/hushh-mcp/"),
}
LANE_CODE_EXCLUDED = (
    "hushh-webapp/ios/",
    "hushh-webapp/android/",
    "consent-protocol/.github/",
    "consent-protocol/docs/",
)
LANE_OUTPUT_RE = re.compile(r"outputs\.(frontend|backend)\s*==\s*'true'")
STAGE_ARM_RE = re.compile(r"^    ([\w|-]+)\)\n(.*?)^      ;;", re.MULTILINE | re.DOTALL)
ORCHESTRATE_RE = re.compile(r"orchestrate\.sh\s+([\w-]+)")
# The jobs this guard must find; if the `if:` shape changes and discovery
# returns nothing, the guard would pass vacuously.
EXPECTED_JOBS = {
    "web-core-check": {"frontend"},
    "web-targeted-check": {"frontend"},
    "protocol-check": {"backend"},
    "mcp-package-check": {"backend"},
    "integration-check": {"frontend", "backend"},
}


class _Filter:
    def __init__(self, patterns: list[str]) -> None:
        self.includes = [p for p in patterns if not p.startswith("!")]
        self.excludes = [p[1:] for p in patterns if p.startswith("!")]
        self._include = pathspec.PathSpec.from_lines("gitignore", self.includes)
        self._exclude = pathspec.PathSpec.from_lines("gitignore", self.excludes)

    def match_file(self, path: str) -> bool:
        return self._include.match_file(path) and not self._exclude.match_file(path)


@cache
def _workflow() -> dict:
    return yaml.safe_load(WORKFLOW_PATH.read_text(encoding="utf-8"))


def _paths_filter_step() -> dict:
    for step in _workflow()["jobs"]["paths"]["steps"]:
        if str(step.get("uses") or "").startswith("dorny/paths-filter"):
            return step
    raise AssertionError("The paths job no longer uses dorny/paths-filter")


def _filter_patterns() -> dict[str, list[str]]:
    filters = yaml.safe_load(_paths_filter_step()["with"]["filters"])
    return {name: [str(p) for p in patterns] for name, patterns in filters.items()}


def _filters(patterns: dict[str, list[str]] | None = None) -> dict[str, _Filter]:
    source = _filter_patterns() if patterns is None else patterns
    return {name: _Filter(list(lines)) for name, lines in source.items()}


@cache
def _tracked_files() -> tuple[str, ...]:
    listing = subprocess.run(  # noqa: S603 - fixed argv, read-only
        ["git", "ls-files", "-z"],  # noqa: S607
        cwd=ROOT,
        check=True,
        capture_output=True,
    ).stdout.decode("utf-8")
    return tuple(path for path in listing.split("\0") if path)


@cache
def _scripts_ci_files() -> tuple[str, ...]:
    return tuple(
        path
        for path in _tracked_files()
        if path.startswith(SCRIPTS_CI) and "/" not in path[len(SCRIPTS_CI) :]
    )


@cache
def _reference_re() -> re.Pattern[str]:
    names = sorted((Path(p).name for p in _scripts_ci_files()), key=len, reverse=True)
    return re.compile(r"(?<![\w.-])(" + "|".join(re.escape(n) for n in names) + r")(?![\w.-])")


def _referenced_scripts(text: str) -> set[str]:
    return {SCRIPTS_CI + name for name in _reference_re().findall(text)}


def _read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8", errors="replace")


@cache
def _stage_scripts() -> dict[str, frozenset[str]]:
    stages: dict[str, frozenset[str]] = {}
    for names, body in STAGE_ARM_RE.findall(_read(ORCHESTRATOR)):
        for name in names.split("|"):
            stages[name] = frozenset(_referenced_scripts(body))
    assert {"web-core", "web-targeted", "protocol", "integration"} <= set(stages), (
        f"Could not read orchestrate.sh's run_stage arms; found {sorted(stages)}"
    )
    return stages


def _closure(entry: set[str]) -> set[str]:
    # orchestrate.sh names every stage, so its text is never followed; its
    # stages are resolved explicitly from the orchestrate.sh <stage> call.
    seen: set[str] = set()
    pending = list(entry)
    while pending:
        script = pending.pop()
        if script in seen:
            continue
        seen.add(script)
        if script == ORCHESTRATOR:
            continue
        pending.extend(_referenced_scripts(_read(script)) - seen)
    return seen


def _lane_jobs() -> dict[str, set[str]]:
    jobs: dict[str, set[str]] = {}
    for name, job in _workflow()["jobs"].items():
        lanes = set(LANE_OUTPUT_RE.findall(str(job.get("if") or "")))
        if lanes:
            jobs[name] = lanes
    return jobs


def _job_scripts(job: str) -> set[str]:
    entry: set[str] = set()
    for step in _workflow()["jobs"][job]["steps"]:
        run = str(step.get("run") or "")
        entry |= _referenced_scripts(run)
        for stage in ORCHESTRATE_RE.findall(run):
            entry |= _stage_scripts()[stage]
    return _closure(entry)


def _uncovered_lane_scripts(filters: dict[str, _Filter]) -> list[str]:
    problems: list[str] = []
    for job, lanes in sorted(_lane_jobs().items()):
        for script in sorted(_job_scripts(job)):
            if not any(filters[lane].match_file(script) for lane in lanes):
                problems.append(f"{job} runs {script}, which schedules none of {sorted(lanes)}")
    return problems


def _lane_code_references(lane: str) -> dict[str, set[str]]:
    # git grep narrows thousands of tracked files to the few naming a script;
    # the boundary-aware regex then decides what each of those actually names.
    argv = ["git", "grep", "-l", "-z", "-I", "-F"]
    for path in _scripts_ci_files():
        argv += ["-e", Path(path).name]
    argv += ["--", *LANE_CODE_ROOTS[lane], ":!*.md", f":!{THIS_FILE}"]
    argv += [f":!{excluded}" for excluded in LANE_CODE_EXCLUDED]
    completed = subprocess.run(argv, cwd=ROOT, check=False, capture_output=True)  # noqa: S603
    assert completed.returncode in (0, 1), completed.stderr.decode("utf-8", "replace")
    found: dict[str, set[str]] = {}
    for path in filter(None, completed.stdout.decode("utf-8").split("\0")):
        for script in _referenced_scripts(_read(path)):
            found.setdefault(script, set()).add(path)
    return found


def test_negated_patterns_use_the_exclusion_aware_quantifier() -> None:
    # Under the default 'some', a '!' pattern MATCHES every file it does not
    # name, which would schedule that lane for almost any change.
    negated = [p for lines in _filter_patterns().values() for p in lines if p.startswith("!")]
    if negated:
        quantifier = _paths_filter_step()["with"].get("predicate-quantifier")
        assert quantifier == "some-with-excludes", (
            f"Filters use negated patterns {negated} but predicate-quantifier is {quantifier!r}"
        )


def test_lane_discovery_finds_every_path_filtered_lane() -> None:
    jobs = _lane_jobs()
    for job, lanes in EXPECTED_JOBS.items():
        assert jobs.get(job) == lanes, (
            f"{job} should be scheduled by {lanes}, found {jobs.get(job)}"
        )
    assert _job_scripts("web-targeted-check") >= {
        ORCHESTRATOR,
        "scripts/ci/web-targeted-check.sh",
        "scripts/ci/web-common.sh",
    }
    assert _job_scripts("integration-check") >= {
        "scripts/ci/integration-check.sh",
        "scripts/ci/resolve-uat-verification-plan.py",
        "scripts/ci/pkm-upgrade-gate.sh",
        "scripts/ci/pkm-runtime-audit.sh",
    }


def test_every_script_a_lane_runs_schedules_that_lane() -> None:
    problems = _uncovered_lane_scripts(_filters())
    assert not problems, "Grow the path filter, do not shrink this check:\n" + "\n".join(problems)


def test_every_script_the_lanes_own_code_names_schedules_that_lane() -> None:
    filters = _filters()
    problems: list[str] = []
    for lane in LANE_CODE_ROOTS:
        for script, users in sorted(_lane_code_references(lane).items()):
            if not filters[lane].match_file(script):
                problems.append(f"{script} (named by {sorted(users)[:3]}) is not in {lane}")
    assert not problems, "Grow the path filter, do not shrink this check:\n" + "\n".join(problems)


def test_no_scripts_ci_file_falls_through_every_filter() -> None:
    filters = _filters()
    unscheduled = [
        path
        for path in _scripts_ci_files()
        if not (filters["frontend"].match_file(path) or filters["backend"].match_file(path))
    ]
    assert not unscheduled, f"scripts/ci files that schedule no lane: {unscheduled}"


def test_the_orchestrator_schedules_both_sides() -> None:
    filters = _filters()
    assert filters["frontend"].match_file(ORCHESTRATOR)
    assert filters["backend"].match_file(ORCHESTRATOR)


def test_the_checker_catches_a_filter_that_drops_a_lane_script() -> None:
    # Negative control: remove the orchestrator from the web side and the
    # integration lane's PKM gate from the backend side; both must be named.
    patterns = _filter_patterns()
    patterns["frontend"] = [p for p in patterns["frontend"] if p != ORCHESTRATOR]
    patterns["backend"] = [*patterns["backend"], "!scripts/ci/pkm-upgrade-gate.sh"]
    problems = "\n".join(_uncovered_lane_scripts(_filters(patterns)))
    assert f"web-core-check runs {ORCHESTRATOR}" in problems
    assert f"web-targeted-check runs {ORCHESTRATOR}" in problems
    # integration runs on either side; excluding the gate from backend leaves
    # frontend, which never had it, so it must be reported.
    assert "integration-check runs scripts/ci/pkm-upgrade-gate.sh" in problems
    # And the unmutated filters report nothing, so the above is the mutation.
    assert not _uncovered_lane_scripts(_filters())
