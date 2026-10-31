"""Bounded shell fixtures for the existing CI lane-partition contract.

Stub expensive npm/native invocations while retaining real selector and shell
behavior. Every fixture owns and removes its temporary directory.
"""
from __future__ import annotations

import json
import os
import re
import shlex
import shutil
import stat
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TARGETED = ROOT / "scripts/ci/web-targeted-check.sh"
PACKAGE_JSON = ROOT / "hushh-webapp/package.json"


def _bash() -> str:
    # A Windows WSL shim named bash cannot run this Git Bash contract fixture.
    if os.name == "nt":
        git = shutil.which("git")
        if git:
            directory = Path(git).resolve().parent
            for anchor in (directory, directory.parent, directory.parent.parent):
                for candidate in (anchor / "bash.exe", anchor / "bin/bash.exe"):
                    if candidate.is_file():
                        return str(candidate)
        raise RuntimeError(
            "Git Bash is required to verify web lane partitioning on Windows"
        )
    return "bash"


STUB_NPM = """#!/usr/bin/env bash
if [ "${1:-}" = "run" ]; then
  printf '%s\\n' "$*" >> "$NPM_STUB_LOG"
  if [ -n "${NPM_STUB_FAIL:-}" ] && [ "${2:-}" = "$NPM_STUB_FAIL" ]; then
    exit 23
  fi
fi
exit 0
"""


def _run(script: Path, env_overrides: dict[str, str], *, stub_diagrams: bool = False) -> tuple[int, list[str], str]:
    with tempfile.TemporaryDirectory() as tmp:
        stub_dir = Path(tmp) / "bin"
        stub_dir.mkdir()
        npm = stub_dir / "npm"
        npm.write_text(STUB_NPM, encoding="utf-8")
        npm.chmod(npm.stat().st_mode | stat.S_IEXEC)
        log = Path(tmp) / "npm.log"
        log.touch()
        node = stub_dir / "node"
        real_node = shlex.quote(shutil.which("node") or "node")
        diagrams = (
            '  scripts/verify-doc-diagrams.cjs|scripts/render-doc-mermaid.mjs|./scripts/testing/capture-feed-needs-you-fixture.mjs)\n'
            '    printf "%s\\n" "$1" >> "$NPM_STUB_LOG"; exit 0;;\n'
            if stub_diagrams else ""
        )
        node.write_text(
            '#!/usr/bin/env bash\ncase "${1:-}" in\n'
            '  ./scripts/native/verify-native-static-parity.mjs|scripts/observability/verify-android-scope.mjs)\n'
            '    printf "%s\\n" "${1#./}" >> "$NPM_STUB_LOG"; exit 0;;\n'
            '  --test)\n'
            '    if [ "${2:-}" = "scripts/testing/analytics-smoke-failure.test.mjs" ]; then\n'
            '      printf "%s\\n" "$2" >> "$NPM_STUB_LOG"; exit 0; fi;;\n'
            + diagrams + f'esac\nexec {real_node} "$@"\n', encoding="utf-8"
        )
        node.chmod(node.stat().st_mode | stat.S_IEXEC)
        env = dict(os.environ)
        env.update(
            {
                "PATH": f"{stub_dir}{os.pathsep}{env['PATH']}",
                "NPM_STUB_LOG": str(log),
                "NPM_STUB_FAIL": "",
                "WEB_CI_DEPS_INSTALLED": "1",
                "HUSHH_WEB_TEST_MAX_WORKERS": "2",
            }
        )
        env.update(env_overrides)
        proc = subprocess.run(
            [_bash(), str(script)],
            cwd=ROOT,
            env=env,
            capture_output=True,
            text=True,
            check=False,
            timeout=60,
        )
        calls = [line for line in log.read_text(encoding="utf-8").splitlines() if line]
        return proc.returncode, calls, proc.stdout + proc.stderr


