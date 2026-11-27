"""Keep native CI triggers on native inputs and shared authentication contracts.

Portable web UI changes belong to the web lanes. The XCUITest login journey is
still valuable, but tracing every React import into the iOS filter made normal
UI work require a full simulator run. This owner pins native build/config/bridge
inputs and the auth/session files shared with the native login journey. Editor
layout/performance specs remain developer-local diagnostics, not an automatic
scheduled job.
"""

from __future__ import annotations

import json
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
WEBAPP_DIR = ROOT / "hushh-webapp"
UI_TESTS_PATH = WEBAPP_DIR / "ios" / "App" / "AppUITests" / "AppUITests.swift"
RENDER_ROOTS = (WEBAPP_DIR / "app", WEBAPP_DIR / "components")
SHARED_AUTH_INPUTS = (
    "hushh-webapp/lib/auth/session-invalidation.ts",
    "hushh-webapp/lib/firebase/auth-context.tsx",
)
NATIVE_BUILD_INPUTS = (
    "hushh-webapp/ios/App/App.xcodeproj/project.pbxproj",
    "hushh-webapp/lib/capacitor/index.ts",
    "hushh-webapp/scripts/native/ios-test.sh",
    "hushh-webapp/capacitor.config.ts",
    "hushh-webapp/package.json",
    "hushh-webapp/package-lock.json",
)
PORTABLE_WEB_INPUTS = (
    "hushh-webapp/app/login/page.tsx",
    "hushh-webapp/components/onboarding/AuthStep.tsx",
    "hushh-webapp/components/onboarding/setup/setup-v10-surface.tsx",
    "hushh-webapp/hooks/use-owner-presentation-state.ts",
    "hushh-webapp/components/connections/gemini-runtime-settings-card.tsx",
    "hushh-webapp/components/profile/world-model-provider.tsx",
)
EDITOR_LOCAL_SCRIPT = "test:layout-editor-performance"
MARKER_RE = re.compile(r"native-route-[a-z0-9-]+")
ONLY_TESTING_RE = re.compile(r"-only-testing:AppUITests/AppUITests/(\w+)")
SWIFT_FUNC_BOUNDARY_RE = re.compile(r"\n    (?:private |fileprivate )?func ")
GLOB_CHARS = set("*?[")


class _Filter:
    """dorny/paths-filter under `predicate-quantifier: some-with-excludes`:
    a file matches when one pattern includes it and no '!' pattern excludes it."""

    def __init__(self, patterns: list[str]) -> None:
        includes = [p for p in patterns if not p.startswith("!")]
        excludes = [p[1:] for p in patterns if p.startswith("!")]
        self._include = pathspec.PathSpec.from_lines("gitignore", includes)
        self._exclude = pathspec.PathSpec.from_lines("gitignore", excludes)

    def match_file(self, path: str) -> bool:
        return self._include.match_file(path) and not self._exclude.match_file(path)


def _load_workflow(path: Path) -> dict:
    return yaml.safe_load(path.read_text(encoding="utf-8"))


