#!/usr/bin/env python3
"""The split web lanes must still run everything the unsplit lanes ran.

PR Validation runs two web lanes as matrices to shorten the critical path:

* ``Web Targeted Contracts`` as a ``node`` leg and three native Playwright
  browser shards (``WEB_TARGETED_PART`` and ``PLAYWRIGHT_SHARD``), and
* ``Web Full Suite (Vitest)`` as Vitest shards (``WEB_FULL_SUITE_SHARD``).
* 100 KB editor latency and History motion as a macOS browser job, outside Linux's
  software-rendered WebKit layout pack, scheduled and required whenever the
  ``editor`` path filter matches.

A split is only safe while it is a partition: every matched pack runs in exactly
one leg, the legs together run what a single ``all`` run does, every shard of
the matrix is scheduled, and the contract verifiers run exactly once. This
drives the real scripts with a stub ``npm`` that records what would have run,
so the assertion is about the scripts' behaviour, not about their text.

With web dependencies installed, ``--collect-browser-shards`` also uses native
Playwright ``--list`` to prove that all three shards partition every browser command
selected for this diff. It never starts a browser or runs test hooks.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github/workflows/ci.yml"
TARGETED = ROOT / "scripts/ci/web-targeted-check.sh"
FULL_SUITE = ROOT / "scripts/ci/web-full-suite-check.sh"
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
        raise RuntimeError("Git Bash is required to verify web lane partitioning on Windows")
    return "bash"

STUB_NPM = """#!/usr/bin/env bash
if [ "${1:-}" = "run" ]; then
  printf '%s\\n' "$*" >> "$NPM_STUB_LOG"
