#!/usr/bin/env python3
"""Check focused CI roles and preserve explicit local diagnostic commands.

Hosted CI has an unsharded ``node`` targeted job, one
affected unit-contract job, and two database jobs for backend changes. The
node/browser selector remains a disjoint partition of selected packs; unknown
browser selection stays conservative. Safari layout and web performance remain
developer-local diagnostics, while native lanes run for native surfaces.

Historical Playwright shard collection and full-suite shard verification remain
available only as explicit local diagnostics. ``--collect-browser-shards`` uses
Playwright ``--list`` and never starts a browser or runs test hooks.
"""

from __future__ import annotations

import json
import os
import re
import runpy
import shlex
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

from web_ci_lane_fixture import (
    ROOT,
    _bash,
    test_browser_plan_skips_only_known_no_browser_selection,
    test_browser_plan_unknown_full_scope_and_missing_metadata_fail_closed,
    _run,
    test_layout_overlap_retains_selected_coverage_and_failure_propagation,
    verify_connections_collection,
    verify_overlap_collection,
)
from web_lane_topology_contract import assert_web_lane_topology

WORKFLOW = ROOT / ".github/workflows/ci.yml"
TARGETED = ROOT / "scripts/ci/web-targeted-check.sh"
FULL_SUITE = ROOT / "scripts/ci/web-full-suite-check.sh"
PACKAGE_JSON = ROOT / "hushh-webapp/package.json"
BROWSER_CORE = runpy.run_path(str(ROOT / "scripts/ci/web-browser-core.py"))


def test_presentation_filter_preserves_interaction_and_lifecycle_cases() -> None:
    presentation = re.compile(BROWSER_CORE["PRESENTATION"])
    for name in ("@presentation Calendar account portraits and fallback initials",
                 "explicit Feed typography survives outside the page shell",
                 "Reset icon colors only its arrowhead and keeps native geometry in the account pane",
                 "shows four distinct activity portraits while animations load at 390px",
                 "retains painted artwork through delayed loads and interrupted transitions",
                 "keeps brief activities perceptible in both locations and recovers from an animation load failure",
                 "keeps header and profile presence in sync through all four native Rive states",
                 "One profile keeps its header and tabs stationary while switching at 390px"):
        assert presentation.search(name), name
    for name in ("keeps hover, press and tap clear",
                 "keeps HD reduced-motion artwork and pauses rendering for app lifecycle changes",
                 "History preserves full long titles at 320px",
                 "cancelling the Calendar card while Google is open ends quietly and ignores the late callback"):
        assert not presentation.search(name), name