@pytest.mark.parametrize(
    "first_error,first_code,second_code,expected_calls,expected_code",
    [
        ("", 0, 0, 1, 0),
        ("collision", 74, 0, 2, 0),
        ("collision-prefixed", 74, 0, 2, 0),
        ("collision", 74, 74, 2, 74),
        ("collision", 65, 0, 1, 65),
        ("checksum", 74, 0, 1, 74),
        ("foreign-cache", 74, 0, 1, 74),
        ("collision-and-checksum", 74, 0, 1, 74),
        ("collision-and-error", 74, 0, 1, 74),
        ("collision-same-line-checksum", 74, 0, 1, 74),
        ("collision-same-line-signature", 74, 0, 1, 74),
        ("collision-same-line-error", 74, 0, 1, 74),
    ],
)
def test_actual_ios_resolve_retries_only_the_bounded_artifact_collision(
    tmp_path, first_error, first_code, second_code, expected_calls, expected_code
):
    stub = tmp_path / "xcodebuild"
    stub.write_text(
        "#!/usr/bin/env python3\n"
        "import json, os, pathlib, sys\n"
        "root = pathlib.Path(os.environ['RUNNER_TEMP'])\n"
        "calls = root / 'calls.jsonl'\n"
        "attempt = len(calls.read_text().splitlines()) + 1 if calls.exists() else 1\n"
        "with calls.open('a') as out: out.write(json.dumps(sys.argv[1:]) + '\\n')\n"
        "error = os.environ['RESOLVE_TEST_ERROR']\n"
        "if attempt == 1 and error:\n"
        "    cache = root if error != 'foreign-cache' else root / 'other'\n"
        "    prefix = \"failed downloading 'https://example.com/framework.zip' \"\n"
        "    prefix += \"which is required by binary target 'Framework': \"\n"
        "    if error == 'collision-prefixed': prefix = 'error: ' + prefix\n"
        "    if error != 'checksum':\n"
        "        suffix = ': ' + error.rsplit('-', 1)[-1] if 'same-line' in error else ''\n"
        "        if suffix == ': error': suffix += ': authorization refused'\n"
        "        print(prefix + str(cache / 'spm-cache/artifacts/framework_zip') "
        "+ ' already exists in file system' + suffix)\n"
        "    if 'checksum' in error and 'same-line' not in error:\n"
        "        print(\"checksum of downloaded artifact of binary target 'Framework' \""
        " + 'does not match checksum specified by the manifest')\n"
        "    if error == 'collision-and-error': print('error: authorization refused')\n"
        "print('attempt-' + str(attempt))\n"
        "sys.exit(int(os.environ['RESOLVE_TEST_FIRST' if attempt == 1 "
        "else 'RESOLVE_TEST_SECOND']))\n"
    )
    stub.chmod(0o700)
    step = next(
        item
        for item in _steps(_load_workflow(MONO_WORKFLOW_PATH), "ios-native-check")
        if item.get("name") == "Resolve Swift package dependencies"
    )
    partial = tmp_path / "spm-cache" / "artifacts" / "partial-download"
    partial.parent.mkdir(parents=True)
    partial.write_bytes(b"partial")
    result = subprocess.run(
        ["bash", "-eo", "pipefail"],
        input=step["run"],
        cwd=ROOT,
        env={
            **os.environ,
            "PATH": f"{tmp_path}:{os.environ['PATH']}",
            "RUNNER_TEMP": str(tmp_path),
            "SPM_CACHE_HIT": "false",
            "GITHUB_OUTPUT": str(tmp_path / "github-output"),
            "XCODE_PROJECT": "synthetic/App.xcodeproj",
            "XCODE_SCHEME": "App",
            "RESOLVE_TEST_ERROR": first_error,
            "RESOLVE_TEST_FIRST": str(first_code),
            "RESOLVE_TEST_SECOND": str(second_code),
        },
        text=True,
        capture_output=True,
        timeout=10,
        check=False,
    )
    assert result.returncode == expected_code, result.stdout + result.stderr
    assert not partial.exists(), "an incomplete cache restore must not reach resolution"
    calls = [json.loads(line) for line in (tmp_path / "calls.jsonl").read_text().splitlines()]
    assert len(calls) == expected_calls
    assert all(call == calls[0] for call in calls)
    assert calls[0][0] == "-resolvePackageDependencies"
    for attempt in range(1, expected_calls + 1):
        log = tmp_path / f"xcodebuild-package-resolution-{attempt}.log"
        assert f"attempt-{attempt}" in log.read_text()


def _steps(workflow: dict, job: str) -> list[dict]:
    jobs = workflow["jobs"]
    assert job in jobs, f"Workflow job missing: {job}"
    return jobs[job]["steps"]