def test_layout_overlap_retains_selected_coverage_and_failure_propagation() -> None:
    scripts = json.loads(PACKAGE_JSON.read_text(encoding="utf-8"))["scripts"]
    covered = " e2e/first-connect-insights.layout.spec.ts"
    full = scripts["test:connections-layout"]
    drive = scripts["test:drive-sharing-layout"]
    assert full.count(covered) == 1 and drive.count(covered) == 1
    assert scripts["test:connections-layout:without-covered"] == full.replace(covered, "", 1)
    # Drive must execute the entire spec without a filter in every project that
    # Connections requests. Treat an unfamiliar command shape as a contract
    # change requiring review; filenames alone cannot prove this containment.
    drive_args = shlex.split(drive)
    connection_args = shlex.split(full.split("&&", 1)[0])
    assert drive_args[:3] == connection_args[:3] == ["CI=1", "playwright", "test"]
    assert connection_args.count(covered.strip()) == 1
    assert all(arg.startswith("e2e/") or arg in {"--project=chromium", "--project=webkit"}
               for arg in drive_args[3:])
    assert all(arg.startswith("e2e/") or arg in {
        "--project=chromium", "--project=webkit", "--workers=1", "--grep-invert",
        "One profile artwork and animated presence",
    } for arg in connection_args[3:])
    drive_projects = {arg for arg in drive_args if arg.startswith("--project=")}
    connection_projects = {arg for arg in connection_args if arg.startswith("--project=")}
    assert drive_projects == connection_projects == {"--project=chromium", "--project=webkit"}

    cases = (
        ("hushh-webapp/e2e/first-connect-insights.layout.spec.ts", True, False, False),
        ("hushh-webapp/components/agent/first-connect-insights-card.tsx", False, True, False),
        ("hushh-webapp/components/agent/agent-chat-workspace.tsx", False, False, True),
        ("hushh-webapp/e2e/financial-packets.layout.spec.ts", True, False, True),
        ("hushh-webapp/components/consent/document-file-request.tsx", False, True, True),
        ("hushh-webapp/components/agent/first-connect-insights-card.tsx\n"
         "hushh-webapp/e2e/first-connect-insights.layout.spec.ts", True, True, False),
        ("hushh-webapp/components/consent/document-file-request.tsx\n"
         "hushh-webapp/e2e/first-connect-insights.layout.spec.ts", True, True, True),
    )
    for changed, broad, drive, connections in cases:
        # Other partition tests cover all/node; exercise them here only on the
        # three-pack overlap so every selector combination remains affordable.
        parts = ("all", "browser", "node") if (broad and drive and connections) else ("browser",)
        for part in parts:
            code, calls, output = _run(
                TARGETED, {"WEB_TARGETED_PART": part, "WEB_TARGETED_CHANGED_FILES": changed},
            )
            assert code == 0, output[-2000:]
            selected = part != "node"
            assert calls.count("run test:layout-contracts") == int(selected and broad), (changed, calls)
            assert calls.count("run test:connections-layout:without-covered") == int(selected and connections and drive), (changed, calls)
            assert calls.count("run test:connections-layout") == int(selected and connections and not drive), (changed, calls)
            assert calls.count("run test:drive-sharing-layout") == int(selected and drive), (changed, calls)

    all_three = cases[-1][0]
    for failed in ("test:layout-contracts", "test:drive-sharing-layout",
                   "test:connections-layout:without-covered"):
        code, calls, _ = _run(TARGETED, {
            "WEB_TARGETED_PART": "browser", "WEB_TARGETED_CHANGED_FILES": all_three,
            "NPM_STUB_FAIL": failed,
        })
        assert code != 0 and f"run {failed}" in calls, (failed, calls)
        assert "run test:layout-contracts" in calls, (failed, calls)


def verify_connections_collection(calls, linux_identities, identities, collect) -> None:
    if any(call in {"run test:connections-layout", "run test:connections-layout:without-covered"} for call in calls):
        remaining = identities(collect([
            "test", "e2e/connections-drawer.layout.spec.ts",
            "--project=chromium", "--project=webkit",
        ], {"CI": "1"}, None), None)
        assert remaining and remaining <= linux_identities, "remaining Connections tests must stay on Linux"