fi
exit 0
"""


def _job_block(workflow: str, job: str, next_job: str) -> str:
    start = workflow.index(f"  {job}:\n")
    end = workflow.index(f"\n  {next_job}:\n", start)
    return workflow[start:end]


def _run(script: Path, env_overrides: dict[str, str]) -> tuple[int, list[str], str]:
    with tempfile.TemporaryDirectory() as tmp:
        stub_dir = Path(tmp) / "bin"
        stub_dir.mkdir()
        npm = stub_dir / "npm"
        npm.write_text(STUB_NPM, encoding="utf-8")
        npm.chmod(npm.stat().st_mode | stat.S_IEXEC)
        log = Path(tmp) / "npm.log"
        log.touch()
        env = dict(os.environ)
        env.update(
            {
                "PATH": f"{stub_dir}{os.pathsep}{env['PATH']}",
                "NPM_STUB_LOG": str(log),
                "WEB_CI_DEPS_INSTALLED": "1",
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
        )
        calls = [line for line in log.read_text(encoding="utf-8").splitlines() if line]
        return proc.returncode, calls, proc.stdout + proc.stderr


def _one_matching_file_per_pack() -> str:
    """A changed-file list that schedules every pack whose paths exist today."""

    tracked = subprocess.run(
        ["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=True
    ).stdout.splitlines()
    patterns = re.findall(r"has_match '([^']+)'", TARGETED.read_text(encoding="utf-8"))
    assert patterns, "web-targeted-check.sh has no has_match packs"
    chosen: list[str] = []
    for pattern in patterns:
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
        _reaches_playwright(ref, scripts, seen) for ref in re.findall(r"npm run ([\w:.-]+)", body)
    )


def test_targeted_legs_partition_the_matched_packs() -> None:
    changed = _one_matching_file_per_pack()
    runs: dict[str, list[str]] = {}
    for part in ("all", "node", "browser"):
        code, calls, output = _run(
            TARGETED, {"WEB_TARGETED_PART": part, "WEB_TARGETED_CHANGED_FILES": changed}
        )
        assert code == 0, f"web-targeted-check.sh ({part}) exited {code}:\n{output[-2000:]}"
        runs[part] = calls

    all_calls, node, browser = runs["all"], runs["node"], runs["browser"]
    assert node and browser, "the fixture must schedule packs in both legs"
    assert not set(node) & set(browser), f"packs ran in both legs: {set(node) & set(browser)}"
    assert sorted(node + browser) == sorted(all_calls), (
        "the node and browser legs together must run exactly what `all` runs"
    )

    scripts = json.loads(PACKAGE_JSON.read_text(encoding="utf-8"))["scripts"]
    for call in browser:
        name = call.split()[1]
        assert _reaches_playwright(name, scripts, set()), f"{name} ran in the browser leg"
    for call in node:
        name = call.split()[1]
        assert not _reaches_playwright(name, scripts, set()), f"{name} needs a browser"


def test_targeted_rejects_an_unknown_part() -> None:
    code, calls, _ = _run(TARGETED, {"WEB_TARGETED_PART": "chromium"})
    assert code == 2 and not calls


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
        "hushh-webapp/e2e/fixtures/person-profile.tsx",
        "hushh-webapp/e2e/fixtures/person-profile-requests.tsx",
        "hushh-webapp/e2e/fixtures/person-profile-request-ports.tsx",
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
        assert calls.count("run test:connections-layout") == 1, (changed, calls)
    scripts = json.loads(PACKAGE_JSON.read_text(encoding="utf-8"))["scripts"]
    pack = scripts["test:connections-layout"]
    for spec in ("e2e/profile-confirmation-back.spec.ts", "e2e/shortcut-icons.motion.spec.ts", "e2e/person-profile-actions.layout.spec.ts"):
        assert pack.count(spec) == 1
        assert spec in pack.split("--project=chromium")[0]
    assert "--project=chromium --project=webkit" in pack


def test_full_suite_shards_run_verifiers_once() -> None:
    code, unsharded, output = _run(FULL_SUITE, {"WEB_FULL_SUITE_SHARD": ""})
    assert code == 0, output[-2000:]
    verifiers = [call for call in unsharded if call != "run test:ci"]
    assert unsharded[0] == "run test:ci" and verifiers

    shard_calls: list[list[str]] = []
    for index in (1, 2, 3):
        code, calls, output = _run(FULL_SUITE, {"WEB_FULL_SUITE_SHARD": f"{index}/3"})
        assert code == 0, output[-2000:]
        assert calls[0] == f"run test:ci -- --shard={index}/3", calls
        shard_calls.append(calls[1:])
    assert shard_calls[0] == verifiers, "shard 1 must run every contract verifier"
    assert shard_calls[1] == [] and shard_calls[2] == [], "only shard 1 runs the verifiers"

    for bad in ("0/3", "4/3", "1/0", "a/b", "1", "1/3/3"):
        code, calls, _ = _run(FULL_SUITE, {"WEB_FULL_SUITE_SHARD": bad})
        assert code == 2 and not calls, f"shard spec {bad!r} was accepted"


def test_workflow_schedules_every_leg_and_shard() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")

    targeted = _job_block(workflow, "web-targeted-check", "web-full-suite-check")
    entries = re.findall(
        r'- part: (node|browser)\n\s+label: ([\w-]+)\n\s+shard: "([^"]*)"', targeted
    )
    assert [(part, shard) for part, _, shard in entries] == [
        ("node", ""), ("browser", "1/3"), ("browser", "2/3"), ("browser", "3/3")
    ], "run node once and all three browser shards"
    assert len({label for _, label, _ in entries}) == 4, "matrix names must be unique"
    assert 'name: "Web Targeted Contracts (${{ matrix.label }})"' in targeted
    assert "name: web-targeted-npm-audit-report-${{ matrix.label }}" in targeted
    assert "WEB_TARGETED_PART: ${{ matrix.part }}" in targeted
    assert "PLAYWRIGHT_SHARD: ${{ matrix.shard }}" in targeted
    assert "timeout-minutes: 30" in targeted
    assert "fail-fast: false" in targeted
    # Failure traces were printed then lost with the runner. Only these
    # source-coupled synthetic fixtures are admitted, never reviewer journeys.
    evidence = re.search(
        r"- name: Upload synthetic Wallet failure evidence\n(.*?)(?=\n      - name:)",
        targeted, re.S,
    )
    assert evidence, "retain the failing Wallet layout trace before runner teardown"
    assert "if: failure() && matrix.part == 'browser'" in evidence[1]
    assert "name: wallet-layout-failures-${{ matrix.label }}" in evidence[1]
    paths = re.search(r"path: \|\n((?:            [^\n]+\n)+)", evidence[1])
    assert paths
    assert [line.strip() for line in paths[1].splitlines()] == [
        "hushh-webapp/test-results/wallet-workspace.layout-*/trace.zip",
        "hushh-webapp/test-results/wallet-workspace.layout-*/test-failed-*.png",
        "hushh-webapp/test-results/wallet-workspace.layout-*/error-context.md",
    ], "do not broaden synthetic evidence into protected browser artifacts"

    editor_perf = _job_block(workflow, "web-editor-performance-check", "web-full-suite-check")
    assert "runs-on: macos-15" in editor_perf
    assert "npm run test:layout-editor-performance" in editor_perf
    scripts = json.loads(PACKAGE_JSON.read_text(encoding="utf-8"))["scripts"]
    assert "test:layout-editor-performance" not in scripts["test:layout-contracts"]

    full = _job_block(workflow, "web-full-suite-check", "ios-native-check")
    shards = re.search(r"shard: \[([0-9, ]+)\]", full)
    assert shards, "web-full-suite-check has no shard matrix"
    indexes = [int(value) for value in shards.group(1).split(",")]
    count = len(indexes)
    assert indexes == list(range(1, count + 1)), f"shards must be 1..N, got {indexes}"
    assert f"WEB_FULL_SUITE_SHARD: ${{{{ matrix.shard }}}}/{count}" in full
    assert f"${{{{ matrix.shard }}}}/{count}\"" in full, "the job name must show the shard count"
    assert "fail-fast: false" in full

    gate = workflow[workflow.index("  ci-status:") :]
    assert '[ "$WEB_FULL_SUITE" != "success" ]' in gate
    assert "WEB_TARGETED=\"${{ needs['web-targeted-check'].result }}\"" in gate
    assert '[ "$WEB_TARGETED" != "success" ]' in gate
    assert "WEB_EDITOR_PERF=\"${{ needs['web-editor-performance-check'].result }}\"" in gate
    assert '[ "$WEB_EDITOR_PERF" != "success" ]' in gate


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
        TARGETED, {"WEB_TARGETED_PART": "browser", "WEB_TARGETED_CHANGED_FILES": changed}
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
        pack = call.split()[1]
        selected = list(commands(pack, {}))
        assert selected, f"no native browser command extracted from {pack}"
        for argv, env in selected:
            first_command = first_command or (argv, env)
            baseline = identities(collect(argv, env, None), None)
            linux_identities.update(baseline)
            shards = [
                identities(collect(argv, env, f"{index}/3"), f"{index}/3")
                for index in (1, 2, 3)
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
        "test", "e2e/agent-history-motion.layout.spec.ts",
        "--project=chromium", "--project=webkit",
    ], {"CI": "1"}, None), None)
    assert len(history) == 2 and {item[1] for item in history} == {"chromium", "webkit"}
    assert history <= timing, "both unchanged History timing tests must reach macOS"
    assert history.isdisjoint(linux_identities), "do not duplicate timing tests in Linux"
    if any(call.split()[1] == "test:connections-layout" for call in calls):
        remaining = identities(collect([
            "test", "e2e/connections-drawer.layout.spec.ts",
            "--project=chromium", "--project=webkit",
        ], {"CI": "1"}, None), None)
        assert remaining and remaining <= linux_identities, "remaining Connections tests must stay on Linux"

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
        test_build_exports_explicit_and_default_backend_origins,
        test_targeted_legs_partition_the_matched_packs,
        test_targeted_rejects_an_unknown_part,
        test_paid_answer_photo_inputs_schedule_browser_pack,
        test_profile_and_shortcut_inputs_schedule_connections_browser_pack,
        test_full_suite_shards_run_verifiers_once,
        test_workflow_schedules_every_leg_and_shard,
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