def _paths_filter_step() -> dict:
    for step in _steps(_load_workflow(MONO_WORKFLOW_PATH), "paths"):
        if str(step.get("uses") or "").startswith("dorny/paths-filter"):
            return step
    raise AssertionError("The paths job no longer uses dorny/paths-filter")


def _filter_patterns(name: str) -> list[str]:
    filters = yaml.safe_load(_paths_filter_step()["with"]["filters"])
    assert name in filters, f"The paths filter has no {name}: list"
    patterns = filters[name]
    assert isinstance(patterns, list) and patterns
    return [str(pattern) for pattern in patterns]


def _ios_filter_patterns() -> list[str]:
    return _filter_patterns("ios")


def _ios_spec() -> _Filter:
    return _Filter(_ios_filter_patterns())


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


def test_release_native_filter_runs_for_all_and_uses_the_isolated_candidate():
    step = _paths_filter_step()
    condition = " ".join(step["if"].split())
    assert "(inputs.scope == 'all' && inputs.uat_base_sha != '') ||" in condition
    assert "(inputs.scope == 'auto' &&" in condition
    assert "inputs.uat_candidate_sha || github.sha" in step["with"]["ref"]
    assert "inputs.uat_base_sha" in step["with"]["base"]


def test_ios_filter_patterns_are_slash_anchored_and_point_at_real_paths() -> None:
    # gitignore rules treat a slash-free pattern as "any depth" while picomatch
    # anchors it at the root. Requiring a slash keeps this test's engine and
    # dorny/paths-filter's engine in agreement, so a green here means green
    # on GitHub. The prefix check stops a typo from becoming a dead pattern.
    for pattern in (p.removeprefix("!") for p in _ios_filter_patterns()):
        assert "/" in pattern, f"ios filter pattern is not slash-anchored: {pattern}"
        glob_at = min(
            (index for index, char in enumerate(pattern) if char in GLOB_CHARS),
            default=len(pattern),
        )
        prefix = pattern[:glob_at]
        anchor = prefix if glob_at == len(pattern) else prefix.rsplit("/", 1)[0]
        assert (ROOT / anchor).exists(), f"ios filter pattern points at nothing: {pattern}"


def test_ios_filter_keeps_native_build_inputs_and_shared_auth_contracts() -> None:
    ios = _ios_spec()
    frontend = _Filter(_filter_patterns("frontend"))
    for path in (*NATIVE_BUILD_INPUTS, *SHARED_AUTH_INPUTS):
        assert (ROOT / path).is_file(), f"native/auth input disappeared: {path}"
        assert ios.match_file(path), f"the ios: filter skips native/auth input {path}"

    # Portable screens are exercised by web validation. Their implementation
    # changes must not reserve a macOS simulator unless a shared auth/native
    # contract above also changes.
    for path in PORTABLE_WEB_INPUTS:
        assert (ROOT / path).is_file(), f"portable web input disappeared: {path}"
        assert frontend.match_file(path), f"the frontend filter skips {path}"
        assert not ios.match_file(path), f"portable UI unexpectedly schedules XCUITest: {path}"
    assert not ios.match_file("scripts/ci/resolve-ios-packages.sh")


def test_native_login_probe_keeps_ui_in_web_lane_and_auth_in_native_lane() -> None:
    names = _ci_run_ui_test_names()
    assert names == ["testAccountNotFoundRecoveryReturnsToLogin"]
    assert "native-route-login" in _ci_run_markers()
    rendered = set(_rendering_files("native-route-login"))
    assert {
        "hushh-webapp/app/login/page.tsx",
        "hushh-webapp/components/onboarding/AuthStep.tsx",
    } <= rendered

    frontend = _Filter(_filter_patterns("frontend"))
    ios = _ios_spec()
    for path in rendered:
        assert frontend.match_file(path), f"login marker UI must stay in the web lane: {path}"
        assert not ios.match_file(path), f"portable login UI should not widen XCUITest: {path}"
    assert all(ios.match_file(path) for path in SHARED_AUTH_INPUTS)


