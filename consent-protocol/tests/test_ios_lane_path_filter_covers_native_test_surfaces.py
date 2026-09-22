"""The iOS CI lane must be scheduled by the web surfaces its XCUITest renders.

`ios-native-check` runs a real XCUITest against the web bundle, but the lane is
gated by the `paths` job's `ios:` filter. A filter that only names `ios/**`
lets a change to the login screen, the vault unlock, or the native route
markers merge without ever running the test that renders them. This guard
parses the filter the way GitHub does (dorny/paths-filter, whose globs and
`pathspec`'s gitignore rules agree for every slash-anchored pattern) and checks
it against the files the CI-run test actually touches.

It also pins the checkout depth and base-ref env of every lane that reaches
the capability graph check (`generate_capability_graph.py --check`), which
must diff against the pull request base and fails closed under CI when that
base is not in the clone: `protocol-check` on PR Validation, and both
`web-full-check` and `protocol-check` on Queue Validation, where the base is
the merge group's `refs/heads/<branch>` and has to be stripped in a shell
step because workflow expressions cannot.
"""

from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

import pathspec
import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
MONO_WORKFLOW_PATH = ROOT / ".github" / "workflows" / "ci.yml"
UPSTREAM_WORKFLOW_PATH = ROOT / "consent-protocol" / ".github" / "workflows" / "ci.yml"
QUEUE_WORKFLOW_PATH = ROOT / ".github" / "workflows" / "queue-validation.yml"
QUEUE_LANES_REACHING_THE_GRAPH_CHECK = ("web-full-check", "protocol-check")
WEBAPP_DIR = ROOT / "hushh-webapp"
UI_TESTS_PATH = WEBAPP_DIR / "ios" / "App" / "AppUITests" / "AppUITests.swift"
RENDER_ROOTS = (WEBAPP_DIR / "app", WEBAPP_DIR / "components")

# Web files the CI-run XCUITest (testAccountNotFoundRecoveryReturnsToLogin)
# renders or depends on: the /login route and its AuthStep, the native route
# marker plumbing, the session-invalidation notice, the auth restoration it
# waits through after activation, the vault unlock fields it asserts are
# absent, and the immersive map it must never leak into.
CI_RUN_XCUITEST_RENDERS = (
    "hushh-webapp/app/login/page.tsx",
    "hushh-webapp/components/onboarding/AuthStep.tsx",
    "hushh-webapp/components/onboarding/AuthStepLight.module.css",
    "hushh-webapp/components/app-ui/native-route-marker.tsx",
    "hushh-webapp/components/app-ui/native-test-route-status.tsx",
    "hushh-webapp/components/app-ui/native-test-beacon.tsx",
    "hushh-webapp/components/app-ui/native-test-bootstrap.tsx",
    "hushh-webapp/components/app-ui/native-test-router.tsx",
    "hushh-webapp/lib/auth/session-invalidation.ts",
    "hushh-webapp/lib/firebase/auth-context.tsx",
    "hushh-webapp/lib/testing/native-test.ts",
    "hushh-webapp/app/providers.tsx",
    "hushh-webapp/components/vault/vault-flow.tsx",
    "hushh-webapp/components/one-location/onboarding/location-picker-map.tsx",
)

MARKER_RE = re.compile(r"native-route-[a-z0-9-]+")
ONLY_TESTING_RE = re.compile(r"-only-testing:AppUITests/AppUITests/(\w+)")
SWIFT_FUNC_BOUNDARY_RE = re.compile(r"\n    (?:private |fileprivate )?func ")
GLOB_CHARS = set("*?[")


def _load_workflow(path: Path) -> dict:
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def _steps(workflow: dict, job: str) -> list[dict]:
    jobs = workflow["jobs"]
    assert job in jobs, f"Workflow job missing: {job}"
    return jobs[job]["steps"]


def _paths_filter_step() -> dict:
    for step in _steps(_load_workflow(MONO_WORKFLOW_PATH), "paths"):
        if str(step.get("uses") or "").startswith("dorny/paths-filter"):
            return step
    raise AssertionError("The paths job no longer uses dorny/paths-filter")


def _ios_filter_patterns() -> list[str]:
    filters = yaml.safe_load(_paths_filter_step()["with"]["filters"])
    assert "ios" in filters, "The paths filter has no ios: list"
    patterns = filters["ios"]
    assert isinstance(patterns, list) and patterns
    return [str(pattern) for pattern in patterns]


def _ios_spec() -> pathspec.PathSpec:
    return pathspec.PathSpec.from_lines("gitignore", _ios_filter_patterns())


def _ci_run_ui_test_names() -> list[str]:
    for step in _steps(_load_workflow(MONO_WORKFLOW_PATH), "ios-native-check"):
        run = str(step.get("run") or "")
        if "xcodebuild test" not in run:
            continue
        names = ONLY_TESTING_RE.findall(run)
        assert names, "The xcodebuild step names no AppUITests test to run"
        return names
    raise AssertionError("ios-native-check has no xcodebuild test step")


