"""The iOS CI lane must be scheduled by the web surfaces its XCUITest renders.

`ios-native-check` runs a real XCUITest against the web bundle, but the lane is
gated by the `paths` job's `ios:` filter. A filter that only names `ios/**`
lets a change to the login screen, the vault unlock, or the native route
markers merge without ever running the test that renders them. This guard
parses the filter the way GitHub does (dorny/paths-filter, whose globs and
`pathspec`'s gitignore rules agree for every slash-anchored pattern) and checks
it against the files the CI-run test actually touches.

The login route now imports post-sign-in setup screens. The render path's
transitive imports are traced so the iOS filter covers those screens too.

It also pins the checkout depth and base-ref env of every lane that reaches
the capability graph check (`generate_capability_graph.py --check`), which
must diff against the pull request base and fails closed under CI when that
base is not in the clone: `protocol-check` and `web-full-suite-check` (whose
`verify:one-voice` runs the check) on PR Validation. Queue Validation is a
pass-through that reuses the PR Validation result and runs no lane, so it has
no base ref to resolve; that is pinned here too, so a lane re-added there
cannot silently skip the graph check.

The macOS editor latency steps get the same
guard from its own `editor:` filter, which replaced scheduling it on every
frontend change. Its inputs are derived from the job itself: the npm script it
runs, the specs that script names, their transitive imports, and the fixture,
stylesheet and font the spec reads from disk. Its nightly backstop on main
(.github/workflows/editor-performance-nightly.yml) is pinned to the same steps.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
from functools import cache
from pathlib import Path

import pathspec
import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
MONO_WORKFLOW_PATH = ROOT / ".github" / "workflows" / "ci.yml"
UPSTREAM_WORKFLOW_PATH = ROOT / "consent-protocol" / ".github" / "workflows" / "ci.yml"
QUEUE_WORKFLOW_PATH = ROOT / ".github" / "workflows" / "queue-validation.yml"
PR_LANES_REACHING_THE_GRAPH_CHECK = {
    "protocol-check": ("orchestrate.sh protocol", "protocol-check.sh"),
    "web-full-suite-check": ("orchestrate.sh web-full-suite",),
}
WEBAPP_DIR = ROOT / "hushh-webapp"
UI_TESTS_PATH = WEBAPP_DIR / "ios" / "App" / "AppUITests" / "AppUITests.swift"
RENDER_ROOTS = (WEBAPP_DIR / "app", WEBAPP_DIR / "components")
ONBOARDING_DIR = "hushh-webapp/components/onboarding/"
ONBOARDING_SETUP_DIR = "hushh-webapp/components/onboarding/setup/"
# The Next.js layouts that wrap the /login route the XCUITest renders.
CI_RUN_XCUITEST_LAYOUTS = ("hushh-webapp/app/layout.tsx", "hushh-webapp/app/login/layout.tsx")

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

# The macOS editor latency steps are scheduled by the `editor:` filter alone.
# The shared job also owns native document crypto. Editor inputs derive from npm
# scripts the job runs (and those they run), the specs they name, those specs'
# transitive imports (CSS `@import` included), and every webapp file the code
# reads through `path.join(<dir>, "<literal>"...)`, such as the fixture the
# spec bundles, the stylesheet it compiles and the font it inlines.
EDITOR_JOB = "web-editor-performance-check"
NIGHTLY_WORKFLOW_PATH = ROOT / ".github" / "workflows" / "editor-performance-nightly.yml"
NPM_RUN_RE = re.compile(r"\bnpm run ([\w:.-]+)")
SPEC_RE = re.compile(r"\b(e2e/[\w./-]+\.spec\.ts)\b")
PATH_JOIN_RE = re.compile(
    r"""path\.(?:join|resolve)\(\s*[\w.]+(?:\(\))?\s*,((?:\s*["'][^"']+["']\s*,?)+)\s*\)"""
)
STRING_LITERAL_RE = re.compile(r"""["']([^"']+)["']""")
CSS_IMPORT_RE = re.compile(r"""@import\s+(?:url\(\s*)?["']([^"']+)["']""")
# What the lane reads without naming it in code: the configs that transpile,
# bundle and run the spec, the lockfile behind every bare import, and the
# workflow that defines the job.
EDITOR_LANE_CONFIG_INPUTS = (
    "hushh-webapp/package.json",
    "hushh-webapp/package-lock.json",
    "hushh-webapp/playwright.config.ts",
    "hushh-webapp/tsconfig.json",
    "hushh-webapp/e2e/tsconfig.json",
    "hushh-webapp/postcss.config.mjs",
    "hushh-webapp/tailwind.config.ts",
    ".github/workflows/ci.yml",
)

MARKER_RE = re.compile(r"native-route-[a-z0-9-]+")
ONLY_TESTING_RE = re.compile(r"-only-testing:AppUITests/AppUITests/(\w+)")
SWIFT_FUNC_BOUNDARY_RE = re.compile(r"\n    (?:private |fileprivate )?func ")
GLOB_CHARS = set("*?[")
IMPORT_RE = re.compile(
    r"""(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']([^"']+)["']"""
)
EDITOR_TYPE_DECLARATION_RE = re.compile(
    r"""\b(?:import\s+type\s+(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)|export\s+type\s+(?:\{[^}]*\}|\*(?:\s+as\s+\w+)?))\s+from\s*["'][^"']+["']\s*;?"""
)
CODE_SUFFIXES = {".ts", ".tsx", ".js", ".jsx", ".mjs"}