def test_upstream_backend_check_mirrors_the_checkout_depth_and_base_ref() -> None:
    # scripts/ci/verify-protocol-ci-parity.sh keeps the two backend jobs in
    # step for the shared env keys; this extends that parity to the new ones.
    steps = _steps(_load_workflow(UPSTREAM_WORKFLOW_PATH), "backend-check")
    checkout = _first_step_using(steps, "actions/checkout")
    assert checkout.get("with", {}).get("fetch-depth") == 0
    backend_step = _step_running(steps, "backend-check.sh")
    base_ref = str(backend_step.get("env", {}).get("CAPABILITY_GRAPH_BASE_REF") or "")
    assert base_ref.startswith("origin/") and "github.base_ref" in base_ref


def test_queue_combined_checks_reuse_the_existing_lane_owner() -> None:
    # Changed combined inputs use the existing lane selection, not a second
    # copy of native/browser jobs. Exact matching evidence can still be reused.
    workflow = _load_workflow(QUEUE_WORKFLOW_PATH)
    jobs = workflow["jobs"]
    assert set(jobs) == {"admission", "combined-checks", "ci-status"}, sorted(jobs)
    assert jobs["ci-status"]["name"] == "CI Status Gate"
    combined = jobs["combined-checks"]
    assert combined["uses"] == "./.github/workflows/ci.yml"
    assert combined["if"] == "needs.admission.outputs.reuse == 'false'"
    assert jobs["ci-status"]["needs"] == ["admission", "combined-checks"]
    # Admission code comes from the protected destination, never the candidate
    # whose workflow/policy edits are awaiting approval. Both phases use it.
    for phase, command in (("admission", "plan"), ("ci-status", "finish")):
        steps = _steps(workflow, phase)
        authority = next(
            step for step in steps if step.get("with", {}).get("path") == ".queue-authority"
        )
        assert str(authority.get("uses") or "").startswith("actions/checkout@")
        assert authority["with"]["ref"] == "${{ github.event.merge_group.base_sha }}"
        assert authority["with"]["persist-credentials"] is False
        dispatch = _step_running(steps, f"queue_combined_result.py {command}")
        assert str(dispatch["run"]).startswith(
            "python3 .queue-authority/scripts/ci/queue_combined_result.py "
        )
    assert "orchestrate.sh" not in QUEUE_WORKFLOW_PATH.read_text(encoding="utf-8")


def test_editor_performance_stays_local_without_an_automatic_job() -> None:
    ci = _load_workflow(MONO_WORKFLOW_PATH)
    jobs = ci["jobs"]
    assert "web-editor-performance-check" not in jobs
    assert "document-webkit-check" not in jobs
    assert "editor" in ci["jobs"]["paths"]["outputs"]
    assert not any("outputs.editor" in str(job.get("if") or "") for job in jobs.values())

    package_scripts = json.loads((WEBAPP_DIR / "package.json").read_text(encoding="utf-8"))[
        "scripts"
    ]
    local_command = package_scripts.get(EDITOR_LOCAL_SCRIPT, "")
    assert "playwright test" in local_command
    assert "--project=chromium" in local_command and "--project=webkit" in local_command

    workflow_dir = ROOT / ".github" / "workflows"
    workflow_paths = (*workflow_dir.glob("*.yml"), *workflow_dir.glob("*.yaml"))
    for workflow_path in sorted(workflow_paths):
        workflow = _load_workflow(workflow_path)
        for job in workflow.get("jobs", {}).values():
            for step in job.get("steps", []):
                assert EDITOR_LOCAL_SCRIPT not in str(step.get("run") or ""), (
                    f"{workflow_path.relative_to(ROOT)} runs the editor diagnostic automatically"
                )