def _swift_function_body(source: str, name: str) -> str:
    start = source.find(f"func {name}(")
    assert start >= 0, f"AppUITests.swift has no test named {name}"
    boundary = SWIFT_FUNC_BOUNDARY_RE.search(source, start + 1)
    return source[start : boundary.start()] if boundary else source[start:]


def _ci_run_markers() -> set[str]:
    source = UI_TESTS_PATH.read_text(encoding="utf-8")
    markers: set[str] = set()
    for name in _ci_run_ui_test_names():
        markers.update(MARKER_RE.findall(_swift_function_body(source, name)))
    assert markers, "The CI-run XCUITest references no native-route marker"
    return markers


def _rendering_files(marker: str) -> list[str]:
    pattern = re.compile(r"marker\s*[=:]\s*\{?[^\n]*?\"" + re.escape(marker) + r"\"")
    found: list[str] = []
    for render_root in RENDER_ROOTS:
        for path in sorted(render_root.rglob("*")):
            if path.suffix not in {".ts", ".tsx"} or "__tests__" in path.parts:
                continue
            if pattern.search(path.read_text(encoding="utf-8")):
                found.append(path.relative_to(ROOT).as_posix())
    return found


def _first_step_using(steps: list[dict], prefix: str) -> dict:
    for step in steps:
        if str(step.get("uses") or "").startswith(prefix):
            return step
    raise AssertionError(f"No step uses {prefix}")


def _step_running(steps: list[dict], *fragments: str) -> dict:
    for step in steps:
        run = str(step.get("run") or "")
        if any(fragment in run for fragment in fragments):
            return step
    raise AssertionError(f"No step runs any of {fragments}")


def _step_with_id(steps: list[dict], step_id: str) -> dict:
    for step in steps:
        if step.get("id") == step_id:
            return step
    raise AssertionError(f"No step has id {step_id}")


def test_ios_filter_patterns_are_slash_anchored_and_point_at_real_paths() -> None:
    # gitignore rules treat a slash-free pattern as "any depth" while picomatch
    # anchors it at the root. Requiring a slash keeps this test's engine and
    # dorny/paths-filter's engine in agreement, so a green here means green
    # on GitHub. The prefix check stops a typo from becoming a dead pattern.
    for pattern in _ios_filter_patterns():
        assert "/" in pattern, f"ios filter pattern is not slash-anchored: {pattern}"
        glob_at = min(
            (index for index, char in enumerate(pattern) if char in GLOB_CHARS),
            default=len(pattern),
        )
        prefix = pattern[:glob_at]
        anchor = prefix if glob_at == len(pattern) else prefix.rsplit("/", 1)[0]
        assert (ROOT / anchor).exists(), f"ios filter pattern points at nothing: {pattern}"


def test_ios_filter_matches_every_file_the_ci_run_xcuitest_renders() -> None:
    spec = _ios_spec()
    missing_on_disk = [path for path in CI_RUN_XCUITEST_RENDERS if not (ROOT / path).is_file()]
    assert not missing_on_disk, f"Render table names files that no longer exist: {missing_on_disk}"
    unmatched = [path for path in CI_RUN_XCUITEST_RENDERS if not spec.match_file(path)]
    assert not unmatched, (
        "The ios: path filter does not schedule the native lane for files the "
        f"CI-run XCUITest renders; grow the filter to cover: {unmatched}"
    )


def test_ios_filter_matches_direct_native_helpers_only() -> None:
    # 'components/app-ui/native-*' is a single-star glob: it must cover the
    # helpers directly under app-ui and must not silently widen to subtrees.
    spec = _ios_spec()
    assert spec.match_file("hushh-webapp/components/app-ui/native-route-marker.tsx")
    assert not spec.match_file("hushh-webapp/components/app-ui/other-component.tsx")
    assert not spec.match_file("hushh-webapp/components/app-ui/nested/native-thing.tsx")


def test_every_marker_the_ci_run_xcuitest_expects_is_rendered_by_a_filtered_file() -> None:
    spec = _ios_spec()
    problems: list[str] = []
    for marker in sorted(_ci_run_markers()):
        rendering = _rendering_files(marker)
        if not rendering:
            problems.append(f"{marker}: no file under hushh-webapp/app or components renders it")
            continue
        uncovered = [path for path in rendering if not spec.match_file(path)]
        if uncovered:
            problems.append(
                f"{marker}: rendered by files the ios filter does not cover {uncovered}"
            )
    assert not problems, "Grow the ios: path filter, do not shrink this check:\n" + "\n".join(
        problems
    )