RESOLVE_SUFFIXES = ("", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".css", ".json")


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
    result = subprocess.run(
        ["bash", "-eo", "pipefail"],
        input=step["run"],
        cwd=ROOT,
        env={
            **os.environ,
            "PATH": f"{tmp_path}:{os.environ['PATH']}",
            "RUNNER_TEMP": str(tmp_path),
            "SPM_CACHE_HIT": "false",
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


def _resolve_import(source: Path, specifier: str) -> Path | None:
    if specifier.startswith("@/"):
        base = WEBAPP_DIR / specifier[2:]
    elif specifier.startswith("."):
        base = source.parent / specifier
    else:
        return None
    for suffix in RESOLVE_SUFFIXES:
        candidate = Path(f"{base}{suffix}")
        if candidate.is_file():
            return candidate.resolve()
    for suffix in (".ts", ".tsx", ".js", ".jsx"):
        candidate = base / f"index{suffix}"
        if candidate.is_file():
            return candidate.resolve()
    return None


def _ci_run_xcuitest_render_closure() -> set[str]:
    """Every repo file transitively imported from what the XCUITest renders."""
    pending = [
        (ROOT / path).resolve() for path in (*CI_RUN_XCUITEST_RENDERS, *CI_RUN_XCUITEST_LAYOUTS)
    ]
    seen: set[Path] = set()
    while pending:
        path = pending.pop()
        if path in seen:
            continue
        seen.add(path)
        if path.suffix not in CODE_SUFFIXES:
            continue
        for specifier in IMPORT_RE.findall(path.read_text(encoding="utf-8")):
            resolved = _resolve_import(path, specifier)
            if resolved is not None and resolved not in seen:
                pending.append(resolved)
    return {path.relative_to(ROOT.resolve()).as_posix() for path in seen}


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
    assert spec.match_file("scripts/ci/resolve-ios-packages.sh")
    assert spec.match_file("hushh-webapp/components/app-ui/native-route-marker.tsx")
    assert not spec.match_file("hushh-webapp/components/app-ui/other-component.tsx")
    assert not spec.match_file("hushh-webapp/components/app-ui/nested/native-thing.tsx")


@pytest.mark.parametrize(
    "path",
    (
        "hushh-webapp/hooks/use-owner-presentation-state.ts",
        "hushh-webapp/components/connections/gemini-runtime-settings-card.tsx",
        "hushh-webapp/components/profile/world-model-provider.tsx",
    ),
)
def test_ios_filter_covers_shared_profile_inputs_in_the_render_path(path: str) -> None:
    # Shared controller-only changes must not skip the native export/build lane.
    # Check the actual import closure, not an invented native-only entrypoint.
    assert path in _ci_run_xcuitest_render_closure(), f"No longer a rendered input: {path}"
    assert _ios_spec().match_file(path), f"The ios: filter skips a rendered shared input: {path}"


def test_ios_filter_schedules_setup_screens_rendered_by_xcuitest() -> None:
    closure = _ci_run_xcuitest_render_closure()
    assert "hushh-webapp/components/onboarding/AuthStep.tsx" in closure
    assert len(closure) > len(CI_RUN_XCUITEST_RENDERS), "the import trace found nothing"
    reached = sorted(path for path in closure if path.startswith(ONBOARDING_SETUP_DIR))
    assert f"{ONBOARDING_SETUP_DIR}setup-v10-surface.tsx" in reached
    assert f"{ONBOARDING_SETUP_DIR}setup-v10-surface.module.css" in reached
    unmatched = [path for path in reached if not _ios_spec().match_file(path)]
    assert not unmatched, f"The ios: filter no longer schedules rendered setup files: {unmatched}"


def test_ios_filter_covers_every_onboarding_file_the_xcuitest_renders() -> None:
    spec = _ios_spec()
    rendered = sorted(p for p in _ci_run_xcuitest_render_closure() if p.startswith(ONBOARDING_DIR))
    assert rendered, "the import trace reached no onboarding file"
    unmatched = [path for path in rendered if not spec.match_file(path)]
    assert not unmatched, f"The ios: filter no longer schedules rendered files: {unmatched}"
    assert spec.match_file(f"{ONBOARDING_SETUP_DIR}one-setup-hub.tsx")


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


@pytest.mark.parametrize("job", sorted(PR_LANES_REACHING_THE_GRAPH_CHECK))
def test_pr_lane_fetches_full_history_and_exports_the_base_ref(job: str) -> None:
    steps = _steps(_load_workflow(MONO_WORKFLOW_PATH), job)
    checkout = _first_step_using(steps, "actions/checkout")
    assert checkout.get("with", {}).get("fetch-depth") == 0, (
        f"{job} must check out full history so the capability graph "
        "check can diff against the PR base ref"
    )
    lane_step = _step_running(steps, *PR_LANES_REACHING_THE_GRAPH_CHECK[job])
    base_ref = str(lane_step.get("env", {}).get("CAPABILITY_GRAPH_BASE_REF") or "")
    assert (
        "format('origin/{0}'" in base_ref
        and "github.base_ref || 'main'" in base_ref
        and "inputs.uat_base_sha" in base_ref
    ), (
        f"{job} must use origin/<PR base ref> for pull requests and the explicit UAT base for direct CI"
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


def test_queue_validation_is_a_pass_through_that_runs_no_lane() -> None:
    # Queue Validation reuses PR Validation's verdict for an identical tree.
    # A CI lane re-added there would need its own merge-group base handling
    # (GITHUB_BASE_REF is unset on merge_group), which this file used to pin.
    workflow = _load_workflow(QUEUE_WORKFLOW_PATH)
    jobs = workflow["jobs"]
    assert set(jobs) == {"pr-validation-reuse", "main-freshness-gate", "ci-status"}, sorted(jobs)
    assert jobs["ci-status"]["name"] == "CI Status Gate"
    reuse = _step_running(
        _steps(workflow, "pr-validation-reuse"), "verify-queue-entry-reuses-pr-validation.py"
    )
    assert reuse.get("env", {}).get("MERGE_GROUP_HEAD_SHA") == (
        "${{ github.event.merge_group.head_sha }}"
    )
    assert "orchestrate.sh" not in QUEUE_WORKFLOW_PATH.read_text(encoding="utf-8")


def _editor_specs() -> list[Path]:
    """The specs named by every npm script the editor lane's job runs, transitively."""
    scripts = json.loads((WEBAPP_DIR / "package.json").read_text(encoding="utf-8"))["scripts"]
    pending = [
        name
        for step in _steps(_load_workflow(MONO_WORKFLOW_PATH), EDITOR_JOB)
        for name in NPM_RUN_RE.findall(str(step.get("run") or ""))
    ]
    assert pending, f"{EDITOR_JOB} runs no npm script"
    seen: set[str] = set()
    specs: set[str] = set()
    while pending:
        name = pending.pop()
        if name in seen:
            continue
        seen.add(name)
        assert name in scripts, f"package.json has no {name} script"
        specs.update(SPEC_RE.findall(scripts[name]))
        pending.extend(NPM_RUN_RE.findall(scripts[name]))
    assert specs, f"npm scripts {sorted(seen)} name no e2e spec"
    return sorted((WEBAPP_DIR / spec).resolve() for spec in specs)


@cache
def _editor_lane_closure() -> frozenset[str]:
    """Every repo file the editor lane imports or reads, from its specs down."""
    pending = _editor_specs()
    seen: set[Path] = set()
    while pending:
        path = pending.pop()
        if path in seen:
            continue
        seen.add(path)
        if path.suffix in CODE_SUFFIXES:
            text = path.read_text(encoding="utf-8")
            found = [
                _resolve_import(path, specifier) for specifier in _editor_runtime_imports(text)
            ]
            # Read, not imported: a joined path that names a webapp file. The
            # lockfile pins node_modules, and a directory is a base, not a read.
            for arguments in PATH_JOIN_RE.findall(text):
                relative = "/".join(STRING_LITERAL_RE.findall(arguments))
                if not relative.startswith("node_modules/") and (WEBAPP_DIR / relative).is_file():
                    found.append((WEBAPP_DIR / relative).resolve())
        elif path.suffix == ".css":
            found = [
                (path.parent / specifier).resolve()
                for specifier in CSS_IMPORT_RE.findall(path.read_text(encoding="utf-8"))
                if specifier.startswith(".") and (path.parent / specifier).is_file()
            ]
        else:
            continue
        pending.extend(found_path for found_path in found if found_path is not None)
    return frozenset(path.relative_to(ROOT.resolve()).as_posix() for path in seen)


def _editor_runtime_imports(text: str) -> list[str]:
    # Vite/Oxc erases explicit type declarations before resolving dependencies.
    # Keep mixed declarations conservatively, and leave the iOS graph unchanged.
    return IMPORT_RE.findall(EDITOR_TYPE_DECLARATION_RE.sub("", text))


def test_editor_dependency_graph_excludes_only_erased_type_declarations() -> None:
    imports = _editor_runtime_imports("""
        import type { Settings } from "./type-only";
        import type Default from "./default-type";
        export type { Settings } from "./export-type";
        export type * from "./export-all-types";
        import { Settings } from "./runtime";
        import { type Settings, create } from "./mixed";
        import "./side-effect";
        const lazy = import("./dynamic");
        const legacy = require("./required");
    """)
    assert imports == ["./runtime", "./mixed", "./side-effect", "./dynamic", "./required"]
    # Negative control: the same edge must become required when it is a value.
    assert _editor_runtime_imports('import { Settings } from "./type-only";') == ["./type-only"]


def _editor_uncovered(patterns: list[str]) -> list[str]:
    spec = _Filter(patterns)
    inputs = {*_editor_lane_closure(), *EDITOR_LANE_CONFIG_INPUTS}
    return sorted(path for path in inputs if not spec.match_file(path))


def test_editor_filter_schedules_the_macos_lane_for_every_file_it_builds_or_reads() -> None:
    workflow = _load_workflow(MONO_WORKFLOW_PATH)
    jobs = workflow["jobs"]
    assert "outputs.editor == 'true'" in jobs[EDITOR_JOB]["if"]
    assert "steps.resolve.outputs.editor" in jobs["paths"]["outputs"]["editor"]
    assert "needs.paths.outputs.editor" in jobs["preflight-gate"]["outputs"]["editor"]
    patterns = _filter_patterns("editor")
    # An exact file path and `<dir>/**` match the same files under gitignore
    # rules (this test) and picomatch (dorny/paths-filter), so a green here is
    # a green on GitHub. A single-star glob would not be: gitignore also
    # matches everything under a directory the star happens to name.
    for pattern in (p.removeprefix("!") for p in patterns):
        anchor = pattern.removesuffix("/**")
        assert not GLOB_CHARS & set(anchor), f"editor pattern {pattern} is not a file or <dir>/**"
        exists = (ROOT / anchor).is_dir() if anchor != pattern else (ROOT / anchor).is_file()
        assert exists, f"editor pattern {pattern} points at nothing"
    closure = _editor_lane_closure()
    # The two inputs only a read reaches; without them the trace is the imports alone.
    assert "hushh-webapp/e2e/fixtures/text-attachment-viewer.tsx" in closure
    assert "hushh-webapp/app/globals.css" in closure
    assert len(closure) > 20, f"the trace found only {sorted(closure)}"
    missing = [path for path in EDITOR_LANE_CONFIG_INPUTS if not (ROOT / path).is_file()]
    assert not missing, f"Config inputs that no longer exist: {missing}"
    uncovered = _editor_uncovered(patterns)
    assert not uncovered, (
        "The editor: path filter does not schedule the macOS editor lane for files "
        f"it builds or reads; grow the filter to cover: {uncovered}"
    )


def test_negative_control_the_editor_check_names_a_dropped_input() -> None:
    patterns = _filter_patterns("editor")
    assert not _editor_uncovered(patterns)
    # One input reached through a read and a directory reached through imports.
    for dropped, reported in (
        ("hushh-webapp/app/globals.css", "hushh-webapp/app/globals.css"),
        (
            "hushh-webapp/components/agent/agent-connections-drawer.tsx",
            "hushh-webapp/components/agent/agent-connections-drawer.tsx",
        ),
        ("hushh-webapp/lib/morphy-ux/**", "hushh-webapp/lib/morphy-ux/"),
    ):
        assert dropped in patterns, f"pick another negative control; {dropped} left the filter"
        uncovered = _editor_uncovered([p for p in patterns if p != dropped])
        assert any(path.startswith(reported) for path in uncovered), (dropped, uncovered)


def test_editor_nightly_runs_the_pr_lane_steps_on_main() -> None:
    ci = _load_workflow(MONO_WORKFLOW_PATH)
    nightly = _load_workflow(NIGHTLY_WORKFLOW_PATH)
    triggers = nightly.get("on") or nightly.get(True)  # PyYAML reads `on:` as True
    assert triggers.get("schedule"), "the nightly backstop has no schedule"
    lane = ci["jobs"][EDITOR_JOB]
    runs = [job for job in nightly["jobs"].values() if job.get("runs-on") == lane["runs-on"]]
    assert len(runs) == 1, f"exactly one nightly job must run on {lane['runs-on']}"
    assert nightly["env"]["NODE_VERSION"] == ci["env"]["NODE_VERSION"]

    def comparable(steps: list[dict], *, pinned_ref: str | None) -> list[tuple]:
        result = []
        for step in steps:
            if step.get("id") in {"document-python", "document-postgres", "document-webkit"}:
                continue
            if step.get("id") == "tested" and pinned_ref:
                continue  # the nightly records the commit for its issue
            settings = dict(step.get("with") or {})
            if str(step.get("uses") or "").startswith("actions/checkout"):
                assert settings.pop("ref", None) == pinned_ref
            uses, run, cwd = step.get("uses"), step.get("run"), step.get("working-directory")
            result.append((uses, run, cwd, sorted(settings.items())))
        return result

    assert comparable(runs[0]["steps"], pinned_ref="main") == comparable(
        lane["steps"], pinned_ref=None
    )