def verify_overlap_collection(calls, linux_identities, identities, collect, commands) -> None:
    if "run test:connections-layout:without-covered" in calls:
        def pack_identities(name: str) -> set[tuple[str, str, str]]:
            return set().union(*(identities(collect(argv, env, None), None)
                                 for argv, env in commands(name, {})))

        baseline = set(linux_identities)
        full = pack_identities("test:connections-layout")
        reduced = pack_identities("test:connections-layout:without-covered")
        removed = full - reduced
        assert removed and reduced <= full and removed <= linux_identities
        assert {item[1] for item in removed} == {"chromium", "webkit"}
        baseline.update(full)
        assert baseline == linux_identities, "deduplication changed collected browser coverage"
        if "run test:layout-contracts" in calls:
            mobile = identities(collect([
                "test", "e2e/first-connect-insights.layout.spec.ts", "--project=mobile-chrome",
            ], {"CI": "1"}, None), None)
            assert mobile and mobile <= linux_identities, "mobile first-connect coverage must remain"


def _browser_plan(changed: str, **overrides: str) -> tuple[int, dict[str, str], list[str], str]:
    head = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True
    ).stdout.strip()
    env = {
        "WEB_TARGETED_PLAN_ONLY": "1",
        "WEB_TARGETED_PART": "browser",
        "WEB_TARGETED_ALL_PACKS": "0",
        "WEB_TARGETED_FULL_SUITE_OWNED": "1",
        "WEB_TARGETED_BASE_SHA": head,
        "WEB_TARGETED_HEAD_SHA": head,
        "WEB_TARGETED_CHANGED_FILES": changed,
        # Use stdout instead of writing into the enclosing CI step's output file.
        "GITHUB_OUTPUT": "",
    }
    env.update(overrides)
    code, calls, output = _run(TARGETED, env, stub_diagrams=True)
    values = dict(re.findall(r"^(selection_known|browser_required)=(true|false)$", output, re.M))
    return code, values, calls, output


def test_browser_plan_skips_only_known_no_browser_selection() -> None:
    code, values, calls, output = _browser_plan("hushh-webapp/lib/voice/voice-session.ts")
    assert code == 0, output[-2000:]
    assert values == {"selection_known": "true", "browser_required": "false"}, values
    assert calls == [], "planning must not install dependencies or execute a test pack"

    for changed, extra in (
        ("hushh-webapp/e2e/calendar-connected-workspace.layout.spec.ts", {}),
        ("docs/README.md", {"PLAYWRIGHT_SHARD": "4/4"}),
    ):
        code, values, calls, output = _browser_plan(changed, **extra)
        assert code == 0, output[-2000:]
        assert values == {"selection_known": "true", "browser_required": "true"}, values
        assert calls == [], "the unsharded plan must not execute browser commands"


def test_browser_plan_unknown_full_scope_and_missing_metadata_fail_closed() -> None:
    code, values, calls, output = _browser_plan("hushh-webapp/unregistered/selector-input.ts")
    assert code == 0, output[-2000:]
    assert values == {"selection_known": "false", "browser_required": "true"}, values
    assert calls == []

    code, values, calls, output = _browser_plan(
        "hushh-webapp/lib/voice/voice-session.ts", WEB_TARGETED_ALL_PACKS="1"
    )
    assert code == 0, output[-2000:]
    assert values == {"selection_known": "true", "browser_required": "true"}, values
    assert calls == []

    code, values, calls, output = _browser_plan(
        "hushh-webapp/lib/voice/voice-session.ts", WEB_TARGETED_BASE_SHA=""
    )
    assert code != 0, "missing exact base metadata must not produce a skippable plan"
    assert "browser_required=false" not in output and "selection_known=true" not in output
    assert calls == []