def test_protocol_check_fetches_full_history_and_exports_the_base_ref() -> None:
    steps = _steps(_load_workflow(MONO_WORKFLOW_PATH), "protocol-check")
    checkout = _first_step_using(steps, "actions/checkout")
    assert checkout.get("with", {}).get("fetch-depth") == 0, (
        "protocol-check must check out full history so the capability graph "
        "check can diff against the PR base ref"
    )
    protocol_step = _step_running(steps, "orchestrate.sh protocol", "protocol-check.sh")
    base_ref = str(protocol_step.get("env", {}).get("CAPABILITY_GRAPH_BASE_REF") or "")
    assert base_ref.startswith("origin/") and "github.base_ref" in base_ref, (
        "protocol-check must export CAPABILITY_GRAPH_BASE_REF as origin/<PR base ref>"
    )


def test_upstream_backend_check_mirrors_the_checkout_depth_and_base_ref() -> None:
    # scripts/ci/verify-protocol-ci-parity.sh keeps the two backend jobs in
    # step for the shared env keys; this extends that parity to the new ones.
    steps = _steps(_load_workflow(UPSTREAM_WORKFLOW_PATH), "backend-check")
    checkout = _first_step_using(steps, "actions/checkout")
    assert checkout.get("with", {}).get("fetch-depth") == 0
    backend_step = _step_running(steps, "backend-check.sh")
    base_ref = str(backend_step.get("env", {}).get("CAPABILITY_GRAPH_BASE_REF") or "")
    assert base_ref.startswith("origin/") and "github.base_ref" in base_ref


@pytest.mark.parametrize("job", QUEUE_LANES_REACHING_THE_GRAPH_CHECK)
def test_queue_lane_fetches_full_history_and_exports_the_merge_group_base(job: str) -> None:
    # On a merge_group event GITHUB_BASE_REF is unset, so the generator would
    # fall back to origin/main, which a depth-1 checkout of the queue branch
    # does not carry. Each lane must resolve the merge group's base itself.
    steps = _steps(_load_workflow(QUEUE_WORKFLOW_PATH), job)
    checkout = _first_step_using(steps, "actions/checkout")
    assert checkout.get("with", {}).get("fetch-depth") == 0, (
        f"{job} must check out full history so the capability graph check can "
        "diff against the merge-group base"
    )
    resolve = _step_with_id(steps, "queue-base")
    assert (
        resolve.get("env", {}).get("QUEUE_BASE_REF") == "${{ github.event.merge_group.base_ref }}"
    )
    assert "GITHUB_OUTPUT" in str(resolve.get("run") or "")
    lane_step = _step_running(steps, "orchestrate.sh web-full", "orchestrate.sh protocol")
    assert steps.index(resolve) < steps.index(lane_step), (
        "the base must resolve before the lane runs"
    )
    assert lane_step.get("env", {}).get("CAPABILITY_GRAPH_BASE_REF") == (
        "${{ steps.queue-base.outputs.ref }}"
    )


@pytest.mark.parametrize(
    ("merge_group_base_ref", "expected"),
    [
        ("refs/heads/main", "origin/main"),
        ("refs/heads/integration/pr-train", "origin/integration/pr-train"),
        ("", "origin/main"),
    ],
)
def test_queue_base_ref_step_names_the_fetched_remote_ref(
    tmp_path: Path, merge_group_base_ref: str, expected: str
) -> None:
    # Run the step's own shell: the generator reads CAPABILITY_GRAPH_BASE_REF
    # verbatim, so the value must already be the remote-tracking ref that a
    # fetch-depth 0 checkout carries, never the bare refs/heads/ form.
    steps = _steps(_load_workflow(QUEUE_WORKFLOW_PATH), "protocol-check")
    script = str(_step_with_id(steps, "queue-base")["run"])
    output = tmp_path / "github_output"
    output.write_text("", encoding="utf-8")
    completed = subprocess.run(  # noqa: S603 - fixed shell running workflow text
        ["bash", "-euo", "pipefail", "-c", script],  # noqa: S607
        cwd=tmp_path,
        check=False,
        capture_output=True,
        text=True,
        env={
            **{k: v for k, v in os.environ.items() if k in {"PATH", "HOME"}},
            "QUEUE_BASE_REF": merge_group_base_ref,
            "GITHUB_OUTPUT": str(output),
        },
    )
    assert completed.returncode == 0, completed.stderr
    assert output.read_text(encoding="utf-8").strip() == f"ref={expected}"


def test_queue_lanes_share_one_base_ref_step() -> None:
    # Two copies of the resolve step is the price of not having a reusable
    # workflow; keep them byte-identical so one cannot drift from the other.
    workflow = _load_workflow(QUEUE_WORKFLOW_PATH)
    scripts = {
        job: str(_step_with_id(_steps(workflow, job), "queue-base")["run"])
        for job in QUEUE_LANES_REACHING_THE_GRAPH_CHECK
    }
    assert len(set(scripts.values())) == 1, scripts