def _one_matching_file_per_pack() -> str:
    """A changed-file list that schedules every pack whose paths exist today."""

    tracked = subprocess.run(
        ["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=True
    ).stdout.splitlines()
    patterns = re.findall(r"has_match '([^']+)'", TARGETED.read_text(encoding="utf-8"))
    assert patterns, "web-targeted-check.sh has no has_match packs"
    chosen: list[str] = []
    for pattern in patterns:
        # Mermaid rendering is a direct browser command, outside run_check's
        # npm packs. Exercise its leg separately below without Chromium here.
        if "render-doc-mermaid" in pattern:
            continue
        regex = re.compile(pattern)
        hit = next((path for path in tracked if regex.search(path)), None)
        if hit is not None:
            chosen.append(hit)
    return "\n".join(sorted(set(chosen)))


def test_build_exports_explicit_and_default_backend_origins() -> None:
    names = ("BACKEND_URL", "PYTHON_API_URL", "DEVELOPER_API_URL", "NEXT_PUBLIC_BACKEND_URL",
             "NEXT_PUBLIC_DEVELOPER_API_URL")
    cases = (
        ({}, ["https://api.example.com"] * len(names)),
        (
            {"BACKEND_URL": "https://backend.example.com", "PYTHON_API_URL": "https://python.example.com",
             "DEVELOPER_API_URL": "https://developer.example.com"},
            ["https://backend.example.com", "https://python.example.com",
             "https://developer.example.com", "https://backend.example.com",
             "https://developer.example.com"],
        ),
        (
            dict(zip(names, (f"https://override-{index}.example.com" for index in range(len(names))))),
            [f"https://override-{index}.example.com" for index in range(len(names))],
        ),
    )
    with tempfile.TemporaryDirectory() as tmp:
        stub_dir = Path(tmp) / "bin"
        stub_dir.mkdir()
        npm = stub_dir / "npm"
        npm.write_text(
            "#!/usr/bin/env bash\n"
            'test "$*" = "run build" || exit 2\n'
            'printf "%s\\n" "${BACKEND_URL-}" "${PYTHON_API_URL-}" '
            '"${DEVELOPER_API_URL-}" "${NEXT_PUBLIC_BACKEND_URL-}" '
            '"${NEXT_PUBLIC_DEVELOPER_API_URL-}" > "$NPM_STUB_LOG"\n',
            encoding="utf-8",
        )
        npm.chmod(npm.stat().st_mode | stat.S_IEXEC)
        log = Path(tmp) / "build-origins.log"
        for overrides, expected in cases:
            env = dict(os.environ)
            for name in names:
                env.pop(name, None)
            env.update({"PATH": f"{stub_dir}{os.pathsep}{env['PATH']}", "NPM_STUB_LOG": str(log)})
            env.update(overrides)
            proc = subprocess.run(
                [_bash(), "-c", "source scripts/ci/web-common.sh; web_ci_build"],
                cwd=ROOT, env=env, capture_output=True, text=True, timeout=15,
            )
            assert proc.returncode == 0, proc.stderr
            assert log.read_text(encoding="utf-8").splitlines() == expected


def _reaches_playwright(script: str, scripts: dict[str, str], seen: set[str]) -> bool:
    if script in seen or script not in scripts:
        return False
    seen.add(script)
    body = scripts[script]
    if re.search(r"\bplaywright\b", body):
        return True
    return any(
        _reaches_playwright(ref, scripts, seen)
        for ref in re.findall(r"npm run ([\w:.-]+)", body)
    )


def test_targeted_legs_partition_the_matched_packs() -> None:
    changed = _one_matching_file_per_pack()
    runs: dict[str, list[str]] = {}
    for part in ("all", "node", "browser"):
        code, calls, output = _run(
            TARGETED, {"WEB_TARGETED_PART": part, "WEB_TARGETED_CHANGED_FILES": changed,
                       "WEB_TARGETED_FULL_SUITE_OWNED": "0"}
        )
        assert code == 0, (
            f"web-targeted-check.sh ({part}) exited {code}:\n{output[-2000:]}"
        )
        runs[part] = calls

    all_calls, node, browser = runs["all"], runs["node"], runs["browser"]
    assert node and browser, "the fixture must schedule packs in both legs"
    assert not set(node) & set(browser), (
        f"packs ran in both legs: {set(node) & set(browser)}"
    )
    assert sorted(node + browser) == sorted(all_calls), (
        "the node and browser legs together must run exactly what `all` runs"
    )

    scripts = json.loads(PACKAGE_JSON.read_text(encoding="utf-8"))["scripts"]
    for call in browser:
        name = call.split()[1]
        assert _reaches_playwright(name, scripts, set()), (
            f"{name} ran in the browser leg"
        )
    for call in node:
        name = call.split()[1]
        assert not _reaches_playwright(name, scripts, set()), f"{name} needs a browser"

    static_commands = {
        f"run {name}" for name in (
            "verify:voice-gateway", "verify:capability-graph",
            "verify:surface-map", "verify:capacitor:plugins",
        )
    }
    assert static_commands <= set(node), "fixture must exercise every static owner"
    code, owned, output = _run(TARGETED, {
        "WEB_TARGETED_PART": "node", "WEB_TARGETED_CHANGED_FILES": changed,
        "WEB_TARGETED_FULL_SUITE_OWNED": "static",
    })
    assert code == 0, output[-2000:]
    assert owned == [call for call in node if call not in static_commands]
    # A local or unfamiliar caller retains every static and functional check.
    for ownership in ("0", "unknown"):
        code, retained, output = _run(TARGETED, {
            "WEB_TARGETED_PART": "node", "WEB_TARGETED_CHANGED_FILES": changed,
            "WEB_TARGETED_FULL_SUITE_OWNED": ownership,
        })
        assert code == 0, output[-2000:]
        assert retained == node

    # Extra arguments change a verifier's contract and must not inherit reuse.
    with tempfile.TemporaryDirectory() as temporary:
        script = Path(temporary) / "targeted.sh"
        script.write_text(TARGETED.read_text().replace(
            'run_full_suite_check "workflow catalog compiler" npm run verify:capability-graph',
            'run_full_suite_check "workflow catalog compiler" npm run verify:capability-graph --changed',
        ))
        code, calls, output = _run(script, {
            "WEB_TARGETED_PART": "node",
            "WEB_TARGETED_CHANGED_FILES": "hushh-webapp/lib/generated/one-location-workflow-card-catalog.v1.ts",
            "WEB_TARGETED_FULL_SUITE_OWNED": "static",
        })
        assert code == 0, output[-2000:]
        assert "run verify:capability-graph --changed" in calls

    # Hosted Vitest replaces only its own cases, never the Node-only remainder.
    analytics = "hushh-webapp/lib/observability/schema.ts"
    remainder = ["scripts/observability/verify-android-scope.mjs",
                 "scripts/testing/analytics-smoke-failure.test.mjs"]
    for part, expected in (("all", remainder), ("node", remainder), ("browser", [])):
        code, calls, output = _run(TARGETED, {
            "WEB_TARGETED_PART": part, "WEB_TARGETED_CHANGED_FILES": analytics,
            "WEB_TARGETED_FULL_SUITE_OWNED": "1",
        })
        assert code == 0, output[-2000:]
        assert calls == expected, (part, calls)


def test_targeted_pack_stops_after_interruption() -> None:
    code, calls, output = _run(TARGETED, {
        "WEB_TARGETED_CHANGED_FILES": "hushh-webapp/app/globals.css",
        "WEB_TARGETED_PART": "browser",
        "NPM_STUB_FAIL": "test:layout-contracts",
        "NPM_STUB_EXIT": "130",
    })
    assert code == 130, output
    assert calls[-1] == "run test:layout-contracts", calls


def test_browser_commands_report_all_failures_but_stop_on_cancellation() -> None:
    from unittest.mock import patch
    from types import SimpleNamespace

    selected = [["first"], ["second"], ["third"]]
    execute = BROWSER_CORE["run_selected"]
    with patch.object(subprocess, "run", side_effect=[
        SimpleNamespace(returncode=1), SimpleNamespace(returncode=2),
        SimpleNamespace(returncode=0),
    ]) as runner:
        assert execute(selected, {}) == 1
        assert [call.args[0][-1] for call in runner.call_args_list] == ["first", "second", "third"]
    for status in (-15, 130, 143, 124):
        with patch.object(subprocess, "run", return_value=SimpleNamespace(returncode=status)) as runner:
            assert execute(selected, {}) >= 124
            assert runner.call_count == 1


def test_functional_browser_plans_keep_chromium_from_multi_project_packs() -> None:
    scripts = json.loads(PACKAGE_JSON.read_text(encoding="utf-8"))["scripts"]
    plan = BROWSER_CORE["plan"]
    expected_specs = {
        "test:account-session:browser": "e2e/account-session-recovery.spec.ts",
        "test:drive-sharing-layout": "e2e/document-share-review.layout.spec.ts",
        "test:connections-layout": "e2e/connections-drawer.layout.spec.ts",
        "test:connections-layout:without-covered": "e2e/connections-drawer.layout.spec.ts",
        "test:one-voice-panel-layout": "e2e/one-voice-panel.layout.spec.ts",
        "test:one-voice-mail-open-layout": "e2e/one-voice-mail-open.layout.spec.ts",
        "test:calendar-workspace-layout": "e2e/calendar-connected-workspace.layout.spec.ts",
        "test:agent-surface-layout": "e2e/agent-surface-model-authority.layout.spec.ts",
    }
    for script, expected_spec in expected_specs.items():
        rows = plan(script, scripts, [])
        chromium = [row for row in rows if "--project=chromium" in row]
        assert chromium, f"{script} lost its functional Chromium pack"
        assert any(expected_spec in row for row in chromium), (script, expected_spec)
        assert not any("--project=webkit" in row for row in rows), script
        if script == "test:account-session:browser":
            assert any("--project=mobile-chrome" in row for row in rows)


def test_functional_browser_plan_accumulates_project_syntax_and_fails_closed() -> None:
    plan = BROWSER_CORE["plan"]
    spec = "e2e/agent-markdown.layout.spec.ts"
    scripts = {
        "synthetic": (
            f"CI=1 playwright test {spec} {spec} --project=chromium --project webkit "
            "--project=mobile-chrome --project chromium --workers=1 "
            "--grep-invert 'One profile artwork and animated presence'"
        )
    }
    rows = plan("synthetic", scripts, [])
    projects = [next(token for token in row if token.startswith("--project=")) for row in rows]
    assert projects == ["--project=chromium", "--project=mobile-chrome"]
    for row in rows:
        assert row.count(spec) == 1 and "--workers=1" in row
        assert "--grep-invert" in row
        assert "One profile artwork and animated presence" in row[-1]
        assert "100 KB paste" in row[-1]

    invalid = (
        (
            "unknown",
            f"playwright test {spec} --project=chromium --project=unknown",
            "Unrecognized browser project",
        ),
        (
            "missing",
            "playwright test e2e/missing-contract.spec.ts --project=chromium",
            "Unresolved browser contract",
        ),
    )
    for script, body, expected_error in invalid:
        try:
            plan(script, {script: body}, [])
        except ValueError as error:
            assert expected_error in str(error), (expected_error, error)
        else:
            raise AssertionError(f"invalid browser plan {script!r} was accepted")


def test_agent_surface_layout_runs_once_without_losing_the_focused_gate() -> None:
    scripts = json.loads(PACKAGE_JSON.read_text(encoding="utf-8"))["scripts"]
    spec = "e2e/agent-surface-model-authority.layout.spec.ts"
    broad_commands = [
        command
        for command in scripts["test:layout-contracts"].split("&&")
        if "playwright test" in command
    ]
    for project in ("chromium", "webkit"):
        commands = [
            command for command in broad_commands if f"--project={project}" in command
        ]
        assert len(commands) == 1 and spec in commands[0], (
            f"the broader layout pack must retain the agent spec on {project}"
        )

    agent_only = "hushh-webapp/components/agent/agent-chat-workspace.tsx"
    for changed, broad_required in (
        (agent_only, False),
        (agent_only + "\n" + "hushh-webapp/" + spec, True),
    ):
        code, calls, output = _run(
            TARGETED,
            {"WEB_TARGETED_PART": "browser", "WEB_TARGETED_CHANGED_FILES": changed},
        )
        assert code == 0, output[-2000:]
        assert calls.count("run test:layout-contracts") == int(broad_required)
        assert calls.count("run test:agent-surface-layout") == int(not broad_required)


def test_targeted_rejects_an_unknown_part() -> None:
    code, calls, _ = _run(TARGETED, {"WEB_TARGETED_PART": "chromium"})
    assert code == 2 and not calls


def test_node_leg_leaves_diagram_rendering_to_browser_leg() -> None:
    code, calls, output = _run(
        TARGETED,
        {"WEB_TARGETED_PART": "node", "WEB_TARGETED_CHANGED_FILES": "docs/README.md"},
    )
    assert code == 0, output[-2000:]
    assert not calls and "Rendered " not in output
    for index in (1, 2, 3, 4):
        code, calls, output = _run(
            TARGETED,
            {"WEB_TARGETED_PART": "browser", "WEB_TARGETED_CHANGED_FILES": "docs/README.md", "PLAYWRIGHT_SHARD": f"{index}/4"},
            stub_diagrams=True,
        )
        assert code == 0, output[-2000:]
        assert calls == (["scripts/verify-doc-diagrams.cjs", "scripts/render-doc-mermaid.mjs"] if index == 1 else [])


def test_paid_answer_photo_inputs_schedule_browser_pack() -> None:
    # Drive the selector, including fixture-only and crypto-only changes that
    # previously had no browser proof. Merely naming a spec is insufficient:
    # the explicit pack must include it in both shipped-browser runs.
    for changed in (
        "hushh-webapp/components/consent/answer-request-card.tsx",
        "hushh-webapp/components/ui/avatar.tsx",
        "hushh-webapp/lib/answers/answer-profile-photo.ts",
        "hushh-webapp/lib/one-marketplace/encryption.ts",
        "hushh-webapp/lib/services/answer-request-service.ts",
        "hushh-webapp/lib/vault/session-epoch.ts",
        "hushh-webapp/e2e/fixtures/answer-profile-photo-boundaries.tsx",
    ):
        code, calls, output = _run(
            TARGETED,
            {"WEB_TARGETED_PART": "browser", "WEB_TARGETED_CHANGED_FILES": changed},
        )
        assert code == 0, output[-2000:]
        assert calls.count("run test:layout-contracts") == 1, (changed, calls)
    scripts = json.loads(PACKAGE_JSON.read_text(encoding="utf-8"))["scripts"]
    pack = scripts["test:layout-contracts"]
    spec = "e2e/answer-profile-photo.layout.spec.ts"
    assert pack.count(spec) == 2
    assert f"{spec}" in pack.split("--project=chromium")[0]
    assert f"{spec}" in pack.split("--project=chromium")[1].split("--project=webkit")[0]


def test_profile_and_shortcut_inputs_schedule_connections_browser_pack() -> None:
    for changed in (
        "hushh-webapp/components/profile/profile-workspace-page.tsx",
        "hushh-webapp/components/ui/alert-dialog.tsx",
        "hushh-webapp/components/ui/sheet.tsx",
        "hushh-webapp/components/icons/ui/shortcut-action-icons.tsx",
        "hushh-webapp/components/icons/ui/shortcut-icon-motion.module.css",
        "hushh-webapp/lib/navigation/web-history-back.ts",
        "hushh-webapp/lib/connections/person-profile-preview.ts",
        "hushh-webapp/lib/navigation/profile-pane.ts",
        "hushh-webapp/lib/morphy-ux/hooks/use-shortcut-icon-motion.ts",
        "hushh-webapp/app/globals.css",
        "hushh-webapp/e2e/profile-confirmation-back.spec.ts",
        "hushh-webapp/e2e/shortcut-icons.motion.spec.ts",
        "hushh-webapp/e2e/fixtures/profile-confirmation-back.tsx",
        "hushh-webapp/e2e/fixtures/shortcut-icon-motion.tsx",
        "hushh-webapp/components/connections/person-profile-page.tsx",
        "hushh-webapp/components/connections/person-profile-page.module.css",
        "hushh-webapp/components/connections/person-profile-hero.tsx",
        "hushh-webapp/e2e/person-profile-actions.layout.spec.ts",
        "hushh-webapp/e2e/person-profile-preview.layout.spec.ts",
        "hushh-webapp/e2e/fixtures/person-profile.tsx",
        "hushh-webapp/e2e/fixtures/person-profile-requests.tsx",
        "hushh-webapp/e2e/fixtures/person-profile-request-ports.tsx",
        "hushh-webapp/e2e/fixtures/person-profile-preview.tsx",
        "hushh-webapp/e2e/fixtures/person-profile-preview-ports.tsx",
        "hushh-webapp/components/app-ui/illustrated-request-dialog.tsx",
        "hushh-webapp/components/app-ui/illustrated-request-dialog.module.css",
        "hushh-webapp/components/consent/document-file-request.tsx",
        "hushh-webapp/components/consent/document-request-button.tsx",
        "hushh-webapp/components/consent/request-scope-button.tsx",
        "hushh-webapp/components/wallet/request-cards-button.tsx",
    ):
        code, calls, output = _run(
            TARGETED,
            {"WEB_TARGETED_PART": "browser", "WEB_TARGETED_CHANGED_FILES": changed},
        )
        assert code == 0, output[-2000:]
        overlap_owner = "run test:drive-sharing-layout" in calls
        expected = "run test:connections-layout:without-covered" if overlap_owner else "run test:connections-layout"
        assert calls.count(expected) == 1, (changed, calls)
        if "person-profile-preview" in changed:
            assert "run test:connections-web" not in calls, (changed, calls)
            node_code, node_calls, node_output = _run(
                TARGETED,
                {"WEB_TARGETED_PART": "node", "WEB_TARGETED_CHANGED_FILES": changed},
            )
            assert node_code == 0, node_output[-2000:]
            assert node_calls.count("run test:connections-web") == 1, (changed, node_calls)
            assert not any("connections-layout" in call for call in node_calls), (changed, node_calls)
    scripts = json.loads(PACKAGE_JSON.read_text(encoding="utf-8"))["scripts"]
    pack = scripts["test:connections-layout"]
    for spec in ("e2e/profile-confirmation-back.spec.ts", "e2e/shortcut-icons.motion.spec.ts", "e2e/person-profile-actions.layout.spec.ts"):
        assert pack.count(spec) == 1
        assert spec in pack.split("--project=chromium")[0]
    assert "--project=chromium --project=webkit" in pack


def test_full_suite_shards_run_verifiers_once() -> None:
    code, unsharded, output = _run(FULL_SUITE, {"WEB_FULL_SUITE_SHARD": ""})
    assert code == 0, output[-2000:]
    verifiers = [call for call in unsharded if not call.startswith("run test:ci")]
    assert unsharded == [*verifiers, "run test:ci -- --maxWorkers=2"] and verifiers
    scripts = json.loads(PACKAGE_JSON.read_text(encoding="utf-8"))["scripts"]

    def siri_calls(name):
        body = scripts[name]
        return int("scripts/native/verify-siri-action-contract.mjs" in body) + sum(
            siri_calls(child) for child in re.findall(r"npm run ([\w:.-]+)", body)
        )

    assert sum(siri_calls(call.split()[1]) for call in verifiers if call.startswith("run ")) == 1
    assert verifiers.count("scripts/native/verify-native-static-parity.mjs") == 1
    assert siri_calls("verify:capacitor:static") == 1  # focused command stays complete

    shard_calls: list[list[str]] = []
    for index in (1, 2, 3):
        code, calls, output = _run(FULL_SUITE, {"WEB_FULL_SUITE_SHARD": f"{index}/3"})
        assert code == 0, output[-2000:]
        assert calls[-1] == f"run test:ci -- --shard={index}/3 --maxWorkers=2", calls
        shard_calls.append(calls[:-1])
    assert shard_calls[0] == verifiers, "shard 1 must run every contract verifier"
    assert shard_calls[1] == [] and shard_calls[2] == [], (
        "only shard 1 runs the verifiers"
    )

    for bad in ("0/3", "4/3", "1/0", "a/b", "1", "1/3/3"):
        code, calls, _ = _run(FULL_SUITE, {"WEB_FULL_SUITE_SHARD": bad})
        assert code == 2 and not calls, f"shard spec {bad!r} was accepted"


def test_unit_lane_reports_independent_failures_and_stops_on_interruption() -> None:
    for status in (23, 124, 130):
        code, calls, output = _run(FULL_SUITE, {
            "NPM_STUB_FAIL": "verify:voice-gateway", "NPM_STUB_EXIT": str(status),
        })
        assert code == (1 if status == 23 else status), output[-2000:]
        if status == 23:
            assert "run verify:capability-graph" in calls, calls
            assert "run test:ci -- --maxWorkers=2" in calls, calls
            assert "Voice gateway (exit 23)" in output, output[-2000:]
        else:
            assert calls == ["run verify:voice-gateway"], calls


def test_full_suite_bootstraps_parser_before_plan_and_skips_when_available() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        stub_dir = Path(tmp) / "bin"
        stub_dir.mkdir()
        log = Path(tmp) / "bootstrap.log"
        node = stub_dir / "node"
        node.write_text(
            "#!/usr/bin/env bash\nset -eu\n"
            'if [ "${1:-}" = "-e" ]; then\n'
            '  case "${2:-}" in\n'
            '    *ui-source-index.mjs*) echo "parser-probe:$PWD" >> "$BOOTSTRAP_LOG"; '
            '      [ "$PARSER_AVAILABLE" = "1" ];;\n'
            '    *effectiveLevel*) echo "effective-level:$PWD" >> "$BOOTSTRAP_LOG"; '
            '      printf focused;;\n'
            '    *) echo "unexpected-node-eval:$2" >&2; exit 91;;\n'
            '  esac\n'
            'elif [[ "${1:-}" == */affected-tests.mjs && "${2:-}" == plan ]]; then\n'
            '  echo "plan:$PWD" >> "$BOOTSTRAP_LOG"\n'
            '  printf \'{"effectiveLevel":"focused"}\\n\'\n'
            'else echo "unexpected-node-call:$*" >&2; exit 92; fi\n',
            encoding="utf-8",
        )
        node.chmod(node.stat().st_mode | stat.S_IEXEC)
        npm = stub_dir / "npm"
        npm.write_text(
            "#!/usr/bin/env bash\nset -eu\n"
            'echo "npm:$PWD:$*" >> "$BOOTSTRAP_LOG"\n',
            encoding="utf-8",
        )
        npm.chmod(npm.stat().st_mode | stat.S_IEXEC)

        tools_dir = ROOT / "hushh-webapp/scripts/architecture/ui-contract-tools"
        expected = {
            "available": ["parser-probe", "plan", "effective-level"],
            "missing": ["parser-probe", "npm", "plan", "effective-level"],
        }
        for parser_state, events in expected.items():
            log.unlink(missing_ok=True)
            env = dict(os.environ)
            env.update({
                "PATH": f"{stub_dir}{os.pathsep}{env['PATH']}",
                "BOOTSTRAP_LOG": str(log),
                "PARSER_AVAILABLE": "1" if parser_state == "available" else "0",
                "CI_VALIDATION_LEVEL": "focused",
                "WEB_FULL_SUITE_SHARD": "2/3",
            })
            proc = subprocess.run(
                [_bash(), str(FULL_SUITE)], cwd=ROOT, env=env,
                capture_output=True, text=True, check=False, timeout=15,
            )
            assert proc.returncode == 0, proc.stderr[-2000:]
            observed = log.read_text(encoding="utf-8").splitlines()
            assert [line.split(":", 1)[0] for line in observed] == events, observed
            assert observed[0] == f"parser-probe:{ROOT / 'hushh-webapp'}"
            assert observed[-2] == f"plan:{ROOT}", observed
            assert observed[-1] == f"effective-level:{ROOT}", observed
            if parser_state == "missing":
                assert observed[1] == f"npm:{tools_dir}:ci --ignore-scripts --no-audit --progress=false"
            assert "shard 2/3 is not scheduled for affected tests" in proc.stdout


def test_workflow_schedules_focused_jobs_and_database_pair() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")
    scripts = json.loads(PACKAGE_JSON.read_text(encoding="utf-8"))["scripts"]
    playwright = (ROOT / "hushh-webapp/playwright.config.ts").read_text(encoding="utf-8")
    assert_web_lane_topology(workflow, scripts, playwright)
    governance = re.search(
        r"(?ms)^  repo-governance:\n(.*?)(?=^  [a-z][a-z0-9_-]*:\n)", workflow
    )
    assert governance, "the parser bootstrap must belong to the governance job"
    parser_install = governance[1].find("- name: Install UI contract parser for governance")
    governance_checks = governance[1].find("- name: Run repo governance checks")
    assert 0 <= parser_install < governance_checks, (
        "install the isolated parser before the affected-tests Node owner runs"
    )
    assert "working-directory: hushh-webapp/scripts/architecture/ui-contract-tools" in governance[1]
    assert "run: npm ci --ignore-scripts --no-audit --progress=false" in governance[1]
    # Ordinary validation has no browser installation or artifact-producing job.
    # Keep the negative control focused on a real aggregate/selection boundary.
    broken = workflow.replace("WEB_TARGETED_PART: node", "WEB_TARGETED_PART: all")
    assert broken != workflow
    try:
        assert_web_lane_topology(broken, scripts, playwright)
    except AssertionError:
        pass
    else:
        raise AssertionError("required Node lane accepted automatic browser execution")


def test_browser_shard_setting_is_validated_before_any_pack() -> None:
    gene = ROOT / "hushh-webapp/scripts/testing/playwright-shard.cjs"
    for shard, primary in (("", "1"), ("1/4", "1"), ("2/4", "0"), ("3/4", "0"), ("4/4", "0")):
        result = subprocess.run(
            ["node", str(gene)],
            env={**os.environ, "PLAYWRIGHT_SHARD": shard},
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0 and result.stdout.strip() == primary
    for bad in ("0/3", "4/3", "1/0", "a/b", "1", "1/3/3", "1/9007199254740992"):
        code, calls, _ = _run(
            TARGETED, {"PLAYWRIGHT_SHARD": bad, "WEB_TARGETED_PART": "browser"}
        )
        assert code != 0 and not calls, f"invalid browser shard {bad!r} ran a pack"
def collect_browser_shards() -> None:
    """Optional native collection proof; normal governance needs no web install."""
    scripts = json.loads(PACKAGE_JSON.read_text(encoding="utf-8"))["scripts"]
    changed = os.environ.get("WEB_TARGETED_CHANGED_FILES")
    if not changed:
        # Include the branch and working tree, even while another lane is editing.
        changed = subprocess.run(
            ["git", "diff", "--name-only", "origin/main...HEAD"],
            cwd=ROOT, capture_output=True, text=True, check=True,
        ).stdout + subprocess.run(
            ["git", "diff", "--name-only", "HEAD"],
            cwd=ROOT, capture_output=True, text=True, check=True,
        ).stdout
    code, calls, output = _run(
        TARGETED, {"WEB_TARGETED_PART": "browser", "WEB_TARGETED_CHANGED_FILES": changed}, stub_diagrams=True
    )
    assert code == 0 and calls, output[-2000:]

    def commands(name: str, inherited: dict[str, str], stack: tuple[str, ...] = ()):
        assert name not in stack, f"recursive npm script: {name}"
        for segment in scripts[name].split(" && "):
            argv = shlex.split(segment)
            env = dict(inherited)
            if argv and argv[0] == "cross-env":
                argv.pop(0)
            while argv and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", argv[0]):
                key, value = argv.pop(0).split("=", 1)
                env[key] = value
            if argv[:2] == ["npm", "run"]:
                assert len(argv) == 3, f"unsupported npm forwarding: {segment}"
                yield from commands(argv[2], env, (*stack, name))
            elif argv[:2] == ["playwright", "test"]:
                yield argv[1:], env
            else:
                assert "playwright" not in argv, f"unhandled Playwright command: {segment}"

    web = PACKAGE_JSON.parent
    cli = web / "node_modules/@playwright/test/cli.js"
    assert cli.is_file(), "install web dependencies before native collection"

    def collect(argv: list[str], overrides: dict[str, str], shard: str | None):
        env = dict(os.environ)
        env.update(overrides)
        env.pop("PLAYWRIGHT_SHARD", None)
        env.pop("PLAYWRIGHT_JSON_OUTPUT_FILE", None)
        env.pop("PLAYWRIGHT_JSON_OUTPUT_NAME", None)
        env.pop("PLAYWRIGHT_JSON_OUTPUT_DIR", None)
        if shard is not None:
            env["PLAYWRIGHT_SHARD"] = shard
        proc = subprocess.run(
            ["node", str(cli), *argv, "--list", "--reporter=json"],
            cwd=web, env=env, capture_output=True, text=True, timeout=60,
        )
        return proc

    def identities(proc, shard: str | None) -> set[tuple[str, str, str]]:
        assert proc.returncode == 0, proc.stderr[-2000:] + proc.stdout[-2000:]
        report = json.loads(proc.stdout)
        assert not report["errors"], report["errors"]
        expected = dict(zip(("current", "total"), map(int, shard.split("/")))) if shard else None
        assert report["config"]["shard"] == expected
        found: list[tuple[str, str, str]] = []

        def visit(suite):
            for spec in suite.get("specs", []):
                for test in spec["tests"]:
                    assert test["results"] == [], "collection must not execute tests"
                    found.append((spec["id"], test["projectName"], test["expectedStatus"]))
            for child in suite.get("suites", []):
                visit(child)

        for suite in report["suites"]:
            visit(suite)
        assert len(found) == len(set(found)), "duplicate collected test identities"
        return set(found)

    proof = []
    linux_identities: set[tuple[str, str, str]] = set()
    first_command = None
    for call in calls:
        if not call.startswith("run "):
            assert call in {"scripts/verify-doc-diagrams.cjs", "scripts/render-doc-mermaid.mjs"}, f"unexpected direct command: {call}"
            continue
        pack = call.split()[1]
        selected = list(commands(pack, {}))
        assert selected, f"no native browser command extracted from {pack}"
        for argv, env in selected:
            first_command = first_command or (argv, env)
            baseline = identities(collect(argv, env, None), None)
            linux_identities.update(baseline)
            shards = [
                identities(collect(argv, env, f"{index}/4"), f"{index}/4")
                for index in (1, 2, 3, 4)
            ]
            assert baseline, f"empty baseline: {pack} {argv}"
            assert sum(map(len, shards)) == len(set().union(*shards)), f"overlapping shards: {pack} {argv}"
            assert set().union(*shards) == baseline, f"missing or added tests: {pack} {argv}"
            proof.append({"pack": pack, "argv": argv, "unsharded": len(baseline),
                          "shards": [len(shard) for shard in shards]})

    timing = set().union(*(
        identities(collect(argv, env, None), None)
        for argv, env in commands("test:layout-editor-performance", {})
    ))
    history = identities(collect([
        "test", "e2e/history-motion.layout.spec.ts",
        "--project=chromium", "--project=webkit",
    ], {"CI": "1"}, None), None)
    assert len(history) == 2 and {item[1] for item in history} == {"chromium", "webkit"}
    assert history <= timing, "both unchanged History timing tests must reach macOS"
    assert history.isdisjoint(linux_identities), "do not duplicate timing tests in Linux"
    verify_connections_collection(calls, linux_identities, identities, collect)

    verify_overlap_collection(calls, linux_identities, identities, collect, commands)

    assert first_command is not None
    argv, env = first_command
    baseline = identities(collect(argv, env, None), None)
    for valid in ("", "1/1"):
        assert identities(collect(argv, env, valid), valid) == baseline
    invalid = ("0/3", "4/3", "1/0", "a/b", "1", "1/3/3", "01/3", "1/3.5",
               " 1/3", "1/3 ", "1/9007199254740992")
    for bad in invalid:
        proc = collect(argv, env, bad)
        assert proc.returncode != 0 and "PLAYWRIGHT_SHARD must be current/total" in proc.stderr, bad
    print(json.dumps({"native_browser_collection": proof, "invalid_shards_rejected": list(invalid),
                      "motion_timing_projects": sorted(item[1] for item in history),
                      "browser_launches": 0, "partition": "complete and disjoint"}, indent=2))


def main() -> int:
    tests = (
        test_presentation_filter_preserves_interaction_and_lifecycle_cases,
        test_build_exports_explicit_and_default_backend_origins,
        test_targeted_legs_partition_the_matched_packs,
        test_functional_browser_plans_keep_chromium_from_multi_project_packs,
        test_browser_commands_report_all_failures_but_stop_on_cancellation,
        test_targeted_pack_stops_after_interruption,
        test_functional_browser_plan_accumulates_project_syntax_and_fails_closed,
        test_browser_plan_skips_only_known_no_browser_selection,
        test_browser_plan_unknown_full_scope_and_missing_metadata_fail_closed,
        test_agent_surface_layout_runs_once_without_losing_the_focused_gate,
        test_targeted_rejects_an_unknown_part,
        test_node_leg_leaves_diagram_rendering_to_browser_leg,
        test_paid_answer_photo_inputs_schedule_browser_pack,
        test_profile_and_shortcut_inputs_schedule_connections_browser_pack,
        test_layout_overlap_retains_selected_coverage_and_failure_propagation,
        test_full_suite_shards_run_verifiers_once,
        test_unit_lane_reports_independent_failures_and_stops_on_interruption,
        test_full_suite_bootstraps_parser_before_plan_and_skips_when_available,
        test_workflow_schedules_focused_jobs_and_database_pair,
        test_browser_shard_setting_is_validated_before_any_pack,
    )
    for test in tests:
        test()
        print(f"ok {test.__name__}")
    if sys.argv[1:] == ["--collect-browser-shards"]:
        collect_browser_shards()
    else:
        assert not sys.argv[1:], "expected no arguments or --collect-browser-shards"
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
